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
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conceal, concealDeep, secretPairs, streamConcealer } from "../core/conceal.ts";
import { contains, realOf } from "../core/paths.ts";
import { readStat } from "../core/pid.ts";
import { readText } from "../core/proc.ts";
import { RESTART_RAN } from "../core/stops.ts";
import { lastDown, whileDown } from "../core/late.ts";
import { sandboxStatus, scopeHead, splitScope } from "../safety/sandbox.ts";

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
  // Its call was cut by a restart while the command ran in front and the command
  // ran on: the turn was waiting on it, so its end starts a turn (see finish).
  wake?: boolean;
  owes?: boolean;        // it ended and the input that says so is not stored yet
  swept?: number;        // processes of it that outlived its terminal and were ended at this start
  looked?: number;       // when what a stop left was last looked for
  by?: "owner";          // the owner ran it from the terminal pane
  pid: number;
  boot?: string;         // its process's start time, read when it started (Linux)
  readOff: number;       // bytes of the log already handed to the model
  taken?: number;        // bytes the last read covered (more than it showed when it was cut)
  decoder: TextDecoder;
  left?: number[];       // what a stop could not end of its group (it still runs)
  leftStart?: Map<number, string>;   // each one's start time, so a pid given to another process is not taken for it
  proc?: Subprocess<any, any, any>;   // absent for a job adopted after a restart
  exited: Promise<void>;
};

export type Handle = "id" | "num" | "pid";
// The variable every process of a job carries, and its value for one job.
const MARK = "KEEL_JOB";
const markOf = (j: { id: string; started: number }) => `${j.id}.${j.started}`;
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

// Variables one tool call adds for the process it starts (a secret a command
// refers to as $KEEL_SECRET_<id>): taken by the job that call starts.
const callEnvs = new Map<string, Record<string, string>>();
export const setCallEnv = (callId: string, env: Record<string, string>) => void callEnvs.set(callId, env);
export const dropCallEnv = (callId: string) => void callEnvs.delete(callId);

export function toolEnv(sessionId: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.test(k) && !OWN_ENV.test(k)) env[k] = v;
  for (const f of envProviders) Object.assign(env, f(sessionId));
  return { ...env, KEEL_SESSION: sessionId, ...extra };
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
  background?: boolean;
  // The session confinement (a beforeTool hook sets ctx.wrapSpawn).
  wrap?: (argv: string[]) => string[];
  callId?: string;
  by?: "owner";
  handle?: Handle;
  stops?: boolean;       // the call stops the command when its turn is stopped
};

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
  const extra = o.callId ? callEnvs.get(o.callId) : undefined;
  if (o.callId) callEnvs.delete(o.callId);
  const started = Date.now();
  // Every process of the job carries its mark: one that left the job's group and session (setsid, a
  // double fork) is still found where there is no cgroup to hold it (see members).
  const env = { ...(o.env ?? toolEnv(o.sessionId)), ...NO_PAGER, ...extra, [MARK]: markOf({ id, started }) };
  // What is kept and shown is the command with placeholders: a value the
  // secret hook put in only reaches the process.
  const job = { id, num, sessionId: o.sessionId, command: conceal(o.command, o.sessionId), description: o.description && conceal(o.description, o.sessionId), cwd: o.cwd, pty: !!o.pty,
    log, started, background: !!o.background, readOff: 0, decoder: new TextDecoder(), callId: o.callId, by: o.by, handle: o.handle, stops: o.stops } as Job;
  const unit = `keel-job-${id}-${Math.random().toString(36).slice(2, 8)}.scope`;
  if (box.slice) { job.contain = "cgroup"; job.cgroup = `/sys/fs/cgroup${box.slice}/${unit}`; }
  else { job.contain = "group"; job.containWhy = box.why; }
  const scoped = (a: string[]) => box.slice ? [...scopeHead(), "--slice=app.slice", `--unit=${unit}`, ...props, "--", ...a] : a;
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
    const script = pairs.length
      ? 'p=$KEEL_CONCEAL; b=$KEEL_CONCEAL_BIN; f=$KEEL_CONCEAL_JS; unset KEEL_CONCEAL KEEL_CONCEAL_BIN KEEL_CONCEAL_JS; "$@" 2>&1 | KEEL_CONCEAL="$p" BUN_BE_BUN=1 "$b" -e "$f"; c=${PIPESTATUS[0]}; echo $c > "$0"; exit $c'
      : '"$@"; c=$?; echo $c > "$0"; exit $c';
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
  // Ended jobs are kept for their output and status, the newest MAX_ENDED of
  // them: a long-running daemon does not hold every command it ever ran (the
  // logs stay on disk).
  let ended = 0;
  for (const j of [...jobs.values()].reverse()) if (!running(j) && ++ended > MAX_ENDED) jobs.delete(j.id);
  return job;
}

// Where jobs' scopes go: the user manager's app.slice, when systemd --user
// and cgroup v2 are there (read once).
let scopeAt: { slice?: string; why?: string } | undefined;
function jobScope(): { slice?: string; why?: string } {
  if (scopeAt) return scopeAt;
  if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) return (scopeAt = { why: "cgroup v2 is not mounted" });
  const st = sandboxStatus();
  if (!st.scope) return (scopeAt = { why: st.scopeReason ?? "no systemd user manager" });
  const r = Bun.spawnSync(["systemctl", "--user", "show", "-p", "ControlGroup", "--value", "app.slice"], { stdout: "pipe", stderr: "ignore" });
  const slice = r.success ? r.stdout.toString().trim() : "";
  return (scopeAt = slice.startsWith("/") ? { slice } : { why: "the user manager names no cgroup for app.slice" });
}

// The sidecar of a job's log: what adoption needs, and once it ended how it
// ended, so the terminal pane lists commands of earlier daemons too.
export type Meta = {
  id: string; num: number; sessionId: string; command: string; description?: string; cwd: string; started: number; background: boolean; pid: number;
  boot?: string; reported?: boolean; pty?: boolean; call_id?: string; by?: "owner"; handle?: Handle;
  stopping?: true;   // a stop was under way when this was written: a daemon that went down then left it for the next one
  wake?: true;       // its end starts a turn of its session (a call a restart cut was waiting on it)
  cgroup?: string; contain?: "cgroup" | "group"; contain_why?: string;
  ended?: number; exit_code?: number | null; signal?: string | null; stop_reason?: string;
  read_off?: number; // bytes of the log the model was handed (a later daemon goes on from there)
};
const meta = (j: Job, pid: number): Meta => ({
  id: j.id, num: j.num, sessionId: j.sessionId, command: j.command, description: j.description, cwd: j.cwd,
  started: j.started, background: j.background, pid, boot: j.boot ?? procStart(pid), call_id: j.callId, by: j.by, handle: j.handle, stopping: j.stopping || undefined, wake: j.wake || undefined, read_off: j.readOff,
  cgroup: j.cgroup, contain: j.contain, contain_why: j.containWhy,
});
// Every sidecar write goes through here: the whole record with secrets as placeholders.
function writeMeta(log: string, m: Meta) {
  writeFileSync(metaPath(log), JSON.stringify(concealDeep(m, m.sessionId)));
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
  jobsChanged.tell?.(job.sessionId);
}

// What a command's end wakes: a session whose turn was waiting on it when a restart cut the call
// (`wake`). The daemon delivers `text` as an input that starts a turn and calls `sent` once it is
// stored, or calls `note` where the end starts no turn (someone stopped the command, the owner
// stopped the session): it then goes with the session's next request, as a background command's
// end does. With nobody to deliver it (no daemon: a test, a probe) the end is that note.
export const jobEnded: { tell?: (job: Job, text: string, then: { sent: () => void; note: () => void }) => void } = {};

// `at`: when it ended, for one that ended while no daemon watched it (its exit file's time).
function finish(job: Job, code: number | null, signal: string | null, at?: number) {
  if (job.ended !== undefined) return;
  job.ended = at ?? Date.now();
  job.exitCode = code;
  job.signal = signal;
  if (job.background) queueMicrotask(() => jobsChanged.tell?.(job.sessionId));
  // A background job's end counts as reported once its note is stored (ackNotices), not before:
  // a restart between the two reports it again.
  try {
    writeMeta(job.log, { ...meta(job, job.pid), reported: !job.background, pty: job.pty || undefined, ended: job.ended, exit_code: code, signal, stop_reason: job.stopReason });
  } catch {}
  if (job.background) {
    // (The command and its description are the model's own words; on one line, so nothing of them reads as a line of the harness.)
    const line = (t: string) => t.replace(/[\x00-\x1f\x7f]+/g, " ");
    const what = job.description ? `"${line(job.description)}"` : `\`${line(job.command.slice(0, 80))}\``;
    const how = job.stopReason ?? (signal ? `was killed by ${signal}` : code === null ? "ended; its exit code was not recorded (it ended under another daemon, or was killed)" : `exited with code ${code}`);
    // One that ended while no daemon watched it is told now, at this start: it says when it really ended.
    const down = at !== undefined ? whileDown(at, lastDown()) : undefined;
    const when = down ? ` It ended ${down}.` : "";
    const note = () => {
      const list = notices.get(job.sessionId) ?? [];
      list.push({ text: `Background command ${what} (ID ${job.id}) ${how}.${when} Output: ${job.log}`, job: job.id, log: job.log });
      notices.set(job.sessionId, list);
    };
    // A command a cut call was waiting on: its end is what that turn waited for, so it starts one.
    // What it printed is not part of the input: it is tool output, read from the log with a tool.
    if (job.wake && jobEnded.tell) {
      // Named by words of its own that cannot read as a tag or a line of the harness inside this input.
      const named = what.replace(/[<>\[\]]/g, "'").replace(/(?<=.)`(?=.)/g, "'");
      const text = `[harness] The command you were running when the daemon restarted has ended, after ${span(job.ended - job.started)}: ${named} (ID ${job.id}) ${how}.${when} Its output is in ${job.log}.`;
      job.owes = true;
      jobEnded.tell(job, text, { sent: () => { job.owes = false; patchMeta(job.log, { reported: true }); }, note: () => { job.owes = false; note(); } });
      return;
    }
    note();
  }
}

// The commands of a session that a cut call was waiting on and that still run: its turn ended
// (the model was told they run on), and their end starts its next one.
// One that ended counts until the input that says so is stored: its session is still owed that turn.
export const awaited = (sessionId: string) => [...jobs.values()].filter((j) => j.sessionId === sessionId && j.wake && (running(j) || j.owes));

// After a restart: take back the jobs a previous daemon started under
// `spillRoot/<session>/jobs/`. One still running is watched until it ends; one
// that ended unreported is reported now. Ended ones come back as history, so
// their logs open under the same IDs, and new jobs never reuse their numbers.
// Returns how many were taken back to watch or report.
// Why a record of a job is not this daemon's to act on; undefined: it is. A record is read back
// from a file, and a stop of its job signals the process and empties the cgroup it names, so it is
// held against what a daemon really started: the process carries the job's mark in its environment
// (startJob puts it there, and nothing else has it), it started when the record says, and the cgroup
// is the job's own scope. A record whose process has ended names nothing to signal.
function notOurs(m: Meta): string | undefined {
  if (typeof m.id !== "string" || !/^[\w-]+$/.test(m.id) || !Number.isInteger(m.pid) || m.pid <= 1 || typeof m.started !== "number") return "it names no job and process a daemon could have started";
  if (m.cgroup !== undefined && !new RegExp(`^/sys/fs/cgroup/[^\\0]*/keel-job-${m.id}-[a-z0-9]{1,8}\\.scope$`).test(m.cgroup)) return "the cgroup it names is not that job's scope";
  if (m.cgroup?.split("/").includes("..")) return "the cgroup it names is not that job's scope";
  if (process.platform !== "linux") return undefined;
  const now = procStart(m.pid);
  if (now === undefined) return undefined; // ended: nothing is signalled by pid
  if (!m.boot) return `it does not say when process ${m.pid} started`;
  if (now !== m.boot) return undefined; // another process has the number now: the job has ended (alive)
  let env: Buffer;
  try { env = procfs.environ(m.pid); } catch { return `process ${m.pid} cannot be read, so it cannot be told to be the job's`; }
  const mark = Buffer.from(`${MARK}=${markOf(m)}`);
  for (let at = env.indexOf(mark); at >= 0; at = env.indexOf(mark, at + 1)) {
    if ((at === 0 || env[at - 1] === 0) && (at + mark.length === env.length || env[at + mark.length] === 0)) return undefined;
  }
  return `process ${m.pid} was not started as that job (it does not carry the job's mark)`;
}

// `refused`: told each record that is not adopted, with why.
export function adoptJobs(spillRoot: string, refused?: (file: string, why: string) => void): number {
  let n = 0;
  let sessions: string[] = [];
  try { sessions = readdirSync(spillRoot); } catch { return 0; }
  const history: Job[] = [];
  const terminals: Job[] = [];
  for (const sid of sessions) {
    const dir = join(spillRoot, sid, "jobs");
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      let m: Meta;
      try { m = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      if (!m || typeof m !== "object") continue;
      const why = notOurs(m);
      if (why) { refused?.(join(dir, f), why); continue; }
      counter = Math.max(counter, m.num ?? 0);
      if (jobs.has(m.id)) continue;
      const log = join(dir, `${m.id}.log`);
      // A sidecar an older daemon wrote with a value in it: rewritten with placeholders.
      const shown = concealDeep(m, m.sessionId);
      if (JSON.stringify(shown) !== JSON.stringify(m)) { m = shown; writeMeta(log, m); }
      const base = { id: m.id, num: m.num, sessionId: m.sessionId, command: m.command, description: m.description, cwd: m.cwd,
        pty: !!m.pty, log, started: m.started, background: m.background, pid: m.pid, boot: m.boot, readOff: m.read_off ?? 0, decoder: new TextDecoder(),
        callId: m.call_id, by: m.by, handle: m.handle, cgroup: m.cgroup, contain: m.contain ?? "group", containWhy: m.contain_why };
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
        const j: Job = { ...base, wake: m.wake, readOff: m.read_off ?? size(log), ended: m.ended ?? m.started, exitCode: m.exit_code ?? null, signal: m.signal ?? null, stopReason: m.stop_reason, exited: Promise.resolve() };
        history.push(j);
        finishStop(j);
        // A terminal the daemon held is gone with it. What ignored the hangup (the daemon was killed, so
        // nothing ended it as an exit does) is ended below, as a daemon that exits ends its terminals' commands.
        // (Looked at once: the record says it ended, so a later start does not look for it again.)
        if (m.pty && m.ended === undefined) { terminals.push(j); patchMeta(log, { ended: m.started }); }
        continue;
      }
      let resolve!: () => void;
      // A command in front whose stop was under way was told to its call; a background one's end is a note of its own.
      const job: Job = { ...base, pty: false, wake: m.wake, stopping: !!m.stopping, stopReason: m.stopping ? m.stop_reason : undefined, background: m.background || !m.stopping, exited: new Promise<void>((r) => (resolve = r)) };
      jobs.set(job.id, job);
      adopted.set(job.id, { job, meta: m, resolve });
      finishStop(job);
      n++;
    }
  }
  for (const j of history.sort((a, b) => b.started - a.started).slice(0, MAX_ENDED)) jobs.set(j.id, j);
  // One read of the process table for all of them, however many records an upgrade left without an end.
  if (terminals.length) { const rows = procTable(true); for (const j of terminals) j.swept = sweep(j, rows); }
  if (adopted.size) { watchAdopted(); watcher ??= setInterval(watchAdopted, 1000); }
  return n;
}

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
  if (j.left && Date.now() - (j.looked ?? 0) >= LOOK_MS) {
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
  if (!jobLive(j)) {
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
  if (sig === "SIGKILL" && j.cgroup) try { writeFileSync(`${j.cgroup}/cgroup.kill`, "1"); } catch {}
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
type Row = { state: string; group: number; session: number; start: string };
const TABLE_MS = 15;
let table: { at: number; rows: Map<number, Row> } | undefined;
function procTable(fresh = false): Map<number, Row> {
  if (!fresh && table && Date.now() - table.at < TABLE_MS) return table.rows;
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
}
function rowOf(pid: number): Row | undefined {
  try {
    const st = procfs.stat(pid);
    const f = st.slice(st.lastIndexOf(") ") + 2).split(" ");
    return { state: f[0]!, group: Number(f[2]), session: Number(f[3]), start: f[19]! };
  } catch { return undefined; }
}
const dead = (r: Row | undefined) => !r || r.state === "Z" || r.state === "X";
// Whether a process is alive and still the one it was (`start`: its start time when it was found).
const lives = (pid: number, start?: string) => { const r = rowOf(pid); return !dead(r) && (start === undefined || r!.start === start); };
// This daemon and the processes above it: never part of a job it looks at, also when one of them
// carries a job's mark or sits in its group (a daemon a job started, over the same state folder).
let line: { at: number; pids: Set<number> } | undefined;
function selfLine(): Set<number> {
  if (line && Date.now() - line.at < 1000) return line.pids;
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
  if (!fresh && marks && Date.now() - marks.at < MARKS_MS) return marks.by;
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
    const [out, code] = await Promise.all([readText(p.stdout, "the look for jobs' marks"), p.exited]);
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
// Live jobs (see jobLive) of any session whose folder is in `dir` or holds it (where links
// land): a job in a parent folder can write into it too.
export const jobsIn = (dir: string) => { const d = realOf(dir); return [...jobs.values()].filter((j) => { const c = realOf(j.cwd); return (contains(d, c) || contains(c, d)) && jobLive(j); }); };
export const findJob = (sessionId: string, id: string | number) =>
  [...jobs.values()].find((j) => j.sessionId === sessionId && (j.id === String(id) || j.num === Number(id)));

// A note for the model's next request, whatever starts it (the owner ran a command it should know
// of; a restart cut its agents).
export function addNotice(sessionId: string, text: string, o: Pick<Notice, "key" | "fresh" | "stored"> = {}) {
  const list = notices.get(sessionId) ?? [];
  list.push({ text, ...o });
  notices.set(sessionId, list);
}
export const hasNotice = (sessionId: string, key: string) => !!notices.get(sessionId)?.some((n) => n.key === key);

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
