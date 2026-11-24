// An agent's lane in five lines (src/automation/lane-line.ts says what each
// is): the facts read here, with no model request. What the loop holds is
// read from memory or one indexed row (its record, its session's state, its
// "now" line and running call, its failures, its plan, the check runs on its
// tree); what reads events or its hours goes to the read thread; its worktree
// is read with git, a few short commands. A lane is made when a view asks for
// it, never on a beat.
import { existsSync } from "node:fs";
import { git } from "../worktree/manager.ts";
import * as ledger from "../checks/ledger.ts";
import { agentState, agentWhy, stateWords } from "../core/state-words.ts";
import { toolKind } from "../core/tool-line.ts";
import { readsOf } from "../server/reads.ts";
import type { TreeHours } from "../admin/hours-rows.ts";
import { capture, D } from "./core.ts";
import * as agents from "./agents.ts";
import * as now from "./now.ts";
import { tasks } from "./goals.ts";
import { recordOf } from "./failures.ts";
import { OTHERS } from "./failure-groups.ts";
import type { AgentRecord } from "./agents.ts";
import { sessionState } from "./state.ts";
import { callWords } from "./now-line.ts";
import { LANE_LABEL, laneLines, type CheckFact, type GitFact, type Lane, type LaneFacts } from "./lane-line.ts";

export type { Lane };

const WRITES = new Set(["write", "edit", "patch", "notebook"]);
const NAMES_KEPT = 50;

// The newest failure in its scope, over every context of its task: of the agent itself in its
// parent's record, and of the agents below it, named.
export function failureOf(sessionIds: readonly string[], agentId: string): LaneFacts["failure"] {
  let best: LaneFacts["failure"] = null;
  for (const sid of sessionIds) for (const g of recordOf(D().store, sid)) {
    // A group below it: the agent of it that failed last is the one named.
    const ref = g.under ? g.refs.filter((r) => r.id !== agentId).sort((x, y) => (y.ts ?? 0) - (x.ts ?? 0))[0] : g.refs.find((r) => r.id === agentId);
    if (g.under && !ref) continue;
    const at = ref?.ts ?? g.last_ts;
    if (best && best.at >= at) continue;
    const below = g.under ? (ref!.id === OTHERS ? "of several" : ref!.label || ref!.id) : undefined;
    best = { kind: g.kind, cls: g.cls, text: ref?.eg ?? g.sample, at, count: ref?.n ?? g.count, ...(below ? { below } : {}) };
  }
  return best;
}

type WtRow = { repo_root: string; branch: string; base_commit: string; state: string };
// Its worktree's row: it goes with the work to a successor, so the newest context holds it (each a key read).
const rowOf = (sessionIds: readonly string[]): WtRow | undefined => {
  for (const sid of sessionIds) {
    const r = D().store.db.query<WtRow, [string]>("SELECT repo_root, branch, base_commit, state FROM worktrees WHERE session_id = ?").get(sid);
    if (r) return r;
  }
  return undefined;
};

// What its branch grew from with no row to say: the commit its parent's folder is on, else the
// repository's default branch, whichever it shares history with.
async function baseOf(run: (args: string[], cwd?: string) => Promise<string>, row: WtRow | undefined, parentFolder: string | undefined): Promise<string> {
  if (row?.base_commit) return (await run(["merge-base", "HEAD", row.base_commit])) || row.base_commit;
  const there = parentFolder && existsSync(parentFolder) ? await run(["rev-parse", "HEAD"], parentFolder) : "";
  for (const c of [there, "origin/HEAD", "main", "master"].filter(Boolean)) {
    const b = await run(["merge-base", "HEAD", c]);
    if (b) return b;
  }
  return "";
}

// Its worktree: the branch, its head, and every file it carries over its base, uncommitted ones included.
// One on another machine is not read from here; one that was removed says so, with its branch.
export async function gitOf(a: Pick<AgentRecord, "worktree" | "branch" | "machine" | "session_id" | "lost">, parentFolder?: string): Promise<GitFact> {
  const folder = a.worktree!;
  if (a.machine) return { remote: a.machine, branch: a.branch ?? null };
  try {
    const row = rowOf(agents.taskSessions(a));
    const run = (args: string[], cwd = folder) => git(cwd, args, { ok: true }).then((s) => s.trim());
    if (row?.state === "removed" || !existsSync(folder)) {
      const branch = row?.branch ?? a.branch ?? null;
      const repo = row?.repo_root ?? parentFolder;
      const head = branch && repo && existsSync(repo) ? (await run(["rev-parse", "--short", "-q", "--verify", `refs/heads/${branch}^{commit}`], repo)) || null : null;
      return { gone: true, branch, head };
    }
    const [branch, log] = await Promise.all([run(["rev-parse", "--abbrev-ref", "HEAD"]), run(["log", "-1", "--format=%h%x00%s"])]);
    if (!log) return { why: "it has no commit to read" };
    const [head = "", subject = ""] = log.split("\0");
    const base = await baseOf(run, row, parentFolder);
    const [commits, numstat, untracked, status] = await Promise.all([
      base ? run(["rev-list", "--count", `${base}..HEAD`]) : Promise.resolve("0"),
      run(["diff", "--numstat", "--no-renames", base || "HEAD"]),
      run(["ls-files", "--others", "--exclude-standard"]),
      run(["status", "--porcelain", "--untracked-files=all"]),
    ]);
    const names: string[] = [];
    let added = 0, removed = 0, files = 0;
    for (const l of numstat.split("\n").filter(Boolean)) {
      const [x, r, ...p] = l.split("\t");
      files++;
      added += Number(x) || 0;
      removed += Number(r) || 0;
      if (names.length < NAMES_KEPT) names.push(p.join("\t"));
    }
    for (const p of untracked.split("\n").filter(Boolean)) { files++; if (names.length < NAMES_KEPT) names.push(p); }
    const dirty = status.split("\n").filter(Boolean).length;
    return { branch: branch && branch !== "HEAD" ? branch : null, head, subject, commits: Number(commits) || 0, files, dirty, added, removed, names };
  } catch (e) {
    return { why: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
  }
}

type CallRow = { seq: number; id: string | null; name: string | null; input: string | null };
// What one context's calls wrote, read up to its last event: a later read takes only the events after
// it. `calls`: each write call's id and the paths it names; `bad`: the calls whose result failed.
type Wrote = { last: number; calls: { id: string | null; paths: string[] }[]; bad: Set<string> };
const wroteKept = new Map<string, Wrote>();
// Contexts kept: the agents a page shows at once, with room; the oldest read goes first.
const WROTE_KEPT = 200;

function pathsOf(c: CallRow, cwd: string): string[] {
  let input: any = {};
  try { input = c.input ? JSON.parse(c.input) : {}; } catch {}
  const paths: string[] = typeof input.file_path === "string" ? [input.file_path] : typeof input.notebook_path === "string" ? [input.notebook_path] : [];
  // A patch names its files in its own lines.
  const patch = typeof input.input === "string" ? input.input : typeof input.patch === "string" ? input.patch : "";
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(m[1]!.trim());
  return paths.map((p) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p));
}

// The files one context's own calls wrote since its task began: events past `fromSeq`, at or after `fromTs`.
async function wroteIn(sessionId: string, fromSeq: number, fromTs: number, cwd: string): Promise<Wrote> {
  const key = `${sessionId}:${fromSeq}:${fromTs}`;
  const had = wroteKept.get(key);
  const last = D().store.lastSeq(sessionId);
  if (had && had.last >= last) return had;
  const after = Math.max(fromSeq, had?.last ?? 0);
  const reads = readsOf(D().store);
  const [calls, failed] = await Promise.all([
    reads.sql<CallRow>(`SELECT e.seq AS seq, b.value ->> '$.id' AS id, b.value ->> '$.name' AS name, b.value -> '$.input' AS input FROM events e, json_each(e.data, '$.blocks') b
      WHERE e.session_id = ? AND e.seq > ? AND e.seq <= ? AND e.ts >= ? AND e.kind = 'assistant' AND b.value ->> '$.type' = 'tool_use'`, [sessionId, after, last, fromTs]),
    // The results that failed, and those of calls that ran under another name than the model wrote.
    reads.sql<{ id: string; as: string | null; bad: number | null }>(`SELECT b.value ->> '$.tool_use_id' AS id, b.value ->> '$.resolved_as' AS "as", b.value ->> '$.is_error' AS bad FROM events e, json_each(e.data, '$.results') b
      WHERE e.session_id = ? AND e.seq > ? AND e.seq <= ? AND e.ts >= ? AND e.kind = 'tool_result' AND (b.value ->> '$.is_error' = 1 OR b.value ->> '$.resolved_as' IS NOT NULL)`, [sessionId, after, last, fromTs]),
  ]);
  const out: Wrote = { last, calls: [...(had?.calls ?? [])], bad: new Set(had?.bad ?? []) };
  const ranAsName = new Map(failed.flatMap((f) => (f.id && f.as ? [[f.id, f.as] as const] : [])));
  for (const c of calls) { const name = (c.id && ranAsName.get(c.id)) || c.name; if (name && WRITES.has(toolKind(name))) out.calls.push({ id: c.id, paths: pathsOf(c, cwd) }); }
  for (const f of failed) if (f.id && f.bad) out.bad.add(f.id);
  wroteKept.delete(key);
  wroteKept.set(key, out);
  if (wroteKept.size > WROTE_KEPT) wroteKept.delete(wroteKept.keys().next().value!);
  return out;
}

// The contexts of its task, the newest first, each with where its task's events begin: the one it
// works in from its first event, a lost one from when the task began.
export type Ctx = { id: string; fromSeq: number; fromTs: number };
export const contextsOf = (a: Pick<AgentRecord, "session_id" | "first_seq" | "lost">, from: number): Ctx[] =>
  [{ id: a.session_id, fromSeq: a.first_seq, fromTs: 0 }, ...(a.lost ?? []).map((l) => ({ id: l.session, fromSeq: 0, fromTs: from })).reverse()];

// The files its own calls wrote over every context of its task (an agent with no worktree of its own:
// what changed in the shared folder is not all its own). A call that failed wrote nothing.
export async function wroteOf(ctx: Ctx[], cwd: string): Promise<LaneFacts["wrote"]> {
  const seen = new Set<string>();
  for (const w of await Promise.all(ctx.map((c) => wroteIn(c.id, c.fromSeq, c.fromTs, cwd)))) {
    for (const c of w.calls) if (!(c.id && w.bad.has(c.id))) for (const p of c.paths) seen.add(p);
  }
  return { names: [...seen].slice(0, NAMES_KEPT), n: seen.size };
}

// Its newest words of its own: the text of its latest replies, the newest first.
// Over its contexts, the newest first: a successor that has said nothing yet speaks with the words of the one it took over from.
export async function wordsOf(ctx: Ctx[]): Promise<string | null> {
  for (const c of ctx) {
    const rows = await readsOf(D().store).sql<{ t: string | null }>(`SELECT (SELECT group_concat(b.value ->> '$.text', '\n') FROM json_each(e.data, '$.blocks') b WHERE b.value ->> '$.type' = 'text') AS t
      FROM events e WHERE e.session_id = ? AND e.seq > ? AND e.ts >= ? AND e.kind = 'assistant' ORDER BY e.seq DESC LIMIT 6`, [c.id, c.fromSeq, c.fromTs]);
    const t = rows.find((r) => r.t?.trim())?.t;
    if (t) return t;
  }
  return null;
}

// Its plan: the newest context's that has one (a successor's own once it writes one).
export function planOf(ctx: Ctx[]): LaneFacts["plan"] {
  for (const c of ctx) {
    const plan = tasks(c.id).filter((t) => t.by === "model").map((t) => ({ text: t.text, status: t.status }));
    if (plan.length) return plan;
  }
  return [];
}

// The runs of the repository's named checks on the tree of its folder as it is now, and its own on earlier trees.
// Its own runs are of every context of its task. A folder that is gone has no tree now: its runs are all earlier.
export async function checksOf(folder: string, sessionIds: readonly string[], since: number): Promise<LaneFacts["checks"]> {
  const fact = (r: { name: string; result: string; pass: number | null; fail: number | null; ended: number }): CheckFact => ({ name: r.name, result: r.result, pass: r.pass, fail: r.fail, ended: r.ended });
  const own = sessionIds.flatMap((sid) => ledger.ofSession(sid, since, 100));
  if (!existsSync(folder)) return own.length ? { tree: [], earlier: own.map(fact) } : null;
  const repo = ledger.repoOf(folder);
  if (!repo || !ledger.namedFor(repo)) return null;
  const look = await ledger.treeOf(repo);
  const tree = look?.tree ? ledger.ofTree(look.tree).map(fact) : [];
  return { tree, earlier: own.filter((r) => r.tree !== look?.tree).map(fact) };
}

export async function laneOf(agentId: string, at = Date.now()): Promise<Lane | undefined> {
  const t0 = performance.now();
  const a = agents.get(agentId);
  if (!a) return undefined;
  const { store } = D();
  const s = store.session(a.session_id);
  if (!s) return undefined;
  const live = !agents.isEnded(a);
  const told = sessionState(s);
  const said = stateWords(agentState(a, told));
  const from = a.task_at ?? a.created;
  const used = agents.usedOf(a, a.ended ?? at);
  const call = live ? now.callOf(a.session_id) : undefined;
  const line = live ? now.freshLineOf(a.session_id, at) : null;
  const folder = a.worktree ?? s.workspace;
  const ctx = contextsOf(a, from);
  const sessions = ctx.map((c) => c.id);
  const parentFolder = store.session(a.parent_id)?.workspace;
  const safe = <T,>(what: string, p: Promise<T>, none: T): Promise<T> => p.catch((e) => { capture(e, { at: `agent lane: ${what}`, session: a.session_id }); return none; });
  // (Its hours are said once it ended: read only then.)
  const [hours, wrote, words, own] = await Promise.all([
    live ? Promise.resolve(null) : safe("hours", readsOf(store).run("hours.tree", { session: a.session_id, now: at }) as Promise<TreeHours | null>, null),
    a.worktree || s.machine ? Promise.resolve(undefined) : safe("files", wroteOf(ctx, s.workspace), null),
    safe("words", wordsOf(ctx), null),
    a.worktree ? gitOf(a, parentFolder) : Promise.resolve(null),
  ]);
  // Checks are read for a tree it changed: its worktree's, or the shared folder's when it wrote there.
  const checks = !s.machine && !a.machine && (a.worktree || wrote?.n) ? await safe("checks", checksOf(folder, sessions, from), null) : null;
  const plan = planOf(ctx);
  const facts: LaneFacts = {
    now: at, live, said,
    state: told ? { watch: told.watch, why: told.why, text: told.text, since: told.since, until: told.until } : null,
    doing: line ? { text: line.text, from: line.from, steps: line.steps, since: line.since } : null,
    ended: live ? null : { at: a.ended ?? at, steps: used.steps, why: agentWhy(a) },
    lost: a.lost?.length ?? 0,
    call: call ? { line: callWords(call.name, call.input, s.workspace), shell: toolKind(call.name) === "shell", since: call.at } : null,
    waitsOn: live ? agents.waitsOn(a, { marked: true }) : "",
    slot: !!a.slot_wait,
    failure: failureOf(sessions, a.id),
    hours: hours ? { wall_ms: hours.wall_ms, classes: hours.classes } : null,
    worktree: !!a.worktree,
    git: own,
    ...(wrote !== undefined ? { wrote } : {}),
    checks,
    plan,
    words,
  };
  return { agent_id: a.id, session_id: a.session_id, at, ms: Math.round((performance.now() - t0) * 10) / 10, lines: laneLines(facts).map((l) => ({ ...l, label: LANE_LABEL[l.key] })) };
}
