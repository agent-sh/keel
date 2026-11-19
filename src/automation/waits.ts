import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { D, attr, capture, deliver, emit, inert } from "./core.ts";
import * as activity from "./activity.ts";
import { readText } from "../core/proc.ts";

// Zero-token waits: the daemon probes, the model is not called until the
// condition holds, the deadline passes or the wait is cancelled. Each of those
// wakes the session once. A monitor streams a command's matching lines as
// events and stays active until the command exits or its deadline.

export type WaitSpec =
  | { kind: "timer"; seconds?: number; at_ms?: number }
  | { kind: "file"; path: string; contains?: string }
  | { kind: "log"; path: string; match: string }
  | { kind: "http"; url: string; status?: number }
  | { kind: "process"; pid: number }
  | { kind: "monitor"; command: string; match?: string; coalesce_ms?: number; max_events?: number }
  // A monitor on a WebSocket: each text message is one line of events.
  | { kind: "websocket"; url: string; protocols?: string[]; match?: string; coalesce_ms?: number; max_events?: number }
  // A pull request's checks on GitHub, read with the owner's gh login.
  | { kind: "pr_checks"; repo: string; pr_number: number }
  | { kind: "session"; machine: string; session: string; title?: string; message_id?: string };

// A wait kind another module probes (the fleet's session notices): how a spec
// is read, how often it is probed, and the probe itself (an outcome fires it;
// a thrown error is kept as the last probe's error).
export type WaitKind = { normalize(spec: any, cwd: string): WaitSpec; every: number; probe(w: WaitRecord): Promise<string | undefined> | string | undefined };
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
}

type Row = Omit<WaitRecord, "spec" | "tail"> & { spec: string; state: string | null };
const toRec = (r: Row): WaitRecord => {
  const { state, ...rest } = r;
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

// Probe state that is not worth a column: log offsets, monitor tails.
const live = new Map<string, { offset?: number; lastProbe?: number; proc?: Bun.Subprocess; ws?: WebSocket; batch?: string[]; flushAt?: number; tail?: string[]; dropped?: number }>();

function resolvePath(p: string, cwd: string) {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function procAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    if (e.code === "ESRCH") return false;
  }
  // A zombie has exited: its parent just has not read its status yet.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return existsSync(`/proc/${pid}`) || process.platform !== "linux";
  }
}

function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
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
      return { kind, url: u.href, status: spec.status ? Number(spec.status) : undefined };
    }
    case "process": {
      const pid = Number(spec.pid);
      if (!Number.isInteger(pid) || pid <= 1) throw new Error("a process wait needs a pid");
      if (!procAlive(pid)) throw new Error(`process ${pid} has already ended`);
      return { kind, pid };
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
    try { st.offset = statSync(spec.path).size; } catch { st.offset = 0; }
  }
  live.set(rec.id, st);
  if (spec.kind === "monitor") startMonitor(rec);
  if (spec.kind === "websocket") startSocket(rec);
  emit("wait", get(rec.id));
  return get(rec.id)!;
}

function settle(id: string, status: WaitRecord["status"], outcome: string, wake = true) {
  const w = get(id);
  if (!w || w.status !== "active") return;
  const st = live.get(id);
  if (st?.proc) {
    try { process.kill(-st.proc.pid, "SIGTERM"); } catch {}
  }
  if (st?.ws) try { st.ws.close(1000); } catch {}
  live.delete(id);
  D().store.db.query("UPDATE waits SET status = ?, outcome = ?, ended = ? WHERE id = ?").run(status, outcome.slice(0, 4000), Date.now(), id);
  const rec = get(id)!;
  emit("wait", rec);
  activity.record("wait", status, w.session_id, `Wait ${w.kind}${w.note ? ` "${w.note}"` : ""} ${status}: ${outcome.split("\n")[0]!.slice(0, 200)}`, { wait_id: id });
  if (wake) {
    const body = `${w.note ? w.note + "\n" : ""}${outcome}`;
    deliver(w.session_id, `<wait_fired id="${w.id}" kind="${w.kind}" outcome="${status}">\n${inert(body, "wait_fired")}\n</wait_fired>`, { kind: "wait", wait_id: w.id, outcome: status });
  }
}

export function cancel(id: string, sessionId?: string): boolean {
  const w = get(id);
  if (!w || (sessionId && w.session_id !== sessionId)) return false;
  // Cancelling is the owner's or the model's own act: nothing to wake for.
  settle(id, "cancelled", "Cancelled.", false);
  return true;
}

export function cancelForSession(sessionId: string) {
  for (const w of list(sessionId, 0)) if (w.status === "active") settle(w.id, "cancelled", "Cancelled with its session.", false);
}

function setError(id: string, msg: string | null) {
  D().store.db.query("UPDATE waits SET last_error = ? WHERE id = ?").run(msg, id);
}

// pr_checks at the pace gh pr checks --watch polls (10 s).
const PROBE_MS: Partial<Record<WaitSpec["kind"], number>> = { file: 1000, log: 1000, process: 1000, http: 3000, pr_checks: 10_000 };
// A pull request that shows no checks yet may get them in a moment: it fires
// as "no checks" only after this long.
const EMPTY_CHECKS_GRACE = 120_000;

async function probe(w: WaitRecord): Promise<string | undefined> {
  const s = w.spec;
  const custom = kinds.get(s.kind);
  if (custom) return custom.probe(w);
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
      const st = live.get(w.id) ?? {};
      live.set(w.id, st);
      let size: number;
      try { size = statSync(s.path).size; } catch { return undefined; }
      if (size < (st.offset ?? 0)) st.offset = 0; // rotated or truncated
      if (size === st.offset) return undefined;
      const fd = openSync(s.path, "r");
      try {
        const len = Math.min(size - (st.offset ?? 0), 4 << 20);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, st.offset ?? 0);
        const text = buf.toString("utf8");
        const cut = text.lastIndexOf("\n");
        if (cut < 0) return undefined; // wait for the line to end
        st.offset = (st.offset ?? 0) + Buffer.byteLength(text.slice(0, cut + 1));
        const re = new RegExp(s.match);
        const hit = text.slice(0, cut).split(/\r?\n/).find((l) => re.test(l));
        return hit !== undefined ? `Matched in ${s.path}:\n${hit.slice(0, 2000)}` : undefined;
      } finally {
        closeSync(fd);
      }
    }
    case "http": {
      try {
        const r = await fetch(s.url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
        const ok = s.status ? r.status === s.status : r.status >= 200 && r.status < 400;
        setError(w.id, ok ? null : `HTTP ${r.status}`);
        return ok ? `${s.url} answered ${r.status}.` : undefined;
      } catch (e) {
        setError(w.id, (e as Error).message);
        return undefined;
      }
    }
    case "process":
      return procAlive(s.pid) ? undefined : `Process ${s.pid} has ended.`;
    case "pr_checks": {
      const p = Bun.spawn([process.env.KEEL_GH_BIN || "gh", "pr", "view", String(s.pr_number), "--repo", s.repo, "--json", "state,statusCheckRollup"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([readText(p.stdout, "gh pr view"), readText(p.stderr, "gh pr view"), p.exited]);
      if (code !== 0) throw new Error(`gh pr view failed: ${err.trim().slice(0, 300)}`);
      setError(w.id, null);
      return prChecksVerdict(JSON.parse(out), s.repo, s.pr_number, Date.now() - w.created >= EMPTY_CHECKS_GRACE);
    }
    default:
      return undefined;
  }
}

// Feeds a monitor's lines into its batch: a matching line waits up to
// coalesce_ms for the next before the batch is delivered.
function lineSink(id: string, s: { match?: string; coalesce_ms?: number }) {
  const st = live.get(id)!;
  const re = s.match ? new RegExp(s.match) : undefined;
  return (line: string) => {
    if (!line.trim()) return;
    // A line over 2,000 characters is delivered in pieces.
    for (const piece of line.match(/[\s\S]{1,2000}/g)!) {
      st.tail!.push(piece);
      if (st.tail!.length > 20) st.tail!.shift();
      if (re && !re.test(piece)) continue;
      st.batch!.push(piece);
      st.flushAt ??= Date.now() + (s.coalesce_ms ?? 500);
    }
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
  // An explicit reader: Bun can release a pipe's reader when the process ends,
  // and an async iterator then rejects outside any handler.
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder("utf-8", { fatal: false });
    const r = stream.getReader();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split(/\r\n|\n|\r/);
        buf = parts.pop()!;
        for (const p of parts) onLine(p);
        if (buf.length > 2000) { onLine(buf); buf = ""; }
      }
    } catch {
      // the pipe closed with the process; what it wrote is already read
    }
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

let ticking = false;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const w of list(undefined, 0)) {
      if (w.status !== "active") continue;
      if (isMonitor(w.kind)) {
        flushMonitor(w.id);
        if (now >= w.deadline) settle(w.id, "timeout", "The monitor reached its deadline and was stopped. Start it again if it is still needed.");
        continue;
      }
      const st = live.get(w.id) ?? {};
      live.set(w.id, st);
      const every = kinds.get(w.kind)?.every ?? PROBE_MS[w.kind] ?? 0;
      const due = w.kind === "timer" || now >= w.deadline || !st.lastProbe || now - st.lastProbe >= every;
      if (!due) continue;
      st.lastProbe = now;
      try {
        const hit = await probe(w);
        if (hit) settle(w.id, "fired", hit);
        else if (now >= w.deadline) settle(w.id, "timeout", `Timed out after ${Math.round((w.deadline - w.created) / 1000)} s.${w.last_error ? ` Last probe: ${w.last_error}` : ""}`);
      } catch (e) {
        setError(w.id, (e as Error).message);
        if (now >= w.deadline) settle(w.id, "timeout", `Timed out. Last probe: ${(e as Error).message}`);
      }
    }
  } finally {
    ticking = false;
  }
}

// At start: monitors died with the last daemon (stop their process groups if
// they are still the same processes); other waits keep going.
export function recover() {
  for (const w of list(undefined, 0)) {
    if (w.status !== "active") continue;
    if (w.kind === "log") live.set(w.id, { offset: (() => { try { return statSync((w.spec as any).path).size; } catch { return 0; } })() });
    if (!isMonitor(w.kind)) continue;
    const row = D().store.db.query<{ state: string | null }, [string]>("SELECT state FROM waits WHERE id = ?").get(w.id);
    const st = row?.state ? JSON.parse(row.state) : {};
    if (st.pgid && st.start && startTime(st.pgid) === st.start) {
      try { process.kill(-st.pgid, "SIGTERM"); } catch {}
    }
    settle(w.id, "ended", "The daemon restarted and stopped this monitor. Start it again if it is still needed.");
  }
}

export function stopAll() {
  for (const [, st] of live) {
    if (st.proc) try { process.kill(-st.proc.pid, "SIGTERM"); } catch {}
    if (st.ws) try { st.ws.close(1001); } catch {}
  }
}
