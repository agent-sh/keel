// Canonical, provider-neutral shapes. Messages follow the Anthropic content-block
// model because it is the richest of the wire formats; every other driver projects
// to and from it.

// `origin` is the "<provider>:<model>" that wrote a block carrying opaque
// provider state (a signature, an encrypted reasoning item). That state is
// replayed only to the same origin; every other wire gets the plain text.
export type TextBlock = { type: "text"; text: string; signature?: string; origin?: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature?: string; origin?: string; opaque?: unknown };
export type RedactedThinkingBlock = { type: "redacted_thinking"; data: string };
export type ImageBlock = { type: "image"; media_type: string; data: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown; signature?: string; origin?: string };
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

// `input` excludes the cached parts on every wire (Anthropic's convention).
// `cost` is USD from the catalog's price; `unpriced` counts calls with no
// known price, so an unknown cost is never shown as free.
export type Usage = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  // The part of cache_write held for an hour (priced at its own rate).
  cache_write_1h?: number;
  cost?: number;
  unpriced?: number;
};

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cache_read: a.cache_read + (b.cache_read ?? 0),
    cache_write: a.cache_write + (b.cache_write ?? 0),
    cache_write_1h: (a.cache_write_1h ?? 0) + (b.cache_write_1h ?? 0) || undefined,
    cost: a.cost !== undefined || b.cost !== undefined ? (a.cost ?? 0) + (b.cost ?? 0) : undefined,
    unpriced: (a.unpriced ?? 0) + (b.unpriced ?? 0) || undefined,
  };
}

// What is stored, one row per event, in order. `seq` is per session. Events form
// a tree: `parent` is the event before it on its branch, the session's `head` is
// the newest event of the branch shown. Nothing is ever rewritten: an edited
// prompt is a new sibling, a compaction is a checkpoint event.
export type UserOrigin = "owner" | "steer" | "queued" | "harness";
export type EventKind =
  | "user"          // a prompt: { text, images?, origin? } (origin absent = owner)
  | "assistant"     // one model response: { blocks, model, usage, stop, stop_details? }
  | "tool_result"   // results of one round of tool calls: { results: ToolResultBlock[] }
  | "turn_start"    // { model }
  | "turn_end"      // { reason, usage, ms }
  | "error"         // { message, where }
  | "note"          // system note shown in the transcript: { text, kind? }
  | "compaction";   // context checkpoint: { mode: "summary" | "clear", summary?, owner_messages?, focus?, auto?, tokens_before? }

export type StoredEvent = {
  id: string;
  session_id: string;
  seq: number;
  parent: string | null;
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
  head: string | null;
  settings: SessionSettings;
  parent_id?: string | null; // a subagent's session names the session that spawned it
  // The fleet machine its tools run on (absent: this daemon's machine).
  machine?: string | null;
};

// Per-session turn settings. Values come from the model's listing (efforts) or
// the owner; nothing here has a built-in model name.
export type SessionSettings = {
  effort?: string;     // one of the model's listed efforts; absent = the model's default
  fallback?: string;   // model id to continue on when the session's model declines
  compact_at?: number; // owner ceiling in tokens; absent = a share of the model's window
};

export type QueueItem = { id: string; session_id: string; text: string; images?: ImageBlock[]; steer: boolean; pos: number; created: number };

// Frames pushed over the WebSocket. `event` frames are durable (replayable by seq);
// `delta` frames are live streaming text and are not stored.
export type Frame =
  | { t: "event"; event: StoredEvent }
  | { t: "delta"; session_id: string; index: number; kind: "text" | "thinking" | "tool_input"; text: string; name?: string }
  | { t: "session"; session: Session }
  | { t: "queue"; session_id: string; queue: QueueItem[]; held: boolean }
  | { t: "status"; session_id: string; status: TurnStatus }
  | { t: "error"; error: ErrorRecord }
  // A feature module's live update (approvals, checkpoints, worktrees): the UI
  // routes it by `name` to the module's own client state.
  | { t: "feature"; name: string; session_id?: string; data: any };

// One kind of failure: `ts` is its last time, `count` how often it happened
// since `first_ts`; `session_id` and `turn_event` (the turn_start event) are
// where it last happened; `resolved_ts` is set when the owner marked it fixed.
export type ErrorRecord = {
  id: string;
  ts: number;
  first_ts?: number;
  count?: number;
  session_id?: string;
  turn_event?: string;
  resolved_ts?: number;
  source: "server" | "client" | "provider" | "tool";
  message: string;
  stack?: string;
  context?: any;
};

// Live, not stored: what the turn is doing besides streaming.
export type TurnStatus =
  | { kind: "idle" }
  | { kind: "retry"; attempt: number; max: number; at: number; message: string }
  | { kind: "compacting"; auto: boolean };
