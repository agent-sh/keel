// Processes the tools start: one-shot shell commands, background runs (Claude's
// run_in_background, a foreground command moved to the background at its
// timeout, Gemini's is_background) and Codex's interactive exec sessions on a
// real PTY. Every job writes its whole output to a log file the model can Read;
// its unread tail is kept in memory for write_stdin polls.
import type { Subprocess } from "bun";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  bytes: number;
  unread: string;
  proc: Subprocess<any, any, any>;
  exited: Promise<void>;
};

const UNREAD_CAP = 1 << 20;
const jobs = new Map<string, Job>();
const notices = new Map<string, string[]>();
let counter = 0;

// Provider credentials never reach a tool shell: a command the model writes
// could print or send them.
const SECRET_ENV = /^(ANTHROPIC_|OPENAI_|AWS_BEARER_TOKEN|AWS_SECRET|AWS_SESSION_TOKEN|CLAUDE_CODE_|GEMINI_API|GOOGLE_API_KEY|OPENROUTER_|XAI_|GROQ_|MISTRAL_|DEEPSEEK_|FIREWORKS_|KIMI_|MOONSHOT_|ZAI_|GLM_)/;
export function toolEnv(sessionId: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.test(k)) env[k] = v;
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
    log, started: Date.now(), background: !!o.background, bytes: 0, unread: "" } as Job;
  const decoder = new TextDecoder();
  const take = (chunk: Uint8Array) => {
    const text = decoder.decode(chunk, { stream: true });
    job.bytes += chunk.byteLength;
    try { appendFileSync(log, chunk); } catch {}
    job.unread = (job.unread + text).slice(-UNREAD_CAP);
  };
  if (o.pty) {
    job.proc = Bun.spawn(argv, {
      cwd: o.cwd, env: { ...env, TERM: "xterm-256color" },
      terminal: { cols: 200, rows: 50, data: (_t, d) => take(d) },
    });
  } else {
    job.proc = Bun.spawn(argv, { cwd: o.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    const pump = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) take(c); };
    void Promise.all([pump(job.proc.stdout as ReadableStream<Uint8Array>), pump(job.proc.stderr as ReadableStream<Uint8Array>)]).catch(() => {});
  }
  job.exited = job.proc.exited.then((code) => {
    job.ended = Date.now();
    job.exitCode = code;
    job.signal = job.proc.signalCode == null ? null : String(job.proc.signalCode);
    if (job.pty) job.proc.terminal?.close();
    if (job.background) {
      const what = job.description ? `"${job.description}"` : `\`${job.command.slice(0, 80)}\``;
      const how = job.stopReason ?? (job.signal ? `was killed by ${job.signal}` : `exited with code ${code}`);
      const list = notices.get(job.sessionId) ?? [];
      list.push(`Background command ${what} (ID ${job.id}) ${how}. Output: ${job.log}`);
      notices.set(job.sessionId, list);
    }
  });
  jobs.set(id, job);
  return job;
}

export const running = (j: Job) => j.ended === undefined;

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

export function takeUnread(j: Job): string {
  const s = j.unread;
  j.unread = "";
  return s;
}

export function writeJob(j: Job, chars: string): boolean {
  if (!running(j) || !j.pty || !j.proc.terminal) return false;
  j.proc.terminal.write(chars);
  return true;
}

// Stop the whole process group: TERM, then KILL if it lingers.
export async function stopJob(j: Job, reason = "was stopped"): Promise<void> {
  if (!running(j)) return;
  j.stopReason = reason;
  const pid = j.proc.pid;
  const kill = (sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch { try { j.proc.kill(sig); } catch {} } };
  kill("SIGTERM");
  if (!(await waitJob(j, 2000))) kill("SIGKILL");
  await waitJob(j, 2000);
}

export const jobsOf = (sessionId: string) => [...jobs.values()].filter((j) => j.sessionId === sessionId);
export const findJob = (sessionId: string, id: string | number) =>
  [...jobs.values()].find((j) => j.sessionId === sessionId && (j.id === String(id) || j.num === Number(id)));

export function drainNotices(sessionId: string): string[] {
  const n = notices.get(sessionId) ?? [];
  notices.delete(sessionId);
  return n;
}

export const jobView = (j: Job) => ({
  id: j.id, num: j.num, command: j.command, description: j.description, cwd: j.cwd, pty: j.pty, log: j.log,
  started: j.started, ended: j.ended, exit_code: j.exitCode, signal: j.signal, background: j.background, bytes: j.bytes,
  running: running(j),
});

process.on("exit", () => {
  for (const j of jobs.values()) if (running(j)) try { process.kill(-j.proc.pid, "SIGKILL"); } catch {}
});
