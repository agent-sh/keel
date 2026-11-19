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
  background: boolean;   // the model was told it runs on; its end is reported
  callId?: string;       // the tool call that started it
  by?: "owner";          // the owner ran it from the terminal pane
  pid: number;
  readOff: number;       // bytes of the log already handed to the model
  decoder: TextDecoder;
  proc?: Subprocess<any, any, any>;   // absent for a job adopted after a restart
  exited: Promise<void>;
};

export const UNREAD_CAP = 1 << 20;
const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
const metaPath = (log: string) => log.replace(/\.log$/, ".json");
const exitPath = (log: string) => `${log}.exit`;
const jobs = new Map<string, Job>();
const MAX_ENDED = 200;
const notices = new Map<string, string[]>();
let counter = 0;

// Provider credentials never reach a tool shell: a command the model writes
// could print or send them.
const SECRET_ENV = /^(ANTHROPIC_|OPENAI_|AWS_BEARER_TOKEN|AWS_SECRET|AWS_SESSION_TOKEN|CLAUDE_CODE_|GEMINI_API|GOOGLE_API_KEY|OPENROUTER_|XAI_|GROQ_|MISTRAL_|DEEPSEEK_|FIREWORKS_|KIMI_|MOONSHOT_|ZAI_|GLM_)/;
// Variables a feature adds to a session's commands (the secrets it was given).
const envProviders: ((sessionId: string) => Record<string, string>)[] = [];
export const registerEnv = (f: (sessionId: string) => Record<string, string>) => void envProviders.push(f);

export function toolEnv(sessionId: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.test(k)) env[k] = v;
  for (const f of envProviders) Object.assign(env, f(sessionId));
  return { ...env, KEEL_SESSION: sessionId, ...extra };
}

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
};

export function startJob(o: StartOpts): Job {
  mkdirSync(o.logDir, { recursive: true });
  const num = ++counter;
  const id = `b${num.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const log = join(o.logDir, `${id}.log`);
  writeFileSync(log, "");
  const bare = o.argv ?? ["bash", "-c", o.command];
  const argv = o.wrap ? o.wrap(bare) : bare;
  const env = o.env ?? toolEnv(o.sessionId);
  const job = { id, num, sessionId: o.sessionId, command: o.command, description: o.description, cwd: o.cwd, pty: !!o.pty,
    log, started: Date.now(), background: !!o.background, readOff: 0, decoder: new TextDecoder(), callId: o.callId, by: o.by } as Job;
  if (o.pty) {
    job.proc = Bun.spawn(argv, {
      cwd: o.cwd, env: { ...env, TERM: "xterm-256color" },
      terminal: { cols: 200, rows: 50, data: (_t, d) => { try { appendFileSync(log, d); } catch {} } },
    });
  } else {
    // The wrapper sits outside any sandbox wrap: it writes the exit code next
    // to the log, where a later daemon finds it.
    const fd = openSync(log, "a");
    try {
      job.proc = Bun.spawn(["bash", "-c", '"$@"; c=$?; echo $c > "$0"; exit $c', exitPath(log), ...argv], {
        cwd: o.cwd, env, stdin: "ignore", stdout: fd, stderr: fd, detached: true,
      });
    } finally { closeSync(fd); }
  }
  // A PTY's record is history only: it never outlives its daemon to be adopted.
  writeFileSync(metaPath(log), JSON.stringify({ ...meta(job, job.proc.pid), ...(o.pty ? { pty: true, reported: true } : {}) }));
  job.pid = job.proc.pid;
  const proc = job.proc;
  job.exited = proc.exited.then((code) => {
    if (job.pty) proc.terminal?.close();
    finish(job, code, proc.signalCode == null ? null : String(proc.signalCode));
  });
  jobs.set(id, job);
  // Ended jobs are kept for their output and status, the newest MAX_ENDED of
  // them: a long-running daemon does not hold every command it ever ran (the
  // logs stay on disk).
  let ended = 0;
  for (const j of [...jobs.values()].reverse()) if (!running(j) && ++ended > MAX_ENDED) jobs.delete(j.id);
  return job;
}

// The sidecar of a job's log: what adoption needs, and once it ended how it
// ended, so the terminal pane lists commands of earlier daemons too.
export type Meta = {
  id: string; num: number; sessionId: string; command: string; description?: string; cwd: string; started: number; background: boolean; pid: number;
  boot?: string; reported?: boolean; pty?: boolean; call_id?: string; by?: "owner";
  ended?: number; exit_code?: number | null; signal?: string | null; stop_reason?: string;
};
const meta = (j: Job, pid: number): Meta => ({
  id: j.id, num: j.num, sessionId: j.sessionId, command: j.command, description: j.description, cwd: j.cwd,
  started: j.started, background: j.background, pid, boot: procStart(pid), call_id: j.callId, by: j.by,
});

// The start time of a process (Linux), so a reused pid is not taken for the job.
function procStart(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]; } catch { return undefined; }
}
function alive(m: Meta): boolean {
  try { process.kill(m.pid, 0); } catch (e: any) { if (e?.code !== "EPERM") return false; }
  const now = procStart(m.pid);
  return !m.boot || !now || now === m.boot;
}

function finish(job: Job, code: number | null, signal: string | null) {
  if (job.ended !== undefined) return;
  job.ended = Date.now();
  job.exitCode = code;
  job.signal = signal;
  try {
    writeFileSync(metaPath(job.log), JSON.stringify({ ...meta(job, job.pid), reported: true, pty: job.pty || undefined, ended: job.ended, exit_code: code, signal, stop_reason: job.stopReason }));
  } catch {}
  if (job.background) {
    const what = job.description ? `"${job.description}"` : `\`${job.command.slice(0, 80)}\``;
    const how = job.stopReason ?? (signal ? `was killed by ${signal}` : code === null ? "ended while Keel restarted; its exit code is unknown" : `exited with code ${code}`);
    const list = notices.get(job.sessionId) ?? [];
    list.push(`Background command ${what} (ID ${job.id}) ${how}. Output: ${job.log}`);
    notices.set(job.sessionId, list);
  }
}

// After a restart: take back the jobs a previous daemon started under
// `spillRoot/<session>/jobs/`. One still running is watched until it ends; one
// that ended meanwhile is reported now. Jobs already reported stay history.
export function adoptJobs(spillRoot: string): number {
  let n = 0;
  let sessions: string[] = [];
  try { sessions = readdirSync(spillRoot); } catch { return 0; }
  for (const sid of sessions) {
    const dir = join(spillRoot, sid, "jobs");
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      let m: Meta;
      try { m = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      if (m.reported || jobs.has(m.id)) continue;
      const log = join(dir, `${m.id}.log`);
      let resolve!: () => void;
      const job: Job = { id: m.id, num: m.num, sessionId: m.sessionId, command: m.command, description: m.description, cwd: m.cwd,
        pty: false, log, started: m.started, background: true, pid: m.pid, readOff: size(log), decoder: new TextDecoder(), callId: m.call_id, by: m.by,
        exited: new Promise<void>((r) => (resolve = r)) };
      counter = Math.max(counter, m.num);
      jobs.set(job.id, job);
      adopted.set(job.id, { job, meta: m, resolve });
      n++;
    }
  }
  if (adopted.size) { watchAdopted(); watcher ??= setInterval(watchAdopted, 1000); }
  return n;
}

const adopted = new Map<string, { job: Job; meta: Meta; resolve: () => void }>();
let watcher: Timer | undefined;
function watchAdopted() {
  for (const [id, a] of adopted) {
    const ex = exitPath(a.job.log);
    const done = existsSync(ex);
    if (!done && alive(a.meta)) continue;
    let code: number | null = null;
    if (done) { const c = Number.parseInt(readFileSync(ex, "utf8"), 10); code = Number.isFinite(c) ? c : null; }
    finish(a.job, code, null);
    adopted.delete(id);
    a.resolve();
  }
  if (!adopted.size && watcher) { clearInterval(watcher); watcher = undefined; }
}

export const running = (j: Job) => j.ended === undefined;
// The pids of the jobs still running, adopted ones included (after a restart
// they are no longer the daemon's children).
export const jobPids = () => [...jobs.values()].filter(running).map((j) => j.pid);

// Resolves true when the job ended within ms, false when it is still running.
export async function waitJob(j: Job, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!running(j)) return true;
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

// What the job printed since the last call (at most the last MiB of it).
export function takeUnread(j: Job): string {
  const end = size(j.log);
  if (end <= j.readOff) return "";
  const from = Math.max(j.readOff, end - UNREAD_CAP);
  const fd = openSync(j.log, "r");
  try {
    const buf = Buffer.alloc(end - from);
    readSync(fd, buf, 0, buf.length, from);
    j.readOff = end;
    return j.decoder.decode(buf, { stream: true });
  } finally { closeSync(fd); }
}

export const hasUnread = (j: Job) => size(j.log) > j.readOff;

export function writeJob(j: Job, chars: string): boolean {
  if (!running(j) || !j.pty || !j.proc?.terminal) return false;
  j.proc.terminal.write(chars);
  return true;
}

// Stop the whole process group: TERM, then KILL if it lingers.
export async function stopJob(j: Job, reason = "was stopped"): Promise<void> {
  if (!running(j)) return;
  j.stopReason = reason;
  const pid = j.pid;
  const kill = (sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch { try { j.proc ? j.proc.kill(sig) : process.kill(pid, sig); } catch {} } };
  kill("SIGTERM");
  if (!(await waitJob(j, 2000))) kill("SIGKILL");
  await waitJob(j, 2000);
}

export const jobsOf = (sessionId: string) => [...jobs.values()].filter((j) => j.sessionId === sessionId);
export const findJob = (sessionId: string, id: string | number) =>
  [...jobs.values()].find((j) => j.sessionId === sessionId && (j.id === String(id) || j.num === Number(id)));

// A note for the model's next request (the owner ran a command it should know of).
export function addNotice(sessionId: string, text: string) {
  const list = notices.get(sessionId) ?? [];
  list.push(text);
  notices.set(sessionId, list);
}

export function drainNotices(sessionId: string): string[] {
  const n = notices.get(sessionId) ?? [];
  notices.delete(sessionId);
  return n;
}

export const jobView = (j: Job) => ({
  id: j.id, num: j.num, command: j.command, description: j.description, cwd: j.cwd, pty: j.pty, log: j.log,
  started: j.started, ended: j.ended, exit_code: j.exitCode, signal: j.signal, background: j.background, bytes: size(j.log),
  running: running(j), last: lastLine(j.log), call_id: j.callId, by: j.by, stop_reason: j.stopReason,
});

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
    const line = cleanTerm(buf.toString("utf8")).split("\n").map((l) => l.trim()).filter(Boolean).pop();
    return line?.slice(0, 300);
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

// A PTY cannot outlive its terminal; every other job runs on and is adopted.
process.on("exit", () => {
  for (const j of jobs.values()) if (running(j) && j.pty) try { process.kill(-j.pid, "SIGKILL"); } catch {}
});
