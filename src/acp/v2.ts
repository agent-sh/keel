// ACP v2 (Preview) as Keel meets it, from the client's side. The spec is a Preview: it is ready to build on and not
// frozen, so this surface may change with it (agentclientprotocol.com/protocol/v2, schema releases 2.0.0-beta.N).
//
// What v2 changes for a client that drives an agent (the rest of src/acp/external.ts is shared by both versions):
//   - `session/prompt` answers once the user message is inserted, with its `messageId`. The turn ends with an idle
//     `state_update` (its stop reason, and its error when it failed), not with the response (Watch).
//   - `session/prompt` takes an `idempotencyKey`: a prompt sent again with the same key, after a connection or a
//     restart cut the first try, is not inserted twice (PromptKeys keeps the key with the pending input).
//   - `state_update` carries the session's `background` list: the terminals, tool calls and child sessions that run
//     apart from the foreground work (Book). A listed item that advertises `capabilities.cancel` is stopped alone with
//     `tool_call/cancel` or `terminal/cancel`.
//   - The client's file system and terminal methods are gone, and the capabilities are one `capabilities` object.
// Version negotiation: the client asks for the latest it knows; an agent that answers 1 is spoken to in v1 (the
// initialize is repeated in v1 on the same connection, or the agent started again when it will not take that).
import type { Database } from "bun:sqlite";
import { registerSettings, settings } from "../admin/settings.ts";

type Json = any;

export const PROTOCOL_V2 = 2;
export type Version = 1 | 2;
// The setting `acp.protocol`: "v1" speaks v1 to every agent (the default while v2 is a Preview, which the spec
// suggests keeping opt-in); "auto" asks each agent for v2 first and keeps v1 for one that does not offer it.
export type Protocol = "v1" | "auto";

registerSettings("acp", { protocol: "v1" }, (v) => (v.protocol === "v1" || v.protocol === "auto" ? undefined : 'protocol is "v1" or "auto"'));
export const protocolSetting = (): Protocol => (settings().acp?.protocol === "auto" ? "auto" : "v1");

export const v2Init = () => ({ protocolVersion: PROTOCOL_V2, info: { name: "keel", title: "Keel", version: "0.1.0" }, capabilities: {} });

// What the agent chose: 2 when it serves v2 with sessions, 1 when it fell back, undefined when it is neither.
export function negotiated(init: Json): Version | undefined {
  if (init?.protocolVersion === 1) return 1;
  if (init?.protocolVersion === PROTOCOL_V2 && init.capabilities && typeof init.capabilities === "object" && init.capabilities.session) return 2;
  return undefined;
}

// An MCP server of Keel's, as v2 names it (the type is stated).
export const v2Server = (s: Json): Json => ({ type: "stdio", ...s });

// --- foreground state ---

export type BackgroundItem = { type: string; terminalId?: string; toolCallId?: string; sessionId?: string };
export type Failure = { code?: number; message?: string };
export type Foreground = { state: string; stopReason?: string; error?: Failure; background: BackgroundItem[] | null };

const ID_MAX = 256;
const itemOf = (b: Json): BackgroundItem | undefined => {
  if (!b || typeof b !== "object" || typeof b.type !== "string") return undefined;
  const id = (v: unknown) => (typeof v === "string" && v && v.length <= ID_MAX ? v : undefined);
  // (An item of a type this version does not know still counts: it means work is running.)
  return { type: b.type.slice(0, 64), ...(id(b.terminalId) ? { terminalId: id(b.terminalId) } : {}), ...(id(b.toolCallId) ? { toolCallId: id(b.toolCallId) } : {}), ...(id(b.sessionId) ? { sessionId: id(b.sessionId) } : {}) };
};

// A `state_update` as a snapshot. `background`: null when the agent does not report it (nothing is then known of what
// runs), else the whole list.
export function foreground(u: Json): Foreground {
  return {
    state: typeof u?.state === "string" ? u.state.slice(0, 64) : "unknown",
    ...(typeof u?.stopReason === "string" ? { stopReason: u.stopReason.slice(0, 64) } : {}),
    ...(u?.error && typeof u.error === "object" ? { error: { ...(typeof u.error.code === "number" ? { code: u.error.code } : {}), ...(typeof u.error.message === "string" ? { message: u.error.message.slice(0, 1000) } : {}) } } : {}),
    background: Array.isArray(u?.background) ? u.background.slice(0, 200).flatMap((b: Json) => itemOf(b) ?? []) : null,
  };
}

// --- the turn: when a prompt's work is over ---

// What ends a turn in v2: an idle state after work began (or, for a prompt the agent had already taken, after what it
// said of its state when the session was resumed). The response to the prompt only says the message went in.
export class Watch {
  running: boolean;
  answered = false;
  ended?: { stop: string; error?: Failure };
  // `resent`: the prompt was sent again with the key of an earlier try. `before`: the state the agent reported when
  // the session was resumed; work that was running then is waited for.
  constructor(readonly resent: boolean, before?: string) {
    this.running = resent && (before === "running" || before === "requires_action");
  }
  // True when this state ends the turn.
  state(f: Foreground): boolean {
    if (this.ended) return false;
    if (f.state === "running" || f.state === "requires_action") { this.running = true; return false; }
    if (f.state !== "idle") return false;
    // Idle ends the work that ran. One that comes with no work seen is an agent's snapshot of a session at rest (a
    // list of background work that changed); it ends a turn only when it names a stop reason after the answer,
    // and never for a prompt the agent may have taken before.
    if (!this.running && !(this.answered && f.stopReason && !this.resent)) return false;
    this.ended = { stop: f.stopReason ?? "end_turn", ...(f.error ? { error: f.error } : {}) };
    return true;
  }
  answer() { this.answered = true; }
  // The agent answered a prompt it recognized and started nothing: it had taken it before.
  get recognized(): boolean { return this.resent && this.answered && !this.running && !this.ended; }
}

// How long Keel waits, after a resent prompt was answered, for work that never starts: past it the agent is taken
// to have recognized the key and to have nothing to run (it says so by starting nothing).
export const RECOGNIZED_MS = 1500;

// The reason a stop reason ends a turn as, in the words the engine uses.
export const turnStop = (stop: string): string => (stop === "max_turn_requests" ? "max_steps" : stop === "cancelled" ? "interrupted" : stop);

// --- the keys of the prompts in flight ---

export type KeyRow = { session_id: string; acp_session: string; key: string; seqs: number[]; message_id: string | null };

// The idempotency key of each session's prompt that is not finished, kept with the events it was made from, so that
// a prompt sent again after a restart carries the same key and the same words (the spec: one key, one submission).
export class PromptKeys {
  constructor(private db: Database) {
    db.run("CREATE TABLE IF NOT EXISTS acp_prompt_keys (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, acp_session TEXT NOT NULL, key TEXT NOT NULL, seqs TEXT NOT NULL, message_id TEXT, ts INTEGER NOT NULL)");
  }
  get(session: string): KeyRow | undefined {
    const r = this.db.query<{ session_id: string; acp_session: string; key: string; seqs: string; message_id: string | null }, [string]>("SELECT * FROM acp_prompt_keys WHERE session_id = ?").get(session);
    if (!r) return undefined;
    try { return { ...r, seqs: JSON.parse(r.seqs) }; } catch { return undefined; }
  }
  put(session: string, acpSession: string, key: string, seqs: number[]) {
    this.db.run("INSERT OR REPLACE INTO acp_prompt_keys (session_id, acp_session, key, seqs, message_id, ts) VALUES (?, ?, ?, ?, NULL, ?)", [session, acpSession, key, JSON.stringify(seqs), Date.now()]);
  }
  answered(session: string, messageId: string) {
    this.db.run("UPDATE acp_prompt_keys SET message_id = ? WHERE session_id = ?", [messageId, session]);
  }
  clear(session: string) {
    this.db.run("DELETE FROM acp_prompt_keys WHERE session_id = ?", [session]);
  }
}

// --- background work ---

// What the agent said of a terminal, a tool call or a child, kept whether or not a turn runs (background work reports
// while the session is idle).
type Term = { id: string; command?: string; cwd?: string; chunks: Buffer[]; bytes: number; exit?: { exitCode?: number | null; signal?: string | null }; cancel: boolean };
type Call = { id: string; title?: string; kind?: string; status?: string; cancel: boolean; terminals: string[] };
type Kid = { id: string; title?: string; cancel: boolean; state?: string };

const OUT_KEEP = 64 * 1024;
const KEEP = 400;

export type BackgroundView = { id: string; kind: "terminal" | "tool call" | "agent" | "work"; title: string; last?: string; can_stop: boolean; since: number };

// The agent's background work. `listed` follows the latest snapshot; the entities are patched as the agent reports
// them (omitted keeps, null clears).
export class Book {
  private terms = new Map<string, Term>();
  private calls = new Map<string, Call>();
  private kids = new Map<string, Kid>();
  private seen = new Map<string, number>();
  listed: BackgroundItem[] | null = null;

  private room<T>(m: Map<string, T>) {
    // The oldest entries go first when an agent reports more than anyone shows.
    while (m.size > KEEP) m.delete(m.keys().next().value!);
  }

  terminal(u: Json) {
    const id = typeof u.terminalId === "string" && u.terminalId.length <= ID_MAX ? u.terminalId : "";
    if (!id) return;
    const t: Term = this.terms.get(id) ?? { id, chunks: [], bytes: 0, cancel: false };
    if ("command" in u) t.command = typeof u.command === "string" ? u.command.slice(0, 500) : undefined;
    if ("cwd" in u) t.cwd = typeof u.cwd === "string" ? u.cwd.slice(0, 1024) : undefined;
    if ("capabilities" in u) t.cancel = !!u.capabilities && typeof u.capabilities === "object" && !!u.capabilities.cancel && typeof u.capabilities.cancel === "object";
    if (u.output && typeof u.output.data === "string") { t.chunks = []; t.bytes = 0; this.append(t, u.output.data); }
    if ("exitStatus" in u) {
      if (u.exitStatus && typeof u.exitStatus === "object") { t.exit = { exitCode: typeof u.exitStatus.exitCode === "number" ? u.exitStatus.exitCode : null, signal: typeof u.exitStatus.signal === "string" ? u.exitStatus.signal : null }; t.cancel = false; }
      else t.exit = undefined;
    }
    this.terms.set(id, t);
    this.room(this.terms);
  }
  output(u: Json) {
    const id = typeof u.terminalId === "string" && u.terminalId.length <= ID_MAX ? u.terminalId : "";
    if (!id || typeof u.data !== "string") return;
    const t: Term = this.terms.get(id) ?? { id, chunks: [], bytes: 0, cancel: false };
    this.append(t, u.data);
    this.terms.set(id, t);
    this.room(this.terms);
  }
  private append(t: Term, data: string) {
    const b = Buffer.from(data, "base64");
    t.chunks.push(b);
    t.bytes += b.length;
    while (t.bytes > OUT_KEEP && t.chunks.length > 1) t.bytes -= t.chunks.shift()!.length;
  }
  // What a terminal shows now: its command, then the end of its output.
  shown(id: string): string | undefined {
    const t = this.terms.get(id);
    if (!t) return undefined;
    const out = Buffer.concat(t.chunks).toString("utf8").replace(/\r\n/g, "\n").trimEnd();
    return [t.command ? `$ ${t.command}` : "", out, t.exit ? `(exit ${t.exit.exitCode ?? t.exit.signal ?? "?"})` : ""].filter(Boolean).join("\n") || undefined;
  }

  call(u: Json) {
    const id = typeof u.toolCallId === "string" && u.toolCallId.length <= ID_MAX ? u.toolCallId : "";
    if (!id) return;
    const c: Call = this.calls.get(id) ?? { id, cancel: false, terminals: [] };
    if (typeof u.title === "string") c.title = u.title.slice(0, 300);
    if (typeof u.kind === "string") c.kind = u.kind.slice(0, 32);
    if (typeof u.status === "string") { c.status = u.status.slice(0, 32); if (final(c.status)) c.cancel = false; }
    if ("capabilities" in u) c.cancel = !final(c.status) && !!u.capabilities && typeof u.capabilities === "object" && !!u.capabilities.cancel && typeof u.capabilities.cancel === "object";
    if (Array.isArray(u.content)) c.terminals = u.content.flatMap((x: Json) => (x?.type === "terminal" && typeof x.terminalId === "string" ? [x.terminalId] : [])).slice(0, 16);
    this.calls.set(id, c);
    this.room(this.calls);
  }

  kid(u: Json) {
    const id = typeof u.sessionId === "string" && u.sessionId.length <= ID_MAX ? u.sessionId : "";
    if (!id) return;
    const k: Kid = this.kids.get(id) ?? { id, cancel: false };
    if ("title" in u) k.title = typeof u.title === "string" ? u.title.slice(0, 200) : undefined;
    if ("capabilities" in u) k.cancel = !!u.capabilities && typeof u.capabilities === "object" && !!u.capabilities.cancel && typeof u.capabilities.cancel === "object";
    if (u.state && typeof u.state.state === "string") k.state = u.state.state;
    this.kids.set(id, k);
    this.room(this.kids);
  }

  // A snapshot of the foreground state: its list of background work replaces the one before (null: not reported).
  snapshot(f: Foreground, now = Date.now()) {
    this.listed = f.background;
    const keep = new Set<string>();
    for (const b of f.background ?? []) { const k = keyOf(b); keep.add(k); if (!this.seen.has(k)) this.seen.set(k, now); }
    for (const k of [...this.seen.keys()]) if (!keep.has(k)) this.seen.delete(k);
  }

  // Whether a tool call is background work now: the agent lists it, or lists a terminal it shows.
  isBackground(callId: string): boolean {
    for (const b of this.listed ?? []) {
      if (b.type === "tool_call" && b.toolCallId === callId) return true;
      if (b.type === "terminal" && b.terminalId && this.calls.get(callId)?.terminals.includes(b.terminalId)) return true;
    }
    return false;
  }

  // What the session shows as its background work: each listed item, in the agent's order.
  views(): BackgroundView[] {
    const out: BackgroundView[] = [];
    for (const b of this.listed ?? []) {
      const since = this.seen.get(keyOf(b)) ?? Date.now();
      if (b.type === "terminal" && b.terminalId) {
        const t = this.terms.get(b.terminalId);
        const last = t ? Buffer.concat(t.chunks).toString("utf8").replace(/\r\n/g, "\n").trimEnd().split("\n").at(-1)?.slice(0, 200) : undefined;
        out.push({ id: `terminal:${b.terminalId}`, kind: "terminal", title: t?.command ?? b.terminalId, ...(last ? { last } : {}), can_stop: !!t?.cancel && !t.exit, since });
      } else if (b.type === "tool_call" && b.toolCallId) {
        const c = this.calls.get(b.toolCallId);
        out.push({ id: `tool_call:${b.toolCallId}`, kind: "tool call", title: c?.title ?? b.toolCallId, ...(c?.status ? { last: c.status } : {}), can_stop: !!c?.cancel && !final(c.status), since });
      } else if (b.type === "subagent" && b.sessionId) {
        const k = this.kids.get(b.sessionId);
        out.push({ id: `subagent:${b.sessionId}`, kind: "agent", title: k?.title ?? b.sessionId, ...(k?.state ? { last: k.state } : {}), can_stop: !!k?.cancel, since });
      } else out.push({ id: `work:${out.length}`, kind: "work", title: `Background work of type ${b.type}`, can_stop: false, since });
    }
    return out;
  }

  // The request that stops one listed item alone, or why none can be sent (the spec: only an item that advertises it).
  cancel(id: string): { method: "tool_call/cancel" | "terminal/cancel"; params: Json } | { method: "session/cancel"; params: Json } | { refused: string } {
    const at = id.indexOf(":");
    const kind = id.slice(0, at), key = id.slice(at + 1);
    const listed = (this.listed ?? []).some((b) => keyOf(b) === id);
    if (at < 0 || !listed) return { refused: "the agent does not list it now" };
    if (kind === "terminal") {
      const t = this.terms.get(key);
      return t?.cancel && !t.exit ? { method: "terminal/cancel", params: { terminalId: key } } : { refused: "the agent did not offer to stop this terminal" };
    }
    if (kind === "tool_call") {
      const c = this.calls.get(key);
      return c?.cancel && !final(c.status) ? { method: "tool_call/cancel", params: { toolCallId: key } } : { refused: "the agent did not offer to stop this tool call" };
    }
    if (kind === "subagent") return this.kids.get(key)?.cancel ? { method: "session/cancel", params: { sessionId: key } } : { refused: "the agent did not offer to stop this agent" };
    return { refused: "this kind of work cannot be stopped from here" };
  }
}

const final = (s?: string) => s === "completed" || s === "failed" || s === "cancelled";
const keyOf = (b: BackgroundItem): string => (b.type === "terminal" ? `terminal:${b.terminalId}` : b.type === "tool_call" ? `tool_call:${b.toolCallId}` : b.type === "subagent" ? `subagent:${b.sessionId}` : `work:${b.type}`);

// --- what an agent's message updates say, as the words they add ---

// The text of a message's content blocks.
export function contentText(c: unknown): string {
  const blocks: Json[] = Array.isArray(c) ? c : c && typeof c === "object" ? [c] : [];
  return blocks.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

// A whole-message upsert (`agent_message`, `agent_thought`) as the words it adds to what its message already showed.
// A message replaced with other words than it began with cannot be taken back from the transcript: it adds nothing.
export function addedText(seen: Map<string, string>, id: string, content: unknown): string {
  const next = contentText(content);
  const had = seen.get(id) ?? "";
  if (seen.size > 256 && !seen.has(id)) seen.delete(seen.keys().next().value!);
  seen.set(id, next.startsWith(had) ? next : had);
  return next.startsWith(had) ? next.slice(had.length) : "";
}

// The permission request of v2 as the one the rest of the runner reads: its call (a tool call's own, or a command as
// an execute call) beside the options.
export function legacyPermission(p: Json): Json {
  const s = p?.subject;
  if (s?.type === "tool_call" && s.toolCall && typeof s.toolCall === "object") return { ...p, toolCall: s.toolCall };
  if (s?.type === "command" && typeof s.command === "string") return { ...p, toolCall: { toolCallId: s.toolCallId ?? `perm-${crypto.randomUUID()}`, title: s.command, kind: "execute", rawInput: { command: s.command, ...(s.cwd ? { cwd: s.cwd } : {}) } } };
  return { ...p, toolCall: { toolCallId: `perm-${crypto.randomUUID()}`, title: String(p?.title ?? "Permission") , kind: "other" } };
}
