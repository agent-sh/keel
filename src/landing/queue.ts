// The landing queue: branches a session (the owner, a coordinator) queues to
// land on their repository's base. A pass of a repository takes the entries
// queued then, in order (rules.ts buildOrder), and builds each in a worktree
// of Keel's own: on the base and the entries ahead of it that passed, by
// rebase (or a merge commit, when the repository's rules ask for one). The
// repository's named checks run on that exact tree, answered from the check
// ledger when they already passed on it and recorded there when they run. A
// check that changes the files it checks lands nothing: what it passed on is
// not what would land. An entry that conflicts or fails a check leaves the
// queue, told at once to the session that holds the branch
// (src/automation/failures.ts), and the entries behind it are built without
// it. The entries that passed land as one batch: the base fast-forwards to the
// last commit every check passed on, then is pushed when the repository says
// so, and the repository's after-land step runs once on that commit. The
// session that queued entries is told what landed and left as one harness
// input, owed here until the prompt that carries it is stored.
//
// A conflict with the base goes to the agent whose branch it is, not out of
// the queue (src/landing/resolve.ts): the queue rebases the branch in a
// worktree of its own to read where it stops (the commit, the files, the
// base's lines), gives that rebase up, and continues the agent with a task
// that names them. When the agent's turn ends, a branch that moved and merges
// with the base is queued again and checked like any entry; a conflict the
// agent calls substantive, or two failed tries, leaves and is told to the
// session that started it. An agent that is gone is replaced by a fresh one
// of the session that queued the branch, on the branch. The forecast's word
// at queue time sends the task at once. Keel never ends a rebase in the
// agent's worktree; one in progress there is named and left as it is.
//
// Who queues what: a session queues its own branches and its agents' (an
// agent's agents' too); a branch another session holds, or one nobody holds,
// is the owner's to queue (the Branches panel).
//
// Nothing of the repository is written but the base ref and the queue's own
// worktrees under Keel's state, removed after the pass. The base moves only
// from the commit the pass built on (compare and swap); a checkout that has
// it out follows by a fast-forward of its own, and only when it holds no
// change of the owner's (staged or not). When it moved meanwhile, the pass is
// built again, a few times at most.
//
// A restart in the middle: the pass is not waited for. The next start reads
// the base: an entry whose built commit the base holds is landed (and told),
// the rest are queued again and built anew, and a check that passed on the
// same tree before the stop is answered from the ledger, so only the check
// the stop cut runs again. A check longer than the time between restarts
// never ends; a repository with such checks raises land.timeout_minutes and
// restarts less often.
import { cpuMsOf } from "../core/proc.ts";
import { during } from "../admin/activity.ts";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { countsOf } from "../checks/counts.ts";
import { inputsOf, keyOf, onTree, record, repoOf, settingFor, treeOf } from "../checks/ledger.ts";
import { parseChecks, readChecks, overlay } from "../checks/named.ts";
import { noteFor as ledgerNote } from "../checks/runs.ts";
import { flakyOn } from "../checks/words.ts";
import { git, locate } from "../core/git.ts";
import { tempEnv } from "../core/temp.ts";
import type { Store } from "../core/store.ts";
import { git as worktreeGit } from "../worktree/manager.ts";
import type { Overlaps } from "../worktree/overlap-scan.ts";
import { afterTask, baseLines, rebaseTask, TRIES, type ConflictAt, type Stop } from "./resolve.ts";
import { buildOrder, checksToRun, failureText, leftWhy, outcomeText, queueWarning, readLand, tailOf, type LandRules, type Left, type Outcome, type Push, type ToRun } from "./rules.ts";
import { homeDir } from "../core/paths";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS landing_queue (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, pos INTEGER NOT NULL,
  queued_by TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  holder TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  tip TEXT NOT NULL, state TEXT NOT NULL, step TEXT, built TEXT, landed TEXT, why TEXT, log TEXT,
  batch TEXT, owed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS landing_queue_repo ON landing_queue(repo, state);
-- A session's newest change, for its last result (src/automation/results.ts): one seek by who queued it.
CREATE INDEX IF NOT EXISTS landing_queue_by ON landing_queue(queued_by, updated);
CREATE INDEX IF NOT EXISTS landing_queue_owed ON landing_queue(queued_by) WHERE owed = 1;
CREATE TABLE IF NOT EXISTS landing_batches (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, base TEXT NOT NULL, from_sha TEXT NOT NULL, to_sha TEXT,
  checks TEXT NOT NULL, push TEXT, after TEXT, after_exit INTEGER, after_log TEXT, ended INTEGER NOT NULL
);
`;

// The columns of a branch's own agent settling its conflict with the base (src/landing/resolve.ts):
// `tries` the rebase tasks it was sent, `agent` the agent that has the newest, `agent_task` the task
// number that ends it, `sent_tip` the branch's tip when it was sent.
const RESOLVE_COLUMNS: [string, string][] = [["tries", "INTEGER NOT NULL DEFAULT 0"], ["agent", "TEXT"], ["agent_task", "INTEGER"], ["sent_tip", "TEXT"]];

// queued: waits for a pass; building / checking: in the pass that runs (step says what);
// resolving: it conflicts with the base and its agent was sent a rebase task;
// landed: on the base; left: out of the queue, `why` says why; removed: taken out by whoever queued it.
export type EntryState = "queued" | "building" | "checking" | "resolving" | "landed" | "left" | "removed";
export const LIVE_STATES: readonly EntryState[] = ["queued", "building", "checking", "resolving"];
const LIVE_SQL = `(${LIVE_STATES.map((s) => `'${s}'`).join(", ")})`;
export type Entry = {
  id: string; repo: string; branch: string; pos: number; queued_by: string | null; holder: string | null;
  tip: string; state: EntryState; step: string | null; built: string | null; landed: string | null;
  why: string | null; log: string | null; batch: string | null; owed: number; created: number; updated: number;
  tries: number; agent: string | null; agent_task: number | null; sent_tip: string | null;
};
export type QueueView = { repo: string | null; base: string | null; entries: Entry[]; running: boolean; rules?: { checks: string[]; push?: string; after?: string; method: string; problems: string[] } };

// How the queue reaches the rest of the daemon. `changed`: the sessions
// whose repository's queue changed. `failed`: a branch left; `root` is told
// (its ref: the agent whose branch it is). `owed`: an outcome waits for `session`.
// `confine`: the argv a check runs with, inside the session's sandbox when it has one.
// `mayPush`: why the queue may not push for this session (it has no network), or nothing.
// `agents`: the agents a conflict with the base goes to (none: the branch leaves, told).
export type QueueDeps = {
  changed: (sessionIds: string[]) => void;
  error: (e: unknown, at: string) => void;
  failed: (root: string, f: { cls: string; message: string; ref?: { id: string; label?: string } }) => void;
  owed: (sessionId: string) => void;
  confine: (argv: string[], sessionId: string | null, folder: string) => string[];
  env: (sessionId: string | null) => Record<string, string>;
  mayPush: (sessionId: string | null) => string | undefined;
  agents?: AgentDeps;
};

// Who settles a branch's conflict: the agent that holds it, or a fresh agent
// of `fresh` (a session) on the branch when that agent is gone.
export type Taker = { agent: string } | { fresh: string };
export type AgentDeps = {
  // Who takes a rebase task for the entry; none: a top-level session holds it, or nobody can.
  who: (e: Pick<Entry, "holder" | "queued_by">) => Taker | undefined;
  // Sends the task: the agent that has it, its session and the task number its end closes; or why not.
  send: (e: Entry, to: Taker, text: string) => Promise<{ agent: string; session: string; task: number } | { why: string }>;
  // The agent as it is now; undefined when it is gone.
  state: (agentId: string) => { ended: boolean; status: string; tasks: number; report: string } | undefined;
};

// Queue calls of one step (a coordinator queueing several branches) make one pass.
const SETTLE_MS = 750;
// A finished entry (and its logs) is kept two weeks: its outcome is told at
// once, and the Branches panel shows what landed and left lately.
const KEEP_MS = 14 * 86_400_000;
// How many times an entry is built again because the base moved under its pass,
// before it leaves: a base that never holds still would rebuild it forever.
export const BASE_MOVES = 3;
// The end of a log a failure line quotes from.
const TAIL_BYTES = 64 * 1024;
// The identity of a commit the queue makes (a rebased entry) on a machine with none of its own.
const KEEL_IDENT = { GIT_AUTHOR_NAME: "Keel", GIT_AUTHOR_EMAIL: "keel@localhost", GIT_COMMITTER_NAME: "Keel", GIT_COMMITTER_EMAIL: "keel@localhost" };
const NO_EDIT = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
// A conflicted file larger than this is named without its lines (a generated file, a lockfile).
const MAX_MARKED = 2 * 1024 * 1024;
type Sg = (args: string[], env?: Record<string, string>) => Promise<{ code: number; out: string; err: string }>;

// (A UUIDv7's random part: the same each run under a fixed world, src/core/fixed-world.ts.)
const newId = () => `lq-${Bun.randomUUIDv7().replace(/-/g, "").slice(-18)}`;
const short = (b: string) => b.replace(/^refs\/(heads|remotes\/[^/]+)\//, "");
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
// A time limit as it is said: seconds under a minute, else whole minutes up.
export const limitSays = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.ceil(ms / 1000))} s` : `${Math.ceil(ms / 60_000)} min`);

// The process groups of the commands the queue runs: killed with the daemon, so a stop leaves no check running.
const groups = new Set<number>();
const killGroup = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch {} };
process.on("exit", () => { for (const g of groups) killGroup(g); });

export class LandingQueue {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<void>>();
  private again = new Set<string>();
  // The sessions whose view of a repository's queue is open (they read it), told when it changes.
  private viewers = new Map<string, Set<string>>();
  // How often each entry was built again because the base moved under it.
  private moves = new Map<string, number>();
  // Entries that conflicted with an entry ahead of them only, and wait for it to land (once each).
  private deferred = new Set<string>();
  // Entries whose agent's end is being read.
  private deciding = new Set<string>();
  // Rebase tasks being made and sent, outside a pass (idle waits for them too).
  private sending = new Set<Promise<unknown>>();
  private track(p: Promise<unknown>) { const t = p.catch((x) => this.d.error(x, "landing rebase task")).finally(() => this.sending.delete(t)); this.sending.add(t); }

  constructor(private store: Store, private ov: Overlaps, private d: QueueDeps) {
    store.migrate(SCHEMA);
    for (const [c, t] of RESOLVE_COLUMNS) if (!store.columnExists("landing_queue", c)) store.migrate(`ALTER TABLE landing_queue ADD COLUMN ${c} ${t}`);
  }

  private get dir() { return join(this.store.stateDir, "landing"); }

  // After a start: what a cut pass left is read against the base (an entry
  // the base holds landed), worktrees it left are removed, old entries go,
  // every repository with queued entries gets a pass, and what is owed is told.
  async recover() {
    const cut = this.store.db.query<Entry, []>("SELECT * FROM landing_queue WHERE state IN ('building', 'checking')").all();
    const landedIn = new Map<string, Entry[]>();
    for (const e of cut) {
      const base = await this.baseOf(e.repo).catch(() => null);
      const holds = !!e.built && !!base && (await git(e.repo, ["merge-base", "--is-ancestor", e.built, base], { read: true })).code === 0;
      if (holds) {
        this.set(e.id, { state: "landed", step: null, landed: e.built, owed: e.queued_by ? 1 : 0 });
        landedIn.set(e.batch ?? "", [...(landedIn.get(e.batch ?? "") ?? []), e]);
      } else this.set(e.id, { state: "queued", step: null, built: null });
    }
    // A batch cut between its move and its after step: the step is owed no more, and the outcome says so.
    for (const batch of landedIn.keys()) this.store.db.query("UPDATE landing_batches SET after_exit = -2 WHERE id = ? AND after IS NOT NULL AND after_exit IS NULL").run(batch);
    for (const r of this.store.db.query<{ repo: string }, []>("SELECT DISTINCT repo FROM landing_queue").all()) await this.dropScratch(r.repo).catch((e) => this.d.error(e, "landing recover"));
    this.prune();
    // An agent's task the stop cut before it was sent is built again; one that was sent is read when the agent ends (or now, if it has).
    for (const e of this.store.db.query<Entry, []>("SELECT * FROM landing_queue WHERE state = 'resolving'").all()) {
      if (!e.agent) this.set(e.id, { state: "queued", step: null, tries: Math.max(0, e.tries - 1) });
      else await this.agentEnded(e.agent).catch((x) => this.d.error(x, "landing recover"));
    }
    for (const r of this.store.db.query<{ repo: string }, []>("SELECT DISTINCT repo FROM landing_queue WHERE state = 'queued'").all()) this.schedule(r.repo, 0);
    for (const r of this.store.db.query<{ queued_by: string }, []>("SELECT DISTINCT queued_by FROM landing_queue WHERE owed = 1 AND queued_by IS NOT NULL").all()) this.d.owed(r.queued_by);
  }

  private prune() {
    const old = this.store.db.query<{ id: string }, [number]>("SELECT id FROM landing_queue WHERE state IN ('landed', 'left', 'removed') AND owed = 0 AND updated < ?").all(Date.now() - KEEP_MS);
    for (const e of old) {
      for (const f of this.logsOf(e.id)) rmSync(f, { force: true });
      this.store.db.query("DELETE FROM landing_queue WHERE id = ?").run(e.id);
      this.moves.delete(e.id);
    }
    this.store.db.query("DELETE FROM landing_batches WHERE ended < ? AND id NOT IN (SELECT batch FROM landing_queue WHERE batch IS NOT NULL)").run(Date.now() - KEEP_MS);
  }
  private logsOf(id: string): string[] {
    const d = join(this.dir, "logs");
    try { return readdirSync(d).filter((f) => f.startsWith(`${id}-`)).map((f) => join(d, f)); } catch { return []; }
  }

  // ---- what sessions do

  // The repository a session lands into: its own.
  repoOf(sessionId: string): string | undefined { return this.ov.whereOf(sessionId)?.repo; }

  // Whether `id` is `of` or an agent below it.
  private within(id: string, of: string): boolean {
    for (let cur: string | null | undefined = id, i = 0; cur && i < 16; i++) {
      if (cur === of) return true;
      cur = this.store.session(cur)?.parent_id;
    }
    return false;
  }

  // Queues branches of the repository. `by`: the session that queues (told
  // the outcome); null for the owner, who may queue any branch. A session
  // queues the branches it or one of its agents holds. A branch already in
  // the queue keeps its place.
  async add(repo: string, branches: string[], by: string | null): Promise<{ queued: Entry[]; refused: { branch: string; why: string }[]; warnings: string[] }> {
    const base = await this.baseOf(repo);
    const queued: Entry[] = [], refused: { branch: string; why: string }[] = [], warnings: string[] = [];
    if (!base) return { queued, refused: branches.map((b) => ({ branch: b, why: "the repository has no base branch to land on (main or master, or the branch origin/HEAD names)" })), warnings };
    const owners = this.ov.owners(repo);
    const live = () => this.store.db.query<Entry, [string]>(`SELECT * FROM landing_queue WHERE repo = ? AND state IN ${LIVE_SQL} ORDER BY pos`).all(repo);
    const early: string[] = [];
    for (const raw of branches) {
      const branch = raw.trim().replace(/^refs\/heads\//, "");
      if (!/^[\w./@-]+$/.test(branch) || branch.includes("..")) { refused.push({ branch: raw, why: "not a branch name" }); continue; }
      if (`refs/heads/${branch}` === base) { refused.push({ branch, why: "it is the base itself" }); continue; }
      const tip = (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`], { read: true })).out.trim();
      if (!tip) { refused.push({ branch, why: "no such branch in the repository" }); continue; }
      const holder = owners.get(branch) ?? this.holderOf(repo, branch) ?? null;
      if (by && !holder) { refused.push({ branch, why: "no session holds it: the owner queues it, from the Branches panel" }); continue; }
      if (by && holder && !this.within(holder, by)) { refused.push({ branch, why: `another session holds it (${holder}): that session queues it, or the one that started it, or the owner from the Branches panel` }); continue; }
      const had = live().find((e) => e.branch === branch);
      if (had) { queued.push(had); continue; }
      // The forecast already finds it conflicting with the base, at these tips: its agent is told now,
      // not after the entries ahead of it were built and checked.
      const fc = this.d.agents?.who({ holder, queued_by: by }) ? await this.ov.againstBase(repo, branch).catch(() => undefined) : undefined;
      const toAgent = fc?.state === "conflict" && fc.tip === tip;
      if (live().some((e) => e.branch === branch)) { queued.push(live().find((e) => e.branch === branch)!); continue; } // queued meanwhile
      const now = Date.now();
      const pos = (this.store.db.query<{ p: number | null }, [string]>("SELECT MAX(pos) AS p FROM landing_queue WHERE repo = ?").get(repo)?.p ?? 0) + 1;
      const id = newId();
      this.store.db.query("INSERT INTO landing_queue (id, repo, branch, pos, queued_by, holder, tip, state, step, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, repo, branch, pos, by, holder, tip, toAgent ? "resolving" : "queued", toAgent ? `the forecast finds it conflicting with ${short(base)}: its agent is being sent a rebase task` : null, now, now);
      if (toAgent) early.push(id);
      queued.push(this.entry(id)!);
      const w = this.warning(repo, branch, base, live().filter((e) => e.branch !== branch).map((e) => e.branch));
      if (w) warnings.push(w);
    }
    if (queued.length) { this.changedFor(repo); this.schedule(repo); }
    for (const id of early) this.track(this.early(id));
    return { queued, refused, warnings };
  }

  // Takes an entry out before it is built. One being built finishes its pass.
  remove(id: string, by: string | null): Entry | { error: string } {
    const e = this.entry(id);
    if (!e) return { error: "no such entry" };
    if (by && e.queued_by !== by && !(e.holder && this.within(e.holder, by))) return { error: "this entry was queued by another session" };
    if (e.state !== "queued" && e.state !== "resolving") return { error: e.state === "building" || e.state === "checking" ? "it is being built now: it lands or leaves with this pass" : `it already ${e.state === "landed" ? "landed" : "left the queue"}` };
    this.set(id, { state: "removed", why: by ? "taken out by the session that queued it" : "taken out by the owner" });
    this.changedFor(e.repo);
    return this.entry(id)!;
  }

  entry = (id: string) => this.store.db.query<Entry, [string]>("SELECT * FROM landing_queue WHERE id = ?").get(id) ?? undefined;

  // Who a branch is, when no live session holds it (an ended agent's branch waits for whoever lands it):
  // the session of the worktree Keel made for it, else the last session that committed to it.
  private holderOf(repo: string, branch: string): string | undefined {
    let id: string | undefined;
    try { id = this.store.db.query<{ session_id: string }, [string, string]>("SELECT session_id FROM worktrees WHERE repo_root = ? AND branch = ? ORDER BY updated DESC LIMIT 1").get(repo, branch)?.session_id; } catch {} // no worktree was ever made
    id ??= this.store.db.query<{ session_id: string }, [string, string]>("SELECT session_id FROM overlap_branches WHERE repo = ? AND branch = ?").get(repo, branch)?.session_id;
    return id && this.store.session(id) ? id : undefined;
  }

  // The forecast's word on a branch queued behind others (rules.ts queueWarning).
  private warning(repo: string, branch: string, base: string, ahead: string[]): string | undefined {
    const pairs = this.ov.pairsOf(repo);
    const files = (p: { files: { path: string }[] }) => p.files.map((f) => f.path);
    const withBase = pairs.find((p) => p.base && p.conflict && p.a === branch);
    const against = ahead.flatMap((a) => { const p = pairs.find((q) => !q.base && q.conflict && ((q.a === a && q.b === branch) || (q.b === a && q.a === branch))); return p ? [{ branch: a, files: files(p) }] : []; });
    return queueWarning(branch, short(base), { base: withBase ? files(withBase) : undefined, ahead: against });
  }

  // ---- what the page reads

  async view(sessionId: string): Promise<QueueView> {
    const repo = this.repoOf(sessionId);
    if (!repo) return { repo: null, base: null, entries: [], running: false };
    const seen = this.viewers.get(repo) ?? new Set<string>();
    seen.delete(sessionId);
    seen.add(sessionId);
    if (seen.size > 64) seen.delete(seen.values().next().value!);
    this.viewers.set(repo, seen);
    const base = await this.baseOf(repo);
    const entries = this.store.db.query<Entry, [string, number]>(`SELECT * FROM landing_queue WHERE repo = ? AND (state IN ${LIVE_SQL} OR updated > ?) ORDER BY pos DESC LIMIT 60`).all(repo, Date.now() - KEEP_MS);
    let rules: QueueView["rules"];
    if (base) {
      const r = await this.rulesOf(repo, base);
      const run = r ? checksToRun(r.rules, r.named, homeDir()) : undefined;
      if (r) rules = { checks: run && "run" in run ? run.run.map((c) => c.command === c.check.run ? c.check.name : `${c.check.name} ${c.command.slice(c.check.run.length).trim()}`.trim()) : [], ...(r.rules.push ? { push: r.rules.push } : {}), ...(r.rules.after ? { after: r.rules.after } : {}), method: r.rules.method, problems: [...r.rules.problems, ...(run && "problem" in run ? [run.problem] : [])] };
    }
    return { repo, base: base ? short(base) : null, entries, running: this.running.has(repo), ...(rules ? { rules } : {}) };
  }

  // ---- the base and the rules

  // The local branch the repository lands on: the one origin/HEAD names, else main or master.
  async baseOf(repo: string): Promise<string | null> {
    const b = await this.ov.baseOf(repo);
    if (!b) return null;
    const local = b.startsWith("refs/remotes/") ? `refs/heads/${b.split("/").slice(3).join("/")}` : b;
    return (await git(repo, ["rev-parse", "-q", "--verify", local], { read: true })).code === 0 ? local : null;
  }

  // The rules and named checks as the base's own commit has them, with the owner's setting laid over.
  private async rulesOf(repo: string, base: string, at?: string): Promise<{ rules: LandRules; named: ReturnType<typeof parseChecks>["checks"] } | undefined> {
    const shown = await git(repo, ["show", `${at ?? base}:.keel/checks.json`], { read: true });
    let raw: any;
    try { raw = shown.code === 0 ? JSON.parse(shown.out) : undefined; } catch { raw = undefined; }
    const file = shown.code === 0 ? parseChecks(shown.out) : undefined;
    const r = repoOf(repo);
    const setting = r ? settingFor(r.scope) as any : undefined;
    const named = overlay(file, setting === undefined ? undefined : readChecks(setting));
    if (!named && raw?.land === undefined && setting?.land === undefined) return undefined;
    return { rules: readLand(setting?.land ?? raw?.land), named: named?.checks ?? [] };
  }

  // ---- passes

  schedule(repo: string, ms = SETTLE_MS) {
    if (this.timers.has(repo)) return;
    const t = setTimeout(() => { this.timers.delete(repo); void this.run(repo); }, ms);
    t.unref?.();
    this.timers.set(repo, t);
  }

  // One pass at a time a repository; one asked for while one runs follows it.
  run(repo: string): Promise<void> {
    const cur = this.running.get(repo);
    if (cur) { this.again.add(repo); return cur; }
    const p = this.pass(repo).catch((e) => this.d.error(e, "landing pass")).finally(() => {
      this.running.delete(repo);
      this.changedFor(repo);
      if (this.again.delete(repo)) void this.run(repo);
    });
    this.running.set(repo, p);
    return p;
  }
  // Resolves when no pass of the repository runs or waits to.
  async idle(repo: string) {
    for (;;) {
      const t = this.timers.get(repo);
      if (t) { clearTimeout(t); this.timers.delete(repo); void this.run(repo); }
      const r = this.running.get(repo);
      if (r) { await r; continue; }
      if (!this.sending.size) return;
      await Promise.all([...this.sending]);
    }
  }

  private changedFor(repo: string) {
    const ids = new Set<string>();
    for (const id of this.ov.owners(repo).values()) ids.add(id);
    for (const r of this.store.db.query<{ a: string | null; b: string | null }, [string, number]>(`SELECT queued_by AS a, holder AS b FROM landing_queue WHERE repo = ?1 AND (state IN ${LIVE_SQL} OR owed = 1 OR updated > ?2)`).all(repo, Date.now() - 3_600_000)) {
      if (r.a) ids.add(r.a);
      if (r.b) ids.add(r.b);
    }
    for (const id of this.viewers.get(repo) ?? []) ids.add(id);
    this.d.changed([...ids]);
  }

  private set(id: string, f: Partial<Pick<Entry, "state" | "step" | "built" | "landed" | "why" | "log" | "batch" | "owed" | "tip" | "holder" | "tries" | "agent" | "agent_task" | "sent_tip">>) {
    const keys = Object.keys(f);
    if (!keys.length) return;
    this.store.db.query(`UPDATE landing_queue SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? WHERE id = ?`).run(...(Object.values(f) as any[]), Date.now(), id);
  }

  // An entry leaves the queue: written, told to the session that holds the
  // branch, and owed to the one that queued it, all at once (a stop after
  // this loses none of it).
  private leave(e: Entry, why: string, base: string, batch: string, log?: string) {
    const root = this.rootOf(e);
    const queuerTold = !!root && root.session === e.queued_by;
    this.set(e.id, { state: "left", step: null, why, log: log ?? null, batch, owed: e.queued_by && !queuerTold && this.store.session(e.queued_by) ? 1 : 0 });
    this.moves.delete(e.id);
    this.deferred.delete(e.id);
    const l: Left = { branch: e.branch, why, ...(log ? { log } : {}) };
    if (root) this.d.failed(root.session, { cls: clsOf(why), message: failureText(l, base), ...(root.ref ? { ref: root.ref } : {}) });
  }

  private pass(repo: string): Promise<void> {
    return during("task", () => this.passOf(repo), "the landing queue's pass");
  }
  private async passOf(repo: string) {
    this.prune();
    const entries = this.store.db.query<Entry, [string]>("SELECT * FROM landing_queue WHERE repo = ? AND state = 'queued' ORDER BY pos").all(repo);
    if (!entries.length) return;
    const w = locate(repo);
    const base = await this.baseOf(repo);
    const batch = newId().replace(/^lq-/, "lb-");
    const baseName = base ? short(base) : "the base";
    const leave = (e: Entry, why: string, log?: string) => this.leave(e, why, baseName, batch, log);
    const finish = (o?: Outcome, checks: string[] = []) => this.finish(repo, baseName, batch, o, checks);
    if (!w || !base) {
      for (const e of entries) leave(e, !w ? "the repository is gone" : "the repository has no base branch to land on");
      return finish();
    }
    const from = (await git(repo, ["rev-parse", "-q", "--verify", base], { read: true })).out.trim();
    const r = await this.rulesOf(repo, base, from);
    const plan = r ? checksToRun(r.rules, r.named, homeDir()) : { problem: "the repository names no checks (.keel/checks.json), so nothing is known to pass" };
    let problem = "problem" in plan ? plan.problem : r!.rules.problems[0];
    // The push goes to a remote the repository names, never to a path or address of the rules' own.
    if (!problem && r!.rules.push && (await git(repo, ["remote", "get-url", "--push", r!.rules.push], { read: true })).code !== 0) problem = `land.push names ${r!.rules.push}, which is not a remote of the repository`;
    if (problem) {
      for (const e of entries) leave(e, `the repository's landing rules are not usable: ${problem}`);
      return finish();
    }
    const rules = r!.rules, checks = (plan as { run: ToRun[] }).run;
    const forecast = new Set(this.ov.pairsOf(repo).filter((p) => p.base && p.conflict).map((p) => p.a));
    const order = buildOrder(entries, forecast);
    for (const e of order) this.set(e.id, { state: "building", step: "waiting for its turn", batch, why: null });
    this.changedFor(repo);

    const scratch = join(this.dir, createHash("sha256").update(repo).digest("hex").slice(0, 16), batch);
    mkdirSync(join(this.dir, "logs"), { recursive: true });
    mkdirSync(join(scratch, ".."), { recursive: true });
    const sg = (args: string[], env?: Record<string, string>) => git(scratch, args, { env: { ...NO_EDIT, ...env }, timeout: 300_000 });
    let made = false;
    const passed: { e: Entry; at: string; tip: string }[] = [];
    let outcome: Outcome | undefined;
    const who = entries.find((e) => e.queued_by)?.queued_by ?? entries.find((e) => e.holder)?.holder ?? null;
    try {
      await worktreeGit(repo, ["worktree", "add", "-q", "--detach", scratch, from]);
      made = true;
      const ident = (await sg(["var", "GIT_COMMITTER_IDENT"])).code === 0 ? {} : KEEL_IDENT;
      if (rules.setup) {
        const s = await this.sh(rules.setup, scratch, `${batch}-setup`, who, repo, rules.timeoutMs);
        if (s.exit !== 0) {
          for (const e of order) leave(e, leftWhy({ kind: "setup", err: `${s.exit === null ? `stopped after ${limitSays(rules.timeoutMs)}` : `exit ${s.exit}`}: ${tailOf(s.text, 3, 300)}` }), s.log);
          return;
        }
      }
      let tip = from;
      for (const e of order) {
        const ahead = passed.map((p) => p.e.branch);
        this.set(e.id, { step: `building on ${baseName}${ahead.length ? ` with ${ahead.join(", ")}` : ""}` });
        this.changedFor(repo);
        const bt = (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${e.branch}^{commit}`], { read: true })).out.trim();
        if (!bt) { leave(e, leftWhy({ kind: "gone" })); continue; }
        this.set(e.id, { tip: bt });
        // Built on the last commit that passed, with nothing left of the entry before it but what git ignores (the setup's).
        await sg(["checkout", "-q", "--detach", "--force", tip]);
        await sg(["clean", "-q", "-fd"]);
        const built = await this.apply(sg, rules.method, tip, bt, ident, e.branch);
        if ("conflict" in built) {
          const to = await this.conflicted(e, { sg, scratch, ident, base, baseName, from, bt, ahead, method: rules.method, checks: checks.map((c) => c.check.name), batch });
          if (to !== "leave") continue;
          leave(e, leftWhy({ kind: "conflict", base: baseName, at: from, files: built.conflict, ahead, ...(e.tries ? { tries: e.tries } : {}) }));
          continue;
        }
        if (built.at === tip) { leave(e, `it has nothing to land: ${baseName}${ahead.length ? " with the entries ahead of it" : ""} already holds its change`); continue; }
        this.set(e.id, { built: built.at, state: "checking" });
        const failed = await this.checkAll(checks, scratch, e, who, repo, rules.timeoutMs, built.at, { base: baseName, from, ahead });
        if (failed) { leave(e, failed.why, failed.log); continue; }
        passed.push({ e, at: built.at, tip: bt });
        tip = built.at;
        this.set(e.id, { step: "passed: lands with the batch" });
      }
      if (!passed.length) return;
      // The base moved while the pass ran: what passed was built on another base, and is built again (a few times).
      const now = (await git(repo, ["rev-parse", "-q", "--verify", base], { read: true })).out.trim();
      if (now !== from) { this.moved(passed.map((p) => p.e), baseName, batch, repo); return; }
      // What the move is to be is written first: a stop after it reads the base (recover).
      this.store.db.query("INSERT OR REPLACE INTO landing_batches (id, repo, base, from_sha, to_sha, checks, push, after, after_exit, after_log, ended) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)")
        .run(batch, repo, baseName, from, tip, JSON.stringify(checks.map((c) => c.check.name)), rules.push ?? null, rules.after ?? null, Date.now());
      const refused = await this.moveBase(repo, base, from, tip);
      if (refused) {
        if (refused.moved) { this.moved(passed.map((p) => p.e), baseName, batch, repo); return; }
        for (const p of passed) leave(p.e, leftWhy({ kind: "unmoved", base: baseName, why: refused.why }));
        return;
      }
      outcome = { repo, base: baseName, from, to: tip, landed: [], left: [], checks: checks.map((c) => c.check.name) };
      for (const p of passed) {
        const cur = (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${p.e.branch}`], { read: true })).out.trim();
        this.set(p.e.id, { state: "landed", step: null, landed: p.at, owed: p.e.queued_by && this.store.session(p.e.queued_by) ? 1 : 0 });
        this.moves.delete(p.e.id);
        outcome.landed.push({ branch: p.e.branch, tip: p.tip, at: p.at, ...(cur && cur !== p.tip ? { moved: true as const } : {}) });
      }
      // Pushed after the base moved here: a remote never holds what this repository does not.
      if (rules.push) outcome.push = await this.push(repo, rules.push, base, tip, who);
      if (rules.after) outcome.after = await this.after(repo, base, tip, from, passed.map((p) => p.e.branch), batch, who, rules.timeoutMs);
      this.ov.schedule(repo, 0);
    } catch (e) {
      // A failure of the pass itself (git could not make the worktree): what was building waits for the next pass.
      for (const x of order) { const s = this.entry(x.id)?.state; if (s === "building" || s === "checking") this.set(x.id, { state: "queued", step: null, why: `the last pass failed: ${(e as Error).message.slice(0, 200)}` }); }
      throw e;
    } finally {
      if (made) await worktreeGit(repo, ["worktree", "remove", "--force", scratch], { ok: true });
      rmSync(scratch, { recursive: true, force: true });
      // What a pass that ended early left building waits for the next one.
      for (const x of order) { const s = this.entry(x.id)?.state; if (s === "building" || s === "checking") this.set(x.id, { state: "queued", step: null }); }
      finish(outcome, checks.map((c) => c.check.name));
    }
  }

  // The base moved under the pass: what passed is built again, unless it was too often.
  private moved(list: Entry[], base: string, batch: string, repo: string) {
    for (const e of list) {
      const k = (this.moves.get(e.id) ?? 0) + 1;
      if (k >= BASE_MOVES) { this.leave(e, leftWhy({ kind: "moving", base, times: k }), base, batch); continue; }
      this.moves.set(e.id, k);
      this.set(e.id, { state: "queued", step: null, built: null, why: `${base} moved during the check; built again` });
    }
    this.again.add(repo);
  }

  // ---- a conflict with the base, settled by the branch's own agent (src/landing/resolve.ts)

  // An entry the pass could not build: "agent" when its agent was sent a rebase task, "later" when it
  // waits for the entries ahead of it to land (it conflicts with them, not with the base), else "leave".
  private async conflicted(e: Entry, p: { sg: Sg; scratch: string; ident: Record<string, string>; base: string; baseName: string; from: string; bt: string; ahead: string[]; method: "rebase" | "merge"; checks: string[]; batch: string }): Promise<"agent" | "later" | "leave"> {
    if (!this.d.agents) return "leave";
    const to = this.d.agents.who(e);
    if (!to || e.tries >= TRIES) return "leave";
    if (p.ahead.length) {
      // With the base alone it merges: what it meets is an entry ahead. Once that lands it is the base's, and a rebase settles it.
      const alone = await p.sg(["merge-tree", "--write-tree", "--name-only", "--no-messages", p.from, p.bt]);
      if (alone.code === 0) {
        if (this.deferred.has(e.id)) return "leave";
        this.deferred.add(e.id);
        this.set(e.id, { state: "queued", step: null, built: null, why: `it conflicts with ${p.ahead.join(", ")}, ahead of it: built again once ${p.ahead.length === 1 ? "that lands" : "they land"}` });
        this.again.add(e.repo);
        return "later";
      }
    }
    const stop = await this.stopOf(p.sg, p.scratch, p.from, p.bt, p.ident);
    if (!stop) return "leave"; // (it rebases clean onto the base alone, and conflicts with what is ahead: it was deferred once already)
    this.track(this.task(e, to, stop, { base: p.base, baseName: p.baseName, from: p.from, tip: p.bt, method: p.method, checks: p.checks }));
    return "agent";
  }

  // An entry the forecast found conflicting when it was queued: its rebase is tried in a worktree of the
  // queue's own, and its agent gets the task; when it rebases clean after all, it waits for a pass.
  private async early(id: string) {
    const e = this.entry(id);
    if (!e || e.state !== "resolving" || e.agent) return;
    try {
      const to = this.d.agents?.who(e);
      const base = await this.baseOf(e.repo);
      const from = base ? (await git(e.repo, ["rev-parse", "-q", "--verify", base], { read: true })).out.trim() : "";
      const stop = to && base && from ? await this.probe(e.repo, from, e.tip) : undefined;
      if (!to || !base || !stop) { this.set(id, { state: "queued", step: null }); this.changedFor(e.repo); this.schedule(e.repo, 0); return; }
      const method = (await this.rulesOf(e.repo, base, from))?.rules.method ?? "rebase";
      await this.task(e, to, stop, { base, baseName: short(base), from, tip: e.tip, method, checks: await this.checkNames(e.repo, base, from) });
    } catch (x) {
      this.d.error(x, "landing rebase task");
      if (this.entry(id)?.state === "resolving" && !this.entry(id)?.agent) { this.set(id, { state: "queued", step: null }); this.schedule(e.repo, 0); }
    }
  }

  // Where a rebase of `bt` onto `onto` stops, tried in a worktree of the queue's own (removed after).
  private async probe(repo: string, onto: string, bt: string): Promise<Stop | undefined> {
    const dir = join(this.dir, createHash("sha256").update(repo).digest("hex").slice(0, 16), newId().replace(/^lq-/, "probe-"));
    mkdirSync(join(dir, ".."), { recursive: true });
    await worktreeGit(repo, ["worktree", "add", "-q", "--detach", dir, onto]);
    try {
      const sg: Sg = (args, env) => git(dir, args, { env: { ...NO_EDIT, ...env }, timeout: 300_000 });
      const ident = (await sg(["var", "GIT_COMMITTER_IDENT"])).code === 0 ? {} : KEEL_IDENT;
      return await this.stopOf(sg, dir, onto, bt, ident);
    } finally {
      await worktreeGit(repo, ["worktree", "remove", "--force", dir], { ok: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The commit a rebase of `bt` onto `onto` stops at, and each conflicted file with the base's lines
  // the conflict covers there. Undefined: it rebases clean. The rebase is the queue's own, in its own
  // worktree, and is given up after it is read.
  private async stopOf(sg: Sg, dir: string, onto: string, bt: string, ident: Record<string, string>): Promise<Stop | undefined> {
    await sg(["checkout", "-q", "--detach", "--force", onto]);
    await sg(["clean", "-q", "-fd"]);
    if ((await sg(["merge-base", "--is-ancestor", onto, bt])).code === 0) return undefined;
    const r = await sg(["-c", "merge.conflictStyle=diff3", "rebase", "-q", "--no-autostash", onto, bt], ident);
    if (r.code === 0) return undefined;
    try {
      const paths = (await sg(["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
      const at = (await sg(["rev-parse", "-q", "--verify", "REBASE_HEAD"])).out.trim();
      const commit = at ? { sha: at, subject: (await sg(["log", "-1", "--format=%s", at])).out.trim() } : undefined;
      const files: ConflictAt[] = paths.map((path) => {
        let text = "";
        try { if (statSync(join(dir, path)).size <= MAX_MARKED) text = readFileSync(join(dir, path), "utf8"); } catch {} // a removed file: no lines
        return { path, lines: baseLines(text) };
      });
      if (!paths.length && !/conflict/i.test(r.out + r.err)) throw new Error(`git rebase: ${tailOf(r.err || r.out, 3, 300)}`);
      return { ...(commit ? { commit } : {}), files };
    } finally {
      await sg(["rebase", "--abort"]);
    }
  }

  // Sends the entry's agent its rebase task (try `tries + 1`). The entry waits as resolving until the agent ends.
  private async task(e: Entry, to: Taker, stop: Stop, at: { base: string; baseName: string; from: string; tip: string; method: "rebase" | "merge"; checks: string[] }) {
    const tries = e.tries + 1;
    this.set(e.id, { state: "resolving", step: `its agent is being sent a rebase task onto ${at.baseName} (try ${tries} of ${TRIES})`, built: null, why: null, tries, agent: null, agent_task: null, sent_tip: at.tip, tip: at.tip });
    this.changedFor(e.repo);
    const baseSubject = (await git(e.repo, ["log", "-1", "--format=%s", at.from], { read: true })).out.trim();
    const inProgress = "agent" in to && !!e.holder && (await this.rebasingIn(e.holder));
    const text = rebaseTask({ branch: e.branch, tip: at.tip, base: at.baseName, baseTip: at.from, baseSubject, stop, try: tries, method: at.method, checks: at.checks, inProgress, fresh: "fresh" in to });
    let r: Awaited<ReturnType<AgentDeps["send"]>>;
    try { r = await this.d.agents!.send(this.entry(e.id) ?? e, to, text); } catch (x) { r = { why: (x as Error).message.slice(0, 300) }; }
    const now = this.entry(e.id);
    if (!now || now.state !== "resolving") return; // taken out meanwhile
    if ("why" in r) {
      this.leaveAlone(now, leftWhy({ kind: "conflict", base: at.baseName, at: at.from, files: stop.files.map((f) => f.path), ahead: [], agent: `its agent could not be given the rebase: ${r.why}` }), at.baseName);
      return;
    }
    this.set(e.id, { agent: r.agent, agent_task: r.task, holder: r.session, step: `its agent rebases it onto ${at.baseName} (try ${tries} of ${TRIES})` });
    this.changedFor(e.repo);
    // It ended before the record said who it was (a short turn): read it now.
    const st = this.d.agents!.state(r.agent);
    if (st?.ended && st.tasks >= r.task) this.track(this.agentEnded(r.agent));
  }

  // Whether a rebase or a merge is in progress in the worktree of a session's branch.
  private async rebasingIn(sessionId: string): Promise<boolean> {
    let path: string | undefined;
    try { path = this.store.db.query<{ path: string }, [string]>("SELECT path FROM worktrees WHERE session_id = ? ORDER BY updated DESC LIMIT 1").get(sessionId)?.path; } catch {} // no worktree was ever made
    if (!path || !existsSync(path)) return false;
    for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
      const p = (await git(path, ["rev-parse", "--git-path", name], { read: true })).out.trim();
      if (p && existsSync(isAbsolute(p) ? p : join(path, p))) return true;
    }
    return false;
  }

  // An agent's turn ended: an entry whose rebase task it had goes back in the queue, gets another
  // task, or goes to the session that started the agent (src/landing/resolve.ts afterTask).
  async agentEnded(agentId: string) {
    const rows = this.store.db.query<Entry, [string]>("SELECT * FROM landing_queue WHERE state = 'resolving' AND agent = ?").all(agentId);
    for (const e of rows) {
      if (this.deciding.has(e.id)) continue;
      const st = this.d.agents?.state(agentId);
      if (st && (!st.ended || st.tasks < (e.agent_task ?? 0))) continue;
      this.deciding.add(e.id);
      try { await this.decide(e, st); } finally { this.deciding.delete(e.id); }
    }
  }

  private async decide(e: Entry, st: ReturnType<AgentDeps["state"]>) {
    const base = await this.baseOf(e.repo);
    const baseName = base ? short(base) : "the base";
    const from = base ? (await git(e.repo, ["rev-parse", "-q", "--verify", base], { read: true })).out.trim() : "";
    const now = (await git(e.repo, ["rev-parse", "-q", "--verify", `refs/heads/${e.branch}^{commit}`], { read: true })).out.trim() || null;
    const merged = now && from ? await git(e.repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", from, now], { read: true }) : undefined;
    const merges = !merged ? null : merged.code === 0 ? true : merged.code === 1 ? false : null;
    const rebasing = e.holder ? await this.rebasingIn(e.holder) : false;
    const files = merged?.code === 1 ? merged.out.split("\n").slice(1).filter(Boolean) : [];
    const next = st
      ? afterTask({ status: st.status, report: st.report, before: e.sent_tip ?? e.tip, now, merges, rebasing, tries: e.tries })
      : { kind: "parent" as const, why: "its agent is gone" };
    if (this.entry(e.id)?.state !== "resolving") return; // taken out meanwhile
    if (next.kind === "queue") {
      this.set(e.id, { state: "queued", step: null, tip: now!, built: null, why: `its agent settled the conflict with ${baseName} (try ${e.tries} of ${TRIES}): built and checked again` });
      this.changedFor(e.repo);
      this.schedule(e.repo, 0);
      return;
    }
    if (next.kind === "again" && now && from && base) {
      const to = this.d.agents?.who(e);
      const stop = to ? await this.probe(e.repo, from, now) : undefined;
      if (to && stop) {
        await this.task({ ...e, tip: now }, to, stop, { base, baseName, from, tip: now, method: (await this.rulesOf(e.repo, base, from))?.rules.method ?? "rebase", checks: await this.checkNames(e.repo, base, from) });
        return;
      }
      if (!stop && to) { this.set(e.id, { state: "queued", step: null, tip: now, why: null }); this.changedFor(e.repo); this.schedule(e.repo, 0); return; }
    }
    this.leaveAlone(e, leftWhy({ kind: "conflict", base: baseName, at: from, files, ahead: [], agent: next.why }), baseName);
  }

  // An entry leaves outside a pass: in a batch of its own, whose outcome is owed as a pass's is.
  private leaveAlone(e: Entry, why: string, baseName: string) {
    const batch = newId().replace(/^lq-/, "lb-");
    this.leave(e, why, baseName, batch);
    this.finish(e.repo, baseName, batch, undefined, []);
    this.changedFor(e.repo);
  }

  private async checkNames(repo: string, base: string, from: string): Promise<string[]> {
    const r = await this.rulesOf(repo, base, from);
    const plan = r ? checksToRun(r.rules, r.named, homeDir()) : undefined;
    return plan && "run" in plan ? plan.run.map((c) => c.check.name) : [];
  }

  // Every check of an entry on its built tree, or why it leaves. The tree is
  // read before the first and after each: a check that wrote into the files it
  // checked passed on files the entry does not hold.
  private async checkAll(checks: ToRun[], scratch: string, e: Entry, who: string | null, repo: string, timeoutMs: number, at: string, where: { base: string; from: string; ahead: string[] }): Promise<{ why: string; log?: string } | undefined> {
    const at_ = repoOf(scratch);
    const look = async () => (at_ ? (await treeOf(at_))?.tree ?? null : null);
    const want = (await git(scratch, ["rev-parse", `${at}^{tree}`], { read: true })).out.trim();
    const before = await look();
    if (!before) return { why: "the queue could not read the tree it would check, so nothing is known to pass on it" };
    if (before !== want) return { why: `the files the checks would run on are not the commit that would land (${await this.changed(scratch)}): land.setup wrote files git does not ignore` };
    for (const c of checks) {
      this.set(e.id, { step: `${c.check.name}` });
      this.changedFor(repo);
      const res = await this.check(c, scratch, e, who, repo, timeoutMs, before);
      if (res.result !== "pass") return { why: leftWhy({ kind: "check", name: c.check.name, base: where.base, at: where.from, ahead: where.ahead, note: res.note, tail: res.tail }), ...(res.log ? { log: res.log } : {}) };
      const after = await look();
      if (after !== before) return { why: leftWhy({ kind: "wrote", name: c.check.name, files: (await this.changed(scratch, true)).split(", ").filter(Boolean) }), ...(res.log ? { log: res.log } : {}) };
    }
    return undefined;
  }
  // The files of the queue's worktree that differ from its commit, as a list in words.
  private async changed(scratch: string, bare = false): Promise<string> {
    const st = (await git(scratch, ["status", "--porcelain", "-z", "--untracked-files=all"], { read: true })).out.split("\0").filter(Boolean).map((l) => l.slice(3));
    const shown = st.slice(0, 6).join(", ") + (st.length > 6 ? ` (+${st.length - 6} more)` : "");
    return bare ? shown : shown || "files git does not list";
  }

  // Builds `branchTip` on `tip`: a fast-forward when it holds `tip`, else its
  // commits rebased onto it (or a merge commit). Its commits that `tip` holds
  // as patches are left out by the rebase.
  private async apply(sg: (args: string[], env?: Record<string, string>) => Promise<{ code: number; out: string; err: string }>, method: "rebase" | "merge", tip: string, branchTip: string, ident: Record<string, string>, branch: string): Promise<{ at: string } | { conflict: string[] }> {
    const ff = (await sg(["merge-base", "--is-ancestor", tip, branchTip])).code === 0;
    const head = async () => (await sg(["rev-parse", "HEAD"])).out.trim();
    if (ff) { await sg(["checkout", "-q", "--detach", "--force", branchTip]); return { at: await head() }; }
    const r = method === "merge"
      ? await sg(["-c", "merge.ff=false", "merge", "--no-ff", "--no-edit", "-q", "-m", `Merge branch '${branch}'`, branchTip], ident)
      : await sg(["rebase", "-q", "--no-autostash", tip, branchTip], ident);
    if (r.code === 0) return { at: await head() };
    const files = (await sg(["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
    await sg(method === "merge" ? ["merge", "--abort"] : ["rebase", "--abort"]);
    if (!files.length && !/conflict/i.test(r.out + r.err)) throw new Error(`git ${method}: ${tailOf(r.err || r.out, 3, 300)}`);
    return { conflict: files };
  }

  // The checkout that has `base` out, when one has.
  private async checkoutOf(repo: string, base: string): Promise<string | undefined> {
    const list = (await git(repo, ["worktree", "list", "--porcelain"], { read: true })).out;
    return list.split("\n\n").map((b) => ({ path: /^worktree (.+)$/m.exec(b)?.[1], branch: /^branch (.+)$/m.exec(b)?.[1] })).find((x) => x.branch === base && x.path)?.path;
  }

  // Moves the base from `from` to `to`, or says why not (`moved`: the base is
  // no longer `from`). A checkout that has the base out is moved only when it
  // holds no change of its own, staged or not, and is still at `from`; it then
  // fast-forwards (git also refuses where an untracked file there would be
  // overwritten). Else the ref moves only if it still is `from`.
  async moveBase(repo: string, base: string, from: string, to: string): Promise<{ why: string; moved?: true } | undefined> {
    const out = await this.checkoutOf(repo, base);
    if (out) {
      const st = (await git(out, ["status", "--porcelain", "-z", "--untracked-files=no"], { read: true })).out.split("\0").filter(Boolean);
      if (st.length) return { why: `the checkout at ${out} has ${short(base)} out and has uncommitted changes (${plural(st.length, "file")}: ${st.slice(0, 4).map((l) => l.slice(3)).join(", ")}); commit or set them aside there, then queue again` };
      const head = (await git(out, ["rev-parse", "-q", "--verify", "HEAD"], { read: true })).out.trim();
      if (head !== from) return { why: `${short(base)} moved`, moved: true };
      const r = await git(out, ["merge", "--ff-only", "-q", to], { env: NO_EDIT, timeout: 300_000 });
      return r.code === 0 ? undefined : (await git(repo, ["rev-parse", "-q", "--verify", base], { read: true })).out.trim() !== from ? { why: `${short(base)} moved`, moved: true } : { why: `git refused to fast-forward the checkout at ${out} (${tailOf(r.err || r.out, 2, 240)})` };
    }
    const r = await git(repo, ["update-ref", base, to, from]);
    if (r.code === 0) return undefined;
    return (await git(repo, ["rev-parse", "-q", "--verify", base], { read: true })).out.trim() !== from ? { why: `${short(base)} moved`, moved: true } : { why: `git update-ref: ${tailOf(r.err, 2, 240)}` };
  }

  // The push of the landed commit to the remote the repository names, for the session that queued it.
  private async push(repo: string, remote: string, base: string, tip: string, who: string | null): Promise<Push> {
    const no = this.d.mayPush(who);
    if (no) return { remote, skipped: no };
    const r = await git(repo, ["push", "--porcelain", remote, `${tip}:${base}`], { timeout: 300_000, fetch: "any" });
    return r.code === 0 ? { remote, ok: true } : { remote, ok: false, err: tailOf(r.err || r.out, 2, 240) };
  }

  // The after-land step: in the checkout that has the base out, now at the
  // landed commit; with none, in a worktree of the queue's own at that commit
  // (removed after). Never in a checkout that has another branch out.
  private async after(repo: string, base: string, tip: string, from: string, branches: string[], batch: string, who: string | null, timeoutMs: number): Promise<{ exit: number | null; log: string }> {
    const out = await this.checkoutOf(repo, base);
    const at = out && (await git(out, ["rev-parse", "-q", "--verify", "HEAD"], { read: true })).out.trim() === tip ? out : undefined;
    const own = at ? undefined : join(this.dir, createHash("sha256").update(repo).digest("hex").slice(0, 16), `${batch}-after`);
    try {
      if (own) await worktreeGit(repo, ["worktree", "add", "-q", "--detach", own, tip]);
      const a = await this.sh(this.store.db.query<{ after: string }, [string]>("SELECT after FROM landing_batches WHERE id = ?").get(batch)!.after, at ?? own!, `${batch}-after`, who, repo, timeoutMs, { KEEL_LANDED: tip, KEEL_LANDED_FROM: from, KEEL_LANDED_BRANCHES: branches.join(" ") });
      this.store.db.query("UPDATE landing_batches SET after_exit = ?, after_log = ? WHERE id = ?").run(a.exit ?? -1, a.log, batch);
      return { exit: a.exit, log: a.log };
    } finally {
      if (own) { await worktreeGit(repo, ["worktree", "remove", "--force", own], { ok: true }); rmSync(own, { recursive: true, force: true }); }
    }
  }

  // One named check on the queue's worktree: answered from the ledger when it
  // passed on this tree (and the same inputs), else run and recorded.
  private async check(c: ToRun, scratch: string, e: Entry, who: string | null, repo: string, timeoutMs: number, tree: string): Promise<{ result: "pass" | "fail"; note: string; tail: string; log?: string }> {
    const at = repoOf(scratch);
    const head = (await git(scratch, ["rev-parse", "-q", "--verify", "HEAD"], { read: true })).out.trim() || null;
    const inputs = inputsOf(scratch, c.check.inputs) ?? null;
    const key = keyOf(c.dir, c.command);
    const scope = at?.scope ?? repo;
    if (c.check.cache) {
      const runs = onTree(key, tree, inputs);
      const last = runs[0];
      if (last?.result === "pass" && !flakyOn(runs)) {
        const now = Date.now();
        record({ name: c.check.name, command: c.command, dir: c.dir, repo: scope, tree, head, session_id: who, by: "queue", result: "answered", exit: null, pass: last.pass, fail: last.fail, started: now, ended: now, log: last.log, from_run: last.id, inputs, top: scratch });
        return { result: "pass", note: "", tail: "" };
      }
    }
    const started = Date.now();
    const s = await this.sh(c.command, join(scratch, c.dir === "." ? "" : c.dir), `${e.id}-${c.check.name}`, who, repo, timeoutMs);
    const counts = countsOf(s.text);
    const result = s.exit === 0 ? "pass" : "fail";
    const run = record({ name: c.check.name, command: c.command, dir: c.dir, repo: scope, tree, head, session_id: who, by: "queue", result: s.exit === null ? "stopped" : result, exit: s.exit, pass: counts?.pass ?? null, fail: counts?.fail ?? null, started, ended: Date.now(), log: s.log, from_run: null, inputs, top: scratch, cpu_ms: s.cpu_ms });
    if (result === "pass") return { result, note: "", tail: "", log: s.log };
    let note = s.exit === null ? `stopped after ${limitSays(timeoutMs)}` : `exit ${s.exit}`;
    if (run && at) { const n = (await ledgerNote(run, at).catch(() => "")).replace(/^Check ledger: [^.]*\.\s*/, "").trim(); if (n) note += `; ${n.charAt(0).toLowerCase()}${n.slice(1).replace(/\.$/, "")}`; }
    return { result: "fail", note, tail: tailOf(s.text), log: s.log };
  }

  // A command of the repository's (setup, a check, the after step) in `cwd`,
  // its output to a log of its own, in a process group of its own: at the time
  // limit the whole group is killed (exit null), and so is one still running
  // when the daemon exits.
  private async sh(command: string, cwd: string, name: string, who: string | null, repo: string, timeoutMs: number, extra: Record<string, string> = {}): Promise<{ exit: number | null; text: string; log: string; cpu_ms?: number | null }> {
    const log = join(this.dir, "logs", `${name.replace(/[^\w.-]/g, "_")}.log`);
    mkdirSync(join(this.dir, "logs"), { recursive: true });
    const fd = openSync(log, "w");
    let pid = 0;
    try {
      writeSync(fd, `$ ${command}\n`);
      const argv = this.d.confine(["bash", "-c", command], who, cwd);
      const p = Bun.spawn(argv, { cwd, env: { ...tempEnv(this.d.env(who)), KEEL_LAND_REPO: repo, CI: "1", ...extra }, stdin: "ignore", stdout: fd, stderr: fd, detached: true });
      pid = p.pid;
      groups.add(pid);
      let late = false;
      const timer = setTimeout(() => { late = true; killGroup(pid); }, timeoutMs);
      const code = await p.exited;
      clearTimeout(timer);
      // What it left running in its group goes with it.
      killGroup(pid);
      // (Without the line that names the command, when the tail reaches back to it.)
      return { exit: late || p.signalCode ? null : code, text: readTail(log).replace(/^\$ [^\n]*\n/, ""), log, cpu_ms: cpuMsOf(p) };
    } catch (e) {
      writeSync(fd, `\n${(e as Error).message}\n`);
      return { exit: 127, text: (e as Error).message, log };
    } finally {
      if (pid) groups.delete(pid);
      closeSync(fd);
    }
  }

  private async dropScratch(repo: string) {
    const mine = join(this.dir, createHash("sha256").update(repo).digest("hex").slice(0, 16));
    if (!existsSync(mine)) return;
    const list = (await git(repo, ["worktree", "list", "--porcelain"], { read: true })).out;
    for (const m of list.matchAll(/^worktree (.+)$/gm)) if (m[1]!.startsWith(`${mine}/`)) await worktreeGit(repo, ["worktree", "remove", "--force", m[1]!], { ok: true });
    rmSync(mine, { recursive: true, force: true });
  }

  // ---- telling

  // The end of a pass: the batch's record, and its outcome owed to whoever
  // queued its entries (what left was told and owed when it left).
  private finish(repo: string, base: string, batch: string, outcome: Outcome | undefined, checks: string[]) {
    this.store.db.query(`INSERT INTO landing_batches (id, repo, base, from_sha, to_sha, checks, push, ended) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET push = excluded.push, ended = excluded.ended`)
      .run(batch, repo, base, outcome?.from ?? "", outcome?.to ?? null, JSON.stringify(outcome?.checks ?? checks), outcome?.push ? JSON.stringify(outcome.push) : null, Date.now());
    const owed = this.store.db.query<{ queued_by: string }, [string]>("SELECT DISTINCT queued_by FROM landing_queue WHERE batch = ? AND owed = 1 AND queued_by IS NOT NULL").all(batch);
    for (const r of owed) this.d.owed(r.queued_by);
  }

  // Who is told that a branch left: the session that holds it, or for an
  // agent's branch the session that started the agent (under the agent's id);
  // with no holder, the session that queued it.
  private rootOf(e: Entry): { session: string; ref?: { id: string; label?: string } } | undefined {
    const id = e.holder ?? e.queued_by;
    const s = id ? this.store.session(id) : undefined;
    if (!s) return undefined;
    if (!s.parent_id) return { session: s.id };
    let a: { id: string; title: string } | null = null;
    try { a = this.store.db.query<{ id: string; title: string }, [string]>("SELECT id, title FROM agents WHERE session_id = ?").get(s.id); } catch {} // no agents table
    return this.store.session(s.parent_id) ? { session: s.parent_id, ref: { id: a?.id ?? s.id.slice(-12), label: a?.title ?? s.title } } : { session: s.id };
  }

  // What `sessionId` is owed, as one note, and what storing it settles.
  // (`landed`, `left`: how many entries did, kept with the outcome: the entries themselves are pruned in time.)
  outcomeFor(sessionId: string): { text: string; entries: string[]; landed: number; left: number; settle: () => void } | undefined {
    const rows = this.store.db.query<Entry, [string]>("SELECT * FROM landing_queue WHERE queued_by = ? AND owed = 1 ORDER BY pos").all(sessionId);
    if (!rows.length) return undefined;
    const parts: string[] = [];
    const byBatch = new Map<string, Entry[]>();
    for (const r of rows) byBatch.set(r.batch ?? "", [...(byBatch.get(r.batch ?? "") ?? []), r]);
    type B = { base: string; from_sha: string; to_sha: string | null; checks: string; push: string | null; after: string | null; after_exit: number | null; after_log: string | null };
    for (const [batch, es] of byBatch) {
      const b = this.store.db.query<B, [string]>("SELECT * FROM landing_batches WHERE id = ?").get(batch);
      let push: Push | undefined;
      try { push = b?.push?.startsWith("{") ? JSON.parse(b.push) : undefined; } catch {}
      const o: Outcome = {
        repo: es[0]!.repo, base: b?.base ?? "the base", from: b?.from_sha ?? "", to: b?.to_sha ?? "", checks: b ? JSON.parse(b.checks) : [],
        landed: es.filter((e) => e.state === "landed").map((e) => ({ branch: e.branch, tip: e.tip, at: e.landed ?? "" })),
        left: es.filter((e) => e.state === "left").map((e) => ({ branch: e.branch, why: e.why ?? "", ...(e.log ? { log: e.log } : {}) })),
        ...(push ? { push } : {}),
        ...(b && b.after_exit === -2 ? { afterCut: true as const } : b && b.after_exit !== null ? { after: { exit: b.after_exit === -1 ? null : b.after_exit, log: b.after_log ?? "" } } : {}),
      };
      parts.push(outcomeText(o).replace(/^\[harness\] Landing queue:\n/, ""));
    }
    const ids = rows.map((r) => r.id);
    return {
      text: `[harness] Landing queue:\n${parts.join("\n")}`,
      entries: ids,
      landed: rows.filter((r) => r.state === "landed").length,
      left: rows.filter((r) => r.state === "left").length,
      settle: () => { for (const id of ids) this.store.db.query("UPDATE landing_queue SET owed = 0 WHERE id = ?").run(id); },
    };
  }
}

// The cause a failure is grouped by: what failed, never which branch.
function clsOf(why: string): string {
  if (why.startsWith("it conflicts")) return "conflict";
  const m = /^(\S+) (failed on it|changed the files)/.exec(why);
  if (m) return `${m[1]} ${m[2] === "failed on it" ? "failed" : "wrote files"}`;
  if (/^\S+ was not moved/.test(why)) return "base not moved";
  if (/^\S+ moved while/.test(why)) return "base kept moving";
  if (why.startsWith("the queue's setup")) return "setup failed";
  if (why.startsWith("the repository's landing rules")) return "rules";
  return "other";
}

// The last bytes of a log, read where they are (a long log is not read whole).
export function readTail(path: string, bytes = TAIL_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString("utf8");
  } catch { return ""; } finally { if (fd !== undefined) closeSync(fd); }
}
