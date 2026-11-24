// The check ledger at work: a shell call that runs one of the repository's
// checks is answered from the ledger when the check passed on these same
// files, else it runs and its end is recorded with the tree it ran on; a red
// one's result says whether it is red on the base too, or flaky. The owner's
// own commands (the terminal pane) are recorded the same way, never answered.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { conceal } from "../core/conceal.ts";
import { realOf, homeDir } from "../core/paths.ts";
import type { Session, ToolResultBlock } from "../core/types.ts";
import type { ToolCall, ToolGate } from "../engine/hooks.ts";
import { toolEnv, type Job } from "../tools/jobs.ts";
import { moveShell } from "../tools/shell.ts";
import { countsOf } from "./counts.ts";
import { baseOf, commitTree, fromTop, inputsOf, keyOf, markAnyway, namedFor, onTree, onTrees, owe, owed, record, repoOf, takeAnyway, treeOf, type Repo } from "./ledger.ts";
import { checkStatus, firstFolder, matchAll, parseTrace, stoppedByTimeout, type Match } from "./named.ts";
import { answerText, baseState, baseWords, flakyOn, runNote, type Result, type Run } from "./words.ts";

// A check run on its way, as plain data: kept with the call in the store too (owe), so a run a
// restart cut whose command the next daemon takes back is still recorded when it ends.
type Pending = {
  repo: Repo; name: string; command: string; dir: string; start: string; filters: number; timeout?: true; nth?: number; bg?: true;
  tree: string; head: string | null; inputs: string | null; why?: string;
  sessionId: string; by: "agent" | "owner"; callId?: string; traced: boolean;
  // Its tree is taken when the command ends (something before the check may have changed a file):
  // where, what the run is known by and the inputs it names.
  atEnd?: { tree: Match["tree"]; command: string; inputs: string[] };
};
// Calls on their way to run checks (one call may run several), by call id; owner's runs by job id;
// recorded runs by call id.
type Stored = { run: Run; repo: Repo; why?: string };
const pending = new Map<string, Pending[]>();
const owners = new Map<string, Promise<Pending | undefined>>();
const recorded = new Map<string, Promise<Stored[]>>();
const MAP_MAX = 512;
const capped = <K, V>(m: Map<K, V> | Set<K>) => { while (m.size > MAP_MAX) m.delete(m.keys().next().value as K); };

// The command a shell call runs, as written.
export function commandOf(call: ToolCall): string | undefined {
  const auto = call.tool.autoShell?.(call.input ?? {})?.command;
  if (typeof auto === "string") return auto;
  const i = call.input ?? {};
  return typeof i.command === "string" ? i.command : typeof i.cmd === "string" ? i.cmd : undefined;
}

// Which checks a command run in `folder` runs, with the repository they are of: the one its leading
// `cd`s go to, else the folder's own. `sessionId`: whose shell runs it (the environment its commands get).
export function checksIn(folder: string, command: string, sessionId?: string): { repo: Repo; matches: Match[] } | undefined {
  const home = homeDir();
  const repo = repoOf(firstFolder(command, folder, home)) ?? repoOf(folder);
  if (!repo) return undefined;
  const named = namedFor(repo);
  if (!named?.checks.length) return undefined;
  let env: Record<string, string> | undefined;
  const environ = (n: string) => (env ??= sessionId ? toolEnv(sessionId) : { ...process.env } as Record<string, string>)[n] !== undefined;
  const matches = matchAll(command, named, { cwd: folder, home, rel: (d) => fromTop(repo, d), environ });
  return matches.length ? { repo, matches } : undefined;
}
export function checkIn(folder: string, command: string, sessionId?: string): { repo: Repo; match: Match } | undefined {
  const got = checksIn(folder, command, sessionId);
  return got && { repo: got.repo, match: got.matches[0]! };
}

// The tree a check runs on, the repository whose work tree it is (its base is compared with), and what
// the run is known by. A check of a commit names the commit by its last argument, resolved here: a name
// that is not a commit is an argument of its own, and the check is of HEAD.
type Target = { repo: Repo; tree: string; head: string | null; why?: string; command: string };
async function treeFor(repo: Repo, tree: Match["tree"], command: string): Promise<Target | undefined> {
  if (tree.kind === "commit") {
    const named = tree.rev ? await commitTree(repo, tree.rev) : undefined;
    const t = named ?? (await commitTree(repo, "HEAD"));
    return t && { repo, tree: t.tree, head: t.head, command: named || !tree.named ? command : tree.named };
  }
  // (The work tree of the folder it ran in: a cd may have gone into another one, or a nested repository.)
  const at = repoOf(tree.folder);
  // A folder argument that is not the top of a work tree: the check reads more than one tree.
  if (!at || (tree.kind === "folder" && realOf(at.top) !== realOf(tree.folder))) return undefined;
  const t = await treeOf(at);
  if (!t) return undefined;
  return t.tree === null ? { repo: at, tree: "", head: t.head, why: t.why, command } : { repo: at, tree: t.tree, head: t.head, command };
}

export async function beforeCall(s: Session, call: ToolCall): Promise<ToolGate> {
  if (s.machine || call.tool.kind !== "shell" || call.tool.appliesPatch) return;
  const command = commandOf(call);
  if (!command) return;
  const folder = call.tool.cwdOf?.(call.ctx, call.input) ?? call.ctx.cwd;
  const found = checksIn(folder, command, s.id);
  if (!found) return;
  // A tool that cannot say when a check itself started records one only when it is the whole command.
  const traced = !!call.tool.tracesChecks;
  const matches = traced ? found.matches : found.matches.slice(0, 1).filter((m) => m.alone);
  const ps: Pending[] = [];
  // (Checks of one tree in one call: the tree is looked at once.)
  const looks = new Map<string, Promise<Target | undefined>>();
  for (const match of matches) {
    const base = { name: match.check.name, dir: match.dir, start: match.start, filters: match.filters, ...(match.timeout ? { timeout: true as const } : {}), ...(match.nth ? { nth: match.nth } : {}), ...(match.bg ? { bg: true as const } : {}), sessionId: s.id, by: "agent" as const, callId: call.id, traced };
    if (match.treeAt === "end") {
      ps.push({ ...base, repo: found.repo, command: match.command, tree: "", head: null, inputs: null, atEnd: { tree: match.tree, command: match.command, inputs: match.check.inputs } });
      continue;
    }
    const at = JSON.stringify(match.tree);
    if (!looks.has(at)) looks.set(at, treeFor(found.repo, match.tree, match.command));
    const look = await looks.get(at)!;
    if (!look) continue;
    // (What the run is known by is the match's own; the tree is shared.)
    const t = match.tree.kind === "commit" ? look : { ...look, command: match.command };
    const inputs = inputsOf(t.repo.top, match.check.inputs) ?? null;
    if (match.answers) {
      const answer = answered(s, call, match, t, inputs);
      if (answer) return answer;
    }
    ps.push({ ...base, repo: t.repo, command: t.command, tree: t.tree, head: t.head, inputs, ...(t.why ? { why: t.why } : {}) });
  }
  if (!ps.length) return;
  pending.set(call.id, ps);
  capped(pending);
  owe(call.id, ps);
  return traced ? { ctx: { checkRun: true } } : undefined;
}

// The answer from the ledger to a command that stands for one check: it passed on these same files.
function answered(s: Session, call: ToolCall, match: Match, t: Target, inputs: string | null): ToolGate {
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
  return undefined;
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
async function store(p: Pending, job: Job): Promise<Stored | undefined> {
  // Its own status, from what the shell reported of it: nothing is recorded of a check that never
  // started (a wait before it gave up). Untraced, the check is the whole command: its status is the job's,
  // or the pipe's first, which nothing reported.
  let exit: number | null;
  if (p.traced) {
    const st = checkStatus(parseTrace(conceal(job.trace ?? "", job.sessionId)), p.start, p.filters, p.nth, !!p.bg);
    if (!st) return undefined;
    exit = st.exit;
  } else exit = p.filters ? null : job.exitCode ?? null;
  // Through head, which stops reading after its lines: a check killed by the closed pipe found nothing.
  if (p.filters && exit === PIPE_CLOSED) exit = null;
  // A tree taken at the end: the files as the command left them, which the check ran on.
  if (p.atEnd) {
    // (Not when it ran on in the background: the session went on and may have changed files since.)
    if (job.background) return undefined;
    const t = await treeFor(p.repo, p.atEnd.tree, p.atEnd.command);
    if (!t) return undefined;
    p = { ...p, repo: t.repo, command: t.command, tree: t.tree, head: t.head, inputs: inputsOf(t.repo.top, p.atEnd.inputs) ?? null, ...(t.why ? { why: t.why } : {}) };
  }
  // (A command stopped or killed says nothing of the check's result, whatever status it left.)
  const result: Result = job.stopReason || job.signal || (p.timeout && stoppedByTimeout(exit)) ? "stopped" : exit === null ? "unknown" : exit === 0 ? "pass" : "fail";
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
  const found = checkIn(job.cwd, job.command, job.sessionId);
  if (!found) return;
  if (!found.match.alone) return;
  const m = found.match;
  owners.set(job.id, treeFor(found.repo, m.tree, m.command).then((t): Pending | undefined => (t ? {
    repo: t.repo, name: m.check.name, command: t.command, dir: m.dir, start: m.start, filters: m.filters, ...(m.timeout ? { timeout: true as const } : {}), tree: t.tree, head: t.head,
    inputs: inputsOf(t.repo.top, m.check.inputs) ?? null, ...(t.why ? { why: t.why } : {}), sessionId: job.sessionId, by: "owner", traced: false,
  } : undefined)));
  capped(owners);
}

export function jobDone(job: Job) {
  // (One a restart cut is in the store: its job was taken back by this daemon.)
  // (A row an earlier daemon owed holds one run, not a list.)
  const got = job.callId ? pending.get(job.callId) ?? owed<Pending | Pending[]>(job.callId) : undefined;
  if (got) {
    pending.delete(job.callId!);
    owed(job.callId!); // (its row in the store goes too)
    recorded.set(job.callId!, Promise.all((Array.isArray(got) ? got : [got]).map((p) => store(p, job).catch(() => undefined))).then((rs) => rs.filter((r): r is Stored => !!r)));
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
  const notes: string[] = [];
  for (const r of await got) {
    const note = r.why ? `Check ledger: ${r.run.name} was recorded with no tree: ${r.why}, so no later run is answered from it.` : await noteFor(r.run, r.repo);
    if (note) notes.push(note);
  }
  if (!notes.length) return;
  const note = notes.join("\n");
  if (typeof result.content === "string") result.content = `${result.content}\n\n${note}`;
  else result.content = [...result.content, { type: "text", text: note }];
}

// A call that failed before its command ran leaves nothing waiting.
export function dropCall(id: string) {
  if (!recorded.has(id)) { pending.delete(id); owed(id); }
}
