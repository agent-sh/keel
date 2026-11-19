// The terminal pane's view of one session's processes on this machine: every
// job its tools (or the owner) started, from memory and from the sidecars the
// jobs leave next to their logs, so commands of earlier daemons are listed too.
// The same functions answer for a session placed here by another daemon.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { findJob, jobsOf, lastLine, type Meta, running, startJob, stopJob, toolEnv, waitJob } from "./jobs.ts";

export type TermJob = {
  id: string; call_id?: string; by?: "owner"; command: string; description?: string; cwd: string;
  started: number; ended?: number; exit_code?: number | null; signal?: string | null; stop_reason?: string;
  background: boolean; running: boolean; pty: boolean; bytes: number; last?: string; tail: string; tail_from: number;
  log_missing?: boolean; // the job is known but its output log is gone
};

// What a list carries of each output: the end, where a run says how it went.
export const TAIL = 8 * 1024;
// What one log read returns at most.
export const LOG_READ = 64 * 1024;
// The newest this many jobs of a session are listed.
const LISTED = 300;

const jobsDir = (spillRoot: string, sessionId: string) => join(spillRoot, sessionId, "jobs");

function slice(path: string, from: number, max: number): { text: string; from: number; size: number } {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, Math.min(from, size), size - max);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString("utf8"), from: start, size };
  } catch {
    return { text: "", from: 0, size: 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The exit code a wrapper wrote for a job no daemon saw end.
function exitOf(log: string): number | null | undefined {
  const p = `${log}.exit`;
  if (!existsSync(p)) return undefined;
  const c = Number.parseInt(readFileSync(p, "utf8"), 10);
  return Number.isFinite(c) ? c : null;
}

export function listJobs(spillRoot: string, sessionId: string): TermJob[] {
  const out = new Map<string, TermJob>();
  const dir = jobsDir(spillRoot, sessionId);
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of files) {
    let m: Meta;
    try { m = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    const log = join(dir, `${m.id}.log`);
    const t = slice(log, 0, TAIL);
    const code = m.ended !== undefined ? m.exit_code : exitOf(log);
    out.set(m.id, {
      id: m.id, call_id: m.call_id, by: m.by, command: m.command, description: m.description, cwd: m.cwd, started: m.started,
      ended: m.ended, exit_code: code, signal: m.signal, stop_reason: m.stop_reason, background: m.background,
      // A record with no end and no live job here: its daemon went before it ended.
      running: false, pty: !!m.pty, bytes: t.size, last: lastLine(log), tail: t.text, tail_from: t.from, log_missing: !existsSync(log) || undefined,
    });
  }
  for (const j of jobsOf(sessionId)) {
    const t = slice(j.log, 0, TAIL);
    out.set(j.id, {
      id: j.id, call_id: j.callId, by: j.by, command: j.command, description: j.description, cwd: j.cwd, started: j.started,
      ended: j.ended, exit_code: j.exitCode, signal: j.signal, stop_reason: j.stopReason, background: j.background,
      running: running(j), pty: j.pty, bytes: t.size, last: lastLine(j.log), tail: t.text, tail_from: t.from, log_missing: !existsSync(j.log) || undefined,
    });
  }
  return [...out.values()].sort((a, b) => a.started - b.started).slice(-LISTED);
}

// The log from `from` on, at most LOG_READ bytes of it, ending on a whole
// character: `to` is where the next read starts, so a follower reads every
// byte in order. A known job whose log is gone says so (null: no such job).
export function readJobLog(spillRoot: string, sessionId: string, jobId: string, from: number) {
  if (!/^[\w-]+$/.test(jobId)) return null;
  const live = findJob(sessionId, jobId);
  const log = live?.log ?? join(jobsDir(spillRoot, sessionId), `${jobId}.log`);
  const known = !!live || existsSync(join(jobsDir(spillRoot, sessionId), `${jobId}.json`));
  if (!existsSync(log)) return known ? { text: "", from: 0, to: 0, size: 0, running: live ? running(live) : false, missing: true } : null;
  return { ...range(log, Number.isFinite(from) && from > 0 ? from : 0, LOG_READ), running: live ? running(live) : false };
}

function range(path: string, from: number, max: number): { text: string; from: number; to: number; size: number } {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.min(from, size);
    const buf = Buffer.alloc(Math.min(max, size - start));
    readSync(fd, buf, 0, buf.length, start);
    let n = buf.length;
    // Do not split a UTF-8 character: its rest comes with the next read.
    if (start + n < size) {
      let i = n - 1;
      while (i > 0 && i > n - 4 && (buf[i]! & 0xc0) === 0x80) i--;
      const lead = buf[i]!, need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (i + need > n) n = i;
    }
    return { text: buf.subarray(0, n).toString("utf8"), from: start, to: start + n, size };
  } catch {
    return { text: "", from, to: from, size: 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The owner's own command, in the session's folder: no gate (it is the owner's),
// the same environment the session's commands get. `done` gets the end.
export function ownerRun(spillRoot: string, sessionId: string, command: string, cwd: string, done?: (j: TermJob) => void) {
  const job = startJob({ sessionId, command, cwd, logDir: jobsDir(spillRoot, sessionId), argv: ["bash", "-c", `exec 2>&1\n${command}`], env: toolEnv(sessionId), by: "owner" });
  if (done) job.exited.then(() => done(listJobs(spillRoot, sessionId).find((j) => j.id === job.id)!));
  return job;
}

export async function stopOne(sessionId: string, jobId: string): Promise<boolean> {
  const j = findJob(sessionId, jobId);
  if (!j || !running(j)) return false;
  await stopJob(j, "was stopped by the owner");
  return true;
}

export async function waitOne(spillRoot: string, sessionId: string, jobId: string, ms: number, signal?: AbortSignal): Promise<TermJob | undefined> {
  const j = findJob(sessionId, jobId);
  if (j) await waitJob(j, ms, signal);
  return listJobs(spillRoot, sessionId).find((x) => x.id === jobId);
}

// The note the model gets after the owner ran a command: what and how it ended,
// and the end of its output (the log path for the rest).
export function ownerNote(j: TermJob, log: string): string {
  const how = j.stop_reason ?? (j.signal ? `was killed by ${j.signal}` : `exited with code ${j.exit_code ?? "unknown"}`);
  const out = j.tail.length > 2000 ? `...${j.tail.slice(-2000)}` : j.tail;
  return `The owner ran \`${j.command.slice(0, 200)}\` in ${j.cwd} from the terminal pane; it ${how}.${out.trim() ? `\nIts output ends:\n${out.trimEnd()}` : ""}\nFull output: ${log}`;
}

export const logPath = (spillRoot: string, sessionId: string, jobId: string) => join(jobsDir(spillRoot, sessionId), `${jobId}.log`);
