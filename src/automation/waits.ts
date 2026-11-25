import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { gitEnv } from "../core/git.ts";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { D, attr, capture, deliver, emit, familyOf, inert, isPending, withdraw } from "./core.ts";
import * as activity from "./activity.ts";
import * as failures from "./failures.ts";
import { readStat } from "../core/pid.ts";
import { pumpText, readText } from "../core/proc.ts";
import { lastDown, lateWords, LATE_MS, span } from "../core/late.ts";
import { sayAt, waitEndLine, waitSetLine } from "../admin/daemon-log.ts";
import { timed } from "../admin/stall.ts";
import { localTime, zonedClock } from "../core/clock.ts";
import { waitsFor } from "../core/state-words.ts";
import { addressBytes, carried as mappedV4 } from "../core/hosts.ts";
import { conceal } from "../core/conceal.ts";
import { endNoticeOwed, findJob, jobHasProcesses, jobLive, jobPidsOf, jobsOf, running, type Job } from "../tools/jobs.ts";
import { CARRY_MAX, carryText, HELD_ON_FILE, jobLine, opensForWrite, othersText, spentAtTurnEnd, stalled, waitingProc, WRITER_GRACE_MS, writerGone, writesPath, type ProcLook, type ThreadLook } from "./wait-carry.ts";
import type { Session } from "../core/types.ts";
import { shownTo } from "../safety/sandbox-view.ts";
import { socketRows } from "../safety/egress.ts";
import { homeDir } from "../core/paths";

// Zero-token waits: the daemon probes, the model is not called until the
// condition holds, the deadline passes or the wait is cancelled. Each of those
// wakes the session once. A monitor streams a command's matching lines as
// events and stays active until the command exits or its deadline.

export type WaitSpec =
  | { kind: "timer"; seconds?: number; at_ms?: number }
  // `writer`: the id of the session's background command that writes the file, named by the model.
  | { kind: "file"; path: string; contains?: string; writer?: string }
  | { kind: "log"; path: string; match: string; writer?: string }
  | { kind: "http"; url: string; status?: number }
  | { kind: "process"; pid: number; start?: string }
  | { kind: "monitor"; command: string; match?: string; coalesce_ms?: number; max_events?: number }
  // A monitor on a WebSocket: each text message is one line of events.
  | { kind: "websocket"; url: string; protocols?: string[]; match?: string; coalesce_ms?: number; max_events?: number }
  // A pull request's checks on GitHub, read with the owner's gh login.
  | { kind: "pr_checks"; repo: string; pr_number: number }
  | { kind: "session"; machine: string; session: string; title?: string; message_id?: string }
  // An MCP call that went on in the background (src/automation/mcp-calls.ts). Keel makes it; nobody sets it by hand.
  | { kind: "mcp_call"; entry: string; tool: string; label: string; started: number; call_id: string; task_id?: string; remote?: true; file: string; spill_dir: string };

// A wait kind another module probes (the fleet's session notices): how a spec
// is read, how often it is probed, and the probe itself (an outcome fires it;
// a thrown error is kept as the last probe's error). The signal aborts when
// the probe took too long or its wait was settled.
// `ended`: told once when the wait is settled, by whatever reason (fired, timed out, cancelled): a kind that holds
// something of its own lets it go there.
export type WaitKind = { normalize(spec: any, cwd: string): WaitSpec; every: number; probe(w: WaitRecord, signal: AbortSignal): Promise<string | undefined> | string | undefined; ended?(w: WaitRecord): void };
const kinds = new Map<string, WaitKind>();
export const registerWaitKind = (kind: string, k: WaitKind) => void kinds.set(kind, k);

export type WaitRecord = {
  id: string;
  session_id: string;
  kind: WaitSpec["kind"];
  spec: WaitSpec;
  note: string;
  status: "active" | "fired" | "timeout" | "cancelled" | "ended";
  created: number;
  deadline: number;
  ended?: number | null;
  outcome?: string | null;
  last_error?: string | null;
  events: number;
  tail?: string[];
  // Who set it: "owner" for one set through the API (POST /api/waits), else the session's model (null).
  by?: string | null;
};

const DEFAULT_TIMEOUT = 600;
const MONITOR_DEFAULT = 300;
const MAX_TIMEOUT = 366 * 86400;
const MONITOR_MAX = 86400;
export const isMonitor = (kind: string) => kind === "monitor" || kind === "websocket";
export const WAIT_LIMIT = 50; // active waits per session, the bound Claude Code puts on scheduled tasks

export function migrate() {
  D().store.migrate(`
CREATE TABLE IF NOT EXISTS waits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  ended INTEGER,
  outcome TEXT,
  last_error TEXT,
  events INTEGER NOT NULL DEFAULT 0,
  state TEXT
);
CREATE INDEX IF NOT EXISTS waits_status ON waits(status, session_id);
-- What reads a session's waits whatever their status (a stop's cleanup, the file and log waits it set): by session, not a scan of every wait ever set.
CREATE INDEX IF NOT EXISTS waits_session ON waits(session_id);`);
  // 1 while the wait's last wake (fired, timed out, ended) is owed to its
  // session: set in the statement that settles it, cleared when the wake is
  // stored in the transcript. A restart sends what is still owed.
  if (!D().store.columnExists("waits", "wake")) D().store.migrate("ALTER TABLE waits ADD COLUMN wake INTEGER NOT NULL DEFAULT 0");
  D().store.migrate("CREATE INDEX IF NOT EXISTS waits_wake ON waits(wake) WHERE wake = 1"); // the few owed ones, read at start
  // Who set the wait (WaitRecord.by): an agent's end leaves the owner's own waits set.
  if (!D().store.columnExists("waits", "by")) D().store.migrate("ALTER TABLE waits ADD COLUMN by TEXT");
  // A monitor's batches its session has not been given yet, the newest
  // EVENTS_KEPT of them: a busy session gets them when its turn ends, and a
  // restart in that time loses none (they leave the table in the write that
  // stores their prompt).
  D().store.migrate("CREATE TABLE IF NOT EXISTS wait_events (wait_id TEXT NOT NULL REFERENCES waits(id) ON DELETE CASCADE, n INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (wait_id, n)) WITHOUT ROWID");
}

// How many batches of one monitor are kept for a session that does not take
// them (the default number a monitor delivers before it stops): of more, the
// oldest go and the next event says how many.
export const EVENTS_KEPT = 20;

type Row = Omit<WaitRecord, "spec" | "tail"> & { spec: string; state: string | null; wake: number };
const toRec = (r: Row): WaitRecord => {
  const { state, wake: _, ...rest } = r;
  return { ...rest, spec: JSON.parse(r.spec), tail: state ? JSON.parse(state).tail : undefined };
};

export function get(id: string): WaitRecord | undefined {
  const r = D().store.db.query<Row, [string]>("SELECT * FROM waits WHERE id = ?").get(id);
  return r ? toRec(r) : undefined;
}

// Every active wait, then the newest settled ones.
export function list(sessionId?: string, settled = 50): WaitRecord[] {
  const db = D().store.db;
  const where = sessionId ? "AND session_id = ?" : "";
  const args = sessionId ? [sessionId] : [];
  const active = db.query<Row, any>(`SELECT * FROM waits WHERE status = 'active' ${where} ORDER BY created`).all(...args);
  const done = db.query<Row, any>(`SELECT * FROM waits WHERE status != 'active' ${where} ORDER BY ended DESC LIMIT ?`).all(...args, settled);
  return [...active, ...done].map(toRec);
}

// What the session waits on, for its cache plan (src/engine/cache-plan.ts): it
// wakes at the first of its active waits, so the earliest due time and
// deadline; and how long its earlier waits of that kind lasted until they fired.
// `since`: when the first of them was set, the start of the wait across restarts.
export function shapeOf(sessionId: string): { kind: string; due?: number; deadline?: number; past?: number[]; since: number } | undefined {
  const db = D().store.db;
  const active = db.query<{ kind: string; spec: string; deadline: number; created: number }, [string]>("SELECT kind, spec, deadline, created FROM waits WHERE status = 'active' AND session_id = ? ORDER BY deadline").all(sessionId);
  if (!active.length) return undefined;
  const dues = active.map((w) => { try { return w.kind === "timer" ? Number(JSON.parse(w.spec).at_ms) || 0 : 0; } catch { return 0; } }).filter(Boolean);
  const kind = active[0]!.kind;
  const past = db.query<{ ms: number }, [string, string]>("SELECT ended - created AS ms FROM waits WHERE session_id = ? AND kind = ? AND status = 'fired' AND ended IS NOT NULL ORDER BY ended DESC LIMIT 20").all(sessionId, kind).map((r) => r.ms);
  return { kind, ...(dues.length ? { due: Math.min(...dues) } : {}), deadline: Math.min(...active.map((w) => w.deadline)), ...(past.length ? { past } : {}), since: Math.min(...active.map((w) => w.created)) };
}

export function activeFor(sessionId: string): number {
  return D().store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM waits WHERE status = 'active' AND session_id = ?").get(sessionId)!.n;
}

// Safe across sessions: the stored spec and note may contain credentials,
// private paths or command lines. Only describe the kind and opaque handle.
export function describeActive(sessionId: string): string {
  return D().store.db.query<Pick<WaitRecord, "id" | "kind">, [string]>(
    "SELECT id, kind FROM waits WHERE status = 'active' AND session_id = ? ORDER BY created, id",
  ).all(sessionId).map((w) => `${w.kind} wait ${w.id}`).join(", ");
}

// Probe state that is not worth a column: log cursors, monitor tails. A log
// wait's cursor (the first unread byte, the file's identity, a line being
// skipped) is also kept in the row, so a restart reads on from where it was.
type LogCursor = { offset: number; ident?: string; skip?: boolean; skipped?: number };
// `probing`: the one probe of the wait that has not answered yet (`late` once
// it was given up on).
type Probing = { started: number; abort: AbortController; late?: boolean };
const live = new Map<string, { cpu?: number; quietSince?: number; aliveAt?: number; grew?: string; offset?: number; ident?: string; skip?: boolean; skipped?: number; lastProbe?: number; probing?: Probing; proc?: Bun.Subprocess; ws?: WebSocket; batch?: string[]; flushAt?: number; tail?: string[]; dropped?: number; seen?: number; errs?: number; recent?: string[] }>();
const LOG_READ = 4 << 20; // a probe reads at most this much of a log
const LINE_MAX = 64 * 1024; // a monitor matches lines up to this long; a longer one is cut there
const DISPLAY = 2000; // characters of one line shown in an event
// What is kept of an outcome, and so what its wake says: room for the longest
// one made here (a monitor's five last lines, each with its marks). A longer
// one is cut there and says how much went.
// (A file or log wait's wake carries the file's new content after it, bounded on its own:
// src/automation/wait-carry.ts.)
const OUTCOME_MAX = 6 * DISPLAY;
const kept = (outcome: string) => (outcome.length <= OUTCOME_MAX ? outcome : `${outcome.slice(0, OUTCOME_MAX)}\n[cut here: ${outcome.length - OUTCOME_MAX} more characters are not kept]`);

const identOf = (path: string) => {
  const st = statSync(path);
  return { size: st.size, ident: `${st.dev}:${st.ino}` };
};
function saveCursor(id: string, c: LogCursor) {
  D().store.db.query("UPDATE waits SET state = json_set(COALESCE(state, '{}'), '$.cursor', json(?)) WHERE id = ?").run(JSON.stringify(c), id);
}

function setState(id: string, key: string, value: unknown) {
  D().store.db.query("UPDATE waits SET state = json_set(COALESCE(state, '{}'), ?, json(?)) WHERE id = ?").run(`$.${key}`, JSON.stringify(value), id);
}
function stateOf(id: string): Record<string, any> {
  const r = D().store.db.query<{ state: string | null }, [string]>("SELECT state FROM waits WHERE id = ?").get(id);
  try { return r?.state ? JSON.parse(r.state) : {}; } catch { return {}; }
}

// The Keel job that writes a file or log wait's file: the one the model named (`writer`), else one whose
// own log is the file, or whose command sends its output there, or one of whose processes holds the file
// open for writing (a script that writes it inside itself), and it was running when the wait was set or
// started after (one that ended before says nothing of what comes). A running one is kept with the wait;
// one that ended is not, so a job started after it is found. When the command lines name none, they are
// not read again until the session starts another job (the newest start is kept); the open files are
// looked at every few seconds.
const noWriter = new Map<string, number>();
function linkJob(w: WaitRecord, now = Date.now()): Job | undefined {
  if (w.kind !== "file" && w.kind !== "log") return undefined;
  const st = stateOf(w.id);
  const kept = st.job ? findJob(w.session_id, st.job) : undefined;
  if (kept && (st.named || running(kept))) return kept;
  const jobs = jobsOf(w.session_id);
  const newest = jobs.reduce((m, j) => Math.max(m, j.started), 0);
  const path = (w.spec as { path: string }).path;
  let found: Job | undefined;
  if (kept || noWriter.get(w.id) !== newest) {
    const home = homeDir();
    found = jobs.filter((j) => j.started <= now && (running(j) || (j.ended ?? 0) >= w.created) && (!kept || j.started > kept.started) && (j.log === path || writesPath(j.command, j.cwd, home, path))).sort((a, b) => b.started - a.started)[0];
    if (!found && !kept) {
      if (noWriter.size > 512) noWriter.clear();
      noWriter.set(w.id, newest);
    }
  }
  found ??= timed(() => "a wait's look for the process that writes its file", () => holderOf(w, jobs.filter((j) => running(j) && (!kept || j.started > kept.started)), path, now));
  if (found && running(found)) setState(w.id, "job", found.id);
  return found ?? kept;
}

// Whether the session waits on this command with a wait of its own: on its exit file (src/tools/jobs.ts
// writes `<log>.exit` at its end), on a file it writes, or on its process. That wait wakes the session at
// the command's end (a file or log wait whose job ended says so), with what the file gained.
export function onJob(sessionId: string, job: Job): boolean {
  const active = D().store.db.query<Row, [string]>("SELECT * FROM waits WHERE status = 'active' AND session_id = ?").all(sessionId).map(toRec);
  return active.some((w) => {
    if (w.kind === "process") return (w.spec as { pid?: number }).pid === job.pid;
    if (w.kind !== "file" && w.kind !== "log") return false;
    return (w.spec as { path: string }).path === `${job.log}.exit` || linkJob(w)?.id === job.id;
  });
}

// A running job one of whose processes has the waited file open for writing. Looked for at most every
// FD_LOOK_MS a wait, in at most 64 processes a job and 1024 open files a process.
const FD_LOOK_MS = 5000;
const fdLooked = new Map<string, number>();
function holderOf(w: WaitRecord, jobs: Job[], path: string, now: number): Job | undefined {
  if (!jobs.length || process.platform !== "linux") return undefined;
  if (now - (fdLooked.get(w.id) ?? 0) < FD_LOOK_MS) return undefined;
  if (fdLooked.size > 512) fdLooked.clear();
  fdLooked.set(w.id, now);
  const real = realOrPlanned(path);
  for (const j of jobs) {
    for (const pid of jobPidsOf(j).slice(0, 64)) {
      let fds: string[] = [];
      try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds.slice(0, 1024)) {
        let at: string;
        try { at = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        if (at !== real && at !== path) continue;
        let flags = "";
        try { flags = /^flags:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8"))?.[1] ?? ""; } catch {}
        if (opensForWrite(flags)) return j;
      }
    }
  }
  return undefined;
}

// What Keel knows of a job, for its line in a wake.
function factsOf(j: Job, path: string) {
  const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
  const lastOutput = Math.max(mtime(path), mtime(j.log)) || undefined;
  return { id: j.id, command: j.command, started: j.started, running: running(j), live: jobLive(j), exit: j.exitCode, signal: j.signal, ended: j.ended, stopReason: j.stopReason, lastOutput };
}

// Whether the session may read a file without asking anyone: as its Read tool would (the permission
// gate, set by src/server/routes/permissions.ts, with what its sandbox shows), else what its folder's
// sandbox shows. A session whose files are on another machine reads none of this one's. A wait's
// probe and wake read as the daemon, so they read only that. Kept for a few seconds a path.
export const readGate: { readable?: (s: Session, path: string) => boolean } = {};
const readVerdicts = new Map<string, { at: number; ok: boolean }>();
function readable(sessionId: string, real: string): boolean {
  const key = `${sessionId}\0${real}`;
  const had = readVerdicts.get(key);
  if (had && Date.now() - had.at < 10_000) return had.ok;
  let ok = false;
  try {
    const s = D().store.session(sessionId);
    if (s && !s.machine) ok = readGate.readable ? readGate.readable(s, real) : shownTo(real, s.workspace).shown;
  } catch (e) { capture(e, { at: "wait read check" }); }
  if (readVerdicts.size > 512) readVerdicts.clear();
  readVerdicts.set(key, { at: Date.now(), ok });
  return ok;
}

// What the wait was allowed to read when it was set (by the gate, or by the owner on its card): the
// path where it really is, and the file there then. That file at that path is read without asking
// again; another file, or another path a link leads to, only when the session may read it.
type Approved = { real: string; ident?: string };
const realOrPlanned = (path: string) => {
  try { return realpathSync(path); } catch {}
  try { return join(realpathSync(dirname(path)), basename(path)); } catch { return path; }
};
function approve(id: string, path: string) {
  const a: Approved = { real: realOrPlanned(path) };
  try { const st = statSync(a.real); if (st.isFile()) a.ident = `${st.dev}:${st.ino}`; } catch {}
  setState(id, "approved", a);
}

// A waited file opened for reading where it really is, or why it is not read: not there, not a
// regular file (a FIFO's open would wait for a writer, a device's read may never end), or not
// readable by the session (a link that leads out of what it may read). What is opened is the file
// that was looked at: the same file before and after the open, at the path that was checked.
type Opened = { fd: number; size: number; ident: string; real: string } | { not: "missing" | "special" | "hidden"; real?: string };
function openWaited(path: string, w: Pick<WaitRecord, "id" | "session_id">): Opened {
  let real: string;
  try { real = realpathSync(path); } catch { return { not: "missing" }; }
  let st: ReturnType<typeof statSync>;
  try { st = statSync(real); } catch { return { not: "missing" }; }
  if (!st.isFile()) return { not: "special", real };
  const ident = `${st.dev}:${st.ino}`;
  const a = stateOf(w.id).approved as Approved | undefined;
  const allowed = (a && a.real === real && (!a.ident || a.ident === ident)) || readable(w.session_id, real);
  if (!allowed) return { not: "hidden", real };
  let fd: number;
  // (O_NONBLOCK: a FIFO put at the path since the look does not hold the open; a regular file's reads are the same.)
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | constants.O_NOFOLLOW); } catch (e: any) { return { not: e?.code === "ENOENT" ? "missing" : e?.code === "ELOOP" ? "hidden" : "special", real }; }
  try {
    const f = fstatSync(fd);
    if (!f.isFile() || `${f.dev}:${f.ino}` !== ident) { closeSync(fd); return { not: f.isFile() ? "hidden" : "special", real }; }
    // (What was opened is where the check looked: a folder on the way was not swapped since.)
    if (process.platform === "linux") {
      let at: string | undefined;
      try { at = readlinkSync(`/proc/self/fd/${fd}`); } catch {}
      if (at !== undefined && at !== real) { closeSync(fd); return { not: "hidden", real }; }
    }
    return { fd, size: f.size, ident, real };
  } catch { closeSync(fd); return { not: "special", real }; }
}
const notRead = (path: string, o: Exclude<Opened, { fd: number }>) => o.not === "missing" ? `${path} is not there.` : o.not === "special" ? `${path} is not a regular file: it is not carried.` : `${path} is not carried: it leads where this session may not read without the owner.`;
// A waited path the probe cannot read: one the session may not read ends the wait now (it would never
// be read before the deadline); one that is not a regular file is said on the wait.
function unread(w: WaitRecord, path: string, o: Exclude<Opened, { fd: number }>): undefined {
  if (o.not === "hidden") settle(w.id, "ended", `${path} leads where this session may not read without the owner, which is not what the wait was set on: the wait ends here.`);
  else if (o.not === "special") setError(w.id, notRead(path, o));
  return undefined;
}

// What a file or log wait's wake carries: the file's new content (src/automation/wait-carry.ts), and
// what Keel knows of the job that writes it. Secrets in it are hidden as in a tool's output.
function carried(w: WaitRecord): string {
  if (w.kind !== "file" && w.kind !== "log") return "";
  const path = (w.spec as { path: string }).path;
  const from = (stateOf(w.id).from ?? { offset: 0 }) as { offset: number; ident?: string };
  const parts: string[] = [];
  const f = openWaited(path, w);
  if ("not" in f) parts.push(notRead(path, f));
  else {
    try {
      const fromStart = !from.ident || from.ident !== f.ident || f.size < from.offset;
      const start = fromStart ? 0 : from.offset;
      const unchanged = !fromStart && f.size === start;
      // Bytes enough for the characters carried (four bytes a character at most), from the end.
      const begin = unchanged ? Math.max(0, f.size - CARRY_MAX * 4) : Math.max(start, f.size - CARRY_MAX * 4);
      const len = f.size - begin;
      const buf = Buffer.alloc(len);
      readSync(f.fd, buf, 0, len, begin);
      const binary = buf.includes(0);
      parts.push(carryText({ path, text: binary ? "" : buf.toString("utf8"), from: start, size: f.size, fromStart, unchanged, binary, skipped: begin - (unchanged ? 0 : start) }));
    } catch { parts.push(`${path} could not be read.`); } finally { closeSync(f.fd); }
  }
  const j = linkJob(w);
  if (j) parts.push(jobLine(factsOf(j, path), Date.now()));
  return conceal(parts.join("\n"), w.session_id);
}

// What a wait carries, said when it is set (src/automation/tools.ts).
export function carries(w: WaitRecord): string {
  if (w.kind !== "file" && w.kind !== "log") return "";
  const j = linkJob(w);
  const quiet = j?.contain === "cgroup" ? `, or ${Math.round(stall.ms / 60_000)} min of it with no output, no processor use and nothing of it waiting on a timer, the network, a lock or another process,` : "";
  const job = j ? ` and what is known of job ${j.id} that writes it (running or its exit, its last output); that job's end without the condition${quiet} wakes you before the deadline` : "";
  return ` Its wake carries what the file gains from now on (its last ${CARRY_MAX.toLocaleString("en-US")} characters, secrets hidden)${job}: no need to read it again.`;
}

// How long a job that writes a waited file may go with no output and no processor use before the
// wait says so. A job at work, or one waiting on another machine, keeps using a little
// processor time: sampled every 10 s, 93 live jobs went at most 20 s without any (ssh sessions,
// test runs, scripts). Output alone says little (a tenth of the jobs that went on to pass were
// silent for over 3 min at their end, as their output went elsewhere). Five minutes of both is
// far past what a working job shows, and well before a wait's usual deadline (20 min).
export const stall = { ms: 5 * 60_000 }; // (a test sets it shorter, and puts it back)

// What one of a job's processes is doing, read from /proc (src/automation/wait-carry.ts decides): each
// of its threads, and for one held in a read or a pipe, what the file its call names is.
function procLook(pid: string, inCgroup: Set<string>): ProcLook {
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const stateOf = (stat: string) => (stat ? stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) : "");
  const children: string[] = [];
  const threads: ThreadLook[] = [];
  let tids: string[] = [];
  try { tids = readdirSync(`/proc/${pid}/task`); } catch {}
  for (const t of tids.slice(0, 256)) {
    const at = `/proc/${pid}/task/${t}`;
    children.push(...read(`${at}/children`).split(" ").filter(Boolean));
    const wchan = read(`${at}/wchan`).trim();
    const look: ThreadLook = { state: stateOf(read(`${at}/stat`)), wchan };
    if (HELD_ON_FILE.test(wchan)) {
      // (The call's first argument: the file it reads or waits on, for read, recv, splice and the like.)
      const arg = read(`${at}/syscall`).split(" ")[1];
      const fd = arg && /^0x[0-9a-f]{1,4}$/.test(arg) ? Number.parseInt(arg, 16) : undefined;
      if (fd !== undefined) {
        try { look.fd = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch {}
        try { look.fifo = look.fd?.startsWith("/") === true && statSync(`/proc/${pid}/fd/${fd}`).isFIFO(); } catch {}
      }
    }
    threads.push(look);
  }
  return { comm: read(`/proc/${pid}/comm`).trim(), threads, childOutside: children.some((c) => !inCgroup.has(c)) };
}

// A wait whose job ended without its condition, or went quiet: told now, not at the deadline. Its end
// is told whatever holds the job: a cgroup of its own knows every process it started, else its process
// group and session do (looked at every few seconds once its command ended). A stall is told only of a job
// in a cgroup of its own, whose processor time is all counted there. `fired`: the end showed the condition
// after all (a log's last line, which the job left without a newline).
type Judged = { status: "ended" | "fired"; text: string; cause: "ended" | "stalled" };
function judgeJob(w: WaitRecord, now: number): Judged | undefined {
  const j = linkJob(w, now);
  if (!j) return undefined;
  const path = (w.spec as { path: string }).path;
  const what = w.kind === "log" ? `no line of it matched ${(w.spec as { match: string }).match}` : (w.spec as { contains?: string }).contains ? `it does not contain "${(w.spec as { contains?: string }).contains}"` : "it is not there";
  const st = live.get(w.id);
  if (!running(j)) {
    // (A moment after the end, for the last writes to land and be probed.)
    if (now - (j.ended ?? now) < WRITER_GRACE_MS) return undefined;
    let alive: boolean;
    if (j.contain === "cgroup") alive = jobLive(j);
    else {
      // (Its group and session are read from the whole process table: not at every probe.)
      if (st && now - (st.aliveAt ?? 0) < FD_LOOK_MS) return undefined;
      if (st) st.aliveAt = now;
      alive = jobHasProcesses(j);
    }
    if (writerGone({ running: false, alive, ended: j.ended, now })) {
      if (w.kind === "log") {
        const last = lastLine(w);
        if (last === null) return undefined; // more of it is still to be read
        if (last !== undefined) return { status: "fired", cause: "ended", text: `Matched in ${path} (its last line, which job ${j.id} left without a newline before it ended):\n${last.slice(0, DISPLAY)}` };
      }
      return { status: "ended", cause: "ended", text: `The job that writes ${path} ended and ${what}.` };
    }
    if (j.contain !== "cgroup") return undefined;
  } else if (j.contain !== "cgroup") return undefined;
  if (!st) return undefined;
  // Progress: the processor time of everything in its cgroup, the size of the file and of its log.
  let cpu = -1;
  try { cpu = Number(/usage_usec (\d+)/.exec(readFileSync(`${j.cgroup}/cpu.stat`, "utf8"))?.[1] ?? -1); } catch {}
  const size = (p: string) => { try { return statSync(p).size; } catch { return -1; } };
  const grew = `${size(path)}:${size(j.log)}`;
  if (cpu < 0) return undefined;
  if (st.cpu !== cpu || st.grew !== grew || st.quietSince === undefined) { st.cpu = cpu; st.grew = grew; st.quietSince = now; return undefined; }
  if (now - st.quietSince < stall.ms) return undefined;
  let looks: ProcLook[];
  try {
    const pids = readFileSync(`${j.cgroup}/cgroup.procs`, "utf8").split("\n").filter(Boolean);
    const inCgroup = new Set(pids);
    looks = pids.map((p) => procLook(p, inCgroup));
  } catch { return undefined; }
  if (!stalled({ now, since: st.quietSince, waiting: looks.some(waitingProc), after: stall.ms })) return undefined;
  return { status: "ended", cause: "stalled", text: `Job ${j.id} that writes ${path} still runs, but in ${Math.round((now - st.quietSince) / 1000)} s it wrote nothing and used no processor time, and none of its ${looks.length} process${looks.length === 1 ? "" : "es"} was seen waiting on a timer, the network, a lock or another process; ${what}.` };
}

// A log wait's part after its cursor once its writer ended: the last line's match when the job left it
// without a newline (a whole line was matched by the probe already), nothing when none matches, null
// while more than one read of the file is still unread.
function lastLine(w: WaitRecord): string | undefined | null {
  const s = w.spec as Extract<WaitSpec, { kind: "log" }>;
  const st = live.get(w.id);
  const f = openWaited(s.path, w);
  if ("not" in f) return undefined;
  try {
    const from = st?.ident === f.ident ? st.offset ?? 0 : 0;
    if (f.size - from > LOG_READ) return null;
    if (f.size <= from) return undefined;
    const buf = Buffer.alloc(f.size - from);
    readSync(f.fd, buf, 0, buf.length, from);
    const rest = buf.toString("utf8");
    if (rest.includes("\n")) return null; // whole lines the probe has not read yet
    return new RegExp(s.match).test(rest) ? rest : undefined;
  } finally { closeSync(f.fd); }
}

function resolvePath(p: string, cwd: string) {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

// How this module looks at a process: signal 0 (false when there is no such
// process) and its /proc stat line (null when unreadable). Tests replace it.
export const procfs = {
  signal0(pid: number): boolean {
    try { process.kill(pid, 0); } catch (e: any) { if (e.code === "ESRCH") return false; }
    return true;
  },
  stat(pid: number): string | null {
    try { return readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return null; }
  },
};

// The stat fields after the command name (which may hold spaces and parens).
const statFields = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).split(" ");

function procAlive(pid: number): boolean {
  if (!procfs.signal0(pid)) return false;
  // A zombie has exited: its parent just has not read its status yet. One
  // whose first thread ended while others still run has not (src/core/pid.ts).
  const stat = procfs.stat(pid);
  if (stat) return readStat(stat) !== "ended";
  return existsSync(`/proc/${pid}`) || process.platform !== "linux";
}

// When the process started (clock ticks since boot): with the pid, what names
// one process, since a pid is reused once its process ends.
function startTime(pid: number): string | undefined {
  const stat = procfs.stat(pid);
  return stat ? statFields(stat)[19] : undefined;
}

// A pattern with a leading inline flag group, as Python, PCRE and Go write it
// ("(?i)exit"): JavaScript takes the same flags as a group around the pattern.
function pattern(p: unknown): string {
  const s = String(p);
  const m = /^\(\?([ims]+)\)/.exec(s);
  const out = m ? `(?${m[1]}:${s.slice(m[0].length)})` : s;
  new RegExp(out);
  return out;
}

const writerOf = (spec: any): { writer?: string } => (spec.writer === undefined || spec.writer === null || spec.writer === "" ? {} : { writer: String(spec.writer).trim() });

// Why a process wait with no process to wait on is refused, and the kind that does what the call
// meant. Models sent pid 0 or 1 with a timeout of a few seconds as a pause, and the path of their
// own command's log with no pid. A command's end starts a turn of an idle session and rides a turn
// at work (src/server/routes/tools.ts); a file wait on `<log>.exit` (src/tools/jobs.ts writes it at
// the end) waits for it too. A session on another machine has its commands there: their end does
// not reach this daemon, and a wait here does not see their files.
// `job`: the background command of the session whose output file a path is.
function processRefusal(spec: any, cwd: string, o: { elsewhere?: boolean; job?: (path: string) => string | undefined }): string {
  const woken = o.elsewhere
    ? "A background command of this session does not wake it when it ends: the command runs on the session's machine, whose files and processes a wait here does not see: wait there with a command in the shell tool."
    : "A background command you started wakes this session by itself when it ends (a turn at work reads its end at its next step): it needs no wait.";
  const exitFile = (log: string) => (o.elsewhere ? "" : ` To wait on it all the same, use kind "file" with path "${log}.exit", which its end writes.`);
  if (typeof spec.path === "string" && spec.path.trim()) {
    const path = resolvePath(spec.path.trim(), cwd);
    const log = path.endsWith(".exit") ? path.slice(0, -".exit".length) : path;
    const job = o.job?.(log);
    if (job) return `kind "process" waits on a process id, not a path. ${path} is the output of your background command ${job}. ${woken}${exitFile(log)}`;
    return `kind "process" waits on a process id, not a path. To wait for that file, use kind "file" (with contains for its text) or kind "log" (with match for a new line). ${woken}${exitFile("<its log>")}`;
  }
  const pause = 'For a pause, use kind "timer" with seconds.';
  const given = spec.pid !== undefined && spec.pid !== null && spec.pid !== "";
  const head = given && Number.isInteger(Number(spec.pid)) && Number(spec.pid) <= 1
    ? `pid ${Number(spec.pid)} is no process to wait on. ${pause}`
    : `a process wait needs a running process's id (a number above 1, as \`echo $!\` prints it). ${pause}`;
  return `${head} ${woken}${o.elsewhere ? "" : ' To wait on one all the same, use kind "file" on its log\'s path plus ".exit", which its end writes.'}`;
}

// A process wait that names no process, answered with the wait it meant instead of a refusal (each refusal
// cost a step, and the next call was this one). `process` with pid 0 or 1 (or none) and a few seconds' timeout
// is a pause; with the path of the output of the session's own background command, or its id as writer, it is
// that command's end. Nothing else is reframed: a real pid, another kind, and a call that says nothing of
// what it waits for stay as they are (a pid given with another kind is ignored by `normalize`). A call with no
// process, path, writer or seconds waits for the end of the session's one running background command, when it has one (`only`).
// `job`: the background command of the session a path is the output of (its id); `log`: the output file of one
// by its id; `only`: the id of the session's one running background command. Neither is given for a session whose commands run elsewhere.
export function reframe(
  input: any,
  cwd: string,
  o: { job?: (path: string) => string | undefined; log?: (id: string) => string | undefined; only?: () => string | undefined } = {},
): { input: any; said: string } | undefined {
  const spec = input?.spec && typeof input.spec === "object" ? input.spec : input;
  if (spec?.kind !== "process") return undefined;
  const given = spec.pid !== undefined && spec.pid !== null && spec.pid !== "";
  if (given && !(Number.isInteger(Number(spec.pid)) && Number(spec.pid) <= 1)) return undefined;
  const why = given ? `pid ${Number(spec.pid)} is no process` : "a process wait needs a process id, and none was given";
  const keep = { timeout_seconds: input.timeout_seconds, note: input.note };
  let log: string | undefined;
  let id: string | undefined;
  if (typeof spec.path === "string" && spec.path.trim()) {
    const path = resolvePath(spec.path.trim(), cwd);
    log = path.endsWith(".exit") ? path.slice(0, -".exit".length) : path;
    id = o.job?.(log);
    if (!id) return undefined;
  } else if (typeof spec.writer === "string" && spec.writer.trim()) {
    const w: string = spec.writer.trim();
    log = o.log?.(w);
    if (!log) return undefined;
    id = w;
  } else if (!(Number(spec.seconds ?? spec.timeout_seconds) > 0)) {
    // No process, no path, no pause: the one background command that is still running is what it waits for.
    id = o.only?.();
    log = id ? o.log?.(id) : undefined;
  }
  if (id && log) {
    return {
      input: { kind: "file", path: `${log}.exit`, ...(o.log?.(id) ? { writer: id } : {}), ...keep },
      said: ` ${why}: waited for the end of your background command ${id} (its exit file) instead. kind "process" is for a process id; a background command you started wakes this session by itself when it ends, so a wait on it is not needed.`,
    };
  }
  const secs = Number(spec.seconds ?? spec.timeout_seconds);
  if (!(secs > 0)) return undefined;
  return {
    input: { kind: "timer", seconds: secs, note: input.note },
    said: ` ${why}: set a pause of ${secs} s instead. For a pause, use kind "timer" with seconds.`,
  };
}

// Whether a wait may probe a local address: the address is this machine's own and its port is one a process of the
// session listens on. A wait runs unasked as a read, so it does not reach other local services (the owner's own
// daemons and databases); a server the session started is its own. A port only named in a command line counts for
// nothing: the words of a command say nothing of what listens.
// `listening`: ports the session's running commands' processes listen on.
export function localProbe(url: URL, listening: readonly number[]): boolean {
  const bytes = addressBytes(url.hostname);
  const v4 = bytes && bytes.length === 16 ? mappedV4(bytes) : null;
  const loopback = bytes
    ? (v4 ?? (bytes.length === 4 ? bytes : null))?.[0] === 127 || (bytes.length === 16 && !v4 && bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1)
    : /^(localhost|.*\.localhost)\.?$/i.test(url.hostname);
  if (!loopback) return false;
  return listening.includes(Number(url.port || (url.protocol === "https:" ? 443 : 80)));
}

// Validates a spec the way the model or the page wrote it; throws the reason.
// `elsewhere`: the session's commands run on another machine, whose files a wait here does not see.
// `job`: the background command of the session whose output file a path is (for the words of a refusal).
export function normalize(raw: any, cwd: string, o: { elsewhere?: boolean; job?: (path: string) => string | undefined } = {}): WaitSpec {
  const spec = raw?.spec && typeof raw.spec === "object" ? raw.spec : raw;
  const kind = spec?.kind ?? (spec?.command ? "monitor" : spec?.pid ? "process" : spec?.url ? "http" : spec?.match && spec?.path ? "log" : spec?.path ? "file" : spec?.seconds || spec?.at_ms ? "timer" : undefined);
  const custom = kinds.get(kind);
  if (custom) return custom.normalize(spec, cwd);
  switch (kind) {
    case "timer": {
      const at = spec.at_ms ? Number(spec.at_ms) : Date.now() + Number(spec.seconds) * 1000;
      if (!Number.isFinite(at) || at <= Date.now() - 1000) throw new Error("a timer needs seconds > 0 or a future at_ms");
      if (at - Date.now() > MAX_TIMEOUT * 1000) throw new Error("a timer is at most a year out");
      return { kind, at_ms: Math.round(at) };
    }
    case "file":
      if (!spec.path) throw new Error("a file wait needs a path");
      return { kind, path: resolvePath(String(spec.path), cwd), contains: spec.contains ? String(spec.contains) : undefined, ...writerOf(spec) };
    case "log":
      if (!spec.path || !spec.match) throw new Error("a log wait needs a path and a match pattern");
      return { kind, path: resolvePath(String(spec.path), cwd), match: pattern(spec.match), ...writerOf(spec) };
    case "http": {
      const u = new URL(String(spec.url));
      if (!/^https?:$/.test(u.protocol)) throw new Error("an http wait needs an http(s) URL");
      // No status: any 2xx or 3xx. One given is the only one that fires the
      // wait, so it has to be one a response can carry.
      if (spec.status === undefined || spec.status === null) return { kind, url: u.href };
      const status = typeof spec.status === "number" ? spec.status : typeof spec.status === "string" && /^\d+$/.test(spec.status.trim()) ? Number(spec.status) : NaN;
      if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error("an http wait's status is a whole number from 200 to 599; leave it out to wait for any 2xx or 3xx");
      return { kind, url: u.href, status };
    }
    case "process": {
      const pid = Number(spec.pid);
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(processRefusal(spec, cwd, o));
      if (!procAlive(pid)) throw new Error(`process ${pid} has already ended`);
      const start = startTime(pid);
      return start ? { kind, pid, start } : { kind, pid };
    }
    case "websocket": {
      const u = new URL(String(spec.url));
      if (!/^wss?:$/.test(u.protocol)) throw new Error("a socket monitor needs a ws:// or wss:// URL");
      if (u.username || u.password) throw new Error("a socket URL carries no credentials");
      const protocols = Array.isArray(spec.protocols) ? spec.protocols.map(String).filter(Boolean).slice(0, 8) : undefined;
      return {
        kind, url: u.href, protocols: protocols?.length ? protocols : undefined, match: spec.match ? pattern(spec.match) : undefined,
        coalesce_ms: Math.min(Math.max(Number(spec.coalesce_ms ?? 500), 0), 60_000),
        max_events: Math.min(Math.max(Number(spec.max_events ?? 20), 1), 200),
      };
    }
    case "pr_checks": {
      const repo = String(spec.repo ?? "").trim();
      const n = Number(spec.pr_number ?? spec.pr);
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.startsWith("-")) throw new Error("a pr_checks wait needs repo as owner/name");
      if (!Number.isInteger(n) || n < 1) throw new Error("a pr_checks wait needs a positive pr_number");
      return { kind, repo, pr_number: n };
    }
    case "monitor":
      if (!spec.command) throw new Error("a monitor needs a command");
      return {
        kind, command: String(spec.command), match: spec.match ? pattern(spec.match) : undefined,
        coalesce_ms: Math.min(Math.max(Number(spec.coalesce_ms ?? 500), 0), 60_000),
        max_events: Math.min(Math.max(Number(spec.max_events ?? 20), 1), 200),
      };
    default:
      throw new Error("a wait is a timer (seconds), file (path, contains?), log (path, match), http (url, status?), process (pid), pr_checks (repo, pr_number), monitor (command, match?) or websocket (url, match?)");
  }
}

// The active wait of the session on the same condition, when the model asks
// for it again before it fired: that one stands, with the later of the two
// deadlines, and no second wait is set (a second would only wake the session
// again for the same thing). Not a timer, a monitor or a socket: two of those
// are two wakes.
export function twin(sessionId: string, spec: WaitSpec, opts: { timeout_seconds?: number } = {}): WaitRecord | undefined {
  if (spec.kind === "timer" || isMonitor(spec.kind)) return undefined;
  const key = JSON.stringify(spec);
  const w = list(sessionId, 0).find((x) => x.status === "active" && x.kind === spec.kind && JSON.stringify(x.spec) === key);
  if (!w) return undefined;
  const timeout = Number(opts.timeout_seconds ?? DEFAULT_TIMEOUT);
  const deadline = Date.now() + Math.min(Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT, MAX_TIMEOUT) * 1000;
  if (deadline > w.deadline) {
    D().store.db.query("UPDATE waits SET deadline = ? WHERE id = ? AND status = 'active'").run(deadline, w.id);
    emit("wait", get(w.id));
  }
  return get(w.id);
}

export function create(sessionId: string, spec: WaitSpec, opts: { timeout_seconds?: number; note?: string; by?: "owner" } = {}): WaitRecord {
  const s = D().store.session(sessionId);
  if (!s) throw new Error("no such session");
  if (s.archived) throw new Error("the session is archived");
  // (The wait reads this machine's disk; such a session's files are on another. A command waits there.)
  if (s.machine && (spec.kind === "file" || spec.kind === "log")) throw new Error(`a ${spec.kind} wait reads this machine's files, and this session's are on ${s.machine}: wait there with a command in the shell tool instead`);
  if (activeFor(sessionId) >= WAIT_LIMIT) throw new Error(`the session already has ${WAIT_LIMIT} active waits; cancel one first`);
  // A writer named by the model is one of this session's commands.
  const named = (spec.kind === "file" || spec.kind === "log") && spec.writer ? findJob(sessionId, spec.writer) : undefined;
  if ((spec.kind === "file" || spec.kind === "log") && spec.writer && !named) {
    const ids = jobsOf(sessionId).filter(running).map((j) => j.id);
    throw new Error(`no background command ${spec.writer} in this session (writer is the ID a background command was started with${ids.length ? `; running: ${ids.slice(0, 8).join(", ")}` : "; none runs now"})`);
  }
  const now = Date.now();
  const isMon = isMonitor(spec.kind);
  let timeout = Number(opts.timeout_seconds ?? (isMon ? MONITOR_DEFAULT : DEFAULT_TIMEOUT));
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("timeout_seconds must be a positive number");
  timeout = Math.min(timeout, isMon ? MONITOR_MAX : MAX_TIMEOUT);
  // A timer's deadline is its wake time plus a minute: it fires, it does not time out.
  const deadline = spec.kind === "timer" ? spec.at_ms! + 60_000 : now + timeout * 1000;
  const rec: WaitRecord = {
    id: Bun.randomUUIDv7().slice(-12), session_id: sessionId, kind: spec.kind, spec, note: String(opts.note ?? "").slice(0, 500),
    status: "active", created: now, deadline, events: 0, by: opts.by ?? null,
  };
  D().store.db.query("INSERT INTO waits (id, session_id, kind, spec, note, status, created, deadline, by) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)")
    .run(rec.id, sessionId, rec.kind, JSON.stringify(spec), rec.note, now, deadline, rec.by ?? null);
  const st: any = {};
  if (spec.kind === "log") {
    // Lines already in the file when the wait starts are not what it waits for.
    try { const f = identOf(spec.path); st.offset = f.size; st.ident = f.ident; } catch { st.offset = 0; }
    saveCursor(rec.id, { offset: st.offset, ident: st.ident });
  }
  if (spec.kind === "log" || spec.kind === "file") {
    // Where the file stood: its wake carries what it gained since.
    let from: { offset: number; ident?: string } = { offset: 0 };
    try { const f = identOf(spec.path); from = { offset: f.size, ident: f.ident }; } catch {}
    setState(rec.id, "from", from);
    // (What the gate, or the owner on its card, let it read.)
    approve(rec.id, spec.path);
    if (named) { setState(rec.id, "job", named.id); setState(rec.id, "named", true); }
    linkJob(get(rec.id)!);
  }
  live.set(rec.id, st);
  if (spec.kind === "monitor") startMonitor(rec);
  if (spec.kind === "websocket") startSocket(rec);
  emit("wait", get(rec.id));
  activity.record("wait", "set", sessionId, `Wait ${rec.kind}${rec.note ? ` "${rec.note}"` : ""} set`, { wait_id: rec.id });
  // (Its kind only: a wait's note, path or command is not the log's to keep.)
  sayAt({ session: sessionId }, waitSetLine({ id: rec.id, on: waitsFor(rec.kind), due: spec.kind === "timer" ? spec.at_ms! : deadline, timer: spec.kind === "timer", title: s.title, clock: zonedClock }));
  return get(rec.id)!;
}

// A wait told later than its time, in words for its outcome and for the rows that list it: a timer that
// fired after its wake time, a deadline that passed, a condition first seen at a start after the daemon
// was down (it may have held for all of that time). Nothing when it was on time.
export function lateOf(w: Pick<WaitRecord, "kind" | "spec" | "created" | "deadline">, status: WaitRecord["status"], now: number, down = lastDown()): { late?: string; note?: string } {
  const due = status === "fired" && w.kind === "timer" ? (w.spec as Extract<WaitSpec, { kind: "timer" }>).at_ms : status === "timeout" ? w.deadline : undefined;
  if (due !== undefined) {
    const late = lateWords(due, now, down);
    if (!late) return {};
    return { late, note: `It ${status === "fired" ? "fired" : "timed out"} ${late}.` };
  }
  // A condition the first probes of this start found: it may have held since the daemon went down.
  if (status === "fired" && down && w.created < down.from && now - down.to < LATE_MS && down.to - down.from >= LATE_MS) {
    return { late: `seen at the daemon's start, after ${span(down.to - down.from)} down`, note: `It was seen at the daemon's start: the daemon was down for ${span(down.to - down.from)} before it, so this may have held since then.` };
  }
  return {};
}

function settle(id: string, status: WaitRecord["status"], outcome: string, wake = true, boot = false, carry = ""): boolean {
  const w = get(id);
  if (!w || w.status !== "active") return false;
  const lateness = lateOf(w, status, Date.now());
  if (lateness.note) outcome = `${outcome} ${lateness.note}`;
  const st = live.get(id);
  if (st?.proc) {
    try { process.kill(-st.proc.pid, "SIGTERM"); } catch {}
  }
  if (st?.ws) try { st.ws.close(1000); } catch {}
  st?.probing?.abort.abort(); // a probe still out is stopped; what it says later is not used
  live.delete(id);
  // An agent's wake says what else it still waits on (models set a timer beside a wait as a fallback
  // and wrote their report on the wake, then were woken again by the timer).
  const others = wake ? othersOf(w) : "";
  // The status changes only from active, in the same statement that reads it,
  // and the same statement records that the wake is owed.
  if (!D().store.db.query("UPDATE waits SET status = ?, outcome = ?, ended = ?, wake = ? WHERE id = ? AND status = 'active'").run(status, `${kept(outcome)}${carry ? `\n\n${carry}` : ""}${others ? `\n\n${others}` : ""}`, Date.now(), wake ? 1 : 0, id).changes) return false;
  const rec = get(id)!;
  try { kinds.get(w.kind)?.ended?.(rec); } catch (e) { capture(e, { at: "a wait kind's end", wait: id }); }
  emit("wait", rec);
  activity.record("wait", status, w.session_id, `Wait ${w.kind}${w.note ? ` "${w.note}"` : ""} ${status}${lateness.late ? ` ${lateness.late}` : ""}: ${outcome.split("\n")[0]!.slice(0, 200)}`, { wait_id: id, ...(lateness.late ? { late: lateness.late } : {}) });
  sayAt({ session: w.session_id }, waitEndLine({ id, on: waitsFor(w.kind), status, ms: (rec.ended ?? Date.now()) - w.created, late: lateness.late, title: D().store.session(w.session_id)?.title }), status === "timeout" ? "warn" : "info");
  if (status === "timeout") failures.seen(w.session_id, "wait", w.kind, outcome);
  if (wake) sendWake(rec, boot);
  // Settled with no wake (cancelled, with its session): nothing more is waited for there, maybe.
  else try { D().engine.waitsSettled?.(w.session_id); } catch (e) { capture(e, { at: "cache plan after a wait", session: w.session_id }); }
  return true;
}

// The line of an agent's wake that names its other active waits, and how to cancel them.
function othersOf(w: WaitRecord): string {
  const s = D().store.session(w.session_id);
  if (!s?.parent_id) return "";
  const rest = list(w.session_id, 0).filter((o) => o.id !== w.id && o.status === "active");
  if (!rest.length) return "";
  return othersText(rest.map((o) => ({ id: o.id, kind: o.kind, note: o.note, due: o.kind === "timer" ? (o.spec as { at_ms?: number }).at_ms : undefined })), familyOf(s.model) === "claude" ? "TaskStop" : "cancel_wait", (ms) => localTime(ms).slice(0, 5));
}

const BOOT_COALESCE = 300; // how long a wake sent at start waits for the engine to close open turns

// The wake of a settled wait, from its row: the same text now or after a
// restart. It stays owed until it is stored in the session's transcript.
const wakeSent = (id: string) => void D().store.db.query("UPDATE waits SET wake = 0 WHERE id = ?").run(id);
function sendWake(w: WaitRecord, boot = false) {
  const body = `${w.note ? w.note + "\n" : ""}${w.outcome ?? ""}`;
  const text = `<wait_fired id="${w.id}" kind="${w.kind}" outcome="${w.status}">\n${inert(body, "wait_fired")}\n</wait_fired>`;
  // An archived session runs no waits: nothing is owed to it.
  // At start the engine first closes the turns the last daemon left open, and a
  // wake never lands inside one. A session whose cut turn the engine is about
  // to continue gets the wake when that turn ends, not ahead of it.
  const when = !boot ? {} : cutTurn(w.session_id) ? { hold: true } : { coalesceMs: BOOT_COALESCE };
  if (!deliver(w.session_id, text, { kind: "wait", wait_id: w.id, outcome: w.status }, { ...when, onSent: () => wakeSent(w.id) })) wakeSent(w.id);
}

// Whether the wake already reached the session: stored as a prompt (alone or
// as one part of a grouped one), or queued in the store for its next turn.
function wakeStored(w: WaitRecord): boolean {
  const is = (m: any) => m?.wait_id === w.id && m?.outcome === w.status;
  const holds = (m: any) => is(m) || (Array.isArray(m?.parts) && m.parts.some(is));
  const rows = D().store.db.query<{ data: string }, [string, string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'user' AND instr(data, ?) > 0").all(w.session_id, w.id);
  return rows.some((r) => holds(JSON.parse(r.data))) || D().store.queue(w.session_id).some((q) => holds(q.meta));
}

// What a cancel did: "cancelled" (it stopped the wait before it ended), or the
// status the wait already had (a wake that already fired is not taken back).
// Undefined when there is no such wait.
export function cancel(id: string, sessionId?: string): "cancelled" | "already_cancelled" | "fired" | "timeout" | "ended" | undefined {
  const w = get(id);
  if (!w || (sessionId && w.session_id !== sessionId)) return undefined;
  // Cancelling is the owner's or the model's own act: nothing to wake for.
  if (settle(id, "cancelled", "Cancelled.", false)) return "cancelled";
  const st = get(id)!.status;
  return st === "cancelled" ? "already_cancelled" : (st as "fired" | "timeout" | "ended");
}

export function cancelText(id: string, r: ReturnType<typeof cancel>): string {
  if (r === "cancelled") return `Cancelled ${id} before it ended.`;
  if (r === "fired") return `${id} had already fired; cancelling did not stop that wake.`;
  if (r === "already_cancelled") return `${id} was already cancelled.`;
  return r ? `${id} had already ended (${r}); nothing to cancel.` : `No wait ${id} in this session.`;
}

// `keepOwner`: the waits the owner set by hand (by = 'owner') stay, with their owed wakes. Returns the ids left set.
export function cancelForSession(sessionId: string, why = "Cancelled with its session.", o: { keepOwner?: boolean } = {}): Set<string> {
  const kept = new Set<string>();
  for (const w of list(sessionId, 0)) {
    if (o.keepOwner && w.by === "owner") { kept.add(w.id); continue; }
    if (w.status === "active") settle(w.id, "cancelled", why, false);
  }
  // A stopped or archived session gets no wake of an earlier wait either, and no batch of its monitors.
  const mine = o.keepOwner ? " AND by IS NOT 'owner'" : "";
  D().store.db.query(`UPDATE waits SET wake = 0 WHERE session_id = ? AND wake = 1${mine}`).run(sessionId);
  D().store.db.query(`DELETE FROM wait_events WHERE wait_id IN (SELECT id FROM waits WHERE session_id = ?${mine})`).run(sessionId);
  return kept;
}

// The last probe's error, of a wait still active (a probe that answers after
// its wait was settled changes nothing).
function setError(id: string, msg: string | null) {
  // (Only a change is written: a probe says the same thing at every tick.)
  D().store.db.query("UPDATE waits SET last_error = ? WHERE id = ? AND status = 'active' AND last_error IS NOT ?").run(msg, id, msg);
}

// pr_checks at the pace gh pr checks --watch polls (10 s).
const PROBE_MS: Partial<Record<WaitSpec["kind"], number>> = { file: 1000, log: 1000, process: 1000, http: 3000, pr_checks: 10_000 };
// A pull request that shows no checks yet may get them in a moment: it fires
// as "no checks" only after this long.
const EMPTY_CHECKS_GRACE = 120_000;

// How long a probe that goes out of the process may take before it is stopped
// and said so: an HTTP request five seconds, gh and a module's own probe three
// of gh's ten-second periods.
const PROBE_LIMIT_MS = 30_000;
const limitOf = (kind: string) => (kind === "http" ? 5000 : PROBE_LIMIT_MS);

// A probe of a local fact (a clock, a file, a process) answers at once; one
// that asks something outside (HTTP, gh, another machine) returns a promise,
// which the scheduler does not wait for.
function probe(w: WaitRecord, signal: AbortSignal): Promise<string | undefined> | string | undefined {
  const s = w.spec;
  const custom = kinds.get(s.kind);
  if (custom) return custom.probe(w, signal);
  switch (s.kind) {
    case "timer":
      return Date.now() >= s.at_ms! ? "The timer is up." : undefined;
    case "file": {
      if (!existsSync(s.path)) return undefined;
      if (!s.contains) return `${s.path} exists.`;
      // (Read as the session may: a regular file it may read, never a FIFO that holds the open.)
      const f = openWaited(s.path, w);
      if ("not" in f) return unread(w, s.path, f);
      let text: string;
      try { text = readFileSync(f.fd, "utf8"); } finally { closeSync(f.fd); }
      const i = text.indexOf(s.contains);
      return i >= 0 ? `${s.path} contains "${s.contains}".` : undefined;
    }
    case "log": {
      const st = live.get(w.id) ?? { offset: 0 };
      live.set(w.id, st);
      // (Read as the session may: a regular file it may read, where it really is.)
      const f = openWaited(s.path, w);
      if ("not" in f) return unread(w, s.path, f);
      // Another file at the path (rotated, renamed over it) is read from its
      // start; the same file shorter than the cursor was truncated.
      if ((st.ident && st.ident !== f.ident) || f.size < (st.offset ?? 0)) { st.offset = 0; st.skip = false; }
      const moved = st.ident !== f.ident;
      st.ident = f.ident;
      if (f.size === st.offset) { closeSync(f.fd); if (moved) saveCursor(w.id, cursor(st)); return undefined; }
      const fd = f.fd;
      try {
        const len = Math.min(f.size - (st.offset ?? 0), LOG_READ);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, st.offset ?? 0);
        let from = 0;
        if (st.skip) {
          // The rest of a line too long to read whole: up to its newline.
          const nl = buf.indexOf(0x0a);
          if (nl < 0) { st.offset! += len; saveCursor(w.id, cursor(st)); return undefined; }
          from = nl + 1;
          st.skip = false;
        }
        const cut = buf.lastIndexOf(0x0a);
        if (cut < from) {
          // No line ends in a full read: the line is longer than a read. It is
          // skipped (and said so) and the next complete line is matched.
          if (len === LOG_READ) { st.offset! += len; st.skip = true; st.skipped = (st.skipped ?? 0) + 1; setError(w.id, `skipped ${st.skipped} line${st.skipped > 1 ? "s" : ""} over 4 MiB`); }
          else if (from) st.offset! += from;
          saveCursor(w.id, cursor(st));
          return undefined;
        }
        const text = buf.subarray(from, cut).toString("utf8");
        const re = new RegExp(s.match);
        const hit = text.split(/\r?\n/).find((l) => re.test(l));
        // The cursor does not pass a matching line: settling the wait is what
        // consumes it, so a daemon that stops in between reads the line again.
        if (hit !== undefined) return `Matched in ${s.path}:\n${hit.slice(0, DISPLAY)}`;
        st.offset! += cut + 1;
        saveCursor(w.id, cursor(st));
        return undefined;
      } finally {
        closeSync(fd);
      }
    }
    case "http":
      // Five seconds whatever becomes of the wait: one whose session was deleted
      // has no row for the scheduler to stop it by.
      return fetch(s.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(limitOf("http"))]), redirect: "manual" }).then((r) => {
        void r.body?.cancel().catch(() => {}); // only the status is read: the connection is not kept for a body
        const ok = s.status != null ? r.status === s.status : r.status >= 200 && r.status < 400;
        setError(w.id, ok ? null : `HTTP ${r.status}`);
        return ok ? `${s.url} answered ${r.status}.` : undefined;
      });
    case "process":
      if (!procAlive(s.pid)) return `Process ${s.pid} has ended.`;
      // The pid names another process now: the one waited on has ended. An
      // unreadable start time proves nothing either way; the pid is alive.
      const now = s.start && startTime(s.pid);
      return now && now !== s.start ? `Process ${s.pid} has ended (its id now names another process).` : undefined;
    case "pr_checks":
      return prChecks(w, s, signal);
    default:
      return undefined;
  }
}

// gh in a process group of its own, so stopping it also stops what it started
// (a credential helper) and closes the pipes read here.
async function prChecks(w: WaitRecord, s: Extract<WaitSpec, { kind: "pr_checks" }>, signal: AbortSignal): Promise<string | undefined> {
  const p = Bun.spawn([process.env.KEEL_GH_BIN || "gh", "pr", "view", String(s.pr_number), "--repo", s.repo, "--json", "state,statusCheckRollup"], { cwd: "/", env: gitEnv("/"), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true }); // (gh runs git by itself: outside any repository, with the daemon's keys)
  const stop = () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  try {
    const [out, err, code] = await Promise.all([readText(p.stdout, "gh pr view"), readText(p.stderr, "gh pr view"), p.exited]);
    if (code !== 0) throw new Error(`gh pr view failed: ${err.trim().slice(0, 300)}`);
    setError(w.id, null);
    return prChecksVerdict(JSON.parse(out), s.repo, s.pr_number, Date.now() - w.created >= EMPTY_CHECKS_GRACE);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

const cursor = (st: { offset?: number; ident?: string; skip?: boolean; skipped?: number }): LogCursor => ({ offset: st.offset ?? 0, ident: st.ident, skip: st.skip, skipped: st.skipped });

// What of a long line an event shows: the part around the match (or its
// start), and how much was left out.
export function shown(line: string, re?: RegExp): string {
  if (line.length <= DISPLAY) return line;
  const at = re ? Math.max(0, (line.search(re) ?? 0) - DISPLAY / 4) : 0;
  const from = Math.min(at, line.length - DISPLAY);
  return `${from ? "[...] " : ""}${line.slice(from, from + DISPLAY)}${from + DISPLAY < line.length ? " [...]" : ""} (${DISPLAY} of ${line.length} characters)`;
}

// Feeds a monitor's lines into its batch: a matching line waits up to
// coalesce_ms for the next before the batch is delivered. The match is on the
// whole line (or socket message); only what is shown is cut. `cut`: the line
// went past LINE_MAX and was cut there.
function lineSink(id: string, s: { match?: string; coalesce_ms?: number }) {
  const st = live.get(id)!;
  const re = s.match ? new RegExp(s.match) : undefined;
  return (line: string, cut = false) => {
    if (!line.trim()) return;
    const text = shown(line, re) + (cut ? ` (the line went on past ${LINE_MAX / 1024} KiB; matched up to there)` : "");
    st.tail!.push(text);
    if (st.tail!.length > 20) st.tail!.shift();
    if (re && !re.test(line)) return;
    st.batch!.push(text);
    st.flushAt ??= Date.now() + (s.coalesce_ms ?? 500);
  };
}

// A WebSocket monitor: each text message is one line (newlines folded), a
// binary frame is named by its size, a message over 1 MiB or the socket
// closing ends it. The daemon opens the socket, so the gate judged the call.
function startSocket(w: WaitRecord) {
  const s = w.spec as Extract<WaitSpec, { kind: "websocket" }>;
  const st = live.get(w.id) ?? {};
  live.set(w.id, st);
  st.batch = [];
  st.tail = [];
  st.dropped = 0;
  const onLine = lineSink(w.id, s);
  const end = (why: string) => {
    if (get(w.id)?.status !== "active") return;
    flushMonitor(w.id, true);
    const tail = !get(w.id)?.events && st.tail?.length ? `\nLast messages:\n${st.tail.slice(-5).join("\n")}` : "";
    settle(w.id, "ended", `${why}${tail}`);
  };
  let ws: WebSocket;
  // The ledger's row of the opening (a monitor sends nothing after it): for the wait's session, whoever starts it.
  const rows = socketRows(s.url, undefined, { tool: "monitor", via: "websocket", session: w.session_id });
  try {
    ws = new WebSocket(s.url, s.protocols);
  } catch (e) {
    rows.failed((e as Error).message);
    queueMicrotask(() => end(`The socket could not be opened: ${(e as Error).message}`));
    return;
  }
  st.ws = ws;
  ws.binaryType = "arraybuffer";
  let opened = false;
  const opening = setTimeout(() => { if (!opened) { rows.failed("the socket did not open within 20 seconds"); end("The socket did not open within 20 seconds."); try { ws.close(); } catch {} } }, 20_000);
  ws.onopen = () => { opened = true; clearTimeout(opening); rows.opened(); };
  ws.onmessage = (ev) => {
    const size = typeof ev.data === "string" ? Buffer.byteLength(ev.data) : (ev.data as ArrayBuffer).byteLength;
    if (size > 1 << 20) {
      end(`A message of ${size} bytes is over the 1 MiB a socket monitor takes; it was stopped. Subscribe to a filtered feed if the server has one.`);
      try { ws.close(1009); } catch {}
      return;
    }
    onLine(typeof ev.data === "string" ? ev.data.replace(/\r?\n|\r/g, " ") : `[binary frame, ${size} bytes]`);
  };
  ws.onerror = () => { if (!opened) { rows.failed("the socket could not be opened"); end("The socket could not be opened."); } };
  ws.onclose = (ev) => { clearTimeout(opening); if (!opened) rows.failed(`the socket closed before it opened (code ${ev.code})`); end(opened ? `The socket was closed by the other side (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""}).` : `The socket could not be opened (code ${ev.code}).`); };
}

// Reads `gh pr view --json state,statusCheckRollup`. A check run is done when
// its status is COMPLETED; a commit status has no status and is done when its
// state is SUCCESS, FAILURE or ERROR. A merged or closed pull request fires at
// once; one with no checks fires only after the grace period.
export function prChecksVerdict(v: any, repo: string, n: number, graceOver: boolean): string | undefined {
  const state = String(v?.state ?? "");
  if (state === "MERGED" || state === "CLOSED") return `PR #${n} in ${repo} is ${state}.`;
  const checks: any[] = Array.isArray(v?.statusCheckRollup) ? v.statusCheckRollup : [];
  if (!checks.length) return graceOver ? `PR #${n} in ${repo} has no checks.` : undefined;
  let passed = 0, skipped = 0;
  const failed: string[] = [];
  for (const c of checks) {
    const name = String(c?.name || c?.context || "unnamed check");
    if (typeof c?.status === "string") {
      if (c.status !== "COMPLETED") return undefined;
      const k = String(c.conclusion ?? "");
      if (k === "SUCCESS") passed++;
      else if (k === "NEUTRAL" || k === "SKIPPED") skipped++;
      else failed.push(name);
    } else {
      const k = String(c?.state ?? "");
      if (k === "SUCCESS") passed++;
      else if (k === "FAILURE" || k === "ERROR") failed.push(name);
      else return undefined; // PENDING, EXPECTED or unknown: not done
    }
  }
  return `PR #${n} in ${repo} checks completed: ${passed} passed, ${failed.length} failed, ${skipped} skipped${failed.length ? ` (failed: ${failed.slice(0, 8).join(", ")}${failed.length > 8 ? ", ..." : ""})` : ""}.`;
}

function startMonitor(w: WaitRecord) {
  const s = w.spec as Extract<WaitSpec, { kind: "monitor" }>;
  const session = D().store.session(w.session_id)!;
  const st = live.get(w.id) ?? {};
  live.set(w.id, st);
  st.batch = [];
  st.tail = [];
  st.dropped = 0;
  const proc = Bun.spawn(["bash", "-c", s.command], {
    cwd: session.workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    env: { ...process.env, TERM: "dumb" },
  });
  st.proc = proc;
  D().store.db.query("UPDATE waits SET state = ? WHERE id = ?").run(JSON.stringify({ pgid: proc.pid, start: startTime(proc.pid) }), w.id);
  const sink = lineSink(w.id, s);
  st.seen = 0; st.errs = 0; st.recent = [];
  // What a monitor that ends with no event says of its command's output: how much, how much on stderr, the last lines.
  const read = async (stream: ReadableStream<Uint8Array>, err: boolean) => {
    const onLine = (line: string, cut = false) => {
      if (line.trim()) {
        st.seen!++;
        if (err) st.errs!++;
        st.recent!.push(`${err ? "[stderr] " : ""}${line.length > 400 ? `${line.slice(0, 400)} [...]` : line}`);
        if (st.recent!.length > 20) st.recent!.shift();
      }
      sink(line, cut);
    };
    let buf = "";
    await pumpText(stream, (t) => {
      buf += t;
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop()!;
      for (const p of parts) onLine(p);
      if (buf.length > LINE_MAX) { onLine(buf, true); buf = ""; }
    }, "monitor").catch(() => {}); // the pipe closed with the process; what it wrote is already read
    if (buf) onLine(buf);
  };
  Promise.all([read(proc.stdout as ReadableStream<Uint8Array>, false), read(proc.stderr as ReadableStream<Uint8Array>, true), proc.exited])
    .then(([, , code]) => {
      if (get(w.id)?.status !== "active") return;
      flushMonitor(w.id, true);
      // The last lines only when no event carried them already.
      const tail = !get(w.id)?.events && st.tail?.length ? `\nLast lines:\n${st.tail.slice(-5).join("\n")}` : "";
      settle(w.id, "ended", `The command exited with code ${code}.${tail}`);
    })
    .catch((e) => capture(e, { at: "monitor", wait: w.id }));
}

// What a monitor that reached its deadline says. With no event, the model is told why there was none: how many
// lines its command wrote, how many of them on stderr and the last of those, and a file with the last lines.
function monitorTimeout(w: WaitRecord): string {
  const base = "The monitor reached its deadline and was stopped. Start it again if it is still needed.";
  const st = live.get(w.id);
  // (The record as it is now: the deadline's own flush may just have delivered an event the caller's copy does not count.)
  if ((get(w.id)?.events ?? w.events) || st?.seen === undefined) return base;
  const match = (w.spec as { match?: string }).match;
  const what = st.seen === 0 ? "Its command wrote nothing" : `No line matched ${match ?? "the pattern"} among the ${st.seen} line${st.seen === 1 ? "" : "s"} its command wrote${st.errs ? `, ${st.errs} of them on stderr` : ""}`;
  let text = `The monitor reached its deadline with no event and was stopped. ${what}.`;
  const errs = (st.recent ?? []).filter((l) => l.startsWith("[stderr] ")).slice(-3);
  if (errs.length) text += `\nLast stderr lines:\n${errs.map((l) => l.slice("[stderr] ".length)).join("\n")}`;
  if (st.recent?.length) {
    try {
      const dir = join(D().store.stateDir, "spill", w.session_id, "monitors");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${w.id}.log`);
      writeFileSync(file, conceal(`${st.recent.join("\n")}\n`), { mode: 0o600 });
      text += `\nThe last ${st.recent.length} lines are saved to ${file}.`;
    } catch (e) { capture(e, { at: "monitor log", wait: w.id }); }
  }
  return `${text} Start it again if it is still needed.`;
}

function flushMonitor(id: string, force = false) {
  const st = live.get(id);
  const w = get(id);
  if (!st?.batch?.length || !w) return;
  if (!force && Date.now() < (st.flushAt ?? 0)) return;
  const lines = st.batch.splice(0);
  st.flushAt = undefined;
  let text = "";
  let left = 0;
  for (const l of lines) {
    if (text.length + l.length > 8192) { left++; continue; }
    text += l + "\n";
  }
  const events = w.events + 1;
  const db = D().store.db;
  // The batch is stored before it is on its way: it is owed until its prompt is.
  db.transaction(() => {
    db.query("UPDATE waits SET events = ?, state = json_set(COALESCE(state, '{}'), '$.tail', json(?)) WHERE id = ?").run(events, JSON.stringify(st.tail ?? []), id);
    db.query("INSERT INTO wait_events (wait_id, n, text) VALUES (?, ?, ?)")
      .run(id, events, `<monitor_event id="${w.id}" batch="${events}"${w.note ? ` note="${attr(w.note)}"` : ""}>\n${inert(text, "monitor_event")}${left ? `[${left} more lines left out]\n` : ""}</monitor_event>`);
    db.query("DELETE FROM wait_events WHERE wait_id = ? AND n <= ?").run(id, events - EVENTS_KEPT);
  })();
  emit("wait", get(id));
  const s = w.spec as Extract<WaitSpec, { kind: "monitor" }>;
  sendEvents(w);
  if (events >= (s.max_events ?? 20)) settle(id, "ended", `The monitor delivered its ${events} batches and stopped.`);
}

// A monitor's batches the session is still owed, as one part of its next
// input, read from the table when it is sent: every batch kept, in order, as
// it was written, and how many older ones went. Sending it takes them off the
// table in the same write.
const isEvents = (id: string) => (m: Record<string, unknown>) => m.wait_id === id && m.outcome === "event";
function eventsOwed(id: string) {
  const db = D().store.db;
  const rows = db.query<{ n: number; text: string }, [string]>("SELECT n, text FROM wait_events WHERE wait_id = ? ORDER BY n").all(id);
  if (!rows.length) return undefined;
  const sent = db.query<{ sent: number | null }, [string]>("SELECT json_extract(state, '$.sent') AS sent FROM waits WHERE id = ?").get(id)?.sent ?? 0;
  const dropped = rows[0]!.n - sent - 1;
  const texts = rows.map((r) => r.text);
  // Said inside the first batch that is left, after its opening line.
  if (dropped > 0) texts[0] = texts[0]!.replace("\n", `\n[${dropped} earlier ${dropped === 1 ? "batch" : "batches"} of this monitor ${dropped === 1 ? "was" : "were"} dropped: more than ${EVENTS_KEPT} waited for this session]\n`);
  const last = rows.at(-1)!.n;
  return {
    text: texts.join("\n\n"),
    meta: { kind: "wait", wait_id: id, outcome: "event" },
    onSent: () => {
      db.query("DELETE FROM wait_events WHERE wait_id = ? AND n <= ?").run(id, last);
      db.query("UPDATE waits SET state = json_set(COALESCE(state, '{}'), '$.sent', ?) WHERE id = ?").run(last, id);
    },
  };
}
function sendEvents(w: WaitRecord, boot = false) {
  if (isPending(w.session_id, isEvents(w.id))) return; // on its way: it is read again when it is sent
  const first = eventsOwed(w.id);
  if (!first) return;
  const when = !boot ? { coalesceMs: 100 } : cutTurn(w.session_id) ? { hold: true } : { coalesceMs: BOOT_COALESCE };
  // An archived session runs no monitors: nothing is owed to it.
  if (!deliver(w.session_id, first.text, first.meta, { ...when, refresh: () => eventsOwed(w.id) })) D().store.db.query("DELETE FROM wait_events WHERE wait_id = ?").run(w.id);
}

const timedOut = (w: WaitRecord, last?: string | null) => `Timed out after ${Math.round((w.deadline - w.created) / 1000)} s.${last ? ` Last probe: ${last}` : ""}`;

// What a probe said: an outcome fires the wait, nothing at the deadline times it out.
function probed(w: WaitRecord, hit: string | undefined) {
  if (hit) { settle(w.id, "fired", hit + firedWith(w), true, false, carried(w)); return; }
  if (Date.now() >= w.deadline) { settle(w.id, "timeout", timedOut(w, get(w.id)?.last_error), true, false, carried(w)); return; }
  const judged = w.kind === "file" || w.kind === "log" ? judgeJob(w, Date.now()) : undefined;
  if (!judged) return;
  if (!settle(w.id, judged.status, judged.status === "fired" ? judged.text + firedWith(w) : judged.text, true, false, carried(w))) return;
  if (judged.status === "ended") try { waitEnded.tell?.(get(w.id)!, judged.cause); } catch (e) { capture(e, { at: "a wait that can no longer fire", wait: w.id }); }
}

// The session's other file and log waits on the same file, probed when one of them fires: those that
// hold too fire with it, in its wake (a second watch of one run woke the session a second time for the
// same line). What they said, for the wake.
function firedWith(w: WaitRecord): string {
  if (w.kind !== "file" && w.kind !== "log") return "";
  const path = (w.spec as { path: string }).path;
  const told: string[] = [];
  for (const o of list(w.session_id, 0)) {
    if (o.id === w.id || o.status !== "active" || (o.kind !== "file" && o.kind !== "log") || (o.spec as { path: string }).path !== path) continue;
    let r: unknown;
    try { r = probe(o, new AbortController().signal); } catch { continue; }
    if (typeof r !== "string") continue;
    if (settle(o.id, "fired", `${r}\nTold in the wake of wait ${w.id}, which fired on the same file at the same time.`, false)) told.push(`Wait ${o.id}${o.note ? ` ("${attr(o.note)}")` : ""} on the same file fired with it: ${r.split("\n").slice(0, 2).join(" ")}`);
  }
  return told.length ? `\n${told.join("\n")}` : "";
}

// Told when a file or log wait ended because it can no longer fire (its writer ended or stalled):
// src/automation/agents.ts tells the parent of an agent parked on it.
export const waitEnded: { tell?: (w: WaitRecord, cause: "ended" | "stalled") => void } = {};

// At the end of an agent's turn: its file and log waits that can no longer bring it anything new. The
// job that writes the file ended, the agent was told so in the turn (the result of the call that ran it,
// or the note of a background command's end, which goes with a request), and nothing of the job runs:
// the wait would wake it after its report only to say what it knows. Each is cancelled, or the wake it
// is owed and not yet stored is taken back, and said so on the wait. Returns their ids.
export function dropSpent(sessionId: string): string[] {
  // (A wake owed for a wait that fired is never taken back: it says what the end did not, that the
  // condition held. Only one that ended or timed out without it is.)
  const rows = D().store.db.query<Row, [string]>("SELECT * FROM waits WHERE session_id = ? AND kind IN ('file', 'log') AND by IS NOT 'owner' AND (status = 'active' OR (wake = 1 AND status IN ('ended', 'timeout')))").all(sessionId).map(toRec);
  const out: string[] = [];
  for (const w of rows) {
    const j = linkJob(w);
    if (!j || running(j)) continue;
    if (!spentAtTurnEnd({ ended: j.ended, alive: jobHasProcesses(j, true), told: !j.background || !endNoticeOwed(sessionId, j.id) })) continue;
    // An active one is probed first: a file that holds what it waits for already is kept, to fire (its next probe).
    if (w.status === "active" && holds(w)) continue;
    const why = `job ${j.id} that writes ${(w.spec as { path: string }).path} ended and the agent was told in the turn; nothing of it runs`;
    if (w.status === "active") {
      if (settle(w.id, "cancelled", `Cancelled at the end of the agent's turn: ${why}, so this wait could not fire.`, false)) out.push(w.id);
    } else if (!wakeStored(w)) {
      withdraw(sessionId, (m) => m.wait_id === w.id);
      D().store.db.query("UPDATE waits SET wake = 0, outcome = outcome || ? WHERE id = ? AND wake = 1").run(`\n\n(Not told: ${why}.)`, w.id);
      emit("wait", get(w.id));
      out.push(w.id);
    }
  }
  return out;
}

// How close in time a timer was set to the wait it backs up, for it to be that wait's fallback.
const FALLBACK_MS = 60_000;

// At the end of an agent's turn that a fired wait started: the timers set beside that wait as its fallback
// (models set one with every condition wait) can bring nothing new once the wait fired and the agent, told
// what else was still set, set nothing after it. Left set, the timer wakes the agent after its report, and
// the one-step turn reads its whole context again, often cold. Only a timer set within a minute of the wait
// that fired, before this turn began, by the agent: a wait the agent set in this turn, a timer set at another
// time and everything the owner set stay. Each is cancelled and says so. Returns their ids.
export function dropFallbacks(sessionId: string): string[] {
  let opened: { ts: number; ids: string[] } | undefined;
  for (const e of D().store.back(sessionId)) {
    if (e.kind !== "user") continue;
    const d = e.data as { kind?: string; wait_id?: string; outcome?: string; parts?: { kind?: string; wait_id?: string; outcome?: string }[] };
    const ids = [d, ...(Array.isArray(d.parts) ? d.parts : [])].filter((m) => m?.kind === "wait" && m.outcome === "fired" && m.wait_id).map((m) => String(m.wait_id));
    opened = { ts: e.ts, ids };
    break;
  }
  if (!opened?.ids.length) return [];
  const fired = opened.ids.map(get).filter((w): w is WaitRecord => !!w && w.kind !== "timer" && w.by !== "owner");
  if (!fired.length) return [];
  const mine = list(sessionId, 0).filter((w) => w.status === "active" && w.by !== "owner");
  if (mine.some((w) => w.created > opened!.ts)) return []; // it set a wait in this turn: it means to wait
  const out: string[] = [];
  for (const w of mine) {
    if (w.kind !== "timer") continue;
    const by = fired.find((f) => Math.abs(w.created - f.created) <= FALLBACK_MS);
    if (by && settle(w.id, "cancelled", `Cancelled at the end of the agent's turn: it was set beside wait ${by.id}, which fired, and the agent set no wait after it, so this one could only wake it after its report.`, false)) out.push(w.id);
  }
  return out;
}

// Whether a file or log wait's condition holds now (its probe, which for a log does not pass a matching line).
function holds(w: WaitRecord): boolean {
  if (live.get(w.id)?.probing) return true; // a probe is out: its answer decides
  try { return typeof probe(w, new AbortController().signal) === "string"; } catch { return false; }
}

function probeFailed(w: WaitRecord, e: unknown) {
  const msg = (e as Error)?.message || String(e);
  setError(w.id, msg);
  if (Date.now() >= w.deadline) settle(w.id, "timeout", timedOut(w, msg));
}

// When the next pass over the active waits has something to do (the daemon's
// tick sleeps until then while it is idle): a timer at its time, a probe a
// period after the last one, a probe in flight at its limit, a monitor at
// every pass, and each at its deadline at the latest.
export function nextDue(now = Date.now()): number | undefined {
  let at: number | undefined;
  for (const w of list(undefined, 0)) {
    const st = live.get(w.id);
    const t = isMonitor(w.kind) ? now
      : st?.probing ? (st.probing.late ? w.deadline : Math.min(w.deadline, st.probing.started + limitOf(w.kind)))
      : w.kind === "timer" ? Math.min(w.deadline, (w.spec as Extract<WaitSpec, { kind: "timer" }>).at_ms ?? now)
      : Math.min(w.deadline, (st?.lastProbe ?? 0) + (kinds.get(w.kind)?.every ?? PROBE_MS[w.kind] ?? 0));
    at = at === undefined ? t : Math.min(at, t);
  }
  return at;
}

// One pass over the active waits. It never waits for a probe: a probe that
// asks something outside the process answers later, and until it does (or is
// stopped at its limit) its wait is not probed again, so a slow target holds
// neither the other waits nor a second request of its own.
export async function tick() {
  const now = Date.now();
  for (const w of list(undefined, 0)) {
    if (isMonitor(w.kind)) {
      // At the deadline what is buffered goes out first, whatever is left of its window.
      flushMonitor(w.id, now >= w.deadline);
      if (now >= w.deadline) settle(w.id, "timeout", monitorTimeout(w));
      continue;
    }
    const st = live.get(w.id) ?? {};
    live.set(w.id, st);
    const out = st.probing;
    if (out) {
      const limit = limitOf(w.kind);
      if (!out.late && now - out.started >= limit) {
        out.late = true;
        const what = w.kind === "http" ? (w.spec as Extract<WaitSpec, { kind: "http" }>).url : w.kind === "pr_checks" ? "gh pr view" : "the probe";
        setError(w.id, `${what} did not answer within ${limit / 1000} s and was stopped`);
        out.abort.abort();
      }
      // A probe that cannot be stopped does not keep the wait past its deadline.
      if (out.late && now >= w.deadline) settle(w.id, "timeout", timedOut(w, get(w.id)?.last_error));
      continue;
    }
    const every = kinds.get(w.kind)?.every ?? PROBE_MS[w.kind] ?? 0;
    const due = w.kind === "timer" || now >= w.deadline || !st.lastProbe || now - st.lastProbe >= every;
    if (!due) continue;
    st.lastProbe = now;
    const abort = new AbortController();
    try {
      const r = probe(w, abort.signal);
      if (!(r instanceof Promise)) { probed(w, r); continue; }
      const mine: Probing = { started: now, abort };
      st.probing = mine;
      r.then(
        (hit) => { if (!abort.signal.aborted) probed(w, hit); },
        // A stopped probe fails because it was stopped: its error is already said.
        (e) => { if (!abort.signal.aborted) probeFailed(w, e); },
      ).catch((e) => capture(e, { at: "wait probe", wait: w.id })).finally(() => { if (st.probing === mine) st.probing = undefined; });
    } catch (e) {
      probeFailed(w, e);
    }
  }
}

// Whether the engine's recovery has a cut turn of this session to decide on:
// one the last daemon left open, or one it parked.
export function cutTurn(sessionId: string): boolean {
  const { store } = D();
  if (store.bootWorking.includes(sessionId)) return true;
  // (The branch's last event, read by itself: a session that is not in memory is not brought in for it.)
  const end = store.headEvent(sessionId);
  return end?.kind === "turn_end" && end.data.reason === "restart";
}

// At start: monitors died with the last daemon (stop their process groups if
// they are still the same processes); other waits keep going. A wake the last
// daemon owed (settled, not yet in the transcript) is sent now, once.
export function recover() {
  // The batches a monitor delivered that never reached its session go first, before the wake that says it ended.
  for (const { wait_id } of D().store.db.query<{ wait_id: string }, []>("SELECT DISTINCT wait_id FROM wait_events").all()) {
    const w = get(wait_id);
    if (w) sendEvents(w, true);
  }
  const owed = D().store.db.query<Row, []>("SELECT * FROM waits WHERE wake = 1 AND status != 'active' ORDER BY ended, created").all().map(toRec);
  for (const w of owed) {
    if (isPending(w.session_id, (m) => m.wait_id === w.id && m.outcome === w.status)) continue; // already on its way
    if (wakeStored(w)) wakeSent(w.id);
    else sendWake(w, true);
  }
  for (const w of list(undefined, 0)) {
    if (w.status !== "active") continue;
    if (w.kind === "log") {
      // On from the saved cursor: a line written while the daemon was down is
      // still new to the wait. A wait saved before cursors were kept reads on from the end.
      const row = D().store.db.query<{ state: string | null }, [string]>("SELECT state FROM waits WHERE id = ?").get(w.id);
      const c: LogCursor | undefined = row?.state ? JSON.parse(row.state).cursor : undefined;
      live.set(w.id, c ? { ...c } : (() => { try { const f = identOf((w.spec as any).path); return { offset: f.size, ident: f.ident }; } catch { return { offset: 0 }; } })());
    }
    if (!isMonitor(w.kind)) continue;
    const row = D().store.db.query<{ state: string | null }, [string]>("SELECT state FROM waits WHERE id = ?").get(w.id);
    const st = row?.state ? JSON.parse(row.state) : {};
    if (st.pgid && st.start && startTime(st.pgid) === st.start) {
      try { process.kill(-st.pgid, "SIGTERM"); } catch {}
    }
    settle(w.id, "ended", "The daemon restarted and stopped this monitor. Start it again if it is still needed.", true, true);
  }
}

export function stopAll() {
  for (const [, st] of live) {
    st.probing?.abort.abort(); // gh has a process group of its own: nothing else stops it with the daemon
    if (st.proc) try { process.kill(-st.proc.pid, "SIGTERM"); } catch {}
    if (st.ws) try { st.ws.close(1001); } catch {}
  }
}
