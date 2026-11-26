// Processes the tools start: one-shot shell commands, background runs (Claude's
// run_in_background, a foreground command moved to the background at its
// timeout, Gemini's is_background) and Codex's interactive exec sessions on a
// real PTY. Every job writes its whole output to a log file the model can Read;
// polls read what is new in it.
//
// A job without a PTY writes its log itself and runs in its own process group,
// so it outlives a daemon restart: a sidecar file names it, a wrapper writes its
// exit code, and the next daemon adopts it (its output, its stop, the note to
// the model when it ends). A PTY dies with the daemon that holds its terminal.
import type { Subprocess } from "bun";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { conceal, concealDeep, secretPairs, streamConcealer } from "../core/conceal.ts";
import { contains, realOf, xdgStateDir } from "../core/paths.ts";
import { tempEnv } from "../core/temp.ts";
import { readStat } from "../core/pid.ts";
import { outputOf } from "../core/proc.ts";
import { timed } from "../admin/stall.ts";
import { RESTART_RAN } from "../core/stops.ts";
import { lastDown, whileDown } from "../core/late.ts";
import { sandboxStatus, scopeHead, splitScope } from "../safety/sandbox.ts";
import { jobSlice, sliceKeeper, MEMORY_DEFAULT, memoryCap, memoryProps, memoryWhy, SLICES, unattendedProps, type JobSlice } from "./job-slice.ts";
import { onSettings, registerSettings, settings } from "../admin/settings.ts";

export type Job = {
  id: string;            // short text id (Claude task_id)
  num: number;           // numeric id (Codex session_id)
  sessionId: string;
  command: string;
  description?: string;
  cwd: string;
  pty: boolean;
  log: string;
  started: number;
  ended?: number;
  exitCode?: number | null;
  signal?: string | null;
  stopReason?: string;
  // How many of its processes the kernel killed for memory (its scope's memory.events, written by its
  // wrapper with the exit code): its result says so instead of a bare exit 137.
  oom?: number;
  // The unattended slice's memory cap it ran under (bytes), for those words.
  oomCap?: number | null;
  // What holds the job's processes: its own transient systemd user scope (a
  // cgroup no descendant leaves, setsid and double forks included), or where
  // that is missing its process group and session, and why.
  cgroup?: string;
  contain?: "cgroup" | "group";
  containWhy?: string;
  background: boolean;   // the model was told it runs on; its end is reported
  callId?: string;       // the tool call that started it
  // How its family's tools name it to the model: Claude's task ID, Codex's
  // session ID, Gemini's PID. And whether the call that runs it stops it when
  // the turn is stopped (the shell tools do; an exec session goes on).
  handle?: Handle;
  stops?: boolean;
  stopping?: boolean;    // a stop of it is under way
  markGone?: boolean;    // ended with no cgroup, and a look for what carries its mark found nothing
  // Its call was cut by a restart while the command ran in front and the command
  // ran on: the turn was waiting on it, so its end starts a turn (see finish).
  wake?: boolean;
  // It ran in front of a call a restart cut and was taken back at this start: that call's result says
  // what became of it (cutCommand), so its end is no input of its own unless the call waits on it (`wake`).
  front?: boolean;
  // A command in front of a call that the owner can move behind it at any time (moveToBackground):
  // the call waits on this signal as well as on the command and its timeout. `movedBy` says who did:
  // the owner, or the owner's steer that waited on it (src/engine/reply-first.ts).
  mover?: AbortController;
  movedBy?: "owner" | "steer";
  // A restart let it run on from in front of its call (releaseFronts): the call does not stop it when the
  // restart parks its turn, and the next daemon takes it back as the command that turn waits on.
  released?: boolean;
  // When its call's limit kills it (a call whose timeout kills, as the fleet's run_on): a command a restart let run
  // on keeps it, and the daemon that holds it then kills it at that time (killDue).
  killAt?: number;
  owes?: boolean;        // it ended and the input that says so is not stored yet
  swept?: number;        // processes of it that outlived its terminal and were ended at this start
  looked?: number;       // when what a stop left was last looked for
  // Since when a process of it holds a socket that serves with the job idle, the processor time it had
  // used then (ms), and the latest sample that saw it (serving, sampleServing).
  serve?: { from: number; cpu: number; at: number };
  by?: "owner";          // the owner ran it from the terminal pane
  // It was started with no sandbox around it (the session's sandbox is off, or the call left it): what is typed into
  // its terminal is judged as the commands it is (src/tools/typed.ts). `typed`: the line being typed into it now (an
  // immutable value, replaced by each write); `typedJudged`: the numbers of the values a write was judged from.
  unconfined?: true;
  typed?: object;
  typedJudged?: Set<number>;
  // Where the shell reports the commands it runs (a check's run, src/checks), and what it reported.
  traceFile?: string;
  trace?: string;
  // The heavy-command slot it holds while it runs (src/tools/heavy.ts), given back at its end.
  slot?: { release(): void };
  // The id of the state folder whose daemon started it (stateIdOf): its record and its processes carry it.
  stateId?: string;
  stateTaken?: string;   // an older build's job: the state folder that took it back first (Meta.state_taken)
  pid: number;
  boot?: string;         // its process's start time, read when it started (Linux)
  readOff: number;       // bytes of the log already handed to the model
  taken?: number;        // bytes the last read covered (more than it showed when it was cut)
  decoder: TextDecoder;
  left?: number[];       // what a stop could not end of its group (it still runs)
  leftStart?: Map<number, string>;   // each one's start time, so a pid given to another process is not taken for it
  proc?: Subprocess<any, any, any>;   // absent for a job adopted after a restart
  // A program of run_code that went on in the background (see codeJob): it holds no log of its own while
  // it runs, and what it printed since the call returned is written to its log, and carried, when it ends.
  kind?: "code";
  result?: string;       // what a program of that kind printed since its call returned (carried by its end's input)
  exited: Promise<void>;
};

export type Handle = "id" | "num" | "pid";
// The variable every process of a job carries, and its value for one job.
const MARK = "KEEL_JOB";
export const markOf = (j: { id: string; started: number }) => `${j.id}.${j.started}`;
// And the id of the state folder whose daemon started it. A record names the job's mark, so a record read
// from a copy of a state folder (or one written to name another daemon's job) names the same mark as the
// original: the folder's id is what the copy does not share. It is made from the spill folder itself (its
// inode and birth time, not its device, whose number can change across a reboot), not kept in a file a copy
// would carry; a rename keeps it.
const STATE_MARK = "KEEL_JOB_STATE";
const stateIds = new Map<string, string>();
export function stateIdOf(spillRoot: string): string | undefined {
  const known = stateIds.get(spillRoot);
  if (known) return known;
  try {
    const id = stateIdFrom(statSync(spillRoot, { bigint: true }));
    stateIds.set(spillRoot, id);
    return id;
  } catch { return undefined; }
}
export const stateIdFrom = (st: { ino: bigint; birthtimeNs: bigint }) => createHash("sha256").update(`${st.ino}:${st.birthtimeNs}`).digest("hex").slice(0, 16);
// The state folder a record says it belongs to: the one whose daemon started its job (`state_id`), or for
// an older build's record the one whose daemon first took it back with its scope running (`state_taken`).
const folderOf = (m: { state_id?: string; state_taken?: string }) => m.state_id ?? m.state_taken;
const COPIED = "its record was written over another state folder (a copy of one)";
// Whether a process's environment (NUL-separated, as /proc/<pid>/environ) holds this exact entry.
function hasEntry(env: Buffer, entry: string): boolean {
  const e = Buffer.from(entry);
  for (let at = env.indexOf(e); at >= 0; at = env.indexOf(e, at + 1)) {
    if ((at === 0 || env[at - 1] === 0) && (at + e.length === env.length || env[at + e.length] === 0)) return true;
  }
  return false;
}
// Whether it holds an entry for this variable, whatever its value.
const hasKey = (env: Buffer, key: string) => env.indexOf(Buffer.from(`${key}=`)) === 0 || env.indexOf(Buffer.from(`\0${key}=`)) >= 0;
// Why a job scope that runs is not the job of this record, from its live processes' environments:
// undefined when one of them carries the job's exact mark and, where the record names a state folder,
// that folder's id, which must be this daemon's (`stateId`). A record that names no folder is an older
// build's, and so are its processes: its mark says it only while no process in the scope carries a
// folder's id (a record of a newer build's job written without its id is not the job's). A scope only its
// name ties to a record (its processes carry no mark of the job, or another folder's) is never this
// daemon's to stop.
export function scopeWhy(m: { id: string; started: number; state_id?: string; state_taken?: string }, envs: (Buffer | undefined)[], stateId: string | undefined): string | undefined {
  if (folderOf(m) !== undefined && folderOf(m) !== stateId) return COPIED;
  const mark = `${MARK}=${markOf(m)}`, st = m.state_id === undefined ? undefined : `${STATE_MARK}=${m.state_id}`;
  if (!st && envs.some((e) => !!e && hasKey(e, STATE_MARK))) return "its record names no state folder, and its scope's processes carry one";
  if (envs.some((e) => !!e && hasEntry(e, mark) && (!st || hasEntry(e, st)))) return undefined;
  return st ? NO_MARK_STATE : "no process in its scope carries the job's mark";
}
const NO_MARK_STATE = "no process in its scope carries the job's mark and this state folder's id";
// A scope refused for want of a mark only, whose record names this state folder and is of a command that ended
// (and was reported): the command's processes carry no mark because it cleaned its environment (`env -i`, a
// launcher that starts a daemon of its own). The scope stays listed as another's, never taken over or stopped
// by Keel: only what is said of it changes, from an error to a note to the command's own session. This is a
// claim of the record, so it decides words and nothing else.
export function unmarkedOwn(m: { id: string; sessionId: string; command: string; description?: string; ended?: number; state_id?: string }, why: string | undefined, stateId: string | undefined): { job: string; session: string; command: string } | undefined {
  if (why !== NO_MARK_STATE || !stateId || m.state_id !== stateId || m.ended === undefined) return undefined;
  return { job: m.id, session: m.sessionId, command: (m.description || m.command).replace(/[\x00-\x1f\x7f`]+/g, " ").trim().slice(0, 60) };
}
const envsIn = (cg: string): (Buffer | undefined)[] => {
  let pids: number[] = [];
  try { pids = readFileSync(`${cg}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; }
  return pids.map((pid) => { try { return procfs.environ(pid); } catch { return undefined; } });
};
export async function scopeEnvs(cg: string): Promise<(Buffer | undefined)[]> {
  const pids = (await fsp.readFile(`${cg}/cgroup.procs`, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  return Promise.all(pids.map((pid) => fsp.readFile(`/proc/${pid}/environ`).catch(() => undefined)));
}
// The jobs this daemon started itself (not taken back from a record): their scopes are theirs without a look.
const startedHere = new Set<string>();
export const ownStart = (j: Job) => startedHere.has(j.id);
export const UNREAD_CAP = 1 << 20;
const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
const metaPath = (log: string) => log.replace(/\.log$/, ".json");
const exitPath = (log: string) => `${log}.exit`;
const jobs = new Map<string, Job>();
const MAX_ENDED = 200;
// Notes for the model's next request; `job` marks a background job's end,
// acknowledged (its sidecar marked reported) only once the note is stored.
// `fresh`: the note's text as things stand when it is sent (nothing: it no longer holds and is dropped).
// `stored`: called once the note is in the session's history. `key`: what the note is about, so the
// same thing is not lined up twice.
export type Notice = { text: string; job?: string; log?: string; key?: string; fresh?: () => string | undefined; stored?: () => void };
const notices = new Map<string, Notice[]>();
let counter = 0;

// Provider credentials never reach a tool shell: a command the model writes
// could print or send them.
const SECRET_ENV = /^(ANTHROPIC_|OPENAI_|AWS_BEARER_TOKEN|AWS_SECRET|AWS_SESSION_TOKEN|CLAUDE_CODE_|GEMINI_API|GOOGLE_API_KEY|OPENROUTER_|XAI_|GROQ_|MISTRAL_|DEEPSEEK_|FIREWORKS_|KIMI_|MOONSHOT_|ZAI_|GLM_)/;
// How this daemon is supervised and how long its drain waits are its own: a
// daemon a command starts (a dev or test one) that read them would exit on a
// restart for a supervisor it does not have, and never come back.
// So is the setting its unit gives its runtime (no collector timer: src/core/relaunch.ts): a command that is a
// program of the same runtime keeps its own.
const OWN_ENV = /^(KEEL_(SUPERVISED|DRAIN_MS|WAIT_FOR_PID)|BUN_GC_TIMER_DISABLE)$/;
// Variables a feature adds to a session's commands (the secrets it was given).
const envProviders: ((sessionId: string) => Record<string, string>)[] = [];
export const registerEnv = (f: (sessionId: string) => Record<string, string>) => void envProviders.push(f);
// Variables a repository's worktree setup chose (src/worktree/setup.ts): only for a command that is the session's own and
// runs under its confinement (StartOpts.vars, the code tool), never in toolEnv, which the daemon's own spawns (an editor,
// xdg-open, git init, the landing queue) read too: a variable a sandboxed command could plant must not reach a process that
// runs without the sandbox.
const varProviders: ((sessionId: string) => Record<string, string>)[] = [];
export const registerVars = (f: (sessionId: string) => Record<string, string>) => void varProviders.push(f);
export function sessionVars(sessionId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of varProviders) Object.assign(out, f(sessionId));
  for (const f of envDrops.values()) for (const k of f(sessionId)) delete out[k];
  return out;
}
// Variables a feature keeps from a session's commands (a review of another person's code gets no GitHub credentials).
// Keyed by the feature, so a hot reload replaces its entry.
const envDrops = new Map<string, (sessionId: string) => readonly string[]>();
export const registerEnvDrop = (id: string, f: (sessionId: string) => readonly string[]): (() => void) => (envDrops.set(id, f), () => void envDrops.delete(id));

// Variables one tool call adds for the process it starts (a secret a command
// refers to as $KEEL_SECRET_<id>, the git settings of an agent's guard):
// taken by the job that call starts. Each feature adds its own to the call's.
// Keyed by the session too: a call's id is its provider's, and two sessions'
// calls can have the same one (a scripted model's, an agent's first).
const callEnvs = new Map<string, Record<string, string>>();
const callKey = (sessionId: string, callId: string) => `${sessionId}\0${callId}`;
export const setCallEnv = (sessionId: string, callId: string, env: Record<string, string>) => { const k = callKey(sessionId, callId); callEnvs.set(k, { ...callEnvs.get(k), ...env }); };
export const dropCallEnv = (sessionId: string, callId: string) => void callEnvs.delete(callKey(sessionId, callId));
export const hasCallEnv = (sessionId: string, callId: string) => callEnvs.has(callKey(sessionId, callId));

export function toolEnv(sessionId: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.test(k) && !OWN_ENV.test(k)) env[k] = v;
  for (const f of envProviders) Object.assign(env, f(sessionId));
  const out: Record<string, string> = { ...env, KEEL_SESSION: sessionId, ...extra };
  for (const f of envDrops.values()) for (const k of f(sessionId)) delete out[k];
  return tempEnv(out);
}

// No pager for a command a session runs, whichever tool starts it: on a terminal a pager takes keys, and less runs
// what is typed into it. git, systemd's tools, dpkg and man each name their own.
const NO_PAGER = { PAGER: "cat", GIT_PAGER: "cat", SYSTEMD_PAGER: "cat", DPKG_PAGER: "cat", MANPAGER: "cat" };

// Terminal output for a model: no escape sequences, carriage-return redraws
// collapsed to the last frame of each line.
export function cleanTerm(s: string): string {
  const noEsc = s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")      // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")                 // CSI
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOc]/g, "")   // charset, keypad, misc
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
  return noEsc
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => (l.includes("\r") ? l.slice(l.lastIndexOf("\r", l.length - 2) + 1).replace(/\r$/, "") : l))
    .join("\n");
}

// The output filter (see startJob): it outlives a stop signal to the group
// until its input closes, so what the command printed last is written too.
const FILTER_JS = `const sc = (${streamConcealer.toString()})(JSON.parse(process.env.KEEL_CONCEAL)); delete process.env.KEEL_CONCEAL;
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {});
process.stdin.on("data", (c) => process.stdout.write(sc.push(c)));
process.stdin.on("end", () => process.stdout.write(sc.end()));`;

export type StartOpts = {
  sessionId: string;
  command: string;
  description?: string;
  cwd: string;
  logDir: string;
  argv?: string[];       // default: bash -c command
  pty?: boolean;
  env?: Record<string, string>;
  // The command is the session's own, run under its confinement: it gets the variables its worktree setup chose (sessionVars).
  vars?: boolean;
  background?: boolean;
  // The session confinement (a beforeTool hook sets ctx.wrapSpawn).
  wrap?: (argv: string[]) => string[];
  callId?: string;
  by?: "owner";
  handle?: Handle;
  stops?: boolean;       // the call stops the command when its turn is stopped
  traceFile?: string;    // the shell reports the commands it runs here (read when the job ends, then removed)
  slot?: { release(): void };  // a heavy-command slot taken for it: held while it runs
};

// A command that runs without having asked for a slot (one a restart left running) takes one
// while it runs, if it is heavy (set by src/tools/heavy.ts).
export const jobSlots: { count?: (job: Job) => { release(): void } | undefined } = {};

export function startJob(o: StartOpts): Job {
  // Bun reports a working directory that is not there as ENOENT of the
  // program it was to start: the folder is named here instead (the shell
  // tools check first and answer the model, see goneCwd).
  if (!statSync(o.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`The working directory ${o.cwd} does not exist: nothing ran.`);
  mkdirSync(o.logDir, { recursive: true });
  const num = ++counter;
  const id = `b${num.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const log = join(o.logDir, `${id}.log`);
  writeFileSync(log, "");
  const bare = o.argv ?? ["bash", "-c", o.command];
  // A confinement's own scope is taken into the job's (its limits with it).
  const { props, argv } = splitScope(o.wrap ? o.wrap(bare) : bare);
  const box = jobScope();
  const extra = o.callId ? callEnvs.get(callKey(o.sessionId, o.callId)) : undefined;
  if (o.callId) callEnvs.delete(callKey(o.sessionId, o.callId));
  const started = Date.now();
  // Every process of the job carries its mark: one that left the job's group and session (setsid, a
  // double fork) is still found where there is no cgroup to hold it (see members).
  const stateId = stateIdOf(dirname(dirname(o.logDir)));
  const env = { ...(o.env ?? toolEnv(o.sessionId)), ...(o.vars ? sessionVars(o.sessionId) : {}), ...NO_PAGER, ...extra, [MARK]: markOf({ id, started }), ...(stateId ? { [STATE_MARK]: stateId } : {}) };
  // What is kept and shown is the command with placeholders: a value the
  // secret hook put in only reaches the process.
  const job = { id, num, sessionId: o.sessionId, command: conceal(o.command, o.sessionId), description: o.description && conceal(o.description, o.sessionId), cwd: o.cwd, pty: !!o.pty,
    log, started, background: !!o.background, readOff: 0, decoder: new TextDecoder(), callId: o.callId, by: o.by, handle: o.handle, stops: o.stops, traceFile: o.traceFile, slot: o.slot, stateId,
    ...(o.wrap ? {} : { unconfined: true as const }) } as Job;
  startedHere.add(id);
  const unit = `keel-job-${id}-${Math.random().toString(36).slice(2, 8)}.scope`;
  // The owner's own command is his whatever its session's turn: no need to ask whether one is attended.
  const place: JobSlice = o.by === "owner" ? "owner" : jobSlice({ attended: attendedOf(o.sessionId) });
  if (box.slice) { job.contain = "cgroup"; job.cgroup = `/sys/fs/cgroup${sliceDir(box.slice, place)}/${unit}`; }
  else { job.contain = "group"; job.containWhy = box.why; }
  // An unattended job's scope lets the kernel end the one process it picked when the slice passes its memory cap,
  // and goes on (OOMPolicy=continue, where the user manager takes it): the default stops the whole scope at once,
  // its wrapper with it, and nothing is left to say why.
  const alone = box.slice && place === "unattended" && box.alone ? ["-p", "OOMPolicy=continue"] : [];
  if (box.slice && place === "unattended") job.oomCap = box.memory?.bytes ?? null;
  const scoped = (a: string[]) => box.slice ? [...scopeHead(), `--slice=${SLICES[place]}`, `--unit=${unit}`, ...props, ...alone, ...maxRuntime(), "--", ...a] : a;
  // Known secret values never reach the log: its output is filtered on the way in.
  const pairs = secretPairs();
  if (o.pty) {
    const sc = pairs.length ? streamConcealer(pairs) : null;
    job.proc = Bun.spawn(scoped(argv), {
      cwd: o.cwd, env: { ...env, TERM: "xterm-256color" },
      terminal: { cols: 200, rows: 50, data: (_t, d) => { try { appendFileSync(log, sc ? sc.push(d) : d); } catch {} } },
    });
    if (sc) void job.proc.exited.then(() => { try { appendFileSync(log, sc.end()); } catch {} });
  } else {
    // The wrapper sits outside any sandbox wrap: it writes the exit code next
    // to the log, where a later daemon finds it. With secrets known, the
    // output goes through a filter process of the same group, so it outlives
    // a daemon restart as the command does; the values reach it in its
    // environment only, and the command never sees that variable.
    const fd = openSync(log, "a");
    // A job in a scope of its own that failed asks its cgroup whether the kernel killed any of its processes for
    // memory, while the scope is still there (it goes with its last process), and writes the count beside the code.
    const exit = job.contain === "cgroup" ? OOM_EXIT : 'echo $c > "$0"';
    const script = pairs.length
      ? `p=$KEEL_CONCEAL; b=$KEEL_CONCEAL_BIN; f=$KEEL_CONCEAL_JS; unset KEEL_CONCEAL KEEL_CONCEAL_BIN KEEL_CONCEAL_JS; "$@" 2>&1 | KEEL_CONCEAL="$p" BUN_BE_BUN=1 "$b" -e "$f"; c=\${PIPESTATUS[0]}; ${exit}; exit $c`
      : `"$@"; c=$?; ${exit}; exit $c`;
    const wrapEnv = pairs.length ? { ...env, KEEL_CONCEAL: JSON.stringify(pairs), KEEL_CONCEAL_BIN: process.execPath, KEEL_CONCEAL_JS: FILTER_JS } : env;
    try {
      job.proc = Bun.spawn(scoped(["bash", "-c", script, exitPath(log), ...argv]), {
        cwd: o.cwd, env: wrapEnv, stdin: "ignore", stdout: fd, stderr: fd, detached: true,
      });
    } finally { closeSync(fd); }
  }
  // A PTY's record is history only: it never outlives its daemon to be adopted.
  job.boot = procStart(job.proc.pid);
  writeMeta(log, { ...meta(job, job.proc.pid), ...(o.pty ? { pty: true, reported: true } : {}) });
  job.pid = job.proc.pid;
  const proc = job.proc;
  job.exited = proc.exited.then((code) => {
    if (job.pty) proc.terminal?.close();
    finish(job, code, proc.signalCode == null ? null : String(proc.signalCode));
  });
  jobs.set(id, job);
  if (job.background) jobsChanged.tell?.(job.sessionId);
  try { jobStarted.tell?.(job); } catch {}
  // Ended jobs are kept for their output and status, the newest MAX_ENDED of
  // them: a long-running daemon does not hold every command it ever ran (the
  // logs stay on disk).
  trim();
  return job;
}

// A program of run_code that outlived its call's wait goes on as a background job of its session: listed with
// the others, stopped by the same routes, its end told once (finish). The program is the daemon's child with an
// IPC channel for its tool calls, so unlike a command it cannot outlive its daemon: it ends with it, and the
// next daemon tells that it was interrupted, never runs it again. Its log holds what it printed since its
// call returned, written when it ends. `end` resolves when the caller has settled it (endCodeJob).
export type CodeJobOpts = { sessionId: string; command: string; cwd: string; logDir: string; callId?: string; proc: Subprocess<any, any, any>; cgroup?: string };
export function codeJob(o: CodeJobOpts): Job {
  mkdirSync(o.logDir, { recursive: true });
  const num = ++counter;
  const id = `b${num.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const log = join(o.logDir, `${id}.log`);
  writeFileSync(log, "");
  let settle!: () => void;
  const job = { id, num, sessionId: o.sessionId, command: conceal(o.command, o.sessionId), cwd: o.cwd, pty: false, log, started: Date.now(), background: true, readOff: 0, decoder: new TextDecoder(),
    callId: o.callId, kind: "code", proc: o.proc, pid: o.proc.pid, stateId: stateIdOf(dirname(dirname(o.logDir))),
    ...(o.cgroup ? { cgroup: o.cgroup, contain: "cgroup" as const } : { contain: "group" as const }),
    exited: new Promise<void>((r) => (settle = r)) } as Job;
  codeEnds.set(id, settle);
  startedHere.add(id);
  job.boot = procStart(job.pid);
  writeMeta(log, meta(job, job.pid));
  jobs.set(id, job);
  jobsChanged.tell?.(job.sessionId);
  trim();
  return job;
}
const codeEnds = new Map<string, () => void>();
// The most of what a program printed that its end's input carries (the whole is in the job's log).
const CODE_CARRY = 8_000;
// The program has ended (or was stopped): what it printed since its call returned goes to the log and, cut to
// CODE_CARRY, into the input that tells its end.
// `log`: what is appended to the log when it is not all of `text` (some of it was written as it printed).
export function endCodeJob(job: Job, o: { code: number | null; signal?: string | null; text: string; log?: string }) {
  if (job.ended !== undefined) return;
  try { appendFileSync(job.log, o.log ?? o.text); } catch {}
  const t = o.text.trim();
  job.result = t.length <= CODE_CARRY ? t : `${t.slice(0, CODE_CARRY / 2)}\n[... ${t.length - CODE_CARRY} characters cut; the whole is in the log ...]\n${t.slice(-CODE_CARRY / 2)}`;
  finish(job, o.code, o.signal ?? null);
  codeEnds.get(job.id)?.();
  codeEnds.delete(job.id);
}

// Ended jobs past the newest MAX_ENDED go, except one that still has processes alive: its group, its
// session, its cgroup, or (where no cgroup holds it) what carries its mark, which is read off the loop in one
// pass for all of them. One trim at a time; a start while one reads asks again when it is done.
let trimming = false, again = false;
function trim() {
  if (trimming) { again = true; return; }
  let ended = 0;
  const over = [...jobs.values()].reverse().filter((j) => !running(j) && ++ended > MAX_ENDED && !jobHasProcesses(j));
  if (!over.length) return;
  const loose = over.filter((j) => j.contain !== "cgroup");
  trimming = true;
  void (loose.length ? procfs.marks(loose.map(markOf)) : Promise.resolve(new Map<string, number[]>()))
    .then((by) => {
      const self = selfLine();
      for (const j of over) if (!(by.get(markOf(j)) ?? []).some((pid) => !self.has(pid) && lives(pid))) jobs.delete(j.id);
    }, () => {})
    .finally(() => { trimming = false; if (again) { again = false; trim(); } });
}

// A daemon whose commands nothing will ever take back (a test run, a scratch daemon of a spec: its state folder is
// removed with it, and a run that is killed never stops its commands) names a longest life for a job's scope in
// KEEL_JOB_MAX_SEC: systemd ends the scope then, whatever became of the daemon. Read when a job starts. The owner's
// daemon sets none.
function maxRuntime(): string[] {
  const n = Math.floor(Number(process.env.KEEL_JOB_MAX_SEC));
  return n > 0 ? ["-p", `RuntimeMaxSec=${n}`] : [];
}

// Whether a session's turn is one the owner attends (set by src/automation/index.ts from the load hold's
// reading): its jobs go in the owner's slice, the others in the unattended one (src/tools/job-slice.ts).
export const jobAttended: { of?: (sessionId: string) => boolean } = {};
function attendedOf(sessionId: string): boolean | undefined {
  try { return jobAttended.of?.(sessionId); } catch { return undefined; }
}
// The cgroup folder (under /sys/fs/cgroup) of a job slice, from app.slice's.
export const sliceDir = (app: string, which: JobSlice) => `${app}/${SLICES[which]}`;
// The slice a job of `sessionId` goes in, and its cgroup folder (none without scopes).
export function placeOf(sessionId: string, byOwner = false): { unit: string; dir?: string } {
  const which: JobSlice = byOwner ? "owner" : jobSlice({ attended: attendedOf(sessionId) });
  const app = jobScope().slice;
  return { unit: SLICES[which], dir: app ? sliceDir(app, which) : undefined };
}

// Where jobs' scopes go: slices of the user manager's app.slice, when systemd --user
// and cgroup v2 are there (read once). `weights`: why the unattended slice has no weight of its own (it then
// weighs what any slice does, still one share for all its jobs). `memory`: the unattended slice's memory cap
// and whether it is in force. `alone`: the user manager takes OOMPolicy=continue on a scope (probed once).
export type MemoryFacts = { bytes: number | null; pending?: true; refused?: string };
export type ScopeAt = { slice?: string; why?: string; weights?: string; memory?: MemoryFacts; alone?: boolean; aloneWhy?: string; keeps?: true; shared?: string };
let scopeAt: ScopeAt | undefined;
export function jobScope(): ScopeAt {
  if (scopeAt) return scopeAt;
  if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) return (scopeAt = { why: "cgroup v2 is not mounted" });
  const st = sandboxStatus();
  if (!st.scope) return (scopeAt = { why: st.scopeReason ?? "no systemd user manager" });
  const r = Bun.spawnSync(["systemctl", "--user", "show", "-p", "ControlGroup", "--value", "app.slice"], { stdout: "pipe", stderr: "ignore" });
  const slice = r.success ? r.stdout.toString().trim() : "";
  if (!slice.startsWith("/")) return (scopeAt = { why: "the user manager names no cgroup for app.slice" });
  const at: ScopeAt = (scopeAt = { slice, memory: { bytes: unattendedCap(), pending: true } });
  // Only the owner's daemon sets the shared slice's properties (sliceKeeper); `keeps` once that is known,
  // `shared` why not.
  void keeperWhy().then((why) => {
    if (why) { at.shared = why; at.memory = { bytes: unattendedCap(), refused: why }; return; }
    at.keeps = true;
    weighUnattended(at);
    capUnattended(at);
  });
  probeAlone(at);
  return at;
}

// The state folder of the daemon this process runs (keepSliceFor, from startDaemon); none in a test or a client.
let daemonState: string | undefined;
export function keepSliceFor(stateDir: string) { daemonState = stateDir; }
async function keeperWhy(): Promise<string | undefined> {
  // A test shares the user manager of the machine it runs on: it never changes that manager's slices.
  if (process.env.NODE_ENV === "test") return "a test does not change the user manager's slices";
  let unitPid: number | undefined;
  if (daemonState !== undefined && daemonState !== xdgStateDir()) {
    try {
      const p = Bun.spawn(["systemctl", "--user", "show", "-p", "MainPID", "--value", "keel-bun.service"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const r = await outputOf(p, { where: "keel-bun.service pid", timeoutMs: 10_000 });
      if (r.code === 0) unitPid = Number(r.out.trim()) || undefined;
    } catch {}
  }
  return sliceKeeper({ stateDir: daemonState, defaultDir: xdgStateDir(), pid: process.pid, unitPid });
}

// The unattended slice's weights, set once a daemon, off the loop: a runtime drop-in, which holds while the
// user manager runs, also over a slice that is empty now. Until it answers, jobs go in the slice at whatever
// weight it has (the default, or what an earlier daemon set). A failure is kept in `weights` (Settings > Health).
function weighUnattended(at: { weights?: string }) {
  setProps(unattendedProps(), (why) => { at.weights = why; });
}

// `systemctl --user set-property --runtime` on the unattended slice, off the loop; `done` gets why it failed, or
// undefined when it held.
function setProps(props: string[], done: (why: string | undefined) => void) {
  try {
    const p = Bun.spawn(["systemctl", "--user", "set-property", "--runtime", SLICES.unattended, ...props], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    void outputOf(p, { where: "set-property" }).then(({ code, err }) => {
      done(code !== 0 ? err.trim().slice(0, 200) || `systemctl set-property exited ${code}` : undefined);
    }, (e) => done(String(e?.message ?? e).slice(0, 200)));
  } catch (e: any) { done(String(e?.message ?? e).slice(0, 200)); }
}

// The one memory cap of all unattended work (job_slice.unattended_memory_max), set on the unattended slice off
// the loop with its weights, apart from them (a refused memory property leaves the weights set), and again when
// the setting changes. The owner's slice and the daemon's own unit are not under it. A cap needs the memory
// controller in app.slice: where the user manager has none to give, the cap is said to be not in force.
registerSettings("job_slice", { unattended_memory_max: MEMORY_DEFAULT }, (v) => {
  const c = memoryCap(v.unattended_memory_max);
  return "error" in c ? c.error : undefined;
});
export const unattendedCap = (): number | null => { const c = memoryCap(settings().job_slice?.unattended_memory_max); return "error" in c ? null : c.bytes; };
function capUnattended(at: ScopeAt) {
  const bytes = unattendedCap();
  if (at.memory && at.memory.bytes === bytes && !at.memory.refused && !at.memory.pending) return;
  const facts: MemoryFacts = { bytes, pending: true };
  at.memory = facts;
  let controllers = "";
  try { controllers = readFileSync(`/sys/fs/cgroup${at.slice}/cgroup.controllers`, "utf8"); } catch {}
  if (bytes !== null && !/\bmemory\b/.test(controllers)) {
    delete facts.pending;
    facts.refused = "the user manager has no memory controller to give its slices (app.slice's cgroup.controllers names none)";
    return;
  }
  setProps(memoryProps(bytes), (why) => {
    if (at.memory !== facts) return; // a later setting took its place
    delete facts.pending;
    if (why) facts.refused = why;
  });
}
onSettings(() => {
  const at = scopeAt;
  if (!at?.slice) return;
  if (at.keeps) capUnattended(at);
  else if (at.shared) at.memory = { bytes: unattendedCap(), refused: at.shared };
  else if (at.memory) at.memory.bytes = unattendedCap(); // the keeper's answer takes the setting as it is then
});

// Whether a scope takes OOMPolicy=continue (systemd 253 and later read it on scopes), asked once off the loop with a
// scope that runs true. Until it answers, unattended jobs start without it.
function probeAlone(at: ScopeAt) {
  try {
    const p = Bun.spawn([...scopeHead(), "-p", "OOMPolicy=continue", "--", "true"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    void outputOf(p, { where: "oom policy" }).then(({ code, err }) => {
      at.alone = code === 0;
      if (code !== 0) at.aloneWhy = err.trim().slice(0, 200) || `systemd-run exited ${code}`;
    }, (e) => { at.alone = false; at.aloneWhy = String(e?.message ?? e).slice(0, 200); });
  } catch (e: any) { at.alone = false; at.aloneWhy = String(e?.message ?? e).slice(0, 200); }
}

// The end of a job's wrapper in a scope of its own: the exit code, and when the command failed the kernel's count of
// its processes killed for memory, read from the scope's memory.events while the scope is still there.
const OOM_EXIT = 'k=; [ $c -ne 0 ] && k=$(sed -n \'s/^oom_kill //p\' "/sys/fs/cgroup$(cut -d: -f3- /proc/self/cgroup)/memory.events" 2>/dev/null); echo "$c${k:+ oom_kill=$k}" > "$0"';

// The job scopes that run now in the user manager's app.slice, by the job id their name holds: the
// cgroup folder of each (`keel-job-<id>-<6 letters>.scope`, as startJob names them). A name alone says
// nothing of who made it: a scope is this daemon's only when its own record names that exact cgroup
// (adoptJobs, adoptScopes).
export const SCOPE_NAME = /^keel-job-(\w+)-[a-z0-9]{1,8}\.scope$/;
export function scopesNow(): Map<string, string> {
  const out = new Map<string, string>();
  if (process.platform !== "linux") return out;
  const slice = jobScope().slice;
  if (!slice) return out;
  // app.slice itself holds the scopes of builds before the job slices.
  for (const dir of [`/sys/fs/cgroup${slice}`, `/sys/fs/cgroup${sliceDir(slice, "owner")}`, `/sys/fs/cgroup${sliceDir(slice, "unattended")}`]) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) { const id = SCOPE_NAME.exec(n)?.[1]; if (id) out.set(id, `${dir}/${n}`); }
  }
  return out;
}

// The sidecar of a job's log: what adoption needs, and once it ended how it
// ended, so the terminal pane lists commands of earlier daemons too.
export type Meta = {
  id: string; num: number; sessionId: string; command: string; description?: string; cwd: string; started: number; background: boolean; pid: number;
  boot?: string; reported?: boolean; pty?: boolean; call_id?: string; by?: "owner"; handle?: Handle;
  trace_file?: string; // where its shell reports the commands it runs (a check's run): read when it ends, whichever daemon sees that
  stopping?: true;   // a stop was under way when this was written: a daemon that went down then left it for the next one
  wake?: true;       // its end starts a turn of its session (a call a restart cut was waiting on it)
  released?: true;   // a restart let it run on from in front of its call (Job.released)
  kill_at?: number;  // when its call's limit kills it (Job.killAt)
  cgroup?: string; contain?: "cgroup" | "group"; contain_why?: string;
  state_id?: string; // the state folder whose daemon started it (stateIdOf)
  kind?: "code";     // a program of run_code (codeJob): it cannot outlive its daemon, its end says it was interrupted
  // An older build's record (no state_id): the state folder whose daemon took it back first, its scope
  // running with the job's mark. A copy of the folder made after that carries this folder's id.
  state_taken?: string;
  ended?: number; exit_code?: number | null; signal?: string | null; stop_reason?: string;
  oom?: number; oom_cap?: number | null; // processes of it the kernel killed for memory, and the cap it ran under
  read_off?: number; // bytes of the log the model was handed (a later daemon goes on from there)
  concealed?: true;  // written with placeholders for the values the secrets vault knew then
};
const meta = (j: Job, pid: number): Meta => ({
  id: j.id, num: j.num, sessionId: j.sessionId, command: j.command, description: j.description, cwd: j.cwd,
  started: j.started, background: j.background, pid, boot: j.boot ?? procStart(pid), call_id: j.callId, by: j.by, handle: j.handle, trace_file: j.traceFile, stopping: j.stopping || undefined, wake: j.wake || undefined, read_off: j.readOff,
  cgroup: j.cgroup, contain: j.contain, contain_why: j.containWhy, state_id: j.stateId, state_taken: j.stateTaken, kind: j.kind, oom_cap: j.oomCap,
});
// Every sidecar write goes through here: the whole record with secrets as placeholders.
function writeMeta(log: string, m: Meta) {
  writeFileSync(metaPath(log), JSON.stringify({ ...concealDeep(m, m.sessionId), concealed: true }));
}
function patchMeta(log: string, patch: Partial<Meta>) {
  try { writeMeta(log, { ...JSON.parse(readFileSync(metaPath(log), "utf8")), ...patch }); } catch {}
}

// The start time of a process (Linux), so a reused pid is not taken for the job.
// `procfs.stat` is the read (a test stands in for it).
export const procfs = {
  stat: (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8"), environ: (pid: number) => readFileSync(`/proc/${pid}/environ`),
  marks: (wanted: string[]): Promise<Map<string, number[]>> => grepMarks(wanted),
};
const procName = (pid: number) => { try { const st = procfs.stat(pid); return st.slice(st.indexOf("(") + 1, st.lastIndexOf(")")); } catch { return undefined; } };
function procStart(pid: number): string | undefined {
  try { return procfs.stat(pid).split(") ").pop()!.split(" ")[19]; } catch { return undefined; }
}
function alive(m: Meta): boolean {
  try { process.kill(m.pid, 0); } catch (e: any) { if (e?.code !== "EPERM") return false; }
  // One that has ended and stays until its parent reads its end (never, under a parent that does not) runs no more.
  try { if (readStat(procfs.stat(m.pid)) === "ended") return false; } catch {}
  const now = procStart(m.pid);
  return !m.boot || !now || now === m.boot;
}

// A session's background commands changed: one started, went on in the
// background, or ended. The daemon says so on the bus, and a page reads the
// list then instead of asking for it at every event of a turn.
export const jobsChanged: { tell?: (sessionId: string) => void } = {};
export function backgrounded(job: Job) {
  job.background = true;
  // (Kept in its record: a next daemon tells its end as a background command's, not as a cut call's.)
  if (!job.pty) try { patchMeta(job.log, { background: true }); } catch {}
  jobsChanged.tell?.(job.sessionId);
}

// Whether an owner's steer has waited long enough on this session's step that a command now put in
// front of a call should go behind it at once (the engine says, src/engine/reply-first.ts): a
// command started after the steer's timer fired would otherwise hold it for its whole run.
// `at`: when the steer's wait passed the mark; `still`: whether it still waits (not taken, not removed).
export const steerWaiting = new Map<string, { at: number; still: () => boolean }>();
export function steerDue(sessionId: string): boolean {
  const w = steerWaiting.get(sessionId);
  if (!w || Date.now() < w.at) return false;
  try { return w.still(); } catch { return false; }
}

// The owner moves a command that runs in front of a call behind it, as the timeout does: the call's
// wait ends at once, the call returns with the command's ID, and the command's end starts the
// session's next turn like any background command's. False for one that is not in front of a call
// (already behind, ended, an exec session, or one a restart cut).
// `which` names it by its ID or by its tool call's, or neither: the newest of the session's that is in front.
export function moveToBackground(sessionId: string, which: { job?: string; call?: string } = {}, by: "owner" | "steer" = "owner"): boolean {
  const mine = [...jobs.values()].filter((x) => x.sessionId === sessionId);
  const j = which.job ? findJob(sessionId, which.job) : which.call ? mine.findLast((x) => x.callId === which.call) : mine.findLast((x) => x.mover && !x.mover.signal.aborted);
  if (!j || j.ended !== undefined || j.background || !j.mover || j.mover.signal.aborted) return false;
  j.movedBy = by;
  j.mover.abort();
  return true;
}

// The command a session's call waits on now, the one the owner can move behind it (the newest of the session's), or none.
export function commandInFront(sessionId: string): { job: string; call?: string; command: string; started: number } | undefined {
  const j = [...jobs.values()].findLast((x) => x.sessionId === sessionId && x.mover && !x.mover.signal.aborted && x.ended === undefined && !x.background);
  return j ? { job: j.id, ...(j.callId ? { call: j.callId } : {}), command: j.description?.trim() || j.command, started: j.started } : undefined;
}

// What a background command's end wakes: its session, which the daemon starts a turn of with `text`
// and calls `sent` once that input is stored, or calls `note` where the end starts no turn (someone
// stopped the command, the owner stopped the session, an agent that has ended): it then goes with the
// session's next request. A command a restart cut the call of (`wake`) was what that turn waited on.
// Any other's end is also a note lined up for the next request from the start (`riding`, its key): a
// turn at work reads it at its next step, and then no turn is started for it (`read` is called, so the
// daemon takes back the input it lined up). With nobody to deliver it (no daemon: a test, a probe)
// the end is that note.
// A job started, and a job ended (its log and status are whole by then): the check ledger
// (src/checks) records the runs of a repository's checks from these.
export const jobStarted: { tell?: (job: Job) => void } = {};
export const jobDone: { tell?: (job: Job) => void } = {};
// A background job the kernel killed processes of for memory: the session's failures record it (src/automation/failures.ts).
// (A call's own command is recorded from its result.)
export const jobMemoryKilled: { tell?: (job: Job) => void } = {};

export const jobEnded: {
  // `key`: the end of a command a cut call waited on, also lined up as a note under this key.
  tell?: (job: Job, text: string, then: { sent: () => void; note: () => void; riding?: string; key?: string }) => void;
  read?: (job: Job) => void;
} = {};
// The key of a background command's end: of its note, and of the input that tells it (stored once under it).
export const endKey = (j: Pick<Job, "id">) => `job-end:${j.id}`;

// A background command by its description, else the start of its command line. (The model's own
// words; on one line, so nothing of them reads as a line of the harness.)
export function jobWhat(job: Pick<Job, "description" | "command">): string {
  const line = (t: string) => t.replace(/[\x00-\x1f\x7f]+/g, " ");
  return job.description ? `"${line(job.description)}"` : `\`${line(job.command.slice(0, 80))}\``;
}
// How a command that ended ended: who stopped it, the signal, or its exit code.
export function endedHow(job: Pick<Job, "stopReason" | "signal" | "exitCode" | "oom" | "oomCap">): string {
  const { signal, exitCode: code } = job;
  return job.stopReason ?? (job.oom ? killedHow(job) : signal ? `was killed by ${signal}` : code === null || code === undefined ? "ended; its exit code was not recorded (it ended under another daemon, or was killed)" : `exited with code ${code}`);
}

// How a job the kernel killed processes of for memory ended, as the words after "The command": the exit code and why.
export function killedHow(job: Pick<Job, "exitCode" | "oom" | "oomCap">): string {
  return `was killed for memory (exit code ${job.exitCode ?? "unknown"}): ${memoryWhy(job.oom ?? 1, job.oomCap)}`;
}

// The count of a job's processes the kernel killed for memory, as its wrapper wrote it beside the exit code.
function oomOf(log: string): number | undefined {
  try { const k = Number(/\boom_kill=(\d+)/.exec(readFileSync(exitPath(log), "utf8"))?.[1] ?? 0); return k > 0 ? k : undefined; } catch { return undefined; }
}

// `at`: when it ended, for one that ended while no daemon watched it (its exit file's time).
function finish(job: Job, code: number | null, signal: string | null, at?: number) {
  if (job.ended !== undefined) return;
  job.ended = at ?? Date.now();
  try { job.slot?.release(); } catch {}
  job.exitCode = code;
  job.signal = signal;
  if (job.contain === "cgroup" && code !== 0 && !job.stopReason) job.oom = oomOf(job.log);
  if (job.background) queueMicrotask(() => jobsChanged.tell?.(job.sessionId));
  // A background job's end counts as reported once its note is stored (ackNotices), not before:
  // a restart between the two reports it again.
  if (job.traceFile) {
    // (At most its first 64 KB: the shell writes 200 lines of 400 characters at most.)
    try { job.trace = readFileSync(job.traceFile, "utf8").slice(0, 65_536); } catch {} // the shell wrote none (it was killed)
    rmSync(job.traceFile, { force: true });
  }
  try { jobDone.tell?.(job); } catch {}
  if (job.oom && job.background) try { jobMemoryKilled.tell?.(job); } catch {}
  try {
    writeMeta(job.log, { ...meta(job, job.pid), reported: !job.background, pty: job.pty || undefined, ended: job.ended, exit_code: code, signal, stop_reason: job.stopReason, ...(job.oom ? { oom: job.oom } : {}) });
  } catch {}
  if (job.background) {
    const what = jobWhat(job);
    const code_ = job.kind === "code";
    const how = job.stopReason ?? (job.oom ? killedHow(job) : signal ? `was killed by ${signal}` : code === null ? (code_ ? "was interrupted when its daemon went down; it is not run again, run it again if its work is still needed" : "ended; its exit code was not recorded (it ended under another daemon, or was killed)") : `exited with code ${code}`);
    const noun = code_ ? "program" : "command";
    const carried = code_ && job.result ? `\nWhat it printed since its call returned (all of it is in ${job.log}):\n${job.result}` : "";
    // One that ended while no daemon watched it is told now, at this start: it says when it really ended.
    const down = at !== undefined ? whileDown(at, lastDown()) : undefined;
    const when = down ? ` It ended ${down}.` : "";
    const note = (o: Pick<Notice, "key" | "stored"> = {}) => {
      const list = notices.get(job.sessionId) ?? [];
      list.push({ text: `Background ${noun} ${what} (ID ${job.id}) ${how}.${when} Output: ${job.log}${carried}`, job: job.id, log: job.log, ...o });
      notices.set(job.sessionId, list);
    };
    // Named by words of its own that cannot read as a tag or a line of the harness inside an input.
    // What it printed is not part of the input: it is tool output, read from the log with a tool.
    const named = what.replace(/[<>\[\]]/g, "'").replace(/(?<=.)`(?=.)/g, "'");
    // A command a cut call was waiting on: its end is what that turn waited for, so it starts one.
    // The turn a restart continued, or one begun since, may still be at work when it ends: the end is
    // also a note lined up for the session's next request, so that turn reads it at its next step and
    // no turn is started for it afterwards (`read` takes back the input lined up).
    if (job.wake && jobEnded.tell) {
      const text = `[harness] The command you were running when the daemon restarted has ended, after ${span(job.ended - job.started)}: ${named} (ID ${job.id}) ${how}.${when} Its output is in ${job.log}.`;
      const key = endKey(job);
      job.owes = true;
      const list = notices.get(job.sessionId) ?? [];
      list.push({ text: text.replace(/^\[harness\] /, ""), job: job.id, log: job.log, key, stored: () => { if (!job.owes) return; job.owes = false; try { jobEnded.read?.(job); } catch {} } });
      notices.set(job.sessionId, list);
      jobEnded.tell(job, text, {
        key,
        sent: () => { job.owes = false; takeNotice(job.sessionId, key); patchMeta(job.log, { reported: true }); },
        note: () => { job.owes = false; },
      });
      return;
    }
    // Any other the model started: its end starts a turn of its idle session, as Claude Code's
    // background tasks do, and rides a turn at work. (Not a command the owner ran in the terminal pane.)
    if (jobEnded.tell && endTold(job)) {
      const key = endKey(job);
      job.owes = true;
      note({ key, stored: () => { if (!job.owes) return; job.owes = false; try { jobEnded.read?.(job); } catch {} } });
      const text = `[harness] Your background ${noun} ${named} (ID ${job.id}) ${how}, after ${span(job.ended - job.started)}.${when} Its output is in ${job.log}.${carried}`;
      jobEnded.tell(job, text, {
        riding: key,
        sent: () => { job.owes = false; takeNotice(job.sessionId, key); patchMeta(job.log, { reported: true }); },
        note: () => { job.owes = false; },
      });
      return;
    }
    note();
  }
}

// The commands of a session that a cut call was waiting on and that still run: its turn ended
// (the model was told they run on), and their end starts its next one.
// One that ended counts until the input that says so is stored: its session is still owed that turn.
export const awaited = (sessionId: string) => [...jobs.values()].filter((j) => j.sessionId === sessionId && j.wake && (running(j) || j.owes));

// Whether a background command's end is an input of its own (finish): one the model started, not a
// cut call's (`wake`: that turn waited on it), not one a restart took back from in front of a call
// (`front`: that call's result says what became of it), not one the owner ran in the terminal pane.
const endTold = (j: Job) => j.background && !j.wake && !j.front && j.by !== "owner";

// The background commands of a session started at `since` or later whose end it is still to be told
// of: they run, or the input that tells their end is on its way. An agent whose turn ends with one
// waits on it (src/automation/agents.ts). Not one being stopped, and not one that serves (serving).
export const unfinished = (sessionId: string, since: number) =>
  [...jobs.values()].filter((j) => j.sessionId === sessionId && endTold(j) && j.started >= since && (j.owes || (running(j) && !j.stopping && !serving(j))));

// Whether a background command of a session started at `since` or later is being stopped: its end,
// stopped, is still to come.
export const beingStopped = (sessionId: string, since: number) =>
  [...jobs.values()].some((j) => j.sessionId === sessionId && endTold(j) && j.started >= since && j.stopping && running(j));

// A job serves when a process of it has held a socket that serves (a TCP or unix socket that listens,
// a UDP socket bound to a port) for SERVE_HOLD_MS while the job used under SERVE_IDLE of a processor:
// the state a dev server or a database left up for the work was started to reach, with no result to
// come. A test run holds its own server while it works, so a listener alone is not enough: the run
// keeps a processor busy, and a server waits for requests. The hold is the reviewer's "a few
// seconds", long enough that a run whose server is up at the instant a turn ends is seen working.
// Decided from samples (sampleServing), never read here: the read is off the loop.
export const SERVE_HOLD_MS = 5_000;
export const SERVE_IDLE = 0.1;
export const serving = (j: Job, now = Date.now()) => running(j) && !!j.serve && j.serve.at - j.serve.from >= SERVE_HOLD_MS && now - j.serve.at < 3 * SERVE_HOLD_MS;
// Whether a job has a listener now, held long enough or not (its end may still be a result to read).
export const listens = (j: Job) => running(j) && !!j.serve;

// The next state of a job's serve mark from one sample: a listening run starts again when the job
// had no listener or kept a processor busy over the run (ms of processor time against ms of clock).
export function nextServe(prev: Job["serve"], s: { at: number; listens: boolean; cpu: number }): Job["serve"] {
  if (!s.listens) return undefined;
  if (!prev || s.at <= prev.from) return { from: s.at, cpu: s.cpu, at: s.at };
  if ((s.cpu - prev.cpu) / (s.at - prev.from) > SERVE_IDLE) return { from: s.at, cpu: s.cpu, at: s.at };
  return { ...prev, at: s.at };
}

// The inodes of the sockets that serve in a /proc/net table: tcp and tcp6 in the LISTEN state (the
// fourth column, 0A; the tenth is the inode), udp and udp6 bound to a local port and connected to
// none (state 07; a client's socket is connected), unix ones that accept (the flag 00010000 in the
// fourth column; the seventh is the inode).
export function servingInodes(kind: "tcp" | "udp" | "unix", table: string): Set<string> {
  const out = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (kind === "unix") {
      if (f.length > 6 && (parseInt(f[3]!, 16) & 0x10000) && f[6] !== "0") out.add(f[6]!);
    } else if (f.length > 9 && f[9] !== "0") {
      if (kind === "tcp" ? f[3] === "0A" : f[3] === "07" && !f[1]!.endsWith(":0000") && /^0+:0000$/.test(f[2]!)) out.add(f[9]!);
    }
  }
  return out;
}

// One sample of jobs at a time, every read with the asynchronous calls (on the runtime's own threads,
// not the loop): each job's processes, the sockets they hold, the tables of their network namespaces,
// and the processor time they used (the cgroup's count, else each process's own and its reaped children's).
let sampling: Promise<void> | undefined;
export function sampleServing(list: Job[]): Promise<void> {
  const go = async () => {
    const tables = new Map<string, Promise<Set<string>>>();
    await Promise.all(list.filter(running).map(async (j) => {
      const at = Date.now();
      const s = await sample(j, tables).catch(() => undefined);
      if (s && running(j)) j.serve = nextServe(j.serve, { at, ...s });
    }));
  };
  const run = (sampling ?? Promise.resolve()).then(go, go);
  sampling = run.finally(() => { if (sampling === run) sampling = undefined; });
  return run;
}
async function sample(j: Job, tables: Map<string, Promise<Set<string>>>): Promise<{ listens: boolean; cpu: number }> {
  const pids = await pidsOf(j);
  let listens = false, cpu = 0;
  if (j.cgroup) try { cpu = Number((await fsp.readFile(`${j.cgroup}/cpu.stat`, "utf8")).match(/^usage_usec (\d+)/m)?.[1] ?? 0) / 1000; } catch {}
  await Promise.all(pids.map(async (pid) => {
    if (!j.cgroup) try {
      const f = (await fsp.readFile(`/proc/${pid}/stat`, "utf8")).split(") ").pop()!.split(" ");
      // utime, stime, cutime, cstime: clock ticks, 100 a second on Linux.
      cpu += (Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14])) * 10;
    } catch {}
    if (listens) return;
    let fds: string[];
    try { fds = await fsp.readdir(`/proc/${pid}/fd`); } catch { return; }
    const socks = (await Promise.all(fds.map((fd) => fsp.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")))).filter((l) => l.startsWith("socket:[")).map((l) => l.slice(8, -1));
    if (!socks.length) return;
    const ns = await fsp.readlink(`/proc/${pid}/ns/net`).catch(() => "");
    let t = tables.get(ns);
    if (!t) tables.set(ns, (t = (async () => {
      const all = new Set<string>();
      for (const [name, kind] of [["tcp", "tcp"], ["tcp6", "tcp"], ["udp", "udp"], ["udp6", "udp"], ["unix", "unix"]] as const) {
        try { for (const i of servingInodes(kind, await fsp.readFile(`/proc/${pid}/net/${name}`, "utf8"))) all.add(i); } catch {}
      }
      return all;
    })()));
    const serve = await t;
    if (socks.some((i) => serve.has(i))) listens = true;
  }));
  return { listens, cpu };
}
// The processor time a job's processes used, in ms (the cgroup's count, else each process's own and
// its reaped children's), read with the asynchronous calls.
export async function cpuMs(j: Job): Promise<number> {
  if (j.cgroup) {
    const t = await fsp.readFile(`${j.cgroup}/cpu.stat`, "utf8");
    return Number(t.match(/^usage_usec (\d+)/m)?.[1] ?? 0) / 1000;
  }
  let cpu = 0;
  await Promise.all((await pidsOf(j)).map(async (pid) => {
    try {
      const f = (await fsp.readFile(`/proc/${pid}/stat`, "utf8")).split(") ").pop()!.split(" ");
      cpu += (Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14])) * 10;
    } catch {}
  }));
  return cpu;
}
// A job's processes, read with the asynchronous calls: its cgroup's, else those of its group and session.
async function pidsOf(j: Job): Promise<number[]> {
  if (j.cgroup) {
    try { return (await fsp.readFile(`${j.cgroup}/cgroup.procs`, "utf8")).split("\n").filter(Boolean).map(Number); } catch { return []; }
  }
  const names = (await fsp.readdir("/proc").catch(() => [] as string[])).filter((n) => /^\d+$/.test(n));
  const out: number[] = [];
  await Promise.all(names.map(async (n) => {
    try {
      const f = (await fsp.readFile(`/proc/${n}/stat`, "utf8")).split(") ").pop()!.split(" ");
      if (f[0] !== "Z" && f[0] !== "X" && (Number(f[2]) === j.pid || Number(f[3]) === j.pid)) out.push(Number(n));
    } catch {}
  }));
  return out;
}

// Whether `cgroup` is the scope the job's kind runs in: a command's names its id (startJob); a run_code
// program's is a session program's scope (sessionScope, kind "code") whose name carries no job id. A
// program's process carries its own mark, not the job's, so while one lives notOurs still refuses it:
// only an ended program's record is taken, as history.
function scopeOfJob(m: Meta, cgroup: string): boolean {
  if (new RegExp(`^/sys/fs/cgroup/[^\\0]*/keel-job-${m.id}-[a-z0-9]{1,8}\\.scope$`).test(cgroup)) return true;
  return m.kind === "code" && /^\/sys\/fs\/cgroup\/[^\0]*\/keel-code-[a-z0-9]{1,8}\.scope$/.test(cgroup);
}

// After a restart: take back the jobs a previous daemon started under
// `spillRoot/<session>/jobs/`. One still running is watched until it ends; one
// that ended unreported is reported now. Ended ones come back as history, so
// their logs open under the same IDs, and new jobs never reuse their numbers.
// Returns how many were taken back to watch or report.
// Why a record of a job is not this daemon's to act on; undefined: it is. A record is read back
// from a file, and a stop of its job signals the process and empties the cgroup it names, so it is
// held against what a daemon really started: the process carries the job's mark in its environment
// (startJob puts it there, and nothing else has it), it started when the record says, and the cgroup
// is the job's own scope. A record whose process has ended names nothing to signal. A record of another
// state folder (a copy, a restore, the folder moved to another disk) is refused only while something of it
// could still be signalled: its process alive, or its scope running. Else it is history like any other.
function notOurs(m: Meta, stateId: string | undefined): string | undefined {
  if (typeof m.id !== "string" || !/^[\w-]+$/.test(m.id) || !Number.isInteger(m.pid) || m.pid <= 1 || typeof m.started !== "number") return "it names no job and process a daemon could have started";
  if (m.cgroup !== undefined && !scopeOfJob(m, m.cgroup)) return "the cgroup it names is not that job's scope";
  if (m.cgroup?.split("/").includes("..")) return "the cgroup it names is not that job's scope";
  const other = folderOf(m) !== undefined && folderOf(m) !== stateId;
  const scopeRuns = () => !!m.cgroup && existsSync(m.cgroup);
  if (process.platform !== "linux") return other && !settled(m) ? COPIED : undefined;
  const now = procStart(m.pid);
  if (now === undefined) return other && scopeRuns() ? COPIED : undefined; // ended: nothing is signalled by pid
  if (!m.boot) return `it does not say when process ${m.pid} started`;
  if (now !== m.boot) return other && scopeRuns() ? COPIED : undefined; // another process has the number now: the job has ended
  if (other) return COPIED;
  let env: Buffer;
  try { env = procfs.environ(m.pid); } catch { return `process ${m.pid} cannot be read, so it cannot be told to be the job's`; }
  if (!hasEntry(env, `${MARK}=${markOf(m)}`)) return `process ${m.pid} was not started as that job (it does not carry the job's mark)`;
  if (m.state_id !== undefined && !hasEntry(env, `${STATE_MARK}=${m.state_id}`)) return `process ${m.pid} was not started over this state folder (it does not carry its id)`;
  if (m.state_id === undefined && hasKey(env, STATE_MARK)) return `its record names no state folder, and process ${m.pid} carries one`;
  return undefined;
}

// The trace file a record names, when it is one the shell tool makes in the job's own folder (it is
// read and removed when the job ends: a record names no other file).
function traceIn(dir: string, f: unknown): string | undefined {
  if (typeof f !== "string" || !f.startsWith(`${dir}/`)) return undefined;
  return /^cwd-[\w.-]+\.trace$/.test(f.slice(dir.length + 1)) ? f : undefined;
}

// `refused`: told each record that is not adopted, with why.
// A settled record whose scope still runs (a build daemon or a server its command left) is taken back
// whatever its age: its processes are this daemon's to list and to stop, not only the newest MAX_ENDED.
type AdoptionRefusal = (file: string, why: string) => void;
export function adoptJobs(spillRoot: string, refused?: AdoptionRefusal): number;
export function adoptJobs(spillRoot: string, refused: AdoptionRefusal | undefined, mode: { afterListen: true }): Promise<number>;
export function adoptJobs(spillRoot: string, refused?: AdoptionRefusal, mode?: { afterListen: true }): number | Promise<number> {
  const scan = scanJobs(spillRoot, refused);
  if (mode?.afterListen) return (async () => {
    // The socket and the route hooks are set up before the first slice.
    await new Promise<void>((done) => setImmediate(done));
    let deadline = performance.now() + 8;
    for (let step = scan.next(); ; step = scan.next()) {
      if (step.done) return step.value;
      if (performance.now() >= deadline) {
        await new Promise<void>((done) => setImmediate(done));
        deadline = performance.now() + 8;
      }
    }
  })();
  let step = scan.next();
  while (!step.done) step = scan.next();
  return step.value;
}

function* scanJobs(spillRoot: string, refused?: AdoptionRefusal): Generator<void, number> {
  let n = 0;
  let sessions: string[] = [];
  try { sessions = readdirSync(spillRoot); } catch { return 0; }
  const scoped = scopesNow();
  const stateId = stateIdOf(spillRoot);
  const held: { m?: Meta; dir: string; f: string }[] = [];
  const history: Job[] = [];
  const terminals: Job[] = [];
  const cut: Job[] = [];
  // `m`: the record as read; a record its folder's index lists as settled is not read unless it is kept (`m` absent).
  const ended: { m?: Meta; started: number; num: number; dir: string; f: string }[] = [];
  // The settled records read at this start that their folder's index does not list yet.
  const unlisted = new Map<string, { m: Meta; f: string }[]>();
  adoptStats.read = 0;
  for (const sid of sessions) {
    yield;
    const dir = join(spillRoot, sid, "jobs");
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    const listed = settledIn(dir);
    for (const [i, f] of files.entries()) {
      if (i % 32 === 0) {
        if (ended.length >= MAX_ENDED * 4) trimHistory();
        yield;
      }
      const known = listed.get(f.slice(0, -5));
      if (known && scoped.has(f.slice(0, -5))) { held.push({ dir, f }); continue; }
      if (known) { ended.push({ ...known, dir, f }); continue; }
      const m = readRecord(join(dir, f));
      if (!m) continue;
      // An end already reported, with no stop to see through and no terminal
      // to sweep, needs nothing at a start but to be listed: only the newest
      // are looked at (below). A state folder keeps every command its sessions
      // ever ran, and looking at each one held a start for seconds; reading
      // each one too, so the folder's index lists the settled ones once
      // written with placeholders, and a later start reads only what it keeps.
      if (settled(m)) {
        if (typeof m.id === "string" && `${m.id}.json` === f) (unlisted.get(dir) ?? unlisted.set(dir, []).get(dir)!).push({ m, f });
        if (typeof m.id === "string" && scoped.has(m.id)) { held.push({ m, dir, f }); continue; }
        ended.push({ m, started: Number(m.started) || 0, num: Number.isInteger(m.num) ? m.num : 0, dir, f });
        continue;
      }
      take(m, dir, f);
    }
  }
  // A settled record whose scope runs: taken back whatever its age, when it names that very scope and a
  // live process in it carries the job's mark (scopeWhy). Else it is history like any other.
  for (const e of held) {
    yield;
    const m = e.m ?? readRecord(join(e.dir, e.f));
    const why = !m ? undefined : m.cgroup !== scoped.get(m.id) ? "the scope running under its id is not the cgroup its record names" : scopeWhy(m, envsIn(m.cgroup!), stateId);
    if (m && !why) take(m, e.dir, e.f, true);
    else if (m) ended.push({ m, started: Number(m.started) || 0, num: Number.isInteger(m.num) ? m.num : 0, dir: e.dir, f: e.f });
  }
  trimHistory();
  for (const e of ended) {
    yield;
    const m = e.m ?? readRecord(join(e.dir, e.f));
    if (m) take(m, e.dir, e.f);
  }
  concealLater(unlisted);
  for (const j of cut) finish(j, null, null);
  for (const j of history.sort((a, b) => b.started - a.started)) jobs.set(j.id, j);
  trim();
  // One read of the process table for all of them, however many records an upgrade left without an end.
  if (terminals.length) { const rows = procTable(true); for (const j of terminals) j.swept = sweep(j, rows); }
  if (adopted.size) { watchAdopted(); watcher ??= setInterval(watchAdopted, 1000); }
  return n;

  function trimHistory() {
    ended.sort((a, b) => b.started - a.started);
    for (const e of ended.splice(MAX_ENDED)) counter = Math.max(counter, e.num);
  }

  // `verified`: its scope runs and a process there carries its mark (scopeWhy).
  function take(m: Meta, dir: string, f: string, verified = false) {
    // A program of run_code that was running when its daemon went down: it ends with its daemon (its calls
    // came over that daemon's channel). It is told as interrupted, once, and never run again.
    if (m.kind === "code" && !m.reported && m.ended === undefined) {
      if (typeof m.id !== "string" || !/^[\w-]+$/.test(m.id) || (folderOf(m) !== undefined && folderOf(m) !== stateId)) { refused?.(join(dir, f), COPIED); return; }
      counter = Math.max(counter, m.num ?? 0);
      if (jobs.has(m.id)) return;
      // (One still there, a moment from seeing its channel closed, is ended: the process the record names, by its start time.)
      try { if (Number.isInteger(m.pid) && m.pid > 1 && m.boot && procStart(m.pid) === m.boot) process.kill(m.pid, "SIGKILL"); } catch {}
      const j: Job = { ...baseOf(m, dir), pty: false, wake: m.wake, background: true, exited: Promise.resolve() };
      jobs.set(j.id, j);
      cut.push(j);
      return;
    }
    const why = notOurs(m, stateId);
    if (why) { refused?.(join(dir, f), why); return; }
    counter = Math.max(counter, m.num ?? 0);
    if (jobs.has(m.id)) return;
    const log = join(dir, `${m.id}.log`);
    // An older build's record whose scope runs with its mark is this folder's from now on: a copy made later is told by it.
    if (stateId && folderOf(m) === undefined && (verified || (!!m.cgroup && scoped.get(m.id) === m.cgroup && !scopeWhy(m, envsIn(m.cgroup), stateId)))) {
      m = { ...m, state_taken: stateId };
      patchMeta(log, { state_taken: stateId });
    }
    // A sidecar an older daemon wrote with a value in it: rewritten with placeholders.
    const shown = concealDeep(m, m.sessionId);
    if (JSON.stringify(shown) !== JSON.stringify(m)) { m = shown; writeMeta(log, m); }
    const base = baseOf(m, dir);
    // A stop the last daemon began and did not see through (it went down
    // first) is finished here: whoever asked for it was told the command
    // was stopped, and what ignored the first signal still runs.
    // A stop that then leaves something alive is said: its call was told the command was stopped.
    const finishStop = (j: Job) => {
      if (!m.stopping || m.pty) return;
      j.left ??= [m.pid];
      void stopJob(j, m.stop_reason ?? "was stopped").then((left) => {
        if (left.length) addNotice(j.sessionId, `The command \`${j.command.slice(0, 80)}\` (ID ${j.id}) could not be stopped: process ${left.join(", ")} of it still runs. Its output is in ${j.log}.`);
        // Seen through: the record is not looked at again at a later start.
        else patchMeta(log, { stopping: undefined });
      }, () => {});
    };
    if (m.reported || m.pty) {
      // History: a PTY never outlives its daemon; one with no end ended with it.
      const j = historyOf(m, dir);
      history.push(j);
      finishStop(j);
      // A terminal the daemon held is gone with it. What ignored the hangup (the daemon was killed, so
      // nothing ended it as an exit does) is ended below, as a daemon that exits ends its terminals' commands.
      // (Looked at once: the record says it ended, so a later start does not look for it again.)
      if (m.pty && m.ended === undefined) { terminals.push(j); patchMeta(log, { ended: m.started }); }
      return;
    }
    let resolve!: () => void;
    // A command in front whose stop was under way was told to its call; a background one's end is a note of its own.
    const job: Job = { ...base, pty: false, wake: m.wake, front: !m.background || undefined, stopping: !!m.stopping, stopReason: m.stopping ? m.stop_reason : undefined, background: m.background || !m.stopping, exited: new Promise<void>((r) => (resolve = r)) };
    jobs.set(job.id, job);
    adopted.set(job.id, { job, meta: m, resolve });
    try { job.slot = jobSlots.count?.(job); } catch {}
    finishStop(job);
    n++;
  }
}

// A job as its record names it, and one that ended as history (its log opens under its ID).
function baseOf(m: Meta, dir: string) {
  return { id: m.id, num: m.num, sessionId: m.sessionId, command: m.command, description: m.description, cwd: m.cwd,
    pty: !!m.pty, log: join(dir, `${m.id}.log`), started: m.started, background: m.background, pid: m.pid, boot: m.boot, readOff: m.read_off ?? 0, decoder: new TextDecoder(),
    callId: m.call_id, by: m.by, handle: m.handle, released: m.released, killAt: typeof m.kill_at === "number" ? m.kill_at : undefined, traceFile: traceIn(dir, m.trace_file), cgroup: m.cgroup, contain: m.contain ?? "group", containWhy: m.contain_why, stateId: m.state_id, stateTaken: m.state_taken, kind: m.kind, oomCap: m.oom_cap };
}
const historyOf = (m: Meta, dir: string): Job => {
  const base = baseOf(m, dir);
  return { ...base, wake: m.wake, readOff: m.read_off ?? size(base.log), ended: m.ended ?? m.started, exitCode: m.exit_code ?? null, signal: m.signal ?? null, stopReason: m.stop_reason, oom: m.oom, exited: Promise.resolve() };
};

// Job scopes that run now and that no job of this daemon holds, taken back when this daemon's own record
// of the job names that exact cgroup (a scope a start did not see, or one of a job this daemon let go).
// A scope with no such record (another daemon's, over another state folder) is never taken: it is only
// counted (`others`). Each unknown id is looked for once. Resolves with what was taken back.
// `scope`: the scope and the mark of the record that was refused (a daemon says each such pair once).
export type Refused = (file: string, why: string, scope: { cgroup: string; mark: string; unmarked?: { job: string; session: string; command: string } }) => void;
const lookedFor = new Set<string>();
export async function adoptScopes(spillRoot: string, refused?: Refused): Promise<{ taken: Job[]; others: string[] }> {
  const out = { taken: [] as Job[], others: [] as string[] };
  const held = new Set([...jobs.values()].map((j) => j.cgroup).filter(Boolean));
  const unknown = [...scopesNow()].filter(([, cg]) => !held.has(cg));
  if (!unknown.length) return out;
  let sessions: string[] | undefined;
  for (const [id, cg] of unknown) {
    if (lookedFor.has(cg)) { out.others.push(cg); continue; }
    sessions ??= await fsp.readdir(spillRoot).catch(() => [] as string[]);
    let found: { m: Meta; dir: string; f: string } | undefined;
    for (const sid of sessions) {
      const dir = join(spillRoot, sid, "jobs");
      const f = `${id}.json`;
      const text = await fsp.readFile(join(dir, f), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      try { const m = JSON.parse(text); if (m && typeof m === "object" && m.id === id && m.sessionId === sid) found = { m, dir, f }; } catch {}
      break;
    }
    const why = !found ? undefined : found.m.cgroup !== cg ? "the scope running under its id is not the cgroup its record names"
      : notOurs(found.m, stateIdOf(spillRoot)) ?? scopeWhy(found.m, await scopeEnvs(cg), stateIdOf(spillRoot));
    if (!found || why || !settled(found.m) || jobs.has(id)) {
      if (found && why) refused?.(join(found.dir, found.f), why, { cgroup: cg, mark: markOf(found.m), unmarked: settled(found.m) ? unmarkedOwn(found.m, why, stateIdOf(spillRoot)) : undefined });
      lookedFor.add(cg);
      out.others.push(cg);
      continue;
    }
    // An older build's record, verified by its scope's mark: this folder's from now on (as adoptJobs does).
    const sid = stateIdOf(spillRoot);
    if (sid && folderOf(found.m) === undefined) { found.m = { ...found.m, state_taken: sid }; patchMeta(join(found.dir, `${id}.log`), { state_taken: sid }); }
    const j = historyOf(found.m, found.dir);
    jobs.set(j.id, j);
    counter = Math.max(counter, found.m.num ?? 0);
    out.taken.push(j);
  }
  if (lookedFor.size > 4096) lookedFor.clear();
  return out;
}

// The settled records a start read that their folder's index does not list.
// One no daemon marked as written with placeholders (an older one wrote it,
// perhaps with a value in it) is written once more with them, a hundred at a
// time after the start; then each is listed in its folder's index, and a later
// start does not read it unless it is among the newest it keeps.
function concealLater(byDir: Map<string, { m: Meta; f: string }[]>) {
  const rest = byDir.entries();
  let next = rest.next();
  let i = 0;
  const step = () => {
    let read = 0;
    const lines = new Map<string, string>();
    while (!next.done && read < 100) {
      const [dir, list] = next.value;
      const e = list[i++]!;
      if (i === list.length) { next = rest.next(); i = 0; }
      read++;
      if (e.m.concealed !== true) {
        try { writeMeta(join(dir, e.f.replace(/\.json$/, ".log")), e.m); } catch { continue; }
      }
      lines.set(dir, (lines.get(dir) ?? "") + `${e.m.id}\t${Number(e.m.started) || 0}\t${Number.isInteger(e.m.num) ? e.m.num : 0}\n`);
    }
    for (const [dir, text] of lines) try { appendFileSync(join(dir, SETTLED), text); } catch {}
    if (!next.done) setTimeout(step, 50);
  };
  if (!next.done) setTimeout(step, 0);
}

// A job folder's index of its settled records (an end reported, no stop to see through, no terminal
// left open), each written with placeholders: a line of its id, when it started and its number.
// Such a record is not written again, so a start lists it from here and reads it only to keep it.
const SETTLED = "settled.tsv";
const settled = (m: Meta) => !!(m.reported || m.pty) && !(m.pty ? m.ended === undefined : m.stopping);
function settledIn(dir: string): Map<string, { started: number; num: number }> {
  const out = new Map<string, { started: number; num: number }>();
  let text = "";
  try { text = readFileSync(join(dir, SETTLED), "utf8"); } catch { return out; }
  // (A line a kill cut short has no end: the last part, and whatever a later append ran into it.)
  const lines = text.split("\n");
  lines.pop();
  for (const line of lines) {
    const [id, started, num, more] = line.split("\t");
    if (more !== undefined || !id || !/^[\w-]+$/.test(id) || !/^\d+$/.test(started ?? "") || !/^\d+$/.test(num ?? "")) continue;
    out.set(id, { started: Number(started), num: Number(num) });
  }
  return out;
}
function readRecord(path: string): Meta | undefined {
  adoptStats.read++;
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    return m && typeof m === "object" ? m : undefined;
  } catch { return undefined; }
}
// How many records the last start read (a test reads it).
export const adoptStats = { read: 0 };

// The exit code a job's wrapper wrote when its command ended by itself, and when (nothing: it has not).
function exitOf(log: string): { code: number | null; at?: number } | undefined {
  const ex = exitPath(log);
  if (!existsSync(ex)) return undefined;
  let code: number | null = null;
  let at: number | undefined;
  try { const c = Number.parseInt(readFileSync(ex, "utf8"), 10); code = Number.isFinite(c) ? c : null; } catch {}
  // It ended when its wrapper wrote the code, which may be long before a daemon looked.
  try { at = Math.floor(statSync(ex).mtimeMs); } catch {}
  return { code, at };
}

// How often what is left of an ended job is looked for again.
const LOOK_MS = 1000;
const adopted = new Map<string, { job: Job; meta: Meta; resolve: () => void }>();
let watcher: Timer | undefined;
function watchAdopted() {
  killDue();
  for (const [id, a] of adopted) {
    const done = exitOf(a.job.log);
    if (!done && alive(a.meta)) continue;
    finish(a.job, done?.code ?? null, null, done?.at === undefined ? undefined : Math.max(a.job.started, done.at));
    adopted.delete(id);
    a.resolve();
  }
  if (!adopted.size && watcher) { clearInterval(watcher); watcher = undefined; }
}

// Running: its process has not ended, or a stop left part of its group alive
// (checked again each time, until nothing of it is left).
export const running = (j: Job) => {
  if (j.ended === undefined) return true;
  // (A look stamped after now was made before the clock was set back: it is due.)
  const since = Date.now() - (j.looked ?? 0);
  if (j.left && (since < 0 || since >= LOOK_MS)) {
    j.looked = Date.now();
    // The processes known to be left are read one by one. Only when they are gone is the rest looked
    // for (others of the group, the cgroup, what carries the mark): once, and then by pid again.
    const still = j.left.filter((pid) => lives(pid, j.leftStart?.get(pid)));
    if (still.length) j.left = still;
    else setLeft(j, [...members(j, { fresh: true }), ...markedNow(j)]);
  }
  return !!j.left;
};
function setLeft(j: Job, rest: Member[]) {
  j.left = rest.length ? rest.map((m) => m.pid) : undefined;
  j.leftStart = rest.length ? new Map(rest.map((m) => [m.pid, m.start])) : undefined;
}
// The pids of the jobs still running, adopted ones included (after a restart
// they are no longer the daemon's children).
export const jobPids = () => [...jobs.values()].filter(running).map((j) => j.pid);
// The jobs that still have processes alive (see jobLive), for what they cost.
export const liveJobs = () => [...jobs.values()].filter(jobLive);

// A command in front of a call that a restart would stop when it parks the turn: one the call stops, not in a
// terminal the daemon holds (that ends with the daemon whatever is done here), still running.
// (One whose stop is under way is left to that stop.)
export const restartStops = (j: Job) => !!j.stops && !j.background && !j.pty && !!j.proc && j.ended === undefined && !j.stopping;

// A restart parks its turns: the commands in front of their calls run on instead of being stopped. Its
// processes are not the daemon's (a scope of their own, else a group the service's stop leaves alone),
// so they outlive it as a background command does, and the next daemon takes each back as the command its
// cut call waited on (`wake`): the call is told it still runs, and its end starts the session's next turn.
// A command stopped here would lose its work, minutes of it for a build or a test run. Answers how many.
export function releaseFronts(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (!restartStops(j)) continue;
    j.stops = false;
    j.released = true;
    backgrounded(j);
    j.wake = true;
    try { patchMeta(j.log, { wake: true, released: true, ...(j.killAt ? { kill_at: j.killAt } : {}) }); } catch {}
    if (j.killAt) { (killer ??= setInterval(killDue, 1000)).unref?.(); }
    n++;
  }
  return n;
}

// The commands a restart let run on whose call's limit has passed are killed, as the call would have killed them.
let killer: ReturnType<typeof setInterval> | undefined;
export function killDue(now = Date.now()) {
  for (const j of jobs.values()) {
    if (!j.released || !j.killAt || j.killAt > now || j.stopping || j.ended !== undefined) continue;
    void stopJob(j, `was killed at its ${Math.round((j.killAt - j.started) / 1000)}s timeout`).catch(() => {});
  }
}

// The owner stopped the session: what a restart let run on from in front of its call stops too, as the call would
// have stopped it. A command the model sent behind its call itself runs on, as it would without a restart.
export async function stopReleased(sessionId: string, reason = "was stopped by the owner"): Promise<number> {
  const list = [...jobs.values()].filter((j) => j.sessionId === sessionId && j.released && running(j));
  await Promise.all(list.map((j) => stopJob(j, reason).catch(() => [])));
  return list.length;
}

// Resolves true when the job ended within ms, false when it is still running.
export async function waitJob(j: Job, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (j.ended !== undefined) return true;
  let timer: Timer | undefined;
  let onAbort: (() => void) | undefined;
  const r = await Promise.race([
    j.exited.then(() => true),
    new Promise<boolean>((res) => { timer = setTimeout(() => res(false), ms); }),
    new Promise<boolean>((res) => {
      if (!signal) return;
      // (One aborted before the wait began, as a command a due steer moves as it starts, ends it at once.)
      if (signal.aborted) return res(false);
      onAbort = () => res(false);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  clearTimeout(timer);
  if (onAbort) signal?.removeEventListener("abort", onAbort);
  // let the pipes flush what the process wrote last
  if (r) await Bun.sleep(5);
  return r;
}

// What the job printed since the last call. Past UNREAD_CAP bytes it is the
// start and the end with a marker for what lies between (the whole of it is
// in the log); `taken` says how many bytes this read covered.
export function takeUnread(j: Job): string {
  const end = size(j.log);
  if (end <= j.readOff) { j.taken = 0; return ""; }
  const from = j.readOff;
  const fd = openSync(j.log, "r");
  const read = (at: number, n: number) => { const b = Buffer.alloc(n); readSync(fd, b, 0, n, at); return b; };
  try {
    let text: string;
    if (end - from <= UNREAD_CAP) text = j.decoder.decode(read(from, end - from), { stream: true });
    else {
      const half = UNREAD_CAP / 2;
      const head = new TextDecoder().decode(read(from, half));
      const tail = j.decoder.decode(read(end - half, half), { stream: true });
      text = `${head}\n[... ${end - from - 2 * half} bytes not shown here; the whole output is in ${j.log} ...]\n${tail}`;
    }
    j.readOff = end;
    j.taken = end - from;
    if (!j.pty) patchMeta(j.log, { read_off: end });
    return text;
  } finally { closeSync(fd); }
}

export const hasUnread = (j: Job) => size(j.log) > j.readOff;

export function writeJob(j: Job, chars: string): boolean {
  if (j.ended !== undefined || !j.pty || !j.proc?.terminal) return false;
  j.proc.terminal.write(chars);
  return true;
}

// Stop everything of a job: TERM, then KILL if any of it lingers. The job
// counts as stopped only once its cgroup is empty and nothing of its process
// group or session is left, not when its leader exits: a child that ignores
// TERM outlives the wrapper shell, and one that called setsid or forked twice
// leaves the group but never the cgroup. KILL goes to the cgroup at once
// (cgroup.kill). A signal to the group goes only while the leader is the
// process the job started as (its start time, read right before the signal),
// or, the leader gone, while members still carry its group id (the kernel does
// not hand out a pid a group still uses). A pid reused since, with nothing of
// the job left, gets nothing and the job ends as gone. Bun has no pidfd API,
// so the read and the signal are back to back instead. Resolves with what is
// still alive (empty when stopped); a job with something left keeps running.
export async function stopJob(j: Job, reason = "was stopped"): Promise<number[]> {
  if (!jobLive(j) && !members(j).length && (j.contain === "cgroup" || !(await markedSoon(j)).length)) {
    // Nothing of it is left: a stop that was under way is over.
    if (j.stopping) { j.stopping = false; if (!j.pty) patchMeta(j.log, { stopping: undefined }); }
    return [];
  }
  if (j.ended === undefined) j.stopReason = reason;
  // Kept with the job: a daemon that goes down before the stop is through leaves it for the next one.
  j.stopping = true;
  if (!j.pty) patchMeta(j.log, { stopping: true, ...(j.ended === undefined ? { stop_reason: reason } : {}) });
  const pid = j.pid;
  // A job stopped while systemd-run still sets up its scope would leave the
  // scope behind empty: its command starts (systemd-run execs it) first.
  if (j.cgroup) for (let i = 0; i < 80 && j.ended === undefined && procName(pid) === "systemd-run"; i++) await Bun.sleep(25);
  const quiet = async (ms: number) => {
    const until = Date.now() + ms;
    if (!(await waitJob(j, ms))) return false;
    while (members(j).length && Date.now() < until) await Bun.sleep(25);
    return !members(j).length;
  };
  signalJob(j, "SIGTERM");
  if (!(await quiet(2000))) signalJob(j, "SIGKILL");
  await quiet(2000);
  // What left the group and the session (setsid, a double fork) is found by the job's mark where no
  // cgroup holds it. That look reads every process's environment: it is made once per stop, when the
  // group is quiet, off the loop, and shared by the stops of one moment (markedSoon).
  let marked = await markedSoon(j);
  const alive = () => marked.filter((m) => lives(m.pid, m.start));
  const wait = async (ms: number) => { for (const until = Date.now() + ms; alive().length && Date.now() < until;) await Bun.sleep(25); return !alive().length; };
  if (marked.length) {
    for (const m of alive()) try { process.kill(m.pid, "SIGTERM"); } catch {}
    if (!(await wait(2000))) for (const m of alive()) try { process.kill(m.pid, "SIGKILL"); } catch {}
    await wait(2000);
    marked = alive();
  }
  // (The read the wait above ended on, shared by the stops that end in this moment.)
  const rest = [...members(j), ...marked];
  setLeft(j, rest);
  j.looked = Date.now();
  j.stopping = false;
  // A stop that left something alive stays marked: the next daemon tries again, and says so if it cannot.
  if (!j.pty && !rest.length) patchMeta(j.log, { stopping: undefined });
  return rest.map((m) => m.pid);
}

// A signal to everything of a job that its group, its session and its cgroup hold. `more`: processes
// found another way (by the job's mark), signalled one by one.
function signalJob(j: Job, sig: NodeJS.Signals, more: Member[] = []) {
  const pid = j.pid;
  const lead = procStart(pid);
  const reused = !!j.boot && lead !== undefined && lead !== j.boot;
  const rest = members(j);
  const groupOk = !reused && (!j.boot || lead !== undefined || rest.some((m) => m.group === pid));
  // A daemon that is itself in the job's group (one the job started) signals the others one by one, never its own group.
  const own = [...selfLine()].some((p) => procTable().get(p)?.group === pid);
  if (groupOk && !own) try { process.kill(-pid, sig); } catch {
    if (lead !== undefined || !j.boot) try { j.proc ? j.proc.kill(sig) : process.kill(pid, sig); } catch {}
  }
  // Members outside the group: in the cgroup (setsid, double forks) or
  // moved to a group of their own within the session.
  // Not while this daemon (or a process above it) is in the scope: the kill would end it too. Its other members
  // are then signalled one by one, below.
  if (sig === "SIGKILL" && j.cgroup && !cgroupHoldsSelf(j.cgroup)) try { writeFileSync(`${j.cgroup}/cgroup.kill`, "1"); } catch {}
  for (const m of [...rest, ...more]) if ((own || m.group !== pid) && procStart(m.pid) === m.start && (!m.cg || inCgroup(m.pid, j.cgroup!))) try { process.kill(m.pid, sig); } catch {}
  if (!rest.length && !more.length && (reused || (j.boot && lead === undefined))) gone(j);
}

// Stops each job; resolves with the ones a stop could not end (part of each still runs).
export async function stopJobs(list: Job[], reason: string): Promise<Job[]> {
  const left = await Promise.all(list.map((j) => stopJob(j, reason)));
  return list.filter((_, i) => left[i]!.length);
}
// What a refusal says of them: each command and the processes of it still alive.
export const leftText = (list: Job[]) => list.map((j) => `${j.command.slice(0, 80)} (pid ${(j.left ?? [j.pid]).join(", ")})`).join("; ");

// The pids in a job's cgroup (empty once its scope is gone).
function cgroupPids(j: Job): number[] {
  if (!j.cgroup) return [];
  try { return readFileSync(`${j.cgroup}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; }
}
const inCgroup = (pid: number, cg: string) => { try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().endsWith(cg.slice("/sys/fs/cgroup".length)); } catch { return false; } };

// One read of every process's state, group, session and start time. The looks of one moment share
// it (a stop of a dozen jobs polls each of them), so it is kept for less than a poll; `fresh` reads again.
type Row = { state: string; parent: number; group: number; session: number; start: string };
const TABLE_MS = 15;
let table: { at: number; rows: Map<number, Row> } | undefined;
function procTable(fresh = false): Map<number, Row> {
  // (A table stamped after now was read before the clock was set back: it is as old as the clock's step back, and is not shared.)
  const age = table ? Date.now() - table.at : -1;
  if (!fresh && table && age >= 0 && age < TABLE_MS) return table.rows;
  // (A read of every process's stat file: on a busy machine thousands, a timed section a stall names.)
  return timed(() => `reading the table of processes (${table?.rows.size ?? "?"} last time)`, () => {
    const rows = new Map<number, Row>();
    let names: string[] = [];
    try { names = readdirSync("/proc"); } catch {}
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue;
      const r = rowOf(Number(n));
      if (r) rows.set(Number(n), r);
    }
    table = { at: Date.now(), rows };
    return rows;
  });
}
function rowOf(pid: number): Row | undefined {
  try {
    const st = procfs.stat(pid);
    const f = st.slice(st.lastIndexOf(") ") + 2).split(" ");
    return { state: f[0]!, parent: Number(f[1]), group: Number(f[2]), session: Number(f[3]), start: f[19]! };
  } catch { return undefined; }
}
const dead = (r: Row | undefined) => !r || r.state === "Z" || r.state === "X";
// Whether a process is alive and still the one it was (`start`: its start time when it was found).
const lives = (pid: number, start?: string) => { const r = rowOf(pid); return !dead(r) && (start === undefined || r!.start === start); };
// This daemon and the processes above it: never part of a job it looks at, also when one of them
// carries a job's mark or sits in its group (a daemon a job started, over the same state folder).
let line: { at: number; pids: Set<number> } | undefined;
function selfLine(): Set<number> {
  const age = line ? Date.now() - line.at : -1;
  if (line && age >= 0 && age < 1000) return line.pids;
  const out = new Set<number>([process.pid]);
  for (let pid = process.pid, i = 0; pid > 1 && i < 64; i++) {
    let ppid: number;
    try { const st = procfs.stat(pid); ppid = Number(st.slice(st.lastIndexOf(") ") + 2).split(" ")[1]); } catch { break; }
    if (!(ppid > 0)) break;
    out.add(ppid);
    pid = ppid;
  }
  line = { at: Date.now(), pids: out };
  return out;
}

// The processes still alive of a job, zombies aside: those in its cgroup,
// and those in its process group or session (a process that has not reached
// the scope yet, or a job with no scope). None of the group when its pid now
// belongs to another process. `cgroup: false`: its group and session only (what
// a terminal's end takes with it). What only carries the job's mark is looked
// for apart (markedNow, markedSoon): that reads every process's environment.
type Member = { pid: number; group: number; start: string; cg?: boolean };
function members(j: Job, o: { cgroup?: boolean; fresh?: boolean; rows?: Map<number, Row> } = {}): Member[] {
  const out: Member[] = [];
  const seen = new Set<number>();
  const self = selfLine();
  if (o.cgroup !== false) for (const pid of cgroupPids(j)) {
    const r = rowOf(pid);
    if (dead(r) || self.has(pid)) continue;
    seen.add(pid);
    out.push({ pid, group: r!.group, start: r!.start, cg: true });
  }
  const rows = o.rows ?? procTable(o.fresh);
  const lead = rows.get(j.pid)?.start ?? procStart(j.pid);
  // The group and session are the job's only while its pid is still its own.
  if (j.boot && lead !== undefined && lead !== j.boot) return out;
  for (const [pid, r] of rows) {
    if (seen.has(pid) || self.has(pid) || dead(r) || (r.group !== j.pid && r.session !== j.pid)) continue;
    out.push({ pid, group: r.group, start: r.start });
  }
  return out;
}

// The processes that carry a job's mark in their environment and are in none of its group, session
// or cgroup: one that took a session of its own left the group, and where no cgroup holds the job
// nothing else names it. Looking reads every process's environment, so it is made as seldom as the
// truth allows: by one pass for every job asked about in the same moment, and off the loop where
// the asker can wait (markedSoon: a stop, the look at what a stop left). With a cgroup nothing is read.
const MARKS_MS = 300;
let marks: { at: number; by: Map<string, number[]> } | undefined;
// Every marked process by its mark, read here and now (a call a restart cut is answered at once).
function marksNow(fresh = false): Map<string, number[]> {
  // (As the table of processes: one stamped after now is not shared.)
  const age = marks ? Date.now() - marks.at : -1;
  if (!fresh && marks && age >= 0 && age < MARKS_MS) return marks.by;
  return timed(() => "reading every process's environment for jobs' marks", () => readMarks());
}
function readMarks(): Map<string, number[]> {
  const by = new Map<string, number[]>();
  const head = Buffer.from(`${MARK}=`);
  let names: string[] = [];
  try { names = readdirSync("/proc"); } catch {}
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let env: Buffer;
    try { env = procfs.environ(Number(n)); } catch { continue; }
    // The variable at the start of an entry (the first, or after a NUL).
    for (let at = env.indexOf(head); at >= 0; at = env.indexOf(head, at + 1)) {
      if (at > 0 && env[at - 1] !== 0) continue;
      const end = env.indexOf(0, at);
      const mark = env.subarray(at + head.length, end < 0 ? env.length : end).toString();
      by.set(mark, [...(by.get(mark) ?? []), Number(n)]);
      break;
    }
  }
  marks = { at: Date.now(), by };
  return by;
}
// The pass off the loop: grep reads the files in a process of its own. `procfs.marks` is the read
// (a test counts its passes); it falls back to the read on the loop where grep cannot be started.
async function grepMarks(wanted: string[]): Promise<Map<string, number[]>> {
  const by = new Map<string, number[]>();
  if (!wanted.length) return by;
  try {
    const p = Bun.spawn(["sh", "-c", 'exec grep -sazxHF "$@" /proc/[0-9]*/environ', "sh", ...wanted.flatMap((m) => ["-e", `${MARK}=${m}`])], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const { out, code } = await outputOf(p, { where: "the look for jobs' marks" });
    // 0: found, 1: none, 2: some files could not be read (another user's processes) and the rest were.
    // Anything else: grep did not run.
    if (code > 2) throw new Error(`grep exited with ${code}`);
    for (const rec of out.split("\0")) {
      const m = rec.match(/^\/proc\/(\d+)\/environ:[^=]+=(.*)$/s);
      if (m) by.set(m[2]!, [...(by.get(m[2]!) ?? []), Number(m[1])]);
    }
    return by;
  } catch {
    const all = marksNow(true);
    for (const m of wanted) if (all.has(m)) by.set(m, all.get(m)!);
    return by;
  }
}
// How long a pass waits for the other askers of its moment.
const MARK_WAIT_MS = 30;
const wanted = new Set<string>();
let pass: Promise<Map<string, number[]>> | undefined;   // the pass that has not begun to read
let reading: Promise<unknown> = Promise.resolve();      // the pass that reads now
const marked = (j: Job, pids: number[]): Member[] => {
  if (!pids.length) return [];
  const self = selfLine();
  const near = new Set(members(j).map((m) => m.pid));
  return pids.flatMap((pid) => { const r = rowOf(pid); return dead(r) || self.has(pid) || near.has(pid) ? [] : [{ pid, group: r!.group, start: r!.start }]; });
};
function markedSoon(j: Job): Promise<Member[]> {
  if (j.cgroup) return Promise.resolve([]);
  const mark = markOf(j);
  wanted.add(mark);
  pass ??= reading.then(() => Bun.sleep(MARK_WAIT_MS)).then(() => {
    const now = [...wanted];
    wanted.clear();
    pass = undefined;
    const p = procfs.marks(now);
    reading = p.catch(() => {});
    return p;
  });
  return pass.then((by) => marked(j, by.get(mark) ?? []), () => []);
}
const markedNow = (j: Job, fresh = false): Member[] => (j.cgroup ? [] : marked(j, marksNow(fresh).get(markOf(j)) ?? []));
// Everything alive of a job, read here and now.
const aliveNow = (j: Job, fresh = false): Member[] => [...members(j, { fresh }), ...markedNow(j, fresh)];

// Ends at once what a terminal's end takes with it and a hangup did not: what is in the terminal's
// own process group and session, as a daemon that exits ends its terminals' commands. What the
// command started outside them (setsid, nohup in a session of its own) is left alone, as a
// background process of a command that ended is. Returns how many processes were still alive.
function sweep(j: Job, rows?: Map<number, Row>): number {
  const rest = members(j, { cgroup: false, rows });
  if (!rest.length) return 0;
  if (rest.some((m) => m.group === j.pid)) try { process.kill(-j.pid, "SIGKILL"); } catch {}
  for (const m of rest) if (m.group !== j.pid && procStart(m.pid) === m.start) try { process.kill(m.pid, "SIGKILL"); } catch {}
  return rest.length;
}

// Whether a job still holds its folder: it runs, or something it started is
// still alive in its cgroup after its command ended (a server left running in
// the background). Without a cgroup only what a stop left is known.
export function jobLive(j: Job): boolean {
  if (running(j)) return true;
  if (!j.cgroup) return false;
  if (cgroupPids(j).length) return true;
  j.cgroup = undefined;   // its scope is gone for good: nothing to read again
  return false;
}

// A job whose process is no longer the one it started as: ended, nothing signalled.
function gone(j: Job) {
  j.left = undefined;
  if (j.ended !== undefined) return;
  j.stopReason = `${j.stopReason ?? "was stopped"}: its process is gone`;
  finish(j, null, null);
  const a = adopted.get(j.id);
  if (a) { adopted.delete(j.id); a.resolve(); }
}

export const jobsOf = (sessionId: string) => [...jobs.values()].filter((j) => j.sessionId === sessionId);
// Every job this daemon holds: ended ones of the last MAX_ENDED, and older ones that still have processes.
export const allJobs = () => [...jobs.values()];
// The processes alive of a job, found by what the daemon holds it by: its cgroup, else its process group, its session
// and the mark only its own processes carry (a process that clears its environment and leaves the session is found
// by the cgroup alone). The daemon and what is above it are never in it. `name`: the process's own name.
export type JobProcess = { pid: number; start: string; name: string };
export async function jobProcesses(j: Job): Promise<JobProcess[]> {
  return (await processesOf([j])).get(j.id) ?? [];
}
// The same for many jobs at once: one read of the process table, and one pass over the marks for the jobs no
// cgroup holds (off the loop). Only jobs with something alive are in the answer.
export async function processesOf(list: Job[]): Promise<Map<string, JobProcess[]>> {
  const out = new Map<string, JobProcess[]>();
  if (!list.length) return out;
  const loose = list.filter((j) => j.contain !== "cgroup");
  const by = loose.length ? await procfs.marks(loose.map(markOf)).catch(() => new Map<string, number[]>()) : new Map<string, number[]>();
  const rows = procTable(true);
  const self = selfLine();
  for (const j of list) {
    const seen = new Set<number>();
    const ps: JobProcess[] = [];
    const add = (pid: number, start: string) => { if (!seen.has(pid) && !self.has(pid)) { seen.add(pid); ps.push({ pid, start, name: procName(pid) ?? "?" }); } };
    for (const m of members(j, { rows })) add(m.pid, m.start);
    for (const pid of by.get(markOf(j)) ?? []) { const r = rows.get(pid) ?? rowOf(pid); if (!dead(r)) add(pid, r!.start); }
    if (ps.length) out.set(j.id, ps);
  }
  return out;
}
// Whether anything of a job is alive now: its command, what a stop left, its cgroup, or (with no cgroup) its
// process group or session after its command ended (a server it started with `&`).
// Whether this daemon, or a process above it, is in the job's cgroup (a daemon a job started): a stop of the
// whole scope would end it too.
export const scopeHoldsSelf = (j: Job): boolean => { const self = selfLine(); return cgroupPids(j).some((p) => self.has(p)); };
// The same for a scope known by its folder (a scope of another daemon).
export const cgroupHoldsSelf = (cgroup: string): boolean => {
  const self = selfLine();
  try { return readFileSync(`${cgroup}/cgroup.procs`, "utf8").split("\n").filter(Boolean).some((p) => self.has(Number(p))); } catch { return false; }
};
// `fresh`: the process table is read now, not the snapshot the looks of the last few milliseconds share (a decision
// that a job's end settled something must not see a process the snapshot kept after it ended).
export const jobHasProcesses = (j: Job, fresh = false): boolean => jobLive(j) || members(j, { fresh }).length > 0;
// The pids alive of a job, as jobHasProcesses finds them (a wait looks at their open files).
// `fresh`: from the processes as they are now, not from the table the looks of one moment share.
export const jobPidsOf = (j: Job, fresh = false): number[] => members(j, { fresh }).map((m) => m.pid);
// The processes of each session's commands that still run, by what the daemon holds each command by: its cgroup
// (the scope it was started in), else its process group and session, each with its start time checked (members).
// Never by what a process says of itself: its environment is its own to set.
export function sessionRoots(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const j of jobs.values()) {
    if (!jobLive(j)) continue;
    const pids = members(j).map((m) => m.pid);
    if (pids.length) out.set(j.sessionId, [...(out.get(j.sessionId) ?? []), ...pids]);
  }
  return out;
}
// The processes of the commands sessions run (not the owner's terminal pane), each with its session:
// by what the daemon holds each command by, as sessionRoots. Who called the daemon's own API from
// one of them is read from this (src/server/caller.ts).
export function sessionCommandPids(): Map<number, string> {
  const out = new Map<number, string>();
  for (const j of jobs.values()) {
    if (j.by === "owner" || !jobLive(j)) continue;
    for (const m of members(j)) out.set(m.pid, j.sessionId);
  }
  for (const h of livingHeld()) for (const pid of heldPids(h)) out.set(pid, h.sessionId);
  return out;
}

// What a session runs outside the jobs table: a run_code program, a repository's checks. Each is held by
// its own scope's cgroup where the machine has them, else by its process group and session (it is started
// detached, as a job is) and the mark every process of it carries in its environment (one that took a
// session of its own is found by that), with its start time checked: while it runs, a request it makes
// to the daemon's API has that session's authority only (src/server/peer-scope.ts).
type Held = { sessionId: string; id: string; started: number; pid: number; boot?: string; cgroup?: string; ended?: boolean; gone?: boolean };
const held = new Set<Held>();
const asJob = (h: Held) => ({ id: h.id, started: h.started, pid: h.pid, boot: h.boot, cgroup: h.cgroup }) as unknown as Job;
const heldPids = (h: Held): number[] => h.cgroup ? cgroupPids(asJob(h)).filter((pid) => !dead(rowOf(pid))) : members(asJob(h)).map((m) => m.pid);
// The held programs, without the ones that ended and left nothing alive: what a program started stays its
// session's for as long as it runs.
function livingHeld(): Held[] {
  for (const h of held) if (h.ended && (h.cgroup ? !heldPids(h).length : h.gone)) held.delete(h);
  return [...held];
}
// The mark of a program of `sessionId` (`env`, for its environment) and `hold`, to call with its pid as
// soon as it started: the returned call says it ended (what it left running is still the session's).
// `cgroup`: the scope it runs in, when it has one.
export function sessionMark(sessionId: string, kind: string, cgroup?: string): { id: string; env: Record<string, string>; hold(pid: number): () => void } {
  const id = `${kind}${Math.random().toString(36).slice(2, 10)}`, started = Date.now();
  return {
    id, env: { [MARK]: markOf({ id, started }) },
    hold: (pid) => {
      const h: Held = { sessionId, id, started, pid, boot: procStart(pid), cgroup };
      held.add(h);
      return () => void (h.ended = true);
    },
  };
}
// Where a program of a session runs: a scope of its own (`kind` names it in the unit) around `argv` as the
// confinement left it, its scope's properties taken into this one as startJob does (`argv` back as it is
// where there are no scopes; `cgroup` is where the scope will be), with its mark (sessionMark).
export function sessionScope(kind: string, argv: string[], sessionId: string): { argv: string[]; cgroup?: string; env: Record<string, string>; hold(pid: number): () => void } {
  const unit = `keel-${kind}-${Math.random().toString(36).slice(2, 10)}.scope`;
  const { props, argv: inner } = splitScope(argv);
  const place = placeOf(sessionId);
  const cgroup = place.dir ? `/sys/fs/cgroup${place.dir}/${unit}` : undefined;
  const mark = sessionMark(sessionId, kind, cgroup);
  return { argv: place.dir ? [...scopeHead(), `--slice=${place.unit}`, `--unit=${unit}`, ...props, "--", ...inner] : argv, cgroup, env: mark.env, hold: mark.hold };
}
// The cgroups that hold a session's commands and programs now, each with its session: the folder of
// each live job's scope and of each held program's, with any folder made under one (a process may make
// a cgroup in its own scope and move into it). A socket made in one of them was made by that session.
export function sessionCgroups(): Map<string, string> {
  const out = new Map<string, string>();
  const add = (dir: string, sessionId: string, depth = 0) => {
    out.set(dir, sessionId);
    if (depth > 3) return;
    let names: import("node:fs").Dirent[];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) if (d.isDirectory()) add(join(dir, d.name), sessionId, depth + 1);
  };
  for (const j of jobs.values()) if (j.by !== "owner" && j.cgroup && jobLive(j) && j.cgroup) add(j.cgroup, j.sessionId);
  for (const h of livingHeld()) if (h.cgroup) add(h.cgroup, h.sessionId);
  return out;
}
// Whether a session may have processes that no cgroup of its holds: a command or program that runs, or
// that ended and was not yet looked at and found with nothing left (a look that finds nothing is final: a
// process gains a mark only from a marked parent). Its processes are found by sessionCallerPids.
export function sessionLooseProcesses(): boolean {
  for (const j of jobs.values()) if (j.by !== "owner" && (running(j) || (j.cgroup && jobLive(j)) || !j.markGone)) return true;
  return livingHeld().length > 0;
}
// The processes of sessions' commands that no cgroup holds, each with its session: by their group and
// session (sessionCommandPids), and by their mark, read off the loop with the other askers of the moment.
// Every process that is a session's, read off the loop as far as it can be and with the process table read
// again (a process that started since the table the moment shares was read is in no other answer): what
// the daemon holds of each command and program (its cgroup, its group and session), what carries a
// command's mark in its environment, and what descends from any of them (a process that left its scope
// for another, as `systemd-run --scope` does, still has its parent). For a socket that no session's
// cgroup made: the answer says whether a process of a session holds it all the same.
export async function sessionCallerPids(): Promise<Map<number, string>> {
  const marking = [...jobs.values()].filter((j) => j.by !== "owner" && (jobLive(j) || !j.markGone));
  const progs = livingHeld();
  const wanted = [...marking.map(markOf), ...progs.map((h) => markOf(h))];
  const by = wanted.length ? await procfs.marks(wanted).catch(() => new Map<string, number[]>()) : new Map<string, number[]>();
  const out = new Map<number, string>();
  const rows = procTable(true);
  const self = selfLine();
  const add = (pid: number, sessionId: string) => { const r = rows.get(pid); if (!dead(r) && !self.has(pid)) out.set(pid, sessionId); };
  for (const j of marking) {
    const near = jobLive(j) ? members(j, { rows }) : [];
    for (const m of near) add(m.pid, j.sessionId);
    const far = by.get(markOf(j)) ?? [];
    for (const pid of far) add(pid, j.sessionId);
    if (!near.length && !far.some((pid) => !dead(rows.get(pid))) && !running(j)) j.markGone = true;
  }
  for (const h of progs) {
    const near = heldPids(h);
    for (const pid of near) add(pid, h.sessionId);
    const far = by.get(markOf(h)) ?? [];
    for (const pid of far) add(pid, h.sessionId);
    if (h.ended && !near.length && !far.some((pid) => !dead(rows.get(pid)))) h.gone = true;
  }
  // What descends from them: each process's line of parents, up to one that is a session's.
  if (out.size) for (const [pid, r] of rows) {
    if (out.has(pid) || self.has(pid) || dead(r)) continue;
    for (let up = r.parent, i = 0; up > 1 && i < 64; i++) {
      const s = out.get(up);
      if (s) { out.set(pid, s); break; }
      if (self.has(up)) break;
      up = rows.get(up)?.parent ?? 0;
    }
  }
  return out;
}
// Live jobs (see jobLive) of any session whose folder is in `dir` or holds it (where links
// land): a job in a parent folder can write into it too.
export const jobsIn = (dir: string) => { const d = realOf(dir); return [...jobs.values()].filter((j) => { const c = realOf(j.cwd); return (contains(d, c) || contains(c, d)) && jobLive(j); }); };
export const findJob = (sessionId: string, id: string | number) =>
  [...jobs.values()].find((j) => j.sessionId === sessionId && (j.id === String(id) || j.num === Number(id)));

// A note for the model's next request, whatever starts it (the owner ran a command it should know
// of; a restart cut its agents).
export function addNotice(sessionId: string, text: string, o: Pick<Notice, "key" | "fresh" | "stored" | "job"> = {}) {
  const list = notices.get(sessionId) ?? [];
  list.push({ text, ...o });
  notices.set(sessionId, list);
}
export const hasNotice = (sessionId: string, key: string) => !!notices.get(sessionId)?.some((n) => n.key === key);
// Takes back the note under `key`: what it says was told another way (an input of its own).
export function takeNotice(sessionId: string, key: string) {
  const list = notices.get(sessionId);
  if (!list) return;
  const keep = list.filter((n) => n.key !== key);
  if (keep.length) notices.set(sessionId, keep);
  else notices.delete(sessionId);
}
// Whether the note that a background command ended still waits for its session's next request.
export const endNoticeOwed = (sessionId: string, jobId: string) => !!notices.get(sessionId)?.some((n) => n.job === jobId);

export function drainNotices(sessionId: string): Notice[] {
  const n = notices.get(sessionId) ?? [];
  notices.delete(sessionId);
  return n;
}

// What became of the command a tool call was running when a daemon restart
// cut the call, as its result tells the model (the engine asks through the
// callOutcome hook, src/server/routes/tools.ts). Asked in two places. While
// the daemon stops: the job is this daemon's own child, and its call either
// stops it (the shell tools), loses it with the terminal (a PTY) or leaves it
// running (an exec session without one). At the next start: the job was taken
// back (adoptJobs) and runs on, or ended meanwhile with or without an exit
// code. Nothing is returned for a call that started no command: its fate is
// not known here. Every text starts with RESTART_RAN (src/core/stops.ts).
//
// No sentence here says a command ended or was stopped without a look at
// what is alive of it (its group, its cgroup, what carries its mark): where
// something lives, the text says which process and how to stop it, and the
// job reads as running so its family's stop reaches it.
// `since`: when the cut turn began. A server that repeats call ids across
// turns must not give a call the command of an earlier turn.
export function cutCommand(sessionId: string, callId: string, o: { since?: number; now?: number } = {}): string | undefined {
  const now = o.now ?? Date.now();
  const j = [...jobs.values()].findLast((x) => x.sessionId === sessionId && x.callId === callId && (o.since === undefined || x.started >= o.since));
  if (!j) return undefined;
  const again = "Run it again if its work is still needed.";
  const upTo = `Its output up to then is in ${j.log}.`;
  // What the command started outside its terminal's group and session: left running, and named.
  const others = (rest: Member[]) => rest.length === 0 ? "" : rest.length === 1 ? ` 1 process it started still runs: pid ${rest[0]!.pid}.`
    : ` ${rest.length} processes it started still run: pids ${rest.slice(0, 8).map((m) => m.pid).join(", ")}${rest.length > 8 ? ", ..." : ""}.`;
  const outside = () => { const own = new Set(members(j, { cgroup: false, fresh: true }).map((m) => m.pid)); return aliveNow(j).filter((m) => !own.has(m.pid)); };
  if (j.ended === undefined && j.proc) {
    // The daemon is stopping. It ends its terminals' commands as it exits (a signal none of them can ignore).
    if (j.pty) return `${RESTART_RAN} It ran in a terminal the daemon held, so it ended with the daemon after ${span(now - j.started)}, before it finished.${others(outside())} ${upTo} ${again}`;
    if (j.stops) {
      // The call's stop of a command in front begins now. "Stopped" is said of a command seen to be gone:
      // it is signalled here and looked at for a moment; one that takes longer is said to be on its way out.
      // (Its own process is read first, a read each time; the rest only once it has ended.)
      const far = markedNow(j);
      signalJob(j, "SIGTERM", far);
      const look = () => [...members(j, { fresh: true }), ...far.filter((m) => lives(m.pid, m.start))];
      let left = look();
      for (const until = Date.now() + CONFIRM_MS; left.length && Date.now() < until;) { Bun.sleepSync(3); if (!lives(j.pid, j.boot)) left = look(); }
      if (!left.length) {
        // It finished by itself in the moment of the stop (its wrapper wrote its exit code): it was not stopped.
        const own = exitOf(j.log);
        if (own?.code != null) return `${RESTART_RAN} The command was not interrupted: it exited with code ${own.code} after ${span((own.at ?? now) - j.started)}. Its output is in ${j.log}. Do not run it again for its result.`;
        return `${RESTART_RAN} The restart stopped the command after ${span(now - j.started)}, before it finished. ${upTo} ${again}`;
      }
      // What is left is the job's still: it reads as running, and a stop of it goes on from here.
      setLeft(j, left);
      j.looked = Date.now();
      return `${RESTART_RAN} The restart is stopping the command after ${span(now - j.started)}, before it finished: ${left.length === 1 ? "1 process of it has" : `${left.length} processes of it have`} not ended yet, and the next start ends what is left and says so if it cannot. ${upTo} ${again}`;
    }
  }
  // A stop that was under way when the daemon went down: this start is finishing it (adoptJobs), whether or
  // not the command's own process had ended by then, and says so later if something of it cannot be ended.
  if (j.stopping && !j.proc) return `${RESTART_RAN} The command ${j.stopReason ?? "was being stopped"} before the daemon went down, and that stop is finished at this start, before the command finished. ${upTo} ${again}`;
  if (j.ended === undefined) {
    if (!j.background) backgrounded(j);
    // The turn was waiting on it: its end starts the session's next turn.
    if (!j.wake) { j.wake = true; if (!j.pty) patchMeta(j.log, { wake: true }); }
    const named = j.handle === "num" ? `session ID ${j.num}` : j.handle === "pid" ? `PID ${j.pid}` : `ID: ${j.id}`;
    return `${RESTART_RAN} The command was not interrupted: it still runs in the background (${named}). Its output is being written to ${j.log}. Do not start it again: you are told when it ends.`;
  }
  // Its end is told here: the note a background job's end makes would say it twice.
  const mine = (notices.get(sessionId) ?? []).filter((n) => n.job === j.id);
  if (mine.length) {
    notices.set(sessionId, (notices.get(sessionId) ?? []).filter((n) => n.job !== j.id));
    ackNotices(mine);
  }
  // It ended, as far as its own process goes. What is alive of it now? For a terminal's command: what
  // is in the terminal's own group and session (ended at this start, and given a moment to go); what
  // it started outside them is left running and named. For any other: all of it.
  const lost = j.pty && j.exitCode == null && !j.signal && !j.stopReason;
  let left = lost ? members(j, { cgroup: false, fresh: true }) : aliveNow(j);
  for (let i = 0; j.swept && left.length && i < 20; i++) { Bun.sleepSync(5); left = members(j, { cgroup: false, fresh: true }); }
  const ended = j.pty && j.exitCode == null && !j.signal && !j.stopReason ? "Its terminal ended with the daemon"
    : j.stopReason ? `The command ${j.stopReason}` : j.exitCode == null ? `The command's own process ended meanwhile${j.signal ? ` (killed by ${j.signal})` : ""}` : `The command's own process exited with code ${j.exitCode}`;
  if (left.length) {
    const pids = left.map((m) => m.pid);
    setLeft(j, left);
    j.looked = Date.now();
    jobsChanged.tell?.(sessionId);
    const which = pids.length === 1 ? `process ${pids[0]} of it still runs` : `${pids.length} processes of it still run (${pids.slice(0, 4).join(", ")}${pids.length > 4 ? ", ..." : ""})`;
    // Claude's family stops a job by its ID; the others have no such tool, so the processes are named for their shell.
    const stop = (j.handle ?? "id") === "id" ? `TaskStop with ID ${j.id}` : `\`kill ${pids.slice(0, 8).join(" ")}\` in the shell`;
    return `${RESTART_RAN} ${ended}, but ${which}. Do not run the command again before ${pids.length === 1 ? "it is" : "they are"} stopped: ${stop}. Its output is in ${j.log}.`;
  }
  if (lost) {
    const swept = j.swept ? ` (${j.swept === 1 ? "1 process of it had outlived the terminal and was" : `${j.swept} processes of it had outlived the terminal and were`} ended at this start)` : "";
    return `${RESTART_RAN} It ran in a terminal the daemon held, so it ended with the daemon${swept}, before it finished.${others(outside())} ${upTo} ${again}`;
  }
  if (j.stopReason) return `${RESTART_RAN} The command ${j.stopReason} after ${span(j.ended - j.started)}, before it finished. ${upTo} ${again}`;
  if (j.exitCode == null) return `${RESTART_RAN} The command ended meanwhile${j.signal ? ` (killed by ${j.signal})` : ""}; its exit code was not recorded. Its output is in ${j.log}: read it before running the command again.`;
  const down = whileDown(j.ended, lastDown());
  return `${RESTART_RAN} The command was not interrupted: it exited with code ${j.exitCode} after ${span(j.ended - j.started)}${down ? `; it ended ${down}` : ""}. Its output is in ${j.log}. Do not run it again for its result.`;
}
// How long a call a restart cut waits to see its command gone before it says so.
const CONFIRM_MS = 60;
const span = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; };

// The notes are stored: their jobs' ends are reported for good.
export function ackNotices(list: Notice[]) {
  for (const n of list) if (n.log) patchMeta(n.log, { reported: true });
}

// What routes send of a job: the whole view with secrets as placeholders.
export const jobView = (j: Job) => concealDeep({
  id: j.id, num: j.num, command: j.command, description: j.description, cwd: j.cwd, pty: j.pty, log: j.log,
  started: j.started, ended: j.ended, exit_code: j.exitCode, signal: j.signal, background: j.background, bytes: size(j.log),
  running: running(j), last: lastLine(j.log), call_id: j.callId, by: j.by, stop_reason: j.stopReason,
  contain: j.contain, contain_why: j.containWhy, left: j.left,
}, j.sessionId);

// The last line a job printed (a progress line, an ETA), for the owner's view
// of what a background run is doing without opening its log.
export function lastLine(log: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(log, "r");
    const size = fstatSync(fd).size;
    const n = Math.min(size, 4096);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return lastLineOf(buf.toString("utf8"));
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
// The last line with something on it of a log's end (its last 4096 bytes).
export function lastLineOf(end: string): string | undefined {
  const line = cleanTerm(end).split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return line && conceal(line).slice(0, 300);
}

// A PTY cannot outlive its terminal; every other job runs on and is adopted.
process.on("exit", () => {
  for (const j of jobs.values()) if (running(j) && j.pty) try { sweep(j); } catch {}
});
