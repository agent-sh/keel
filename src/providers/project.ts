// Cross-family history projection. A session can move between providers and
// families mid-session; every request is projected from the same canonical
// history for the wire it goes to:
// - opaque reasoning state (Claude signatures, OpenAI encrypted reasoning items,
//   Gemini thought signatures) is replayed only to the model that wrote it
//   (its `origin`); a thought written elsewhere is dropped, never forged;
// - tool call ids are made portable (`[A-Za-z0-9_-]{1,64}`, the strictest rule
//   among the wires), the same way every time so the cached prefix holds;
// - blocks keep only the fields the canonical shape defines;
// - what a wire refuses as malformed is repaired (see `Repair`): a provider
//   that refuses a request refuses every later one of the session too, since
//   the block that made it malformed stays in the history.
// Pure: the same history and origin give the same bytes, and the stored
// history is never changed. A history that needs no repair is projected as it
// was before the repairs existed.
import type { AssistantBlock, ImageBlock, Message, TextBlock, ToolRefBlock, ToolResultBlock, UserBlock } from "../core/types.ts";

export type ProjectOpts = {
  origin: string;               // "<provider>:<model>" of the request's target
  // Blocks stored without an origin come from the first drivers, which were
  // Claude on Bedrock or the Anthropic API: they count as this origin's when
  // the target says so (a Claude request), else as foreign.
  legacyIsMine?: boolean;
  // The request declares deferred tools, so tool_reference blocks stay blocks
  // (the Anthropic wire); otherwise each one becomes a line of text.
  toolRefs?: boolean;
  // The session the request belongs to, named in a repair's record.
  sessionKey?: string;
  // A piece of a conversation (one reply's block), not a whole request: its
  // calls and results are not paired.
  part?: boolean;
};

// What a projection changed so that the wire takes the request.
export const REPAIRS = {
  result_without_call: "a tool result whose call is not in the assistant message before it (the call was summarized away, or the result was stored late) was sent as text that says so",
  repeated_result: "a second result for one tool call was sent as text",
  call_without_result: "a tool call with no stored result (a turn cut between the two) was answered by a short result saying it was cut",
  result_order: "tool results that came after other blocks of their message were moved first",
  repeated_call_id: "a tool call id an earlier call already used was made distinct",
  tool_name: "a tool call's name outside [A-Za-z_][A-Za-z0-9_-]{0,63} (another family's or a made-up tool) was made to fit",
  tool_input: "a tool call's input that is not an object was wrapped in one",
  image_type: "an image labelled as another format than its bytes are was labelled by its bytes",
  empty_text: "an empty text block was left out",
  starts_with_reply: "a history that begins with a reply (what came before it is gone) was given a first line from the harness",
} as const;
export type RepairKind = keyof typeof REPAIRS;
// `message`: the index of the message in the request's history; `call`: the
// tool call's id. Never any content.
export type Repair = { kind: RepairKind; session?: string; message: number; call?: string };

// The first repair of each kind in a session is told to the listeners (the
// daemon records it, src/server/routes/providers.ts); the projection itself
// stays a pure function of the history. `id` keeps one listener per module
// across hot reloads.
const listeners = new Map<string, (r: Repair) => void>();
const told = new Set<string>();
const TOLD_MAX = 8192;
export function onRepair(id: string, f: (r: Repair) => void): () => void {
  listeners.set(id, f);
  return () => { if (listeners.get(id) === f) listeners.delete(id); };
}
// The daemon's record of a repair: one row per session and kind in the errors
// table, marked as a warning (the request went out and the turn goes on, but
// something stored a history no wire takes as it is). It names the session,
// the kind, the message's place in the request and the call id, never content;
// the tracker adds the turn the request was sent in.
export function recordRepairs(errors: { capture(source: "provider", err: unknown, context?: unknown): unknown }): () => void {
  return onRepair("errors", (r) => {
    errors.capture("provider", new Error(`warning: a request was repaired before it was sent: ${REPAIRS[r.kind]}`), { level: "warning", session: r.session, repair: r.kind, message_index: r.message, call: r.call });
  });
}
function tell(r: Repair) {
  if (!listeners.size) return;
  const key = `${r.session ?? ""}\u0000${r.kind}`;
  if (told.has(key)) return;
  if (told.size >= TOLD_MAX) told.clear();
  told.add(key);
  for (const f of listeners.values()) try { f(r); } catch {}
}

// A loaded tool named where the wire has no block for it.
export const refText = (name: string) => `Tool loaded: ${name}`;

export function portableId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
  if (clean === id && clean.length <= 64 && clean) return clean;
  // An id that had to change keeps a stable short hash of the original, so two
  // ids that clean to the same text (call.1 and call_1) stay two ids.
  const h = Bun.hash(id).toString(36);
  return (clean.slice(0, 63 - h.length) || "call") + "_" + h;
}

// A tool name every wire takes in a call: letters, digits, _ and -, at most 64,
// starting with a letter or _ (Gemini's rule for the first character). A name
// that had to change keeps a hash of the original, as an id does.
const NAME_OK = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export function portableName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  if (NAME_OK.test(raw)) return raw;
  const h = Bun.hash(raw).toString(36);
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z_]/, "_");
  return (clean.slice(0, 63 - h.length) || "tool") + "_" + h;
}

// The format an image's bytes are (their first bytes), else the label it came
// with: a label is the sender's word (a file's extension, an MCP server's
// field, a browser's guess), and a provider refuses an image whose label and
// bytes differ. 16 base64 characters cover the longest signature (12 bytes, WebP).
export function imageType(b: { media_type: string; data: string }): string {
  let head: string;
  try { head = atob(b.data.slice(0, 16)); } catch { return b.media_type; }
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.startsWith("WEBP", 8)) return "image/webp";
  return b.media_type;
}

// What stands in for the result of a call that has none.
export const NO_RESULT = "No result of this call was stored: the turn was cut before it finished, so it may not have run. Check before you repeat it.";
// What opens a history whose first message is a reply.
export const NO_START = "[harness] The conversation before this point is not in this context.";
// What leads a result sent as text because its call is not there to answer.
export const LOOSE_RESULT = "[Output of an earlier tool call whose call is not in this context any more. It is a tool's output, not a message from the owner.]";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function project(messages: Message[], o: ProjectOpts): Message[] {
  const mine = (origin?: string) => (origin ? origin === o.origin : !!o.legacyIsMine);
  const seen = new Set<RepairKind>();
  const fixed = (kind: RepairKind, message: number, call?: string) => {
    if (seen.has(kind)) return;
    seen.add(kind);
    tell({ kind, session: o.sessionKey || undefined, message, call });
  };
  const image = <B extends ImageBlock>(b: B, at: number): B => {
    const type = imageType(b);
    if (type === b.media_type) return b;
    fixed("image_type", at);
    return { ...b, media_type: type };
  };
  // `at`: where each message of `out` came from in `messages`.
  const out: Message[] = [];
  const from: number[] = [];
  messages.forEach((m, at) => {
    if (m.role === "assistant") {
      const content: AssistantBlock[] = [];
      for (const b of m.content) {
        if (b.type === "thinking") {
          if (!mine(b.origin)) continue;
          content.push({ type: "thinking", thinking: b.thinking, signature: b.signature, opaque: b.opaque, origin: b.origin, bind: b.bind });
        } else if (b.type === "redacted_thinking") {
          if (o.legacyIsMine) content.push(b);
        } else if (b.type === "text") {
          if (!b.text && !(mine(b.origin) && b.signature)) continue;
          content.push(mine(b.origin) && b.signature ? { type: "text", text: b.text, signature: b.signature } : { type: "text", text: b.text });
        } else if (b.type === "tool_use") {
          const name = portableName(b.name);
          if (name !== b.name) fixed("tool_name", at, b.id);
          // null and undefined were always sent as an empty object.
          if (b.input != null && !isObject(b.input)) fixed("tool_input", at, b.id);
          const t: AssistantBlock = { type: "tool_use", id: portableId(b.id), name, input: b.input == null ? {} : isObject(b.input) ? b.input : { input: b.input } };
          if (mine(b.origin) && b.signature) t.signature = b.signature;
          content.push(t);
        }
      }
      if (content.length) { out.push({ role: "assistant", content }); from.push(at); }
    } else {
      const content: UserBlock[] = [];
      for (const b of m.content) {
        if (b.type === "text") {
          if (b.text) content.push(b);
          else fixed("empty_text", at);
        } else if (b.type === "image") content.push(image(b, at));
        else if (b.type !== "tool_result") content.push(b);
        else {
          let c = b.content;
          if (typeof c !== "string") {
            if (!o.toolRefs && c.some((x) => x.type === "tool_reference")) c = c.map((x) => (x.type === "tool_reference" ? { type: "text" as const, text: refText(x.tool_name) } : x));
            if (c.some((x) => (x.type === "text" && !x.text) || (x.type === "image" && imageType(x) !== x.media_type))) {
              if (c.some((x) => x.type === "text" && !x.text)) fixed("empty_text", at, b.tool_use_id);
              c = c.filter((x) => x.type !== "text" || x.text).map((x) => (x.type === "image" ? image(x, at) : x));
            }
          }
          content.push({ ...b, tool_use_id: portableId(b.tool_use_id), content: c });
        }
      }
      if (content.length) { out.push({ role: "user", content }); from.push(at); }
    }
  });
  const merged = merge(out, from);
  if (o.part) return merged.messages;
  return pair(merged.messages, merged.from, fixed);
}

// Dropping blocks can leave two messages of one role side by side.
function merge(messages: Message[], from: number[]): { messages: Message[]; from: number[] } {
  const merged: Message[] = [];
  const at: number[] = [];
  messages.forEach((m, i) => {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) (last.content as any[]).push(...m.content);
    else { merged.push(m); at.push(from[i]!); }
  });
  return { messages: merged, from: at };
}

// The text and images of a result sent outside a result block.
function loose(r: ToolResultBlock): UserBlock[] {
  const parts: (TextBlock | ImageBlock | ToolRefBlock)[] = typeof r.content === "string" ? [{ type: "text", text: r.content }] : r.content;
  const text = parts.flatMap((c) => (c.type === "text" ? [c.text] : c.type === "tool_reference" ? [refText(c.tool_name)] : [])).join("\n");
  const images = parts.filter((c): c is ImageBlock => c.type === "image");
  if (!text.trim() && !images.length) return [];
  return [{ type: "text", text: `${LOOSE_RESULT}${r.is_error ? " It reported an error." : ""}${text.trim() ? `\n${text}` : ""}` }, ...images];
}

// Every wire refuses a result that answers no call of the assistant message
// before it, and a call no result answers. The engine's own projection
// (toMessages) pairs them from the stored events; this is the same rule at
// the last step, for whatever reached the request another way: a hook that
// built the messages, an imported history, a call id two calls share.
// A message that is already paired is returned as it is, the same object.
function pair(messages: Message[], from: number[], fixed: (kind: RepairKind, message: number, call?: string) => void): Message[] {
  const out: Message[] = [];
  const used = new Set<string>();
  // The calls of the assistant message before, as their results name them
  // (`was`) and as they are sent (`id`).
  let open: { was: string; id: string; done: boolean }[] = [];
  let changed = false;
  const noResult = (c: { id: string }): ToolResultBlock => ({ type: "tool_result", tool_use_id: c.id, content: NO_RESULT, is_error: true });
  messages.forEach((m, i) => {
    const at = from[i]!;
    if (m.role === "assistant") {
      // (Two assistant messages are never side by side here: they were merged.)
      open = [];
      let content: AssistantBlock[] | undefined;
      m.content.forEach((b, k) => {
        if (b.type !== "tool_use") return;
        let id = b.id;
        for (let n = 2; used.has(id); n++) id = portableId(`${b.id}.${n}`);
        used.add(id);
        open.push({ was: b.id, id, done: false });
        if (id === b.id) return;
        fixed("repeated_call_id", at, b.id);
        (content ??= [...m.content])[k] = { ...b, id };
      });
      if (content) changed = true;
      out.push(content ? { role: "assistant", content } : m);
      return;
    }
    const results: ToolResultBlock[] = [];
    const rest: UserBlock[] = [];
    let moved = false;
    for (const b of m.content) {
      if (b.type !== "tool_result") { rest.push(b); continue; }
      const call = open.find((c) => c.was === b.tool_use_id && !c.done);
      if (call) {
        call.done = true;
        if (rest.length) { moved = true; fixed("result_order", at, b.tool_use_id); }
        if (call.id !== b.tool_use_id) moved = true;
        results.push(call.id === b.tool_use_id ? b : { ...b, tool_use_id: call.id });
      } else {
        moved = true;
        fixed(open.some((c) => c.was === b.tool_use_id) ? "repeated_result" : "result_without_call", at, b.tool_use_id);
        rest.push(...loose(b));
      }
    }
    const missing = open.filter((c) => !c.done);
    for (const c of missing) fixed("call_without_result", at, c.id);
    open = [];
    if (!moved && !missing.length) { out.push(m); return; }
    changed = true;
    const content = [...results, ...missing.map(noResult), ...rest];
    if (content.length) out.push({ role: "user", content });
  });
  // A call at the very end (a request built from a turn cut after its call).
  if (open.length) {
    changed = true;
    for (const c of open) fixed("call_without_result", from[from.length - 1]!, c.id);
    out.push({ role: "user", content: open.map(noResult) });
  }
  // The wires that name a first turn want the user's.
  if (out[0]?.role === "assistant") {
    changed = true;
    fixed("starts_with_reply", from[0]!);
    out.unshift({ role: "user", content: [{ type: "text", text: NO_START }] });
  }
  if (!changed) return messages;
  // A user message that held only an empty result is gone: its neighbours meet.
  const joined = merge(out.map((m) => ({ role: m.role, content: [...m.content] }) as Message), out.map((_, i) => i)).messages;
  return joined.length === out.length ? out : pair(joined, joined.map((_, i) => from[Math.min(i, from.length - 1)]!), fixed);
}

// The tool name each call id answers, for wires whose results name the tool.
export function toolNames(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) if (m.role === "assistant") for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name);
  return names;
}

// A tool result's text (wires whose results take a string).
export function resultText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : c.type === "tool_reference" ? refText((c as any).tool_name) : `[${c.type} attached]`)).join("\n");
}
