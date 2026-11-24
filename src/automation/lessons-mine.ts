// The lessons miner (src/automation/lessons.ts proposes from it): a failure
// cause that recurs across a repository's agent trees, read from the tables
// that already hold failures, with nothing written. Runs on the read thread
// (src/server/read-tasks.ts), so it imports nothing of the daemon.
//
// Three sources, each a class key that stays the same between reads:
// - tool: a failed tool call in the tool ledger (telemetry_tools), by the
//   tool and its error's first lines with what varies between repeats
//   folded (ids, hex, paths, numbers).
// - failure: a cause of the session failure table (session_failures) that is
//   not a tool call's (those are the ledger's) and not the provider's or a
//   message's (an outage or a gone session is nothing an agent does), by its
//   fingerprint.
// - review: a reviewer's finding (the review panel's findings, a verdict that
//   refused a commit), by its words: findings that share most of their
//   content words are one class, keyed by the oldest of them.
//
// A unit is an agent tree: an agent a top-level session started, with the
// agents under it, or a top-level session's own work. That is the unit a
// lesson's trial draws (src/admin/experiments.ts, unit "agent"), and why the
// count is of trees, not sessions: one tree's agents share their task, and a
// cause they repeat is told to that tree already (src/automation/failures.ts).
import type { Database } from "bun:sqlite";
import { homeDir } from "../core/paths.ts";
import { basename } from "node:path";
import { keyShaped } from "../core/conceal.ts";
import { repoRoot } from "../core/repo-root.ts";

export type Source = "tool" | "failure" | "review";
// One failure of a class in one session: `n` of them (a failure row counts several). `example`: the
// failure's text as recorded (mineFrom makes the candidate's examples of it).
export type Hit = { source: Source; key: string; label: string; example: string; session: string; ts: number; n: number; words?: string[] };
export type SessionRow = { id: string; parent_id: string | null; workspace: string; machine: string | null; repo_root: string | null };
export type Evidence = { session: string; tree: string; n: number; ts: number };
export type Candidate = {
  key: string; source: Source; label: string; repo: string; repo_name: string;
  failures: number; sessions: number; trees: number; first_ts: number; last_ts: number;
  examples: string[]; words?: string[]; evidence: Evidence[];
  // What a trial of it needs (trialOf): the repository's trees in the window and a day, the share of
  // them the class failed in, the trees an arm needs and the days the repository takes to start them.
  // Absent when the repository's trees could not be counted.
  repo_trees?: number; trees_a_day?: number; rate?: number; per_arm?: number; trial_days?: number;
};

// A cause in three trees is a pattern of the repository's work: one tree's
// repeats are told to it already, and two trees can share one cause through
// one shared change (two agents of one lane, or a builder and its reviewer).
export const TREES = 3;
// Read over the last two weeks: a cause that has not failed since is likely
// fixed, and a lane's working cycle fits in it.
export const DAYS = 14;
// What a candidate carries to the owner's card and the drafting model.
export const EXAMPLES = 3;
export const EVIDENCE = 12;
const LINES = 3;
const EXAMPLE_CHARS = 240;
// Rows read of each source: the newest first. A store with more failures
// than this in the window is read in its newest part.
const ROWS = 50_000;

// ---- class keys ----

const firstLines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, LINES);
const SHAPE_CHARS = 200;
// The first lines with what varies between repeats folded: ids, hex, paths, quoted text, numbers. The
// ledger cuts a line at a length that depends on the path in it, so a line that goes on past its first
// sentence is that sentence (with how a command ended, when it says). The ledger keeps a shell failure as
// the line that names its cause with how it ended (src/admin/reason.ts), so for a command that is the cause.
export function errorShape(text: string): string {
  let t = firstLines(text).join("\n");
  const end = /^.{12,}?[.!?](?=\s+\S)/s.exec(t);
  const how = /\(exit code -?\d+\)$/.exec(t)?.[0];
  if (end) t = how ? `${end[0]} ${how}` : end[0];
  return t
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[a-z]+_[A-Za-z0-9]{10,}\b/g, "<id>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/(?:[\w.~@-]*\/)+[\w.~@%+-]*/g, "<path>")
    .replace(/"[^"\n]{0,200}"|'[^'\n]{0,200}'|`[^`\n]{0,200}`/g, "<q>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .slice(0, SHAPE_CHARS);
}
// How a command ended, which names no cause: a grep with no match exits 1 every time, and works.
const ENDED = /\(?exit code <n>\)?|killed by \w+|signal: \w+|interrupted|stopped/gi;
// A command its time limit ended (timeout's status): a cause of its own, with no words.
const TIME_LIMIT = /\bexit code 124\b|\btimed? ?out\b/i;
// The class of a failed call's ledger line, or null when it names no cause: at least two words besides how it
// ended (the same test as the guards' remedy classes), or a time limit.
export function toolClass(error: string): string | null {
  const shape = errorShape(error);
  if ((shape.replace(ENDED, " ").match(/[A-Za-z]{3,}/g) ?? []).length >= 2) return shape;
  return TIME_LIMIT.test(error) ? "the command reached its time limit" : null;
}
const hash = (s: string) => Bun.hash(s).toString(36);
export const toolKey = (tool: string, cls: string) => `tool:${tool}:${hash(`${tool}\0${cls}`)}`;
export const failureKey = (fp: string) => `failure:${fp}`;

// A failure's text as one line for the owner and the drafting model: anything shaped like a key hidden
// (the vault's own values are hidden where a prompt is made, src/automation/lesson-draft.ts), and the
// paths of the machine folded (foldPaths).
export function exampleOf(text: string, repo: string | null = null, home = homeDir()): string {
  const line = foldPaths(keyShaped(firstLines(text).join(" / ")), repo, home).replace(/[\p{Cc}\u2028\u2029]+/gu, " ");
  return line.length > EXAMPLE_CHARS ? `${line.slice(0, EXAMPLE_CHARS - 1)}…` : line;
}
// The folders of the machine out of a failure's words: the repository's own as a relative path, a
// worktree's (Keel's, or a repository's `<name>.worktrees/` beside it) as <worktree>, the home folder
// as ~. What a cause is about stays (the file under them); whose machine it is does not.
const WORKTREE = /(?:\/[^\s"'`:()<>]*)?\/(?:worktrees|[\w.-]+\.worktrees)\/[\w.-]+/g;
const escaped = (s: string) => s.replace(/[.*+?^$|()[\]{}\\]/g, "\\$&");
// A folder named whole: at the end of a path, never the start of a longer name.
const folder = (dir: string) => new RegExp(`${escaped(dir)}(?=/|(?![\\w.-]))`, "g");
export function foldPaths(text: string, repo: string | null, home: string): string {
  let t = text.replace(WORKTREE, "<worktree>");
  if (repo && repo !== "/") t = t.split(`${repo}/`).join("./").replace(folder(repo), ".");
  if (home && home !== "/") t = t.replace(folder(home), "~");
  return t;
}
// Every path out of a text, for words that stand without one (a plain draft).
export const noPaths = (text: string) => text.replace(/(?:[\w.~@<>-]*\/)+[\w.~@%+-]*/g, "<path>");

// ---- review findings by their words ----

// Words that say nothing of what a finding is about.
const STOP = new Set(("a an and are as at be been but by can could did do does for from has have in into is it its may might no not of on or "
  + "so than that the their then there these this those to was were what when where which while who why will with would should must "
  + "also only just more most any all each one two other own same such very here now after before about over under out up down "
  + "change changes changed commit file files line lines code still yet make makes made use uses used").split(" "));
const stem = (w: string) => w.replace(/(?:ing|ed|es|s)$/, "");
// A finding's content words, stemmed, once each, sorted.
export function wordsOf(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    const w = stem(raw);
    if (w.length >= 3) out.add(w);
  }
  return [...out].sort();
}
// Two findings are one class when they share at least three content words and
// those are most of the shorter one's: a short finding inside a long one is
// the same finding said with more context.
export function similar(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  const shared = b.filter((w) => set.has(w)).length;
  return shared >= 3 && shared / Math.min(a.length, b.length) >= 0.6;
}
// Findings oldest first, each joined to the first class whose seed it is like,
// else the seed of a new one. A class keeps its key while newer findings join.
export function clusterFindings<T extends { ts: number; words: string[] }>(items: T[]): (T & { seed: string[] })[] {
  const seeds: string[][] = [];
  return [...items].sort((x, y) => x.ts - y.ts).map((it) => {
    let seed = seeds.find((s) => similar(s, it.words));
    if (!seed) seeds.push((seed = it.words));
    return { ...it, seed };
  });
}
export const reviewKey = (seed: readonly string[]) => `review:${hash(seed.join(" "))}`;

// ---- reading ----

const tried = <T>(f: () => T[]): T[] => { try { return f(); } catch { return []; } };
const json = (s: string | null) => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };

// Every failure of the three sources since `since`, as hits.
export function hitsOf(db: Database, since: number): Hit[] {
  const out: Hit[] = [];
  for (const r of tried(() => db.query<{ session_id: string; ts: number; tool: string; error: string | null }, [number, number]>(
    "SELECT session_id, ts, tool, error FROM telemetry_tools WHERE is_error = 1 AND ts >= ? ORDER BY ts DESC LIMIT ?").all(since, ROWS))) {
    const error = r.error ?? "";
    const cls = toolClass(error);
    if (cls) out.push({ source: "tool", key: toolKey(r.tool, cls), label: r.tool, example: error, session: r.session_id, ts: r.ts, n: 1 });
  }
  const agentSession = new Map<string, string>();
  const sessionOfAgent = (id: string) => {
    if (!agentSession.has(id)) agentSession.set(id, tried(() => db.query<{ session_id: string }, [string]>("SELECT session_id FROM agents WHERE id = ?").all(id))[0]?.session_id ?? "");
    return agentSession.get(id) || undefined;
  };
  for (const r of tried(() => db.query<{ session_id: string; fp: string; kind: string; cls: string; sample: string; count: number; last_ts: number; refs: string }, [number, number]>(
    "SELECT session_id, fp, kind, cls, sample, count, last_ts, refs FROM session_failures WHERE last_ts >= ? AND kind NOT IN ('tool', 'provider', 'message') ORDER BY last_ts DESC LIMIT ?").all(since, ROWS))) {
    const base = { source: "failure" as const, key: failureKey(r.fp), label: `${r.kind} ${r.cls}`, example: r.sample };
    const refs = (json(r.refs) ?? []) as { id: string; n?: number; ts?: number }[];
    let named = 0;
    for (const ref of refs) {
      const n = ref.n ?? 0;
      if (n <= 0) continue;
      // An agent's failures are its own session's; the session's own (and the ones past the named agents) its row's.
      const session = ref.id === "self" || ref.id === "others" ? r.session_id : sessionOfAgent(ref.id) ?? r.session_id;
      out.push({ ...base, session, ts: ref.ts ?? r.last_ts, n });
      named += n;
    }
    if (named < r.count) out.push({ ...base, session: r.session_id, ts: r.last_ts, n: r.count - named });
  }
  const findings = findingsOf(db, since);
  // A finding a small model put in a kind is of that kind's class; the rest are classed by their words.
  for (const f of findings) if (f.kind) out.push({ source: "review", key: kindKey(f.kind), label: f.kind, example: f.text, session: f.session, ts: f.ts, n: 1 });
  for (const f of clusterFindings(findings.filter((f) => !f.kind && f.words.length >= 3))) {
    out.push({ source: "review", key: reviewKey(f.seed), label: f.seed.join(" "), example: f.text, session: f.session, ts: f.ts, n: 1, words: f.seed });
  }
  return out;
}

// A refusing verdict or a finding as the kinds table keys it: who judged it and what.
export const verdictRef = (agentId: string, commit: string) => `v:${agentId}:${commit}`;
export const findingRef = (reviewId: string, findingId: number | string) => `r:${reviewId}:${findingId}`;
export const kindKey = (kind: string) => `review:kind:${hash(kind)}`;
// The findings no kind was asked for yet, oldest first (src/automation/lessons.ts asks the small model).
export function untagged(db: Database, since: number, max: number): { ref: string; session: string; text: string }[] {
  return findingsOf(db, since).filter((f) => f.kind === undefined).sort((a, b) => a.ts - b.ts).slice(0, max).map((f) => ({ ref: f.ref, session: f.judge, text: f.text }));
}

// The review findings and refusing verdicts from `since` (to `until`), each in the session of the work it judged.
// A reviewer may quote what it found, a leaked key too: the words are read with anything key-shaped hidden.
// `kind`: the kind a small model gave it (null: none of the kinds), undefined while it was not asked.
// `judge`: the session of whoever judged it.
type Finding = { ref: string; session: string; judge: string; ts: number; text: string; words: string[]; kind?: string | null };
function findingsOf(db: Database, since: number, until = Number.MAX_SAFE_INTEGER): Finding[] {
  const kinds = new Map<string, string | null>();
  for (const r of tried(() => db.query<{ ref: string; kind: string | null }, [number]>("SELECT ref, kind FROM lesson_kinds WHERE ts >= ?").all(since - 86_400_000))) kinds.set(r.ref, r.kind);
  const kindOf = (ref: string) => (kinds.has(ref) ? kinds.get(ref) ?? null : undefined);
  const sessionOfAgent = (id: string) => tried(() => db.query<{ session_id: string }, [string]>("SELECT session_id FROM agents WHERE id = ?").all(id))[0]?.session_id;
  const findings: Finding[] = [];
  // A verdict that refused a commit belongs to the tree whose branch it judged.
  const branchSession = (branches: string | null) => {
    for (const b of (json(branches) ?? []) as string[]) {
      const s = tried(() => db.query<{ session_id: string }, [string]>("SELECT session_id FROM agents WHERE branch = ? ORDER BY created DESC LIMIT 1").all(b))[0]?.session_id;
      if (s) return s;
    }
    return undefined;
  };
  for (const v of tried(() => db.query<{ agent_id: string; commit_sha: string; session_id: string; branches: string; why: string; at: number }, [number, number, number]>(
    "SELECT v.agent_id, v.commit_sha, a.session_id, v.branches, v.why, v.at FROM review_verdicts v JOIN agents a ON a.id = v.agent_id WHERE v.land = 'no' AND v.at >= ? AND v.at <= ? ORDER BY v.at DESC LIMIT ?").all(since, until, ROWS))) {
    const ref = verdictRef(v.agent_id, v.commit_sha);
    const why = keyShaped(v.why);
    findings.push({ ref, session: branchSession(v.branches) ?? v.session_id, judge: v.session_id, ts: v.at, text: why, words: wordsOf(why), kind: kindOf(ref) });
  }
  for (const r of tried(() => db.query<{ id: string; session_id: string; data: string; created: number }, [number, number, number]>(
    "SELECT id, session_id, data, created FROM reviews WHERE state = 'done' AND created >= ? AND created <= ? ORDER BY created DESC LIMIT ?").all(since, until, ROWS))) {
    const d = json(r.data) as { agent_id?: string; findings?: { id?: number; title?: string; body?: string; state?: string }[] } | undefined;
    const session = (d?.agent_id && sessionOfAgent(d.agent_id)) || r.session_id;
    for (const [i, f] of (d?.findings ?? []).entries()) {
      // A finding the owner dismissed was not a failure.
      if (!f.title || f.state === "dismissed") continue;
      const ref = findingRef(r.id, f.id ?? i);
      const title = keyShaped(f.title);
      findings.push({ ref, session, judge: r.session_id, ts: r.created, text: keyShaped(f.body ? `${f.title}: ${f.body}` : f.title), words: wordsOf(title), kind: kindOf(ref) });
    }
  }
  return findings;
}

// The sessions the hits name and every session above them, with the repository a managed worktree was made of.
export function sessionsOf(db: Database, ids: Iterable<string>): Map<string, SessionRow> {
  const out = new Map<string, SessionRow>();
  const worktrees = !!tried(() => db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worktrees'").all()).length;
  const q = db.query<SessionRow, [string]>(`SELECT s.id, s.parent_id, s.workspace, s.machine, ${worktrees ? "(SELECT repo_root FROM worktrees w WHERE w.session_id = s.id)" : "NULL"} AS repo_root FROM sessions s WHERE s.id = ?`);
  const todo = [...new Set(ids)];
  while (todo.length) {
    const id = todo.pop()!;
    if (out.has(id)) continue;
    const r = q.get(id);
    if (!r) continue;
    out.set(id, r);
    if (r.parent_id && !out.has(r.parent_id)) todo.push(r.parent_id);
  }
  return out;
}

// The agent tree a session is in: the agent under its top-level session, or the top-level session itself.
export function treeOf(sessions: ReadonlyMap<string, Pick<SessionRow, "id" | "parent_id">>, id: string): string {
  let at = id;
  for (let i = 0; i < 64; i++) {
    const p = sessions.get(at)?.parent_id;
    if (!p || !sessions.get(p)?.parent_id) return at;
    at = p;
  }
  return at;
}

// The repository a session worked in: its worktree's (or the one it was started from), else its folder's.
export function repoOfSession(sessions: ReadonlyMap<string, SessionRow>, id: string, root: (dir: string) => string | null): string | null {
  for (let at: string | null | undefined = id, i = 0; at && i < 64; at = sessions.get(at)?.parent_id, i++) {
    const s = sessions.get(at);
    if (!s) return null;
    if (s.machine) return null;
    if (s.repo_root) return s.repo_root;
    const r = root(s.workspace);
    if (r) return r;
  }
  return null;
}

// The hits grouped into classes per repository, those in `trees` agent trees or more, the most trees first.
// `census`: each repository's trees in the window and a day (treesOf), which say what a trial of a class needs.
export function mineFrom(hits: Hit[], sessions: ReadonlyMap<string, SessionRow>, root: (dir: string) => string | null, trees = TREES, census?: ReadonlyMap<string, Census>): Candidate[] {
  const repoCache = new Map<string, string | null>();
  const repoOf = (id: string) => {
    if (!repoCache.has(id)) repoCache.set(id, repoOfSession(sessions, id, root));
    return repoCache.get(id)!;
  };
  const groups = new Map<string, { c: Candidate; ses: Set<string>; trs: Map<string, Evidence> }>();
  for (const h of hits) {
    const repo = repoOf(h.session);
    if (!repo) continue;
    const id = `${repo}\0${h.key}`;
    let g = groups.get(id);
    if (!g) {
      g = { c: { key: h.key, source: h.source, label: h.label, repo, repo_name: basename(repo), failures: 0, sessions: 0, trees: 0, first_ts: h.ts, last_ts: h.ts, examples: [], ...(h.words ? { words: h.words } : {}), evidence: [] }, ses: new Set(), trs: new Map() };
      groups.set(id, g);
    }
    const c = g.c;
    c.failures += h.n;
    c.first_ts = Math.min(c.first_ts, h.ts);
    c.last_ts = Math.max(c.last_ts, h.ts);
    if (h.example && c.examples.length < EXAMPLES) { const eg = exampleOf(h.example, repo); if (!c.examples.includes(eg)) c.examples.push(eg); }
    g.ses.add(h.session);
    const tree = treeOf(sessions, h.session);
    const e = g.trs.get(tree);
    if (e) { e.n += h.n; if (h.ts > e.ts) { e.ts = h.ts; e.session = h.session; } }
    else g.trs.set(tree, { session: h.session, tree, n: h.n, ts: h.ts });
  }
  const out: Candidate[] = [];
  for (const { c, ses, trs } of groups.values()) {
    if (trs.size < trees) continue;
    c.sessions = ses.size;
    c.trees = trs.size;
    c.evidence = [...trs.values()].sort((a, b) => b.ts - a.ts).slice(0, EVIDENCE);
    const n = census?.get(c.repo);
    if (n && n.trees > 0) Object.assign(c, trialOf(Math.min(1, c.trees / n.trees), n.trees, n.a_day));
    out.push(c);
  }
  return out.sort((a, b) => b.trees - a.trees || b.failures - a.failures || b.last_ts - a.last_ts);
}

// ---- what a trial needs ----
// A lesson's trial (src/admin/experiments.ts, the lesson template) counts in each agent tree whether its
// class failed there (0 or 1), and names a winner only at the sample size it set in advance. That size is
// the one a two-sided test of two shares at the trials' 5% needs to find, four times in five, a lesson that
// halves its class: a note an agent reads at its start and follows removes most of a mistake it names, and
// one that cuts less is not worth the words in every agent's task. (Against the trials' own decision, on
// trees drawn at the class's rate: 80 of 100 kept at 20% and at 8.8% with a half cut, 2 of 100 kept
// with no effect.) Never fewer trees than the trials' default (FAMILIES_PER_ARM): the intervals are bootstrapped.
export const CUT = 0.5;
export const MIN_PER_ARM = 64;
const Z = 1.959964 + 0.841621;
export function perArm(rate: number): number {
  const p1 = Math.min(1, Math.max(0, rate)), p2 = p1 * (1 - CUT);
  if (p1 <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(MIN_PER_ARM, Math.ceil((Z * Z * (p1 * (1 - p1) + p2 * (1 - p2))) / ((p1 - p2) ** 2)));
}
// A lesson is proposed only for a class whose trial the repository's own pace of agent trees decides within
// a week: one that would run for months holds the one live trial slot and leaves its lesson unproven.
export const TRIAL_DAYS = 7;
export function trialOf(rate: number, repoTrees: number, aDay: number): Pick<Candidate, "repo_trees" | "trees_a_day" | "rate" | "per_arm" | "trial_days"> {
  const n = perArm(rate);
  return { repo_trees: repoTrees, trees_a_day: Math.round(aDay * 10) / 10, rate: Math.round(rate * 1000) / 1000, per_arm: Number.isFinite(n) ? n : 0,
    trial_days: Number.isFinite(n) && aDay > 0 ? Math.ceil((2 * n) / aDay) : Number.MAX_SAFE_INTEGER };
}
export const decidable = (c: Pick<Candidate, "trial_days">) => c.trial_days !== undefined && c.trial_days <= TRIAL_DAYS;

// Each repository's trees started since `since` (a top-level session's own work, and each agent it started)
// and how many a day, over the window or the part of it the store covers (at least an hour: a store a few
// minutes old would read a burst as a pace).
export type Census = { trees: number; a_day: number };
export function treesOf(db: Database, since: number, now: number, root: (dir: string) => string | null): Map<string, Census> {
  const rows = tried(() => db.query<{ id: string }, [number]>(
    "SELECT s.id FROM sessions s LEFT JOIN sessions p ON p.id = s.parent_id WHERE s.created >= ? AND (s.parent_id IS NULL OR p.parent_id IS NULL)").all(since));
  if (!rows.length) return new Map();
  const sessions = sessionsOf(db, rows.map((r) => r.id));
  const oldest = tried(() => db.query<{ t: number | null }, []>("SELECT MIN(created) AS t FROM sessions").all())[0]?.t ?? since;
  const days = Math.max(1 / 24, (now - Math.max(since, oldest)) / 86_400_000);
  const count = new Map<string, number>();
  for (const r of rows) {
    const repo = repoOfSession(sessions, r.id, root);
    if (repo) count.set(repo, (count.get(repo) ?? 0) + 1);
  }
  return new Map([...count].map(([repo, trees]) => [repo, { trees, a_day: trees / days }]));
}

// The read thread's task: the candidates of every repository over the last `days`.
export function mineRead(db: Database, a: { now: number; days?: number; trees?: number }): Candidate[] {
  const since = a.now - (a.days ?? DAYS) * 86_400_000;
  const hits = hitsOf(db, since);
  const cache = new Map<string, string | null>();
  const root = (dir: string) => { if (!cache.has(dir)) cache.set(dir, repoRoot(dir)); return cache.get(dir)!; };
  return mineFrom(hits, sessionsOf(db, hits.map((h) => h.session)), root, a.trees ?? TREES, treesOf(db, since, a.now, root));
}

// ---- a trial's count ----

// Whether a hit is of a lesson's class: the same key, or for a review class a finding like its seed.
export const ofClass = (cls: { source: Source; key: string; words?: string[] }, h: Hit) =>
  h.source === cls.source && (h.key === cls.key || (cls.source === "review" && !cls.key.startsWith("review:kind:") && !!cls.words && !!h.words && similar(cls.words, h.words)));

// Whether a family of a trial failed with one class (1) or not (0), from `since` on: a family is a root
// session and every session the experiment gave its arm (`sessions`). Once a tree: the trial asks whether a
// lesson keeps its agents from the mistake, and one agent that repeats it twenty times is one tree that made it.
// The ledger and the failure table are read by the sessions' own rows (indexed by session).
export function familyHas(db: Database, cls: { source: Source; key: string; words?: string[] }, sessions: { id: string; root: string }[], since: number, until: number): Map<string, number> {
  const out = new Map<string, number>();
  const rootOf = new Map(sessions.map((s) => [s.id, s.root]));
  for (const s of sessions) out.set(s.root, out.get(s.root) ?? 0);
  const add = (session: string, n: number) => { const r = rootOf.get(session); if (r !== undefined && n > 0) out.set(r, 1); };
  const ids = [...rootOf.keys()];
  if (cls.source === "tool") {
    const q = db.query<{ tool: string; error: string | null }, [string, number, number]>("SELECT tool, error FROM telemetry_tools WHERE session_id = ? AND is_error = 1 AND ts >= ? AND ts <= ?");
    for (const id of ids) for (const r of tried(() => q.all(id, since, until))) { const c = toolClass(r.error ?? ""); if (c && toolKey(r.tool, c) === cls.key) add(id, 1); }
    return out;
  }
  if (cls.source === "failure") {
    // A family's failures are in its sessions' rows and, for its agents, in the rows of the session above
    // each, under the agent's id.
    const agents = new Map<string, string>();
    const aq = db.query<{ id: string; parent_id: string }, [string]>("SELECT id, parent_id FROM agents WHERE session_id = ?");
    for (const id of ids) for (const a of tried(() => aq.all(id))) agents.set(a.id, id);
    const fp = cls.key.slice("failure:".length);
    const scopes = new Set<string>(ids);
    const pq = db.query<{ parent_id: string | null }, [string]>("SELECT parent_id FROM sessions WHERE id = ?");
    for (const id of ids) { const p = tried(() => pq.all(id))[0]?.parent_id; if (p) scopes.add(p); }
    const fq = db.query<{ session_id: string; count: number; refs: string; last_ts: number }, [string, string]>("SELECT session_id, count, refs, last_ts FROM session_failures WHERE session_id = ? AND fp = ?");
    for (const scope of scopes) {
      for (const r of tried(() => fq.all(scope, fp))) {
        if (r.last_ts < since) continue;
        for (const ref of (json(r.refs) ?? []) as { id: string; n?: number }[]) {
          const n = ref.n ?? 0;
          if (ref.id === "self" || ref.id === "others") { if (rootOf.has(scope)) add(scope, n); }
          else if (agents.has(ref.id)) add(agents.get(ref.id)!, n);
        }
      }
    }
    return out;
  }
  // Reviews: the findings and refusing verdicts of the family's work (the review tables are small: read by time).
  for (const f of findingsOf(db, since, until)) {
    const h: Hit = { source: "review", key: f.kind ? kindKey(f.kind) : "", label: "", example: "", session: f.session, ts: f.ts, n: 1, ...(f.kind ? {} : { words: f.words }) };
    if (ofClass(cls, h)) add(f.session, 1);
  }
  return out;
}
