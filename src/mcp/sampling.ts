// MCP sampling: a server asks for a reply from the client's model while it
// works on a call (`sampling/createMessage`). The owner sees what the server
// would send and allows it or not; only then does the session's model answer,
// and the owner sees the answer before it goes back (and may type another).
//
// The specification (modelcontextprotocol.io/specification/2025-11-25/client/sampling):
// the request holds `messages` (role user or assistant, content text, image
// or audio, one block or a list), an optional `systemPrompt`, `maxTokens`
// (required), `modelPreferences` (hints a client may follow), `includeContext`
// (soft-deprecated, only with the `sampling.context` capability) and `tools`
// (only with `sampling.tools`). Keel declares plain `sampling`, so a request
// with tools is invalid params. The answer is `{ role: "assistant", content,
// model, stopReason }`; a rejected request is the error code -1. Applications
// should let the owner review and deny each request, and review the answer
// before it is delivered.
import type { ImageBlock, Message, TextBlock } from "../core/types.ts";
import { withoutHidden } from "../core/hidden-chars.ts";
import { plain } from "./elicit.ts";

export type SampleRequest = {
  system: string;
  messages: Message[];
  maxTokens: number;
  // What the owner's card shows: the whole request as text, and notes beside it.
  shown: string;
  notes: string[];
};
export type Refused = { refuse: string; code: number };

// The whole request as JSON: past it, no card shows it and it is not parsed further.
const REQUEST_MAX = 2_000_000;
// What a card shows of the request's text, and of the model's reply. Past it the owner is told how much is not shown.
export const SHOWN_MAX = 20_000;
// A reply is at most this many tokens, whatever the server asks.
export const SAMPLE_TOKENS_MAX = 32_000;

const invalid = (why: string): Refused => ({ refuse: why, code: -32602 });
// A request always carries a system prompt (a provider refuses an empty one):
// this one when the server gives none, and the card shows it like the server's.
export const NO_SYSTEM = "Reply to the messages below.";

export function samplingOf(params: any): SampleRequest | Refused {
  if (!params || typeof params !== "object") return invalid("a sampling request has params");
  let size = 0;
  try { size = JSON.stringify(params).length; } catch { return invalid("the request cannot be read"); }
  if (size > REQUEST_MAX) return invalid(`the request is larger than ${REQUEST_MAX / 1_000_000} MB`);
  if (params.tools !== undefined || params.toolChoice !== undefined) return invalid("Keel did not offer tool use in sampling (sampling.tools): a request with tools is not taken");
  const maxTokens = params.maxTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) return invalid("maxTokens is a whole number of at least 1");
  if (!Array.isArray(params.messages) || !params.messages.length) return invalid("messages is a list of at least one message");
  const messages: Message[] = [];
  const lines: string[] = [];
  // What is sent is what the card shows: the server's text without the
  // characters a reader cannot see (tag characters, a right-to-left override),
  // which would carry words to the model that the owner never read.
  const given = typeof params.systemPrompt === "string" ? withoutHidden(params.systemPrompt) : "";
  const system = given.trim() ? given : NO_SYSTEM;
  lines.push(`System prompt${system === NO_SYSTEM ? " (Keel's: the server gave none)" : ""}:\n${system}`);
  for (const [i, m] of params.messages.entries()) {
    const role = m?.role;
    if (role !== "user" && role !== "assistant") return invalid(`message ${i + 1} has the role ${String(role)}: user or assistant`);
    const parts: unknown[] = Array.isArray(m.content) ? m.content : [m.content];
    const blocks: (TextBlock | ImageBlock)[] = [];
    const said: string[] = [];
    for (const c of parts as any[]) {
      if (c?.type === "text" && typeof c.text === "string") { const text = withoutHidden(c.text); if (text.trim()) { blocks.push({ type: "text", text }); said.push(text); } }
      else if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string" && role === "user") { blocks.push({ type: "image", media_type: c.mimeType, data: c.data }); said.push(`[an image, ${plain(c.mimeType, 60)}]`); }
      else if (c?.type === "image") return invalid(`message ${i + 1} has an image Keel cannot send (an image is data and a mimeType, in a user message)`);
      else if (c?.type === "audio") return invalid(`message ${i + 1} has audio: Keel sends text and images to its models here`);
      else if (c?.type === "tool_use" || c?.type === "tool_result") return invalid(`message ${i + 1} has ${c.type}: Keel did not offer tool use in sampling`);
      else return invalid(`message ${i + 1} has content Keel does not know (${plain(c?.type, 40) || "no type"})`);
    }
    if (!blocks.length) return invalid(`message ${i + 1} is empty`);
    messages.push(role === "user" ? { role, content: blocks } : { role, content: blocks as TextBlock[] });
    lines.push(`${role === "user" ? "User" : "Assistant"}:\n${said.join("\n")}`);
  }
  const { shown, note } = cardText(lines.join("\n\n"), "The request");
  const notes: string[] = note ? [note] : [];
  if (params.includeContext === "thisServer" || params.includeContext === "allServers") notes.push("It asks for the context of MCP servers to go with it: none is sent (Keel did not offer sampling.context).");
  const hints = Array.isArray(params.modelPreferences?.hints) ? params.modelPreferences.hints.map((h: any) => plain(h?.name, 60)).filter(Boolean) : [];
  if (hints.length) notes.push(`It would prefer ${hints.slice(0, 5).join(", ")}: it is answered by this session's model.`);
  const tokens = Math.min(maxTokens, SAMPLE_TOKENS_MAX);
  notes.push(`The reply is at most ${tokens} tokens${tokens < maxTokens ? ` (it asked for ${maxTokens})` : ""}.`);
  return { system, messages, maxTokens: tokens, shown, notes };
}

// A provider's stop as the protocol names it.
export function stopReason(stop: string): string {
  return ({ end_turn: "endTurn", max_tokens: "maxTokens", stop_sequence: "stopSequence", refusal: "refusal" } as Record<string, string>)[stop] ?? stop;
}

// Text for a card: the first SHOWN_MAX characters, and a note of how many more
// are sent and not shown.
export function cardText(text: string, what: string): { shown: string; note?: string } {
  if (text.length <= SHOWN_MAX) return { shown: text };
  const chars = [...text];
  if (chars.length <= SHOWN_MAX) return { shown: text };
  return { shown: chars.slice(0, SHOWN_MAX).join(""), note: `${what} is longer than the card shows: ${chars.length - SHOWN_MAX} more characters are sent and not shown.` };
}
