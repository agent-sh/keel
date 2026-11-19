// The daemon's own log: every console line, with its time and level, kept in
// memory (the last LINES) for the live view and appended to one file per day
// under the state folder (the last DAYS kept), where an agent can read it.
// Keys and tokens are redacted before a line is kept anywhere.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scrub } from "../providers/http.ts";

export type LogLine = { ts: number; level: "debug" | "info" | "warn" | "error"; text: string };

const LINES = 2000;
const DAYS = 7;
const G = globalThis as any;

type State = { lines: LogLine[]; dir: string; day: string; subs: Set<(l: LogLine) => void>; orig: Record<string, (...a: any[]) => void> };

const fmt = (a: unknown[]) => a.map((x) => (typeof x === "string" ? x : x instanceof Error ? (x.stack ?? x.message) : safeJson(x))).join(" ");
function safeJson(x: unknown) {
  try { return JSON.stringify(x); } catch { return String(x); }
}

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

// Installed once per process (hot reload runs this module again): console.*
// still print as before, and each line is also kept.
export function installLogs(stateDir: string) {
  const dir = join(stateDir, "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (G.__keelLogs) { G.__keelLogs.dir = dir; return; }
  const st: State = { lines: [], dir, day: "", subs: new Set(), orig: {} };
  G.__keelLogs = st;
  for (const [m, level] of [["log", "info"], ["info", "info"], ["debug", "debug"], ["warn", "warn"], ["error", "error"]] as const) {
    const orig = (console as any)[m].bind(console);
    st.orig[m] = orig;
    (console as any)[m] = (...a: unknown[]) => {
      orig(...a);
      try { keep({ ts: Date.now(), level, text: scrub(fmt(a)).slice(0, 20_000) }); } catch {}
    };
  }
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
  appendFileSync(join(st.dir, `keel-${day}.log`), `${new Date(l.ts).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.text}\n`, { mode: 0o600 });
  for (const f of st.subs) try { f(l); } catch {}
}

function prune(dir: string) {
  const files = readdirSync(dir).filter((f) => /^keel-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - DAYS))) rmSync(join(dir, f), { force: true });
}

export const logDir = (): string | undefined => G.__keelLogs?.dir;

// The kept lines, oldest first: from `since` (ms), at `level` or above, holding `q`.
export function logLines(o: { since?: number; until?: number; level?: string; q?: string; limit?: number } = {}): LogLine[] {
  const st: State | undefined = G.__keelLogs;
  if (!st) return [];
  const min = LEVELS.indexOf((o.level ?? "debug") as any);
  const q = o.q?.toLowerCase();
  const out = st.lines.filter((l) => (o.since === undefined || l.ts >= o.since) && (o.until === undefined || l.ts <= o.until) && LEVELS.indexOf(l.level) >= min && (!q || l.text.toLowerCase().includes(q)));
  return o.limit ? out.slice(-o.limit) : out;
}

export const LEVELS = ["debug", "info", "warn", "error"] as const;

export function onLog(f: (l: LogLine) => void): () => void {
  const st: State | undefined = G.__keelLogs;
  if (!st) return () => {};
  st.subs.add(f);
  return () => void st.subs.delete(f);
}
