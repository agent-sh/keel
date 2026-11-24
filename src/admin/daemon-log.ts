// The daemon's own account of its life, in its log: one line each for a
// start (revision, folders), the providers and MCP servers it found, a drain
// and its backup, a restart and its reason, a clean stop, a settings change
// (what changed, never a value that could be a secret), the owner's Stop and
// an agent's start and end. Every line starts "[daemon]", "[turn]" or
// "[agent]" and is bounded, so `keel debug log --grep '[daemon]'` reads as the
// daemon's story across restarts (the log is kept per day and read back at a
// start: logs.ts). The words are here; the callers say when.
import type { AgentRecord } from "../automation/agents.ts";
import { scrubbedLine } from "../core/conceal.ts";
import { runMode } from "../core/runmode.ts";
import { logAt, logOwn } from "./logs.ts";
import { dur } from "./timeline-rows.ts";
import { stopSays } from "../core/stoppers.ts";
import { attemptWords } from "../core/state-words.ts";

// Where the lines go: the daemon's log (logs.ts logOwn). A daemon a command runs inside its own
// process (keel run with no daemon answering) says none of them: they are a serving daemon's story,
// and its streams are the command's.
export function say(line: string, level: "info" | "warn" = "info") {
  if (!runMode.client) logOwn(line, level);
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
const val = (v: unknown) => scrubbedLine(String(v ?? "")).replace(/\s+/g, " ").trim();
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
export const backupLine = (o: { ok: boolean; ms: number; name?: string; owed?: string; error?: string }) =>
  clip(o.owed ? `[daemon] no backup before the restart, it is made after the start: ${val(o.owed)}` : o.ok ? `[daemon] backup before the restart made in ${dur(o.ms)}${o.name ? `: ${val(o.name)}` : ""}` : `[daemon] backup before the restart failed after ${dur(o.ms)}: ${o.error ? val(o.error) : "no reason given"}; the restart is called off`);
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

// A stopped turn, in the stopper's own words; one nobody named is "stopped", never the owner's.
export const stopLine = (by: string | undefined) => clip(`[turn] ${stopSays(by)}`);

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

// ---- What happened in a session, one bounded line each, so an incident reads from the log alone.
// Under the session's ids (logs.ts logAt) and with its title. Never a prompt, a reply, a command, its
// output or a wait's note: a tool's name, a kind, a state, a class and the harness's own words.
const reason = (r: unknown, n = 160) => { const s = val(r); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const inTitle = (t: string | undefined) => ` in ${title(t)}`;
const card = (id: string) => ` [card ${val(id).slice(-8)}]`;

// A hook's refusal or stop, with the hook's own reason: "[hook] PreToolUse hook refused Bash in "Lane": no pushes".
export const hookLine = (o: { event: string; did: string; reason: string; title?: string }) =>
  clip(`[hook] ${val(o.event)} hook ${val(o.did)}${inTitle(o.title)}: ${reason(o.reason) || "no reason given"}`);

// An approval asked and answered: who answered, and from where (the page, the phone, the command line, an editor).
type Card = { id: string; tool: string; risk: string; state: string; choice?: string; reason?: string; created: number; resolved?: number; by?: { client: string; device?: string; peer?: string } };
const CHOICE: Record<string, string> = { once: "allowed once", session: "allowed for the session", always: "allowed always", deny: "denied" };
export function approvalLine(a: Card, from: string | undefined, sessionTitle: string | undefined): string | null {
  if (a.state === "pending") return clip(`[approval] asked: ${val(a.tool)}${a.risk === "high" ? ", high risk" : ""}${inTitle(sessionTitle)}${card(a.id)}`);
  const took = a.resolved && a.resolved >= a.created ? ` after ${dur(a.resolved - a.created)}` : "";
  if (a.state === "cancelled") return clip(`[approval] closed without an answer${took}: ${val(a.tool)}${inTitle(sessionTitle)}${a.reason ? ` (${reason(a.reason, 120)})` : ""}${card(a.id)}`);
  const said = CHOICE[a.choice ?? ""] ?? (a.state === "denied" ? "denied" : "allowed");
  // The owner's reason for a denial is their own words: said to be there, not quoted.
  return clip(`[approval] ${said}${from ? ` from ${val(from)}` : ""}${took}: ${val(a.tool)}${inTitle(sessionTitle)}${a.state === "denied" && a.reason ? ", with a reason" : ""}${card(a.id)}`);
}

// A call the reviewing judge settled without a card. The judge's own reason is not quoted (it may restate the call).
const JUDGED: Record<string, string> = {
  judge: "the judge allowed", refused: "the judge refused", repeat: "refused again (the same call was refused before)",
  streak: "refused without review (too many refused in a row)", unavailable: "refused: the judge could not review it", retry: "let one retry through (the owner's)",
};
export const judgedLine = (j: { outcome: string; tool: string; model?: string }, sessionTitle: string | undefined) =>
  JUDGED[j.outcome] ? clip(`[approval] ${JUDGED[j.outcome]} ${val(j.tool)}${j.model && j.outcome !== "repeat" && j.outcome !== "streak" ? ` (${val(j.model)})` : ""}${inTitle(sessionTitle)}`) : null;

// A session's turn that failed, with the class of its failure.
// `tried`: the request was tried that many times over that long before the turn gave up.
export const failedLine = (o: { cls?: string; status?: number; title?: string; steps?: number; tried?: { tries: number; ms: number } }) =>
  clip(`[turn] failed: ${val(o.cls || "an error")}${o.status ? ` (HTTP ${o.status})` : ""}${inTitle(o.title)}${o.steps ? `, after ${o.steps} step${o.steps === 1 ? "" : "s"}` : ""}${o.tried ? `, the request given up after ${o.tried.tries} tries over ${dur(Math.max(0, o.tried.ms))}` : ""}`);

// A message between sessions: sent, with where it stands, and later delivered or not.
const MSG: Record<string, string> = { refused: "not sent", queued: "queued", delivered: "delivered", handled: "handled", held: "held for the owner", outbound: "waiting for its daemon to fetch it", dropped: "not delivered" };
export const messageLine = (o: { id: string; from?: string; to?: string; machine?: string; state: string; why?: string | null; sent?: boolean }) =>
  clip(`[message] ${o.sent ? `sent from ${title(o.from)} to ${title(o.to)}${o.machine ? ` on ${val(o.machine)}` : ""}` : `to ${title(o.to)} from ${title(o.from)}`}: ${MSG[o.state] ?? val(o.state)}${o.why ? ` (${reason(o.why, 120)})` : ""}${o.id ? ` [message ${val(o.id).slice(-8)}]` : ""}`);

// A wait set and settled: its kind, when it is due, how it ended, and when it was told late.
export const waitSetLine = (o: { id: string; on: string; due: number; title?: string; clock: (ms: number) => string; timer: boolean }) =>
  clip(`[wait] set on ${val(o.on)}${inTitle(o.title)}, ${o.timer ? "due" : "gives up"} at ${o.clock(o.due)} [wait ${val(o.id)}]`);
const SETTLED: Record<string, string> = { fired: "fired", timeout: "timed out", cancelled: "was cancelled", ended: "ended" };
export const waitEndLine = (o: { id: string; on: string; status: string; ms: number; late?: string; title?: string }) =>
  clip(`[wait] on ${val(o.on)} ${SETTLED[o.status] ?? val(o.status)} after ${dur(Math.max(0, o.ms))}${o.late ? `, ${val(o.late)}` : ""}${inTitle(o.title)} [wait ${val(o.id)}]`);

// A loop that ended by its own limit: its end time or its runs.
export const loopEndLine = (o: { name: string; why: string; title?: string }) => clip(`[loop] ${title(o.name)} ended: ${reason(o.why, 200)}${inTitle(o.title)}`);

// A loop's run that ended, or one that did not run.
export const loopLine = (o: { name: string; said: string; title?: string }) => clip(`[loop] ${title(o.name)} run ${reason(o.said, 200)}${inTitle(o.title)}`);

// A model request that is being tried again, and the provider answering again after it.
export const retryLine = (o: { attempt: number; max: number; inMs: number; message: string; title?: string }) =>
  clip(`[provider] retrying the model request${inTitle(o.title)}: ${attemptWords(o.attempt + 1, o.max && o.max + 1, "try")} in ${dur(Math.max(0, o.inMs))} after ${reason(o.message, 160)}`);
export const answeredLine = (o: { tries: number; ms: number; title?: string }) =>
  clip(`[provider] answered again${inTitle(o.title)} after ${o.tries} tr${o.tries === 1 ? "y" : "ies"} over ${dur(Math.max(0, o.ms))}`);

// What became of a command a restart cut: the first sentence of what its call was told, without the paths.
export function cutCommandLine(text: string, sessionTitle: string | undefined): string {
  const body = text.replace(/^The daemon restarted while this command ran\.\s*/, "");
  const first = (body.match(/^.*?\.(?=\s|$)/)?.[0] ?? body).replace(/ Its output (is|up to then is|is being written to) .*$/, "");
  return clip(`[turn] the command a restart cut${inTitle(sessionTitle)}: ${reason(first.replace(/\/\S+/g, "(a file)"), 240)}`);
}
