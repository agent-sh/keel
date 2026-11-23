// The check ledger at work: a shell call that runs one of the repository's
// checks is answered from the ledger when the check passed on these same
// files, else it runs and its end is recorded with the tree it ran on; a red
// one's result says whether it is red on the base too, or flaky. The owner's
// own commands (the terminal pane) are recorded the same way, never answered.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { conceal } from "../core/conceal.ts";
import { realOf } from "../core/paths.ts";
import type { Session, ToolResultBlock } from "../core/types.ts";
import type { ToolCall, ToolGate } from "../engine/hooks.ts";
import type { Job } from "../tools/jobs.ts";
import { moveShell } from "../tools/shell.ts";
import { countsOf } from "./counts.ts";
import { baseOf, commitTree, fromTop, inputsOf, keyOf, markAnyway, namedFor, onTree, onTrees, owe, owed, record, repoOf, takeAnyway, treeOf, type Repo } from "./ledger.ts";
import { checkStatus, matchCommand, parseTrace, type Match } from "./named.ts";
import { answerText, baseState, baseWords, flakyOn, runNote, type Result, type Run } from "./words.ts";

// A check run on its way, as plain data: kept with the call in the store too (owe), so a run a
// restart cut whose command the next daemon takes back is still recorded when it ends.
type Pending = {
  repo: Repo; name: string; command: string; dir: string; start: string; filters: number;
  tree: string; head: string | null; inputs: string | null; why?: string;
  sessionId: string; by: "agent" | "owner"; callId?: string; traced: boolean;
};
// Calls on their way to run a check, by call id; owner's runs by job id; recorded runs by call id.
const pending = new Map<string, Pending>();
const owners = new Map<string, Promise<Pending | undefined>>();
const recorded = new Map<string, Promise<{ run: Run; repo: Repo; why?: string } | undefined>>();
const MAP_MAX = 512;
const capped = <K, V>(m: Map<K, V> | Set<K>) => { while (m.size > MAP_MAX) m.delete(m.keys().next().value as K); };

// The command a shell call runs, as written.
export function commandOf(call: ToolCall): string | undefined {
  const auto = call.tool.autoShell?.(call.input ?? {})?.command;
  if (typeof auto === "string") return auto;
  const i = call.input ?? {};
  return typeof i.command === "string" ? i.command : typeof i.cmd === "string" ? i.cmd : undefined;
}

// Which check a command run in `folder` runs, with the repository it is of.
export function checkIn(folder: string, command: string): { repo: Repo; match: Match } | undefined {
  const repo = repoOf(folder);
  if (!repo) return undefined;
  const named = namedFor(repo);
  if (!named?.checks.length) return undefined;
  const match = matchCommand(command, named, { cwd: folder, home: homedir(), rel: (d) => fromTop(repo, d) });
  return match ? { repo, match } : undefined;
}

// The tree a check runs on, the repository whose work tree it is (its base is compared with), and what
// the run is known by. A check of a commit names the commit by its last argument, resolved here: a name
// that is not a commit is an argument of its own, and the check is of HEAD.
type Target = { repo: Repo; tree: string; head: string | null; why?: string; command: string };
async function treeFor(repo: Repo, m: Match): Promise<Target | undefined> {
  if (m.tree.kind === "commit") {
    const named = m.tree.rev ? await commitTree(repo, m.tree.rev) : undefined;
    const t = named ?? (await commitTree(repo, "HEAD"));
    return t && { repo, tree: t.tree, head: t.head, command: named || !m.tree.named ? m.command : m.tree.named };
  }
  const at = m.tree.kind === "folder" ? repoOf(m.tree.folder) : repo;
  // A folder argument that is not the top of a work tree: the check reads more than one tree.
  if (!at || (m.tree.kind === "folder" && realOf(at.top) !== realOf(m.tree.folder))) return undefined;
  const t = await treeOf(at);
  if (!t) return undefined;
  return t.tree === null ? { repo: at, tree: "", head: t.head, why: t.why, command: m.command } : { repo: at, tree: t.tree, head: t.head, command: m.command };
}

export async function beforeCall(s: Session, call: ToolCall): Promise<ToolGate> {
  if (s.machine || call.tool.kind !== "shell" || call.tool.appliesPatch) return;
  const command = commandOf(call);
  if (!command) return;
  const folder = call.tool.cwdOf?.(call.ctx, call.input) ?? call.ctx.cwd;
  const found = checkIn(folder, command);
  if (!found) return;
  const { match } = found;
  // A tool that cannot say when the check itself started records it only when it is the whole command.
  const traced = !!call.tool.tracesChecks;
  if (!traced && !match.alone) return;
  const t = await treeFor(found.repo, match);
  if (!t) return;
  const inputs = inputsOf(t.repo.top, match.check.inputs) ?? null;
  const key = keyOf(match.dir, t.command);
  // Answered before anything of the command runs: a wait in front of the check is spared too.
  // (Sent again after an answer, it runs: the mark is kept in the store.)
  if (t.tree && match.check.cache && match.exact && !takeAnyway(s.id, key, `${t.tree}${inputs ? `+${inputs}` : ""}`)) {
    const runs = onTree(key, t.tree, inputs);
    const last = runs[0];
    if (last?.result === "pass" && !flakyOn(runs)) {
      const now = Date.now();
      record({ name: match.check.name, command: t.command, dir: match.dir, repo: t.repo.scope, tree: t.tree, head: t.head, session_id: s.id, call_id: call.id, by: "agent", result: "answered", exit: null, pass: last.pass, fail: last.fail, started: now, ended: now, log: last.log, from_run: last.id, inputs, top: t.repo.top });
      markAnyway(s.id, key, `${t.tree}${inputs ? `+${inputs}` : ""}`);
      // The shell is left where the command would have left it (its cds before the check).
      if (call.tool.tracesChecks && !call.input?.dir_path) moveShell(call.ctx, match.shellCwd);
      return { answer: answerText(last, { session: s.id, now }) };
    }
  }
  const p: Pending = {
    repo: t.repo, name: match.check.name, command: t.command, dir: match.dir, start: match.start, filters: match.filters,
    tree: t.tree, head: t.head, inputs, ...(t.why ? { why: t.why } : {}), sessionId: s.id, by: "agent", callId: call.id, traced,
  };
  pending.set(call.id, p);
  capped(pending);
  owe(call.id, p);
  return traced ? { ctx: { checkRun: true } } : undefined;
}

// The end of a log, where a summary is.
function logTail(path: string, bytes = 64 * 1024): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString("utf8");
  } catch { return ""; } finally { if (fd !== undefined) closeSync(fd); }
}

// A pipe's status when its reader closed it early (SIGPIPE: 128 + 13): what the check found is not known.
const PIPE_CLOSED = 141;
function store(p: Pending, job: Job): { run: Run; repo: Repo; why?: string } | undefined {
  // Its own status, from what the shell reported of it: nothing is recorded of a check that never
  // started (a wait before it gave up). Untraced, the check is the whole command: its status is the job's,
  // or the pipe's first, which nothing reported.
  let exit: number | null;
  if (p.traced) {
    const st = checkStatus(parseTrace(conceal(job.trace ?? "", job.sessionId)), p.start, p.filters);
    if (!st) return undefined;
    exit = st.exit;
  } else exit = p.filters ? null : job.exitCode ?? null;
  // Through head, which stops reading after its lines: a check killed by the closed pipe found nothing.
  if (p.filters && exit === PIPE_CLOSED) exit = null;
  // (A command stopped or killed says nothing of the check's result, whatever status it left.)
  const result: Result = job.stopReason || job.signal ? "stopped" : exit === null ? "unknown" : exit === 0 ? "pass" : "fail";
  const counts = countsOf(logTail(job.log));
  const run = record({
    name: p.name, command: p.command, dir: p.dir, repo: p.repo.scope, tree: p.tree, head: p.head,
    session_id: p.sessionId, call_id: p.callId ?? null, by: p.by, result, exit, pass: counts?.pass ?? null, fail: counts?.fail ?? null,
    started: job.started, ended: job.ended ?? Date.now(), log: job.log, from_run: null, inputs: p.inputs, top: p.repo.top,
  });
  return run ? { run, repo: p.repo, ...(p.why ? { why: p.why } : {}) } : undefined;
}

// A job started: the owner's own run of a check is looked at now (its tree, as it starts).
export function jobStarted(job: Job) {
  if (job.by !== "owner" || job.callId) return;
  const found = checkIn(job.cwd, job.command);
  if (!found) return;
  if (!found.match.alone) return;
  const m = found.match;
  owners.set(job.id, treeFor(found.repo, m).then((t): Pending | undefined => (t ? {
    repo: t.repo, name: m.check.name, command: t.command, dir: m.dir, start: m.start, filters: m.filters, tree: t.tree, head: t.head,
    inputs: inputsOf(t.repo.top, m.check.inputs) ?? null, ...(t.why ? { why: t.why } : {}), sessionId: job.sessionId, by: "owner", traced: false,
  } : undefined)));
  capped(owners);
}

export function jobDone(job: Job) {
  // (One a restart cut is in the store: its job was taken back by this daemon.)
  const p = job.callId ? pending.get(job.callId) ?? owed<Pending>(job.callId) : undefined;
  if (p) {
    pending.delete(job.callId!);
    owed(job.callId!); // (its row in the store goes too)
    recorded.set(job.callId!, Promise.resolve(store(p, job)));
    capped(recorded);
    return;
  }
  const o = owners.get(job.id);
  if (!o) return;
  owners.delete(job.id);
  void o.then((q) => q && store(q, job)).catch(() => {});
}

// The words a finished run's result gets: red on the base too, or flaky.
export async function noteFor(run: Run, repo: Repo): Promise<string> {
  const key = keyOf(run.dir, run.command);
  const flaky = flakyOn(onTree(key, run.tree, run.inputs));
  if (run.result !== "fail") return runNote(run, { flaky });
  return runNote(run, { flaky, base: await baseFor(run, repo) });
}

// How a red run's check fares on the base, or nothing when the run was on the base's own tip.
export async function baseFor(run: Run, repo: Repo): Promise<string | undefined> {
  if (!run.tree) return undefined;
  const base = await baseOf(repo);
  if (!base || base.history[0]?.tree === run.tree) return undefined;
  return baseWords(baseState(base.history, onTrees(keyOf(run.dir, run.command), base.history.map((h) => h.tree))), base.name);
}

export async function afterCall(_s: Session, call: ToolCall, result: ToolResultBlock) {
  const got = recorded.get(call.id);
  if (!got) return;
  recorded.delete(call.id);
  const r = await got;
  if (!r) return;
  const note = r.why ? `Check ledger: ${r.run.name} was recorded with no tree: ${r.why}, so no later run is answered from it.` : await noteFor(r.run, r.repo);
  if (!note) return;
  if (typeof result.content === "string") result.content = `${result.content}\n\n${note}`;
  else result.content = [...result.content, { type: "text", text: note }];
}

// A call that failed before its command ran leaves nothing waiting.
export function dropCall(id: string) {
  if (!recorded.has(id)) { pending.delete(id); owed(id); }
}
