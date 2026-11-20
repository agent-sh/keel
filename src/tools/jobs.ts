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
  by?: "owner";          // the owner ran it from the terminal pane
  pid: number;
  boot?: string;         // its process's start time, read when it started (Linux)
  readOff: number;       // bytes of the log already handed to the model
  taken?: number;        // bytes the last read covered (more than it showed when it was cut)
  decoder: TextDecoder;
  left?: number[];       // what a stop could not end of its group (it still runs)
  proc?: Subprocess<any, any, any>;   // absent for a job adopted after a restart
  exited: Promise<void>;
};

export const UNREAD_CAP = 1 << 20;
const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
const metaPath = (log: string) => log.replace(/\.log$/, ".json");
const exitPath = (log: string) => `${log}.exit`;
const jobs = new Map<string, Job>();
const MAX_ENDED = 200;
// Notes for the model's next request; `job` marks a background job's end,
// acknowledged (its sidecar marked reported) only once the note is stored.
export type Notice = { text: string; job?: string; log?: string };
const notices = new Map<string, Notice[]>();
let counter = 0;

// Provider credentials never reach a tool shell: a command the model writes
// could print or send them.
const SECRET_ENV = /^(ANTHROPIC_|OPENAI_|AWS_BEARER_TOKEN|AWS_SECRET|AWS_SESSION_TOKEN|CLAUDE_CODE_|GEMINI_API|GOOGLE_API_KEY|OPENROUTER_|XAI_|GROQ_|MISTRAL_|DEEPSEEK_|FIREWORKS_|KIMI_|MOONSHOT_|ZAI_|GLM_)/;
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
};

export function startJob(o: StartOpts): Job {
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
  const env = { ...(o.env ?? toolEnv(o.sessionId)), ...extra };
  // What is kept and shown is the command with placeholders: a value the
  // secret hook put in only reaches the process.
  const job = { id, num, sessionId: o.sessionId, command: conceal(o.command, o.sessionId), description: o.description && conceal(o.description, o.sessionId), cwd: o.cwd, pty: !!o.pty,
    log, started: Date.now(), background: !!o.background, readOff: 0, decoder: new TextDecoder(), callId: o.callId, by: o.by } as Job;
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
  boot?: string; reported?: boolean; pty?: boolean; call_id?: string; by?: "owner";
  cgroup?: string; contain?: "cgroup" | "group"; contain_why?: string;
  ended?: number; exit_code?: number | null; signal?: string | null; stop_reason?: string;
  read_off?: number; // bytes of the log the model was handed (a later daemon goes on from there)
};
const meta = (j: Job, pid: number): Meta => ({
  id: j.id, num: j.num, sessionId: j.sessionId, command: j.command, description: j.description, cwd: j.cwd,
  started: j.started, background: j.background, pid, boot: j.boot ?? procStart(pid), call_id: j.callId, by: j.by, read_off: j.readOff,
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
export const procfs = { stat: (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8") };
const procName = (pid: number) => { try { const st = procfs.stat(pid); return st.slice(st.indexOf("(") + 1, st.lastIndexOf(")")); } catch { return undefined; } };
function procStart(pid: number): string | undefined {
  try { return procfs.stat(pid).split(") ").pop()!.split(" ")[19]; } catch { return undefined; }
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
  // A background job's end counts as reported once its note is stored (ackNotices), not before:
  // a restart between the two reports it again.
  try {
    writeMeta(job.log, { ...meta(job, job.pid), reported: !job.background, pty: job.pty || undefined, ended: job.ended, exit_code: code, signal, stop_reason: job.stopReason });
  } catch {}
  if (job.background) {
    const what = job.description ? `"${job.description}"` : `\`${job.command.slice(0, 80)}\``;
    const how = job.stopReason ?? (signal ? `was killed by ${signal}` : code === null ? "ended while Keel restarted; its exit code is unknown" : `exited with code ${code}`);
    const list = notices.get(job.sessionId) ?? [];
    list.push({ text: `Background command ${what} (ID ${job.id}) ${how}. Output: ${job.log}`, job: job.id, log: job.log });
    notices.set(job.sessionId, list);
  }
}

// After a restart: take back the jobs a previous daemon started under
// `spillRoot/<session>/jobs/`. One still running is watched until it ends; one
// that ended unreported is reported now. Ended ones come back as history, so
// their logs open under the same IDs, and new jobs never reuse their numbers.
// Returns how many were taken back to watch or report.
export function adoptJobs(spillRoot: string): number {
  let n = 0;
  let sessions: string[] = [];
  try { sessions = readdirSync(spillRoot); } catch { return 0; }
  const history: Job[] = [];
  for (const sid of sessions) {
    const dir = join(spillRoot, sid, "jobs");
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      let m: Meta;
      try { m = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      counter = Math.max(counter, m.num ?? 0);
      if (jobs.has(m.id)) continue;
      const log = join(dir, `${m.id}.log`);
      // A sidecar an older daemon wrote with a value in it: rewritten with placeholders.
      const shown = concealDeep(m, m.sessionId);
      if (JSON.stringify(shown) !== JSON.stringify(m)) { m = shown; writeMeta(log, m); }
      const base = { id: m.id, num: m.num, sessionId: m.sessionId, command: m.command, description: m.description, cwd: m.cwd,
        pty: !!m.pty, log, started: m.started, background: m.background, pid: m.pid, boot: m.boot, readOff: m.read_off ?? 0, decoder: new TextDecoder(),
        callId: m.call_id, by: m.by, cgroup: m.cgroup, contain: m.contain ?? "group", containWhy: m.contain_why };
      if (m.reported || m.pty) {
        // History: a PTY never outlives its daemon; one with no end ended with it.
        history.push({ ...base, readOff: m.read_off ?? size(log), ended: m.ended ?? m.started, exitCode: m.exit_code ?? null, signal: m.signal ?? null, stopReason: m.stop_reason, exited: Promise.resolve() });
        continue;
      }
      let resolve!: () => void;
      const job: Job = { ...base, pty: false, background: true, exited: new Promise<void>((r) => (resolve = r)) };
      jobs.set(job.id, job);
      adopted.set(job.id, { job, meta: m, resolve });
      n++;
    }
  }
  for (const j of history.sort((a, b) => b.started - a.started).slice(0, MAX_ENDED)) jobs.set(j.id, j);
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

// Running: its process has not ended, or a stop left part of its group alive
// (checked again each time, until nothing of it is left).
export const running = (j: Job) => {
  if (j.ended === undefined) return true;
  if (j.left && !members(j).length) j.left = undefined;
  return !!j.left;
};
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
  if (!jobLive(j)) return [];
  if (j.ended === undefined) j.stopReason = reason;
  const pid = j.pid;
  // A job stopped while systemd-run still sets up its scope would leave the
  // scope behind empty: its command starts (systemd-run execs it) first.
  if (j.cgroup) for (let i = 0; i < 80 && j.ended === undefined && procName(pid) === "systemd-run"; i++) await Bun.sleep(25);
  const kill = (sig: NodeJS.Signals) => {
    const lead = procStart(pid);
    const reused = !!j.boot && lead !== undefined && lead !== j.boot;
    const rest = members(j);
    const groupOk = !reused && (!j.boot || lead !== undefined || rest.some((m) => m.group === pid));
    if (groupOk) try { process.kill(-pid, sig); } catch {
      if (lead !== undefined || !j.boot) try { j.proc ? j.proc.kill(sig) : process.kill(pid, sig); } catch {}
    }
    // Members outside the group: in the cgroup (setsid, double forks) or
    // moved to a group of their own within the session.
    if (sig === "SIGKILL" && j.cgroup) try { writeFileSync(`${j.cgroup}/cgroup.kill`, "1"); } catch {}
    for (const m of rest) if (m.group !== pid && procStart(m.pid) === m.start && (!m.cg || inCgroup(m.pid, j.cgroup!))) try { process.kill(m.pid, sig); } catch {}
    if (!rest.length && (reused || (j.boot && lead === undefined))) gone(j);
  };
  const quiet = async (ms: number) => {
    const until = Date.now() + ms;
    if (!(await waitJob(j, ms))) return false;
    while (members(j).length && Date.now() < until) await Bun.sleep(25);
    return !members(j).length;
  };
  kill("SIGTERM");
  if (!(await quiet(2000))) kill("SIGKILL");
  await quiet(2000);
  const rest = members(j).map((m) => m.pid);
  j.left = rest.length ? rest : undefined;
  return rest;
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

// The processes still alive of a job, zombies aside: those in its cgroup,
// and those in its process group or session (a process that has not reached
// the scope yet, or a job with no scope). None of the group when its pid now
// belongs to another process.
type Member = { pid: number; group: number; start: string; cg?: boolean };
function members(j: Job): Member[] {
  const out: Member[] = [];
  const seen = new Set<number>();
  const stat = (pid: number) => { try { const st = procfs.stat(pid); return st.slice(st.lastIndexOf(") ") + 2).split(" "); } catch { return undefined; } };
  for (const pid of cgroupPids(j)) {
    const f = stat(pid);
    if (!f || f[0] === "Z" || f[0] === "X") continue;
    seen.add(pid);
    out.push({ pid, group: Number(f[2]), start: f[19]!, cg: true });
  }
  const lead = procStart(j.pid);
  if (j.boot && lead !== undefined && lead !== j.boot) return out;
  let names: string[];
  try { names = readdirSync("/proc"); } catch { return out; }
  const id = String(j.pid);
  for (const n of names) {
    if (!/^\d+$/.test(n) || seen.has(Number(n))) continue;
    const f = stat(Number(n));
    if (!f || f[0] === "Z" || f[0] === "X" || (f[2] !== id && f[3] !== id)) continue;
    out.push({ pid: Number(n), group: Number(f[2]), start: f[19]! });
  }
  return out;
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
// Live jobs (see jobLive) of any session whose folder is in `dir` or holds it (where links
// land): a job in a parent folder can write into it too.
export const jobsIn = (dir: string) => { const d = realOf(dir); return [...jobs.values()].filter((j) => { const c = realOf(j.cwd); return (contains(d, c) || contains(c, d)) && jobLive(j); }); };
export const findJob = (sessionId: string, id: string | number) =>
  [...jobs.values()].find((j) => j.sessionId === sessionId && (j.id === String(id) || j.num === Number(id)));

// A note for the model's next request (the owner ran a command it should know of).
export function addNotice(sessionId: string, text: string) {
  const list = notices.get(sessionId) ?? [];
  list.push({ text });
  notices.set(sessionId, list);
}

export function drainNotices(sessionId: string): Notice[] {
  const n = notices.get(sessionId) ?? [];
  notices.delete(sessionId);
  return n;
}

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
    const line = cleanTerm(buf.toString("utf8")).split("\n").map((l) => l.trim()).filter(Boolean).pop();
    return line && conceal(line).slice(0, 300);
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

// A PTY cannot outlive its terminal; every other job runs on and is adopted.
process.on("exit", () => {
  for (const j of jobs.values()) if (running(j) && j.pty) try { process.kill(-j.pid, "SIGKILL"); } catch {}
});
