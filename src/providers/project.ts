// Cross-family history projection. A session can move between providers and
// families mid-session; every request is projected from the same canonical
// history for the wire it goes to:
// - opaque reasoning state (Claude signatures, OpenAI encrypted reasoning items,
//   Gemini thought signatures) is replayed only to the model that wrote it
//   (its `origin`); a thought written elsewhere is dropped, never forged;
// - tool call ids are made portable (`[A-Za-z0-9_-]{1,64}`, the strictest rule
//   among the wires), the same way every time so the cached prefix holds;
// - blocks keep only the fields the canonical shape defines.
// Pure: the same history and origin give the same bytes.
import type { AssistantBlock, Message, UserBlock } from "../core/types.ts";

export type ProjectOpts = {
  origin: string;               // "<provider>:<model>" of the request's target
  // Blocks stored without an origin come from the first drivers, which were
  // Claude on Bedrock or the Anthropic API: they count as this origin's when
  // the target says so (a Claude request), else as foreign.
  legacyIsMine?: boolean;
  // The request declares deferred tools, so tool_reference blocks stay blocks
  // (the Anthropic wire); otherwise each one becomes a line of text.
  toolRefs?: boolean;
};

const refText = (name: string) => `Tool loaded: ${name}`;

export function portableId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
  if (clean === id && clean.length <= 64 && clean) return clean;
  // An id that had to change keeps a stable short hash of the original, so two
  // ids that clean to the same text (call.1 and call_1) stay two ids.
  const h = Bun.hash(id).toString(36);
  return (clean.slice(0, 63 - h.length) || "call") + "_" + h;
}

export function project(messages: Message[], o: ProjectOpts): Message[] {
  const mine = (origin?: string) => (origin ? origin === o.origin : !!o.legacyIsMine);
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const content: AssistantBlock[] = [];
      for (const b of m.content) {
        if (b.type === "thinking") {
          if (!mine(b.origin)) continue;
          content.push({ type: "thinking", thinking: b.thinking, signature: b.signature, opaque: b.opaque, origin: b.origin });
        } else if (b.type === "redacted_thinking") {
          if (o.legacyIsMine) content.push(b);
        } else if (b.type === "text") {
          if (!b.text && !(mine(b.origin) && b.signature)) continue;
          content.push(mine(b.origin) && b.signature ? { type: "text", text: b.text, signature: b.signature } : { type: "text", text: b.text });
        } else if (b.type === "tool_use") {
          const t: AssistantBlock = { type: "tool_use", id: portableId(b.id), name: b.name, input: b.input ?? {} };
          if (mine(b.origin) && b.signature) t.signature = b.signature;
          content.push(t);
        }
      }
      if (content.length) out.push({ role: "assistant", content });
    } else {
      const content: UserBlock[] = m.content.map((b) => {
        if (b.type !== "tool_result") return b;
        const c = typeof b.content === "string" || o.toolRefs || !b.content.some((x) => x.type === "tool_reference")
          ? b.content
          : b.content.map((x) => (x.type === "tool_reference" ? { type: "text" as const, text: refText(x.tool_name) } : x));
        return { ...b, tool_use_id: portableId(b.tool_use_id), content: c };
      });
      if (content.length) out.push({ role: "user", content });
    }
  }
  // Dropping blocks can leave two messages of one role side by side.
  const merged: Message[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) (last.content as any[]).push(...m.content);
    else merged.push(m);
  }
  return merged;
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
