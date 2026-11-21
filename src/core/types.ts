// Canonical, provider-neutral shapes. Messages follow the Anthropic content-block
// model because it is the richest of the wire formats; every other driver projects
// to and from it.

// `origin` is the "<provider>:<model>" that wrote a block carrying opaque
// provider state (a signature, an encrypted reasoning item). That state is
// replayed only to the same origin; every other wire gets the plain text.
export type TextBlock = { type: "text"; text: string; signature?: string; origin?: string };
// `bind`: the fingerprint of what was sent before the block (src/providers/wires/binding.ts).
export type ThinkingBlock = { type: "thinking"; thinking: string; signature?: string; origin?: string; opaque?: unknown; bind?: string };
export type RedactedThinkingBlock = { type: "redacted_thinking"; data: string; bind?: string };
// `path`: the file a tool read the image from, for the note about a scaled
// image; never stored (src/engine/image-fit.ts).
export type ImageBlock = { type: "image"; media_type: string; data: string; path?: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown; signature?: string; origin?: string };
// A deferred tool a tool search loaded: on the Anthropic wire the provider puts
// the tool's definition in place of the block (the cached prefix is unchanged);
// every other wire reads it as a line of text.
export type ToolRefBlock = { type: "tool_reference"; tool_name: string };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | (TextBlock | ImageBlock | ToolRefBlock)[];
  is_error?: boolean;
};

export type AssistantBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock;
// A file the owner attached, stored once by content (src/engine/attachments.ts).
// It travels with the prompt among its image blocks and is resolved per model
// just before a request: text inline, a PDF as a document where the model
// reads PDFs, anything else as a note with the saved path.
// `scaled`: the original of the image block before it, which was stored scaled
// down (its pixel size then and now).
export type AttachmentBlock = { type: "attachment"; id: string; name: string; media_type: string; size: number; charset?: string; scaled?: { from: [number, number]; to: [number, number] } };
// A PDF as the provider reads it (resolved from an attachment, never stored).
export type DocumentBlock = { type: "document"; media_type: string; data: string; name: string };
// What a prompt carries besides its text (stored in the user event's `images`).
export type PromptBlock = ImageBlock | AttachmentBlock;
export type UserBlock = TextBlock | ImageBlock | ToolResultBlock | AttachmentBlock | DocumentBlock;

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
  // OpenAI Responses: the parts of cache_write held 30 minutes and 12 hours.
  cache_write_30m?: number;
  cache_write_12h?: number;
  cost?: number;
  unpriced?: number;
  speed_asked?: string; // the speed offer the call asked for
  speed?: string;       // the tier the provider said served it (an offer id or "standard"); unset when it did not say
};

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cache_read: a.cache_read + (b.cache_read ?? 0),
    cache_write: a.cache_write + (b.cache_write ?? 0),
    cache_write_1h: (a.cache_write_1h ?? 0) + (b.cache_write_1h ?? 0) || undefined,
    cache_write_30m: (a.cache_write_30m ?? 0) + (b.cache_write_30m ?? 0) || undefined,
    cache_write_12h: (a.cache_write_12h ?? 0) + (b.cache_write_12h ?? 0) || undefined,
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
  | "turn_end"      // { reason, usage, ms, steps?, tools?, tool_errors?, stopped_by? }
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
  updated: number; // the last activity (a prompt, a turn), not a rename
  rev?: number; // bumped by every change of the session itself
  phase: "idle" | "working" | "error";
  archived: boolean;
  usage: Usage;
  head: string | null;
  settings: SessionSettings;
  parent_id?: string | null; // a subagent's session names the session that spawned it
  // The fleet machine its tools run on (absent: this daemon's machine).
  machine?: string | null;
  // The session's folder is not on this machine's disk any more.
  workspace_gone?: true;
};

// Per-session turn settings. Values come from the model's listing (efforts) or
// the owner; nothing here has a built-in model name.
export type SessionSettings = {
  effort?: string;     // one of the model's listed efforts; absent = the model's default
  fallback?: string;   // model id to continue on when the session's model declines
  compact_at?: number; // owner ceiling in tokens; absent = a share of the model's window
  idle_compact?: false; // false: no summary is prepared while the session is idle (src/engine/compact.ts)
  speed?: string;      // a speed offer id of the model's listing; absent = standard
  // Marks, daemon state every client shares (src/server/routes/marks.ts).
  pinned_ms?: number;  // pinned at; absent = not pinned
  tags?: string[];
  done_ms?: number;    // the owner marked the work finished; their next prompt clears it
  failed_ms?: number;  // the last turn ended in a failure; the next turn's start clears it
  last_end?: string;   // why the last turn ended (turn_end's reason: end_turn, interrupted, restart, error...)
  accept_messages?: boolean; // false: messages from other sessions are refused
  peer_turns?: number; // turns other sessions may start before the owner speaks here again
  max_steps?: number;  // model steps one turn may take; absent = no budget
  skill_mode?: string; // a skill kept on as standing instructions
  cache_long?: boolean; // an agent's request came after a pause near its short cache lifetime: it asks for the long one from then on
  drop_thinking?: boolean; // the provider refused this session's sent-back thinking once: "drop_block" from then on
  image_edge?: number; // px: the image limit the provider stated when it refused a request; larger images are sent scaled to it
  images_out?: string[]; // images (imageKey) the provider refused a request over: sent as a note from then on (src/engine/image-fit.ts)
  folder_id?: string;  // the owner's folder of sessions it is filed in (src/server/routes/session-folders.ts)
  project?: string;    // a project's id, or "none"; absent = the project that holds its folder (src/server/routes/projects.ts)
  helper?: boolean; // the owner's always-on helper conversation (src/helper/)
};

// `anchor`: the session's head when it was queued (the branch it was written on).
export type QueueItem = { id: string; session_id: string; text: string; images?: ImageBlock[]; steer: boolean; pos: number; created: number; anchor?: string; meta?: Record<string, unknown> };

export type PendingQuestion = { session_id: string; call_id: string; parent_id?: string };

// Frames pushed over the WebSocket. `event` frames are durable (replayable by seq);
// `delta` frames are live streaming text and are not stored. `rev` is the bus's
// order of the frame, set when it is emitted and never lower after a restart: a
// session snapshot carries the rev it was read at, so a page keeps whichever of
// the two is newer for a session's metadata, queue, status and draft.
export type Frame = (
  | { t: "event"; event: StoredEvent }
  | { t: "delta"; session_id: string; index: number; kind: "text" | "thinking" | "tool_input"; text: string; name?: string }
  | { t: "session"; session: Session; deleted?: boolean } // deleted: the session is gone; pages drop it
  | { t: "queue"; session_id: string; queue: QueueItem[]; held: boolean }
  | { t: "status"; session_id: string; status: TurnStatus }
  | { t: "questions"; pending: PendingQuestion[]; machine?: string } // all live questions of one daemon
  | { t: "error"; error: ErrorRecord }
  // A feature module's live update (approvals, checkpoints, worktrees): the UI
  // routes it by `name` to the module's own client state.
  | { t: "feature"; name: string; session_id?: string; data: any }
  // A new page was installed (src/server/ui-bundle.ts): open pages reload into it.
  | { t: "ui"; version: string }
) & { rev?: number };

// What only the WebSocket sends (never on the bus): the greeting, the end of a
// replay, the reply a running turn has streamed so far, a ping's answer.
export type DraftBlocks = Record<number, { kind: "text" | "thinking" | "tool_input"; text: string; name?: string }>;
export type SocketFrame =
  | { t: "hello"; pid: number; started_ms: number; ui?: string }
  | { t: "replayed"; cursors: Record<string, number> }
  | { t: "draft"; session_id: string; blocks: DraftBlocks; rev?: number }
  | { t: "pong"; nonce?: number };
// What a client sends: catch up on these sessions after `seq` (events wait
// for the first resume), or ask for a pong.
export type ClientFrame = { op: "resume"; cursors: Record<string, number> } | { op: "ping"; nonce?: number };

// One kind of failure: `ts` is its last time, `count` how often it happened
// since `first_ts`; `session_id`, `turn_event` (the turn_start event) and
// `span_id` are where it last happened, each absent when that occurrence had
// none (a side request runs in no turn, a daemon failure in no session);
// `resolved_ts` is set when the owner marked it fixed.
export type ErrorRecord = {
  id: string;
  ts: number;
  first_ts?: number;
  count?: number;
  session_id?: string;
  turn_event?: string;
  // The exact model request or tool call (trace span) the last occurrence failed in.
  span_id?: string;
  resolved_ts?: number;
  // Set when the owner marked it read: it no longer counts in the badge. A new occurrence clears it.
  read_ts?: number;
  source: "server" | "client" | "provider" | "tool";
  message: string;
  stack?: string;
  context?: any;
};

// Live, not stored: what the turn is doing besides streaming.
export type TurnStatus =
  | { kind: "idle" }
  | { kind: "retry"; attempt: number; max: number; at: number; message: string }
  | { kind: "compacting"; auto: boolean }
  // Waiting on the model's first output of this request (`connected`: when the
  // provider answered; bytes since then, a keep-alive say, are not output), or
  // on tools to finish.
  | { kind: "model"; since: number; model: string; connected?: number }
  | { kind: "tool"; since: number; names: string[] };
