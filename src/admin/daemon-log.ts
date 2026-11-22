// The daemon's own account of its life, in its log: one line each for a
// start (revision, folders), the providers and MCP servers it found, a drain
// and its backup, a restart and its reason, a clean stop, a settings change
// (what changed, never a value that could be a secret), the owner's Stop and
// an agent's start and end. Every line starts "[daemon]", "[turn]" or
// "[agent]" and is bounded, so `keel debug log --grep '[daemon]'` reads as the
// daemon's story across restarts (the log is kept per day and read back at a
// start: logs.ts). The words are here; the callers say when.
import type { AgentRecord } from "../automation/agents.ts";
import { scrubbed } from "../core/conceal.ts";
import { runMode } from "../core/runmode.ts";
import { logAt } from "./logs.ts";
import { dur } from "./timeline-rows.ts";

// Where the lines go: the daemon's log, through the console. A daemon a command runs inside its own
// process (keel run with no daemon answering) says none of them: its console is the command's output.
export function say(line: string, level: "info" | "warn" = "info") {
  if (runMode.client) return;
  if (level === "warn") console.warn(line); else console.log(line);
}
// The same for a line about a session's turn (logs.ts).
export function sayAt(at: { session: string; turn?: string }, line: string, level: "info" | "warn" = "info") {
  if (!runMode.client) logAt(at, line, level);
}

const LINE = 400;
const clip = (s: string, n = LINE) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// A value that came from outside (a title, a name, a reason, a failure's words, a path): scrubbed
// whole, before it is cut or put in a line. A cut can leave half a key that no pattern knows, so
// the scrub never runs on a cut text; the log's sinks scrub the finished line once more (logs.ts).
const val = (v: unknown) => scrubbed(String(v ?? "")).replace(/\s+/g, " ").trim();
const list = (names: string[], max = 8) => { const all = names.map(val); return all.length > max ? `${all.slice(0, max).join(", ")} and ${all.length - max} more` : all.join(", "); };
const title = (t: string | undefined) => { const s = val(t); return s ? `"${s.length > 48 ? `${s.slice(0, 47)}…` : s}"` : "an untitled session"; };

export const startLine = (o: { revision: string; pid: number; url: string; state: string; config: string; client?: boolean }) =>
  // Two folders' paths: its own, longer bound.
  clip(`[daemon] started${o.client ? " as a client" : ""}: Keel ${o.revision}, pid ${o.pid}, at ${val(o.url)}; state ${val(o.state)}; config ${val(o.config)}`, 1200);

// `available`: providers with credentials and how many models each listed. `failed`: the ones whose listing failed.
export function providersLine(p: { available: { id: string; models: number }[]; failed: string[]; unset: number }): string {
  const found = p.available.length ? list(p.available.map((x) => `${x.id} (${x.models} model${x.models === 1 ? "" : "s"})`)) : "none";
  return clip(`[daemon] providers found: ${found}${p.failed.length ? `; listing failed: ${list(p.failed)}` : ""}${p.unset ? `; ${p.unset} not set up` : ""}`);
}

export function mcpLine(servers: { name: string; state: string }[]): string {
  if (!servers.length) return "[daemon] MCP servers: none configured";
  const by = (st: (s: string) => boolean) => servers.filter((s) => st(s.state)).map((s) => s.name);
  const up = by((s) => s === "ready" || s === "idle" || s === "armed"), bad = by((s) => s === "error" || s === "unreachable" || s === "missing"), off = by((s) => s === "disabled");
  const auth = by((s) => s === "needs_auth");
  const rest = servers.length - up.length - bad.length - off.length - auth.length;
  return clip(`[daemon] MCP servers: ${servers.length} configured${up.length ? `; connected: ${list(up)}` : ""}${bad.length ? `; failed: ${list(bad)}` : ""}${auth.length ? `; need sign-in: ${list(auth)}` : ""}${off.length ? `; ${off.length} disabled` : ""}${rest ? `; ${rest} not connected yet` : ""}`);
}

export const drainLine = (o: { restart: boolean; running: number; timeoutMs: number; reason?: string }) =>
  clip(`[daemon] draining for a ${o.restart ? "restart" : "stop"}${o.reason ? ` (${val(o.reason)})` : ""}: ${o.running ? `${o.running} turn${o.running === 1 ? "" : "s"} running get${o.running === 1 ? "s" : ""} up to ${dur(o.timeoutMs)}` : "no turn is running"}`);
export const backupLine = (o: { ok: boolean; ms: number; name?: string; error?: string }) =>
  clip(o.ok ? `[daemon] backup before the restart made in ${dur(o.ms)}${o.name ? `: ${val(o.name)}` : ""}` : `[daemon] backup before the restart failed after ${dur(o.ms)}: ${o.error ? val(o.error) : "no reason given"}; the restart is called off`);
export const exitLine = (o: { restart: boolean; parked: number; upMs: number; reason?: string }) =>
  clip(`[daemon] ${o.restart ? `restarting${o.reason ? ` (${val(o.reason)})` : ""}` : "stopping cleanly"} after ${dur(o.upMs)} up${o.parked ? `: ${o.parked} turn${o.parked === 1 ? "" : "s"} parked for the next start` : ""}`);

// What a settings change changed, by section and key. A value is shown only
// when it is a number, a boolean or null: a string may be a key, a header or
// an address with one in it, so it is said as set, changed or removed.
const SECRETISH = /key|token|secret|password|header|auth|credential/i;
const shown = (k: string, v: unknown) => (v === undefined ? "unset" : SECRETISH.test(k) ? "(not shown)" : typeof v === "number" || typeof v === "boolean" || v === null ? String(v) : "(text)");
export function settingsChanges(before: Record<string, any>, after: Record<string, any>): string[] {
  const out: string[] = [];
  for (const section of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[section] ?? {}, b = after[section] ?? {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
      const plain = (v: unknown) => !SECRETISH.test(k) && (typeof v === "number" || typeof v === "boolean" || v === null);
      out.push(plain(a[k]) && plain(b[k]) ? `${section}.${k} ${shown(k, a[k])} -> ${shown(k, b[k])}` : `${section}.${k} ${b[k] == null || b[k] === "" ? "removed" : a[k] == null || a[k] === "" ? "set" : "changed"}${plain(b[k]) && b[k] !== null ? ` to ${shown(k, b[k])}` : ""}`);
    }
  }
  return out;
}
export const settingsLine = (changes: string[]) => clip(`[daemon] settings changed: ${list(changes, 12)}`);

export const stopLine = (by: string | undefined) => clip(`[turn] stopped by ${!by || by === "owner" ? "the owner" : by === "hook" ? "a hook" : val(by)}`);

const ENDED: Record<string, string> = { completed: "reported", failed: "failed", stopped: "was stopped", incomplete: "ended without finishing" };
// An agent's start and end, on its parent's session. Null for a state that is neither.
// `since`: when this process began. A start is said of an agent made in this process, an end of
// one that ended in it: a daemon that starts again hears of every agent it holds (the ones still
// running, parked or long ended) and says neither of them twice.
export function agentLine(a: Pick<AgentRecord, "title" | "type" | "status" | "created" | "ended" | "end_reason" | "background" | "machine">, was: string | undefined, since = 0): string | null {
  if (was === undefined && (a.status === "running" || a.status === "waiting")) {
    if (a.created < since) return null;
    return clip(`[agent] started: ${title(a.title)} (${val(a.type)}${a.background ? ", in the background" : ""}${a.machine ? `, on ${val(a.machine)}` : ""})`);
  }
  if (a.ended && a.ended >= since && was !== a.status && a.status !== "running" && a.status !== "waiting") {
    const took = a.ended > a.created ? ` after ${dur(a.ended - a.created)}` : "";
    return clip(`[agent] ended: ${title(a.title)} ${ENDED[a.status] ?? a.status}${took}${a.end_reason && a.status !== "completed" ? ` (${val(a.end_reason)})` : ""}`);
  }
  return null;
}
