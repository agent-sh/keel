// Canonical, provider-neutral shapes. Messages follow the Anthropic content-block
// model because it is the richest of the wire formats; every other driver projects
// to and from it.

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature?: string };
export type RedactedThinkingBlock = { type: "redacted_thinking"; data: string };
export type ImageBlock = { type: "image"; media_type: string; data: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | (TextBlock | ImageBlock)[];
  is_error?: boolean;
};

export type AssistantBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock;
export type UserBlock = TextBlock | ImageBlock | ToolResultBlock;

export type Message =
  | { role: "user"; content: UserBlock[] }
  | { role: "assistant"; content: AssistantBlock[] };

export type Usage = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cache_read: a.cache_read + (b.cache_read ?? 0),
    cache_write: a.cache_write + (b.cache_write ?? 0),
  };
}

// What is stored, one row per event, in order. `seq` is per session.
export type EventKind =
  | "user"          // the owner's message: { text, images? }
  | "assistant"     // one model response: { blocks, model, usage, stop }
  | "tool_result"   // results of one round of tool calls: { results: ToolResultBlock[] }
  | "turn_start"    // { model }
  | "turn_end"      // { reason, usage, ms }
  | "error"         // { message, where }
  | "note";         // system note shown in the transcript: { text }

export type StoredEvent = {
  id: string;
  session_id: string;
  seq: number;
  kind: EventKind;
  data: any;
  ts: number;
};

export type Session = {
  id: string;
  title: string;
  model: string;
  workspace: string;
  created: number;
  updated: number;
  phase: "idle" | "working" | "error";
  archived: boolean;
  usage: Usage;
};

// Frames pushed over the WebSocket. `event` frames are durable (replayable by seq);
// `delta` frames are live streaming text and are not stored.
export type Frame =
  | { t: "event"; event: StoredEvent }
  | { t: "delta"; session_id: string; index: number; kind: "text" | "thinking" | "tool_input"; text: string; name?: string }
  | { t: "session"; session: Session }
  | { t: "error"; error: ErrorRecord };

export type ErrorRecord = {
  id: string;
  ts: number;
  source: "server" | "client" | "provider" | "tool";
  message: string;
  stack?: string;
  context?: any;
};
