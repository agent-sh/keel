// An agent's lane in five lines (src/automation/lane-line.ts says what each
// is): the facts read here, with no model request. What the loop holds is
// read from memory or one indexed row (its record, its session's state, its
// "now" line and running call, its failures, its plan, the check runs on its
// tree); what reads events or its hours goes to the read thread; its worktree
// is read with git, a few short commands. A lane is made when a view asks for
// it, never on a beat.
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
import { sessionState } from "./state.ts";
import { callWords } from "./now-line.ts";
import { LANE_LABEL, laneLines, type CheckFact, type GitFact, type Lane, type LaneFacts } from "./lane-line.ts";

export type { Lane };

const WRITES = new Set(["write", "edit", "patch", "notebook"]);
const NAMES_KEPT = 50;

// The newest failure in its scope: of the agent itself in its parent's record, and of the agents below it.
function failureOf(sessionId: string, agentId: string): LaneFacts["failure"] {
  let best: LaneFacts["failure"] = null;
  for (const g of recordOf(D().store, sessionId)) {
    const mine = g.under ? undefined : g.refs.find((r) => r.id === agentId);
    const at = mine?.ts ?? g.last_ts;
    if (best && best.at >= at) continue;
    best = { kind: g.kind, cls: g.cls, text: mine?.eg ?? g.sample, at, count: mine?.n ?? g.count };
  }
  return best;
}

// Its worktree: the branch, its head, and every file it carries over its base, uncommitted ones included.
async function gitOf(folder: string, sessionId: string): Promise<GitFact> {
  try {
    const run = (args: string[]) => git(folder, args, { ok: true }).then((s) => s.trim());
    const row = D().store.db.query<{ base_commit: string }, [string, string]>("SELECT base_commit FROM worktrees WHERE session_id = ? OR path = ? LIMIT 1").get(sessionId, folder);
    const [branch, log] = await Promise.all([run(["rev-parse", "--abbrev-ref", "HEAD"]), run(["log", "-1", "--format=%h%x00%s"])]);
    if (!log) return { why: "it has no commit to read" };
    const [head = "", subject = ""] = log.split("\0");
    const base = row?.base_commit ? (await run(["merge-base", "HEAD", row.base_commit])) || row.base_commit : "";
    const [commits, numstat, untracked, status] = await Promise.all([
      base ? run(["rev-list", "--count", `${base}..HEAD`]) : Promise.resolve("0"),
      run(["diff", "--numstat", "--no-renames", base || "HEAD"]),
      run(["ls-files", "--others", "--exclude-standard"]),
      run(["status", "--porcelain", "--untracked-files=all"]),
    ]);
    const names: string[] = [];
    let added = 0, removed = 0, files = 0;
    for (const l of numstat.split("\n").filter(Boolean)) {
      const [a, r, ...p] = l.split("\t");
      files++;
      added += Number(a) || 0;
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

type CallRow = { id: string | null; name: string | null; input: string | null };
// The files its own calls wrote since its task began (an agent with no worktree of its own: what changed
// in the shared folder is not all its own). A call that failed wrote nothing.
async function wroteOf(sessionId: string, fromSeq: number, cwd: string): Promise<LaneFacts["wrote"]> {
  const reads = readsOf(D().store);
  const [calls, failed] = await Promise.all([
    reads.sql<CallRow>(`SELECT b.value ->> '$.id' AS id, b.value ->> '$.name' AS name, b.value -> '$.input' AS input FROM events e, json_each(e.data, '$.blocks') b
      WHERE e.session_id = ? AND e.seq > ? AND e.kind = 'assistant' AND b.value ->> '$.type' = 'tool_use'`, [sessionId, fromSeq]),
    reads.sql<{ id: string }>(`SELECT b.value ->> '$.tool_use_id' AS id FROM events e, json_each(e.data, '$.results') b
      WHERE e.session_id = ? AND e.seq > ? AND e.kind = 'tool_result' AND b.value ->> '$.is_error' = 1`, [sessionId, fromSeq]),
  ]);
  const bad = new Set(failed.map((r) => r.id));
  const seen = new Set<string>();
  for (const c of calls) {
    if (!c.name || !WRITES.has(toolKind(c.name)) || (c.id && bad.has(c.id))) continue;
    let input: any = {};
    try { input = c.input ? JSON.parse(c.input) : {}; } catch {}
    const paths: string[] = typeof input.file_path === "string" ? [input.file_path] : typeof input.notebook_path === "string" ? [input.notebook_path] : [];
    // A patch names its files in its own lines.
    const patch = typeof input.input === "string" ? input.input : typeof input.patch === "string" ? input.patch : "";
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(m[1]!.trim());
    for (const p of paths) seen.add(p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);
  }
  return { names: [...seen].slice(0, NAMES_KEPT), n: seen.size };
}

// Its newest words of its own: the text of its latest replies, the newest first.
async function wordsOf(sessionId: string, fromSeq: number): Promise<string | null> {
  const rows = await readsOf(D().store).sql<{ t: string | null }>(`SELECT (SELECT group_concat(b.value ->> '$.text', '\n') FROM json_each(e.data, '$.blocks') b WHERE b.value ->> '$.type' = 'text') AS t
    FROM events e WHERE e.session_id = ? AND e.seq > ? AND e.kind = 'assistant' ORDER BY e.seq DESC LIMIT 6`, [sessionId, fromSeq]);
  return rows.find((r) => r.t?.trim())?.t ?? null;
}

// The runs of the repository's named checks on the tree of its folder as it is now, and its own on earlier trees.
async function checksOf(folder: string, sessionId: string, since: number): Promise<LaneFacts["checks"]> {
  const repo = ledger.repoOf(folder);
  if (!repo || !ledger.namedFor(repo)) return null;
  const look = await ledger.treeOf(repo);
  const fact = (r: { name: string; result: string; pass: number | null; fail: number | null; ended: number }): CheckFact => ({ name: r.name, result: r.result, pass: r.pass, fail: r.fail, ended: r.ended });
  const tree = look?.tree ? ledger.ofTree(look.tree).map(fact) : [];
  const earlier = ledger.ofSession(sessionId, since, 100).filter((r) => r.tree !== look?.tree).map(fact);
  return { tree, earlier };
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
  const safe = <T,>(what: string, p: Promise<T>, none: T): Promise<T> => p.catch((e) => { capture(e, { at: `agent lane: ${what}`, session: a.session_id }); return none; });
  const [hours, wrote, words] = await Promise.all([
    safe("hours", readsOf(store).run("hours.tree", { session: a.session_id, now: at }) as Promise<TreeHours | null>, null),
    a.worktree || s.machine ? Promise.resolve(undefined) : safe("files", wroteOf(a.session_id, a.first_seq, s.workspace), null),
    safe("words", wordsOf(a.session_id, a.first_seq), null),
  ]);
  const own = a.worktree ? await gitOf(a.worktree, a.session_id) : null;
  // Checks are read for a tree it changed: its worktree's, or the shared folder's when it wrote there.
  const checks = !s.machine && (a.worktree || wrote?.n) ? await safe("checks", checksOf(folder, a.session_id, from), null) : null;
  const plan = tasks(a.session_id).filter((t) => t.by === "model").map((t) => ({ text: t.text, status: t.status }));
  const facts: LaneFacts = {
    now: at, live, said,
    state: told ? { watch: told.watch, why: told.why, text: told.text, since: told.since, until: told.until } : null,
    doing: line ? { text: line.text, from: line.from, steps: line.steps, since: line.since } : null,
    ended: live ? null : { at: a.ended ?? at, steps: used.steps, why: agentWhy(a) },
    call: call ? { line: callWords(call.name, call.input, s.workspace), shell: toolKind(call.name) === "shell", since: call.at } : null,
    waitsOn: live ? agents.waitsOn(a) : "",
    slot: !!a.slot_wait,
    failure: failureOf(a.session_id, a.id),
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
