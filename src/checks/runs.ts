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
import { countsOf } from "./counts.ts";
import { baseOf, commitTree, fromTop, keyOf, namedFor, onTree, onTrees, record, repoOf, treeOf, type Repo } from "./ledger.ts";
import { checkStatus, matchCommand, parseTrace, type Match } from "./named.ts";
import { answerText, baseState, baseWords, flakyOn, runNote, type Result, type Run } from "./words.ts";

type Pending = { repo: Repo; match: Match; tree: string; head: string | null; sessionId: string; by: "agent" | "owner"; callId?: string; traced: boolean };
// Calls on their way to run a check, by call id; owner's runs by job id; recorded runs by call id.
const pending = new Map<string, Pending>();
const owners = new Map<string, Promise<Pending | undefined>>();
const recorded = new Map<string, Promise<{ run: Run; repo: Repo } | undefined>>();
// A check the ledger answered: the same command on the same tree in the same session runs next time.
const anyway = new Set<string>();
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

// The tree a check runs on, and the repository whose base it is compared with.
async function treeFor(repo: Repo, m: Match): Promise<{ repo: Repo; tree: string; head: string | null } | undefined> {
  if (m.tree.kind === "commit") { const t = await commitTree(repo, m.tree.rev); return t && { repo, ...t }; }
  const at = m.tree.kind === "folder" ? repoOf(m.tree.folder) : repo;
  // A folder argument that is not the top of a work tree: the check reads more than one tree.
  if (!at || (m.tree.kind === "folder" && realOf(at.top) !== realOf(m.tree.folder))) return undefined;
  const t = await treeOf(at);
  return t && { repo: at, ...t };
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
  const key = keyOf(match.dir, match.command);
  const once = `${s.id}\0${key}\0${t.tree}`;
  // Answered before anything of the command runs: a wait in front of the check is spared too.
  if (match.check.cache && match.exact && !anyway.delete(once)) {
    const runs = onTree(key, t.tree);
    const last = runs[0];
    if (last?.result === "pass" && !flakyOn(runs)) {
      const now = Date.now();
      record({ name: match.check.name, command: match.command, dir: match.dir, repo: t.repo.scope, tree: t.tree, head: t.head, session_id: s.id, call_id: call.id, by: "agent", result: "answered", exit: null, pass: last.pass, fail: last.fail, started: now, ended: now, log: last.log, from_run: last.id });
      anyway.add(once);
      capped(anyway);
      return { answer: answerText(last, { session: s.id, now }) };
    }
  }
  pending.set(call.id, { repo: t.repo, match, tree: t.tree, head: t.head, sessionId: s.id, by: "agent", callId: call.id, traced });
  capped(pending);
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

function store(p: Pending, job: Job): { run: Run; repo: Repo } | undefined {
  // Its own status, from what the shell reported of it: nothing is recorded of a check that never
  // started (a wait before it gave up). Untraced, the check is the whole command: its status is the job's,
  // or the pipe's first, which nothing reported.
  let exit: number | null;
  if (p.traced) {
    const st = checkStatus(parseTrace(conceal(job.trace ?? "", job.sessionId)), p.match.start, p.match.filters);
    if (!st) return undefined;
    exit = st.exit;
  } else exit = p.match.filters ? null : job.exitCode ?? null;
  // (A command stopped or killed says nothing of the check's result, whatever status it left.)
  const result: Result = job.stopReason || job.signal ? "stopped" : exit === null ? "unknown" : exit === 0 ? "pass" : "fail";
  const counts = countsOf(logTail(job.log));
  const run = record({
    name: p.match.check.name, command: p.match.command, dir: p.match.dir, repo: p.repo.scope, tree: p.tree, head: p.head,
    session_id: p.sessionId, call_id: p.callId ?? null, by: p.by, result, exit, pass: counts?.pass ?? null, fail: counts?.fail ?? null,
    started: job.started, ended: job.ended ?? Date.now(), log: job.log, from_run: null,
  });
  return run ? { run, repo: p.repo } : undefined;
}

// A job started: the owner's own run of a check is looked at now (its tree, as it starts).
export function jobStarted(job: Job) {
  if (job.by !== "owner" || job.callId) return;
  const found = checkIn(job.cwd, job.command);
  if (!found) return;
  if (!found.match.alone) return;
  owners.set(job.id, treeFor(found.repo, found.match).then((t) => (t ? { repo: t.repo, match: found.match, tree: t.tree, head: t.head, sessionId: job.sessionId, by: "owner" as const, traced: false } : undefined)));
  capped(owners);
}

export function jobDone(job: Job) {
  const p = job.callId ? pending.get(job.callId) : undefined;
  if (p) {
    pending.delete(job.callId!);
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
  const flaky = flakyOn(onTree(key, run.tree));
  if (run.result !== "fail") return runNote(run, { flaky });
  return runNote(run, { flaky, base: await baseFor(run, repo) });
}

// How a red run's check fares on the base, or nothing when the run was on the base's own tip.
export async function baseFor(run: Run, repo: Repo): Promise<string | undefined> {
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
  const note = await noteFor(r.run, r.repo);
  if (!note) return;
  if (typeof result.content === "string") result.content = `${result.content}\n\n${note}`;
  else result.content = [...result.content, { type: "text", text: note }];
}

// A call that failed before its command ran leaves nothing waiting.
export function dropCall(id: string) {
  if (!recorded.has(id)) pending.delete(id);
}
