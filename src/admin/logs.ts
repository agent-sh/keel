// The daemon's own log: every console line, with its time, its level and the
// session and turn of the code that wrote it, kept in memory (the last LINES)
// for the live view and appended to one file per day under the state folder
// (the last DAYS kept), where an agent can read it. Keys and tokens are
// redacted before a line goes anywhere: the console prints the same scrubbed
// text the file gets (standard output is the journal under a service unit).
//
// The files are the log; the memory is its newest end. A start reads that end
// back from the files, and a question about a time the memory no longer holds
// (the bundle of a failure from before a restart) is answered from the files,
// reading only the part of a day's file around that time.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { localDay, zoned, type Zoned } from "../core/clock.ts";
import { errorScope } from "../core/errors.ts";
import { scrubbedLine } from "../core/conceal.ts";
import { runMode } from "../core/runmode.ts";

// `session`, `turn`: where the code that wrote the line ran (its turn_start event), when it ran in one.
export type LogLine = { ts: number; level: "debug" | "info" | "warn" | "error"; text: string; session?: string; turn?: string };

const LINES = 2000;
const DAYS = 7;
// What one question reads of the files at most, and the piece a seek reads.
const READ_MAX = 2 * 1024 * 1024;
const PIECE = 64 * 1024;
const G = globalThis as any;

type State = { lines: LogLine[]; dir: string; day: string; subs: Set<(l: LogLine) => void>; orig: Record<string, (...a: any[]) => void> };

const fmt = (a: unknown[]) => a.map((x) => (typeof x === "string" ? x : x instanceof Error ? (x.stack ?? x.message) : safeJson(x))).join(" ");
function safeJson(x: unknown) {
  try { return JSON.stringify(x); } catch { return String(x); }
}

// A console call's arguments as the one line every sink gets: the secrets Keel knows as their
// placeholders, anything else shaped like a key hidden, bounded.
export const logText = (a: unknown[]): string => scrubbedLine(fmt(a)).slice(0, 20_000);

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const fileOf = (dir: string, day: string) => join(dir, `keel-${day}.log`);

// A line as the file holds it: the time, the level, the session and turn in
// braces when it has them, the text. A text of several lines goes on under it.
export function formatLine(l: LogLine): string {
  const place = l.session ? `{${l.session}${l.turn ? ` ${l.turn}` : ""}} ` : "";
  return `${new Date(l.ts).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${place}${l.text}`;
}
// A line as a person or a model reads it (keel debug log): the same, with its
// time in the machine's own zone, as every text Keel writes; the output says
// the zone once (clock.ts). The files keep ISO times: they are read back.
export function shownLine(l: LogLine, z: Zoned = zoned()): string {
  const place = l.session ? `{${l.session}${l.turn ? ` ${l.turn}` : ""}} ` : "";
  return `${localDay(l.ts)} ${z.time(l.ts, true)} ${l.level.toUpperCase().padEnd(5)} ${place}${l.text}`;
}
const HEAD = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) (DEBUG|INFO |WARN |ERROR) (?:\{([0-9a-f-]{36})(?: ([0-9a-f-]{36}))?\} )?/;
// The lines of a piece of a log file. One that does not start with a time
// belongs to the line above it (a stack); before any line, it is dropped.
export function parseLines(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of text.split("\n")) {
    const m = HEAD.exec(raw);
    if (m) out.push({ ts: Date.parse(m[1]!), level: m[2]!.trim().toLowerCase() as LogLine["level"], text: raw.slice(m[0].length), ...(m[3] ? { session: m[3] } : {}), ...(m[4] ? { turn: m[4] } : {}) });
    else if (out.length && raw) out.at(-1)!.text += `\n${raw}`;
  }
  return out;
}

// Installed once per process (hot reload runs this module again): console.*
// still print as before, and each line is also kept.
export function installLogs(stateDir: string) {
  const dir = join(stateDir, "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (G.__keelLogs) { G.__keelLogs.dir = dir; return; }
  // What the daemon before this one wrote last is this one's memory to begin with.
  const st: State = { lines: tail(dir, LINES), dir, day: "", subs: new Set(), orig: {} };
  G.__keelLogs = st;
  for (const [m, level] of [["log", "info"], ["info", "info"], ["debug", "debug"], ["warn", "warn"], ["error", "error"]] as const) {
    const orig = (console as any)[m].bind(console);
    st.orig[m] = orig;
    (console as any)[m] = (...a: unknown[]) => {
      // One text for both sinks: what goes to standard output (the journal, under a service unit)
      // is what the file gets, scrubbed before either sees it.
      let text: string;
      try { text = logText(a); } catch { text = "(a log line that could not be formatted)"; }
      // A daemon a command runs inside its own process (keel run with no daemon answering): the
      // console is the command's own (its answer, a protocol's lines, its words to the terminal).
      // What it prints goes out as it was given; the file keeps the scrubbed text, as before.
      if (runMode.client) orig(...a); else orig(text);
      try {
        const at = errorScope.getStore();
        keep({ ts: Date.now(), level, text, ...(at?.session ? { session: at.session, ...(at.turn ? { turn: at.turn } : {}) } : {}) });
      } catch {}
    };
  }
}

// A line about a session's turn from code that does not run in it (the
// daemon's account of a restart, a compaction seen on the bus).
export function logAt(at: { session: string; turn?: string }, text: string, level: "info" | "warn" | "error" = "info") {
  errorScope.run(at, () => logOwn(text, level));
}

// A line of the daemon's own account (a start, a cut turn, a compaction, an agent, a stop). A
// serving daemon prints it: its standard output is its log. A daemon a command runs inside its
// own process has the command's standard output, which is the answer or a protocol's lines
// (keel run with --output-format stream-json): an info line is never printed there. It is kept in
// the log's file and nowhere else; a warning or a failure goes to standard error, as it did.
export function logOwn(text: string, level: "info" | "warn" | "error" = "info") {
  if (level === "warn") return console.warn(text);
  if (level === "error") return console.error(text);
  if (!runMode.client) return console.log(text);
  try {
    const at = errorScope.getStore();
    keep({ ts: Date.now(), level: "info", text: logText([text]), ...(at?.session ? { session: at.session, ...(at.turn ? { turn: at.turn } : {}) } : {}) });
  } catch {}
}

function keep(l: LogLine) {
  const st: State | undefined = G.__keelLogs;
  if (!st) return;
  st.lines.push(l);
  if (st.lines.length > LINES) st.lines.splice(0, st.lines.length - LINES);
  const day = dayOf(l.ts);
  if (day !== st.day) {
    st.day = day;
    prune(st.dir);
  }
  appendFileSync(fileOf(st.dir, day), `${formatLine(l)}\n`, { mode: 0o600 });
  for (const f of st.subs) try { f(l); } catch {}
}

const days = (dir: string) => {
  try { return readdirSync(dir).filter((f) => /^keel-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort(); } catch { return []; }
};
function prune(dir: string) {
  const files = days(dir);
  for (const f of files.slice(0, Math.max(0, files.length - DAYS))) rmSync(join(dir, f), { force: true });
}

// Bytes [from, to) of a file as text, cut to whole lines: the first line is
// dropped unless the read starts at the file's start.
function piece(fd: number, from: number, to: number): string {
  const buf = Buffer.alloc(Math.max(0, to - from));
  const n = readSync(fd, buf, 0, buf.length, from);
  const text = buf.subarray(0, n).toString("utf8");
  return from > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

// The last `n` lines the files hold, oldest first: the end of the newest files.
export function tail(dir: string, n: number): LogLine[] {
  let out: LogLine[] = [];
  let left = READ_MAX;
  for (const f of days(dir).reverse()) {
    if (out.length >= n || left <= 0) break;
    try {
      const fd = openSync(join(dir, f), "r");
      try {
        const size = fstatSync(fd).size;
        const from = Math.max(0, size - left);
        out = [...parseLines(piece(fd, from, size)), ...out];
        left -= size - from;
      } finally { closeSync(fd); }
    } catch {}
  }
  return out.slice(-n);
}

// Where the lines at or after `ts` start in a day's file: its lines are in
// time order, so a few pieces find the place without reading the file.
function seek(fd: number, size: number, ts: number): number {
  let lo = 0, hi = size;
  while (hi - lo > PIECE) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const first = parseLines(piece(fd, mid, Math.min(size, mid + PIECE)))[0];
    // No line starts in the piece (one long entry): the place is not before it.
    if (!first || first.ts < ts) lo = mid;
    else hi = mid;
  }
  return lo;
}

// The lines of [since, until] from the files, oldest first. At most READ_MAX
// bytes are read, and they are the end of the window: on a log too chatty to
// read whole, the newest lines of the window (the ones around a failure, the
// ones a `limit` asks for) are the ones returned.
export function fromFiles(dir: string, since: number, until: number): LogLine[] {
  let out: LogLine[] = [];
  let left = READ_MAX;
  for (const f of days(dir).reverse()) {
    const day = f.slice(5, 15);
    if (day < dayOf(since) || day > dayOf(until)) continue;
    if (left <= 0) break;
    try {
      const fd = openSync(join(dir, f), "r");
      try {
        const size = fstatSync(fd).size;
        // The window's end is within a piece after where the lines past `until` start.
        const to = Math.min(size, seek(fd, size, until + 1) + PIECE);
        const from = Math.max(seek(fd, size, since), to - left);
        left -= to - from;
        out = [...parseLines(piece(fd, from, to)).filter((l) => l.ts >= since && l.ts <= until), ...out];
      } finally { closeSync(fd); }
    } catch {}
  }
  return out;
}

export const logDir = (): string | undefined => G.__keelLogs?.dir;

// The kept lines, oldest first: from `since` (ms), at `level` or above, holding
// `q`, of `session`. A window that starts before what the memory holds is read
// from the files.
export function logLines(o: { since?: number; until?: number; level?: string; q?: string; limit?: number; session?: string } = {}): LogLine[] {
  const st: State | undefined = G.__keelLogs;
  if (!st) return [];
  const min = LEVELS.indexOf((o.level ?? "debug") as any);
  const q = o.q?.toLowerCase();
  const oldest = st.lines[0]?.ts ?? Infinity;
  const lines = o.since !== undefined && o.since < oldest ? fromFiles(st.dir, o.since, o.until ?? Date.now()) : st.lines;
  const out = lines.filter((l) => (o.since === undefined || l.ts >= o.since) && (o.until === undefined || l.ts <= o.until) && LEVELS.indexOf(l.level) >= min && (!q || l.text.toLowerCase().includes(q)) && (!o.session || l.session === o.session));
  return o.limit ? out.slice(-o.limit) : out;
}

export const LEVELS = ["debug", "info", "warn", "error"] as const;

export function onLog(f: (l: LogLine) => void): () => void {
  const st: State | undefined = G.__keelLogs;
  if (!st) return () => {};
  st.subs.add(f);
  return () => void st.subs.delete(f);
}
