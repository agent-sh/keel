import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import { gitEnv } from "../core/git.ts";
import { isAbsolute, resolve } from "node:path";
import { D, attr, capture, deliver, emit, inert, isPending } from "./core.ts";
import * as activity from "./activity.ts";
import * as failures from "./failures.ts";
import { readStat } from "../core/pid.ts";
import { pumpText, readText } from "../core/proc.ts";
import { lineage } from "../core/tree.ts";

// Zero-token waits: the daemon probes, the model is not called until the
// condition holds, the deadline passes or the wait is cancelled. Each of those
// wakes the session once. A monitor streams a command's matching lines as
// events and stays active until the command exits or its deadline.

export type WaitSpec =
  | { kind: "timer"; seconds?: number; at_ms?: number }
  | { kind: "file"; path: string; contains?: string }
  | { kind: "log"; path: string; match: string }
  | { kind: "http"; url: string; status?: number }
  | { kind: "process"; pid: number; start?: string }
  | { kind: "monitor"; command: string; match?: string; coalesce_ms?: number; max_events?: number }
  // A monitor on a WebSocket: each text message is one line of events.
  | { kind: "websocket"; url: string; protocols?: string[]; match?: string; coalesce_ms?: number; max_events?: number }
  // A pull request's checks on GitHub, read with the owner's gh login.
  | { kind: "pr_checks"; repo: string; pr_number: number }
  | { kind: "session"; machine: string; session: string; title?: string; message_id?: string };

// A wait kind another module probes (the fleet's session notices): how a spec
// is read, how often it is probed, and the probe itself (an outcome fires it;
// a thrown error is kept as the last probe's error). The signal aborts when
// the probe took too long or its wait was settled.
export type WaitKind = { normalize(spec: any, cwd: string): WaitSpec; every: number; probe(w: WaitRecord, signal: AbortSignal): Promise<string | undefined> | string | undefined };
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
CREATE INDEX IF NOT EXISTS waits_status ON waits(status, session_id);`);
  // 1 while the wait's last wake (fired, timed out, ended) is owed to its
  // session: set in the statement that settles it, cleared when the wake is
  // stored in the transcript. A restart sends what is still owed.
  if (!D().store.columnExists("waits", "wake")) D().store.migrate("ALTER TABLE waits ADD COLUMN wake INTEGER NOT NULL DEFAULT 0");
  D().store.migrate("CREATE INDEX IF NOT EXISTS waits_wake ON waits(wake) WHERE wake = 1"); // the few owed ones, read at start
}

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
  const done = db.query<Row, any>(`SELECT * FROM waits WHERE status != 'active' ${where} ORDER BY ended DESC LIMIT ${settled}`).all(...args);
  return [...active, ...done].map(toRec);
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
const live = new Map<string, { offset?: number; ident?: string; skip?: boolean; skipped?: number; lastProbe?: number; probing?: Probing; proc?: Bun.Subprocess; ws?: WebSocket; batch?: string[]; flushAt?: number; tail?: string[]; dropped?: number }>();
const LOG_READ = 4 << 20; // a probe reads at most this much of a log
const LINE_MAX = 64 * 1024; // a monitor matches lines up to this long; a longer one is cut there
const DISPLAY = 2000; // characters of one line shown in an event
// What is kept of an outcome, and so what its wake says: room for the longest
// one made here (a monitor's five last lines, each with its marks). A longer
// one is cut there and says how much went.
const OUTCOME_MAX = 6 * DISPLAY;
const kept = (outcome: string) => (outcome.length <= OUTCOME_MAX ? outcome : `${outcome.slice(0, OUTCOME_MAX)}\n[cut here: ${outcome.length - OUTCOME_MAX} more characters are not kept]`);

const identOf = (path: string) => {
  const st = statSync(path);
  return { size: st.size, ident: `${st.dev}:${st.ino}` };
};
function saveCursor(id: string, c: LogCursor) {
  D().store.db.query("UPDATE waits SET state = json_set(COALESCE(state, '{}'), '$.cursor', json(?)) WHERE id = ?").run(JSON.stringify(c), id);
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

// Validates a spec the way the model or the page wrote it; throws the reason.
export function normalize(raw: any, cwd: string): WaitSpec {
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
      return { kind, path: resolvePath(String(spec.path), cwd), contains: spec.contains ? String(spec.contains) : undefined };
    case "log":
      if (!spec.path || !spec.match) throw new Error("a log wait needs a path and a match pattern");
      new RegExp(spec.match);
      return { kind, path: resolvePath(String(spec.path), cwd), match: String(spec.match) };
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
      if (!Number.isInteger(pid) || pid <= 1) throw new Error("a process wait needs a pid");
      if (!procAlive(pid)) throw new Error(`process ${pid} has already ended`);
      const start = startTime(pid);
      return start ? { kind, pid, start } : { kind, pid };
    }
    case "websocket": {
      const u = new URL(String(spec.url));
      if (!/^wss?:$/.test(u.protocol)) throw new Error("a socket monitor needs a ws:// or wss:// URL");
      if (u.username || u.password) throw new Error("a socket URL carries no credentials");
      if (spec.match) new RegExp(spec.match);
      const protocols = Array.isArray(spec.protocols) ? spec.protocols.map(String).filter(Boolean).slice(0, 8) : undefined;
      return {
        kind, url: u.href, protocols: protocols?.length ? protocols : undefined, match: spec.match ? String(spec.match) : undefined,
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
      if (spec.match) new RegExp(spec.match);
      return {
        kind, command: String(spec.command), match: spec.match ? String(spec.match) : undefined,
        coalesce_ms: Math.min(Math.max(Number(spec.coalesce_ms ?? 500), 0), 60_000),
        max_events: Math.min(Math.max(Number(spec.max_events ?? 20), 1), 200),
      };
    default:
      throw new Error("a wait is a timer (seconds), file (path, contains?), log (path, match), http (url, status?), process (pid), pr_checks (repo, pr_number), monitor (command, match?) or websocket (url, match?)");
  }
}

export function create(sessionId: string, spec: WaitSpec, opts: { timeout_seconds?: number; note?: string } = {}): WaitRecord {
  const s = D().store.session(sessionId);
  if (!s) throw new Error("no such session");
  if (s.archived) throw new Error("the session is archived");
  if (activeFor(sessionId) >= WAIT_LIMIT) throw new Error(`the session already has ${WAIT_LIMIT} active waits; cancel one first`);
  const now = Date.now();
  const isMon = isMonitor(spec.kind);
  let timeout = Number(opts.timeout_seconds ?? (isMon ? MONITOR_DEFAULT : DEFAULT_TIMEOUT));
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("timeout_seconds must be a positive number");
  timeout = Math.min(timeout, isMon ? MONITOR_MAX : MAX_TIMEOUT);
  // A timer's deadline is its wake time plus a minute: it fires, it does not time out.
  const deadline = spec.kind === "timer" ? spec.at_ms! + 60_000 : now + timeout * 1000;
  const rec: WaitRecord = {
    id: Bun.randomUUIDv7().slice(-12), session_id: sessionId, kind: spec.kind, spec, note: String(opts.note ?? "").slice(0, 500),
    status: "active", created: now, deadline, events: 0,
  };
  D().store.db.query("INSERT INTO waits (id, session_id, kind, spec, note, status, created, deadline) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
    .run(rec.id, sessionId, rec.kind, JSON.stringify(spec), rec.note, now, deadline);
  const st: any = {};
  if (spec.kind === "log") {
    // Lines already in the file when the wait starts are not what it waits for.
    try { const f = identOf(spec.path); st.offset = f.size; st.ident = f.ident; } catch { st.offset = 0; }
    saveCursor(rec.id, { offset: st.offset, ident: st.ident });
  }
  live.set(rec.id, st);
  if (spec.kind === "monitor") startMonitor(rec);
  if (spec.kind === "websocket") startSocket(rec);
  emit("wait", get(rec.id));
  activity.record("wait", "set", sessionId, `Wait ${rec.kind}${rec.note ? ` "${rec.note}"` : ""} set`, { wait_id: rec.id });
  return get(rec.id)!;
}

function settle(id: string, status: WaitRecord["status"], outcome: string, wake = true, boot = false): boolean {
  const w = get(id);
  if (!w || w.status !== "active") return false;
  const st = live.get(id);
  if (st?.proc) {
    try { process.kill(-st.proc.pid, "SIGTERM"); } catch {}
  }
  if (st?.ws) try { st.ws.close(1000); } catch {}
  st?.probing?.abort.abort(); // a probe still out is stopped; what it says later is not used
  live.delete(id);
  // The status changes only from active, in the same statement that reads it,
  // and the same statement records that the wake is owed.
  if (!D().store.db.query("UPDATE waits SET status = ?, outcome = ?, ended = ?, wake = ? WHERE id = ? AND status = 'active'").run(status, kept(outcome), Date.now(), wake ? 1 : 0, id).changes) return false;
  const rec = get(id)!;
  emit("wait", rec);
  activity.record("wait", status, w.session_id, `Wait ${w.kind}${w.note ? ` "${w.note}"` : ""} ${status}: ${outcome.split("\n")[0]!.slice(0, 200)}`, { wait_id: id });
  if (status === "timeout") failures.seen(w.session_id, "wait", w.kind, outcome);
  if (wake) sendWake(rec, boot);
  return true;
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

export function cancelForSession(sessionId: string) {
  for (const w of list(sessionId, 0)) if (w.status === "active") settle(w.id, "cancelled", "Cancelled with its session.", false);
  // A stopped or archived session gets no wake of an earlier wait either.
  D().store.db.query("UPDATE waits SET wake = 0 WHERE session_id = ? AND wake = 1").run(sessionId);
}

// The last probe's error, of a wait still active (a probe that answers after
// its wait was settled changes nothing).
function setError(id: string, msg: string | null) {
  D().store.db.query("UPDATE waits SET last_error = ? WHERE id = ? AND status = 'active'").run(msg, id);
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
      const text = readFileSync(s.path, "utf8");
      const i = text.indexOf(s.contains);
      return i >= 0 ? `${s.path} contains "${s.contains}".` : undefined;
    }
    case "log": {
      const st = live.get(w.id) ?? { offset: 0 };
      live.set(w.id, st);
      let f: { size: number; ident: string };
      try { f = identOf(s.path); } catch { return undefined; }
      // Another file at the path (rotated, renamed over it) is read from its
      // start; the same file shorter than the cursor was truncated.
      if ((st.ident && st.ident !== f.ident) || f.size < (st.offset ?? 0)) { st.offset = 0; st.skip = false; }
      const moved = st.ident !== f.ident;
      st.ident = f.ident;
      if (f.size === st.offset) { if (moved) saveCursor(w.id, cursor(st)); return undefined; }
      const fd = openSync(s.path, "r");
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
  try {
    ws = new WebSocket(s.url, s.protocols);
  } catch (e) {
    queueMicrotask(() => end(`The socket could not be opened: ${(e as Error).message}`));
    return;
  }
  st.ws = ws;
  ws.binaryType = "arraybuffer";
  let opened = false;
  const opening = setTimeout(() => { if (!opened) { end("The socket did not open within 20 seconds."); try { ws.close(); } catch {} } }, 20_000);
  ws.onopen = () => { opened = true; clearTimeout(opening); };
  ws.onmessage = (ev) => {
    const size = typeof ev.data === "string" ? Buffer.byteLength(ev.data) : (ev.data as ArrayBuffer).byteLength;
    if (size > 1 << 20) {
      end(`A message of ${size} bytes is over the 1 MiB a socket monitor takes; it was stopped. Subscribe to a filtered feed if the server has one.`);
      try { ws.close(1009); } catch {}
      return;
    }
    onLine(typeof ev.data === "string" ? ev.data.replace(/\r?\n|\r/g, " ") : `[binary frame, ${size} bytes]`);
  };
  ws.onerror = () => { if (!opened) end("The socket could not be opened."); };
  ws.onclose = (ev) => { clearTimeout(opening); end(opened ? `The socket was closed by the other side (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""}).` : `The socket could not be opened (code ${ev.code}).`); };
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
  const onLine = lineSink(w.id, s);
  const read = async (stream: ReadableStream<Uint8Array>) => {
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
  Promise.all([read(proc.stdout as ReadableStream<Uint8Array>), read(proc.stderr as ReadableStream<Uint8Array>), proc.exited])
    .then(([, , code]) => {
      if (get(w.id)?.status !== "active") return;
      flushMonitor(w.id, true);
      // The last lines only when no event carried them already.
      const tail = !get(w.id)?.events && st.tail?.length ? `\nLast lines:\n${st.tail.slice(-5).join("\n")}` : "";
      settle(w.id, "ended", `The command exited with code ${code}.${tail}`);
    })
    .catch((e) => capture(e, { at: "monitor", wait: w.id }));
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
  D().store.db.query("UPDATE waits SET events = ?, state = json_set(COALESCE(state, '{}'), '$.tail', json(?)) WHERE id = ?")
    .run(events, JSON.stringify(st.tail ?? []), id);
  emit("wait", get(id));
  const s = w.spec as Extract<WaitSpec, { kind: "monitor" }>;
  deliver(w.session_id, `<monitor_event id="${w.id}" batch="${events}"${w.note ? ` note="${attr(w.note)}"` : ""}>\n${inert(text, "monitor_event")}${left ? `[${left} more lines left out]\n` : ""}</monitor_event>`, { kind: "wait", wait_id: w.id, outcome: "event" }, { coalesceMs: 100 });
  if (events >= (s.max_events ?? 20)) settle(id, "ended", `The monitor delivered its ${events} batches and stopped.`);
}

const timedOut = (w: WaitRecord, last?: string | null) => `Timed out after ${Math.round((w.deadline - w.created) / 1000)} s.${last ? ` Last probe: ${last}` : ""}`;

// What a probe said: an outcome fires the wait, nothing at the deadline times it out.
function probed(w: WaitRecord, hit: string | undefined) {
  if (hit) settle(w.id, "fired", hit);
  else if (Date.now() >= w.deadline) settle(w.id, "timeout", timedOut(w, get(w.id)?.last_error));
}

function probeFailed(w: WaitRecord, e: unknown) {
  const msg = (e as Error)?.message || String(e);
  setError(w.id, msg);
  if (Date.now() >= w.deadline) settle(w.id, "timeout", timedOut(w, msg));
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
      if (now >= w.deadline) settle(w.id, "timeout", "The monitor reached its deadline and was stopped. Start it again if it is still needed.");
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
  const end = lineage(store.events(sessionId), store.session(sessionId)?.head ?? null).at(-1);
  return end?.kind === "turn_end" && end.data.reason === "restart";
}

// At start: monitors died with the last daemon (stop their process groups if
// they are still the same processes); other waits keep going. A wake the last
// daemon owed (settled, not yet in the transcript) is sent now, once.
export function recover() {
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
