// The terminal pane's view of one session's processes on this machine: every
// job its tools (or the owner) started, from memory and from the sidecars the
// jobs leave next to their logs, so commands of earlier daemons are listed too.
// The same functions answer for a session placed here by another daemon.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { conceal, concealDeep } from "../core/conceal.ts";
import { SessionMap } from "../core/session-map.ts";
import { findJob, jobsOf, lastLineOf, type Meta, running, startJob, stopJob, toolEnv, waitJob } from "./jobs.ts";

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

// The file reads of a list go through here, so a test can count them.
export const io = { readdirSync, readFileSync, openSync, statSync };

// What the last list of a session read from its files, kept while they stay
// as they were: the record of a job that ended is final, a record still open
// and a log are read again only when the file's size or time moved. A list
// is asked for every second or two while a command runs; without this each
// one read every record and every log of the session again. Dropped with
// the session, or when more sessions than this were listed since.
type Seen = {
  metas: Map<string, { m: Meta; size: number; mtime: number }>;
  tails: Map<string, { size: number; mtime: number; text: string; from: number; last?: string }>;
  exits: Map<string, number | null>;
};
const seen = new SessionMap<Seen>(16);

// The end of a log and its last line, read once per state of the file.
// Undefined: the log is gone.
function tailOf(c: Seen, log: string) {
  let st: { size: number; mtimeMs: number };
  try { st = io.statSync(log); } catch { c.tails.delete(log); return undefined; }
  const had = c.tails.get(log);
  if (had && had.size === st.size && had.mtime === st.mtimeMs) return had;
  let fd: number | undefined;
  try {
    fd = io.openSync(log, "r");
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const t = { size, mtime: st.size === size ? st.mtimeMs : -1, text: buf.toString("utf8"), from, last: lastLineOf(buf.subarray(-4096).toString("utf8")) };
    c.tails.set(log, t);
    return t;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The exit code a wrapper wrote for a job no daemon saw end.
function exitOf(c: Seen, log: string): number | null | undefined {
  if (c.exits.has(log)) return c.exits.get(log);
  let text: string;
  try { text = io.readFileSync(`${log}.exit`, "utf8"); } catch { return undefined; }
  const n = Number.parseInt(text, 10);
  const code = Number.isFinite(n) ? n : null;
  c.exits.set(log, code);
  return code;
}

export function listJobs(spillRoot: string, sessionId: string): TermJob[] {
  const c = seen.get(sessionId) ?? { metas: new Map(), tails: new Map(), exits: new Map() };
  seen.set(sessionId, c);
  // Every job without its output first: the records the jobs left, then the
  // ones in memory (a job of this daemon is in both; memory is the newer).
  type Bare = Omit<TermJob, "bytes" | "last" | "tail" | "tail_from" | "log_missing"> & { log: string; open: boolean };
  const out = new Map<string, Bare>();
  const dir = jobsDir(spillRoot, sessionId);
  let files: string[] = [];
  try { files = io.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
  const here = new Set(files);
  for (const f of c.metas.keys()) if (!here.has(f)) c.metas.delete(f);
  for (const f of files) {
    let k = c.metas.get(f);
    if (!k || k.m.ended === undefined) {
      try {
        const st = io.statSync(join(dir, f));
        if (!k || k.size !== st.size || k.mtime !== st.mtimeMs) c.metas.set(f, (k = { m: JSON.parse(io.readFileSync(join(dir, f), "utf8")), size: st.size, mtime: st.mtimeMs }));
      } catch { c.metas.delete(f); continue; }
    }
    const m = k.m;
    out.set(m.id, {
      id: m.id, call_id: m.call_id, by: m.by, command: m.command, description: m.description, cwd: m.cwd, started: m.started,
      ended: m.ended, exit_code: m.exit_code, signal: m.signal, stop_reason: m.stop_reason, background: m.background,
      // A record with no end and no live job here: its daemon went before it ended.
      running: false, pty: !!m.pty, log: join(dir, `${m.id}.log`), open: m.ended === undefined,
    });
  }
  for (const j of jobsOf(sessionId)) {
    out.set(j.id, {
      id: j.id, call_id: j.callId, by: j.by, command: j.command, description: j.description, cwd: j.cwd, started: j.started,
      ended: j.ended, exit_code: j.exitCode, signal: j.signal, stop_reason: j.stopReason, background: j.background,
      running: running(j), pty: j.pty, log: j.log, open: false,
    });
  }
  // Only the jobs that are listed have their output read.
  const listed = [...out.values()].sort((a, b) => a.started - b.started).slice(-LISTED);
  const logs = new Set(listed.map((j) => j.log));
  for (const log of c.tails.keys()) if (!logs.has(log)) c.tails.delete(log);
  for (const log of c.exits.keys()) if (!logs.has(log)) c.exits.delete(log);
  const jobs = listed.map(({ log, open, ...j }): TermJob => {
    const t = tailOf(c, log);
    return { ...j, exit_code: open ? exitOf(c, log) : j.exit_code, bytes: t?.size ?? 0, last: t?.last, tail: t?.text ?? "", tail_from: t?.from ?? 0, log_missing: t ? undefined : true };
  });
  // The whole record as the routes send it: secrets as placeholders.
  return concealDeep(jobs, sessionId);
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
  const r = range(log, Number.isFinite(from) && from > 0 ? from : 0, LOG_READ);
  return { ...r, text: conceal(r.text, sessionId), running: live ? running(live) : false };
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
