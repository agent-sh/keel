// Canonical, provider-neutral shapes. Messages follow the Anthropic content-block
// model because it is the richest of the wire formats; every other driver projects
// to and from it.

// `origin` is the "<provider>:<model>" that wrote a block carrying opaque
// provider state (a signature, an encrypted reasoning item). That state is
// replayed only to the same origin; every other wire gets the plain text.
// `system`: text the harness wrote itself (a notice, a changed block of the owner's prompt), not the
// owner's words and not what a tool or an agent returned. A wire that documents a system or developer
// message among the turns carries it so, after the user message it ends (src/providers/wires/common.ts
// operatorTail); every other wire reads it as the user text it was stored as.
export type TextBlock = { type: "text"; text: string; signature?: string; origin?: string; system?: true };
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
  // The name of the offered tool a call ran as when the model wrote another (bash for Bash). The stored
  // call keeps the name the model wrote, so what reads a call by its tool reads it through this.
  resolved_as?: string;
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
  // tool_result also carries `verdict` for an error result: "failed" (the call ran), "denied" (a gate refused it), "none" (not run otherwise).
  | "turn_end"      // { reason, usage, ms, steps? (replies the model gave), tools?, tool_errors? (ran and failed), tool_denied?, stopped_by? }
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
  // Who wrote the title (src/engine/title.ts): "" given (the owner, the
  // session's maker, or a session from before), "prompt" the first prompt's
  // words, "model" a small model, "start" a small model from a first prompt
  // that held no task yet (made again once), "hook" a hook of the owner's (kept
  // like a given one against a model, but not over what the owner gave).
  title_by?: "" | "prompt" | "model" | "start" | "hook";
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
  // A session another harness runs on this machine, shown here as it goes
  // (src/integrations/outside/service.ts): read-only, nothing is sent to it.
  outside?: OutsideMark;
};

// What a list shows of an outside session, from its own records. The rest
// (its files, its usage by model) is read with GET /api/sessions/:id/outside.
export type OutsideMark = {
  harness: "claude" | "codex";
  source_id: string;
  state: "working" | "waiting" | "done" | "stale";
  waiting_for?: string;
  since: number;   // when the state began
  model?: string;  // the model its harness names
  files: number;   // files its tool calls changed
  failures: number;
};

// Per-session turn settings. Values come from the model's listing (efforts) or
// the owner; nothing here has a built-in model name.
export type SessionSettings = {
  effort?: string;     // one of the model's listed efforts; absent = the model's default
  fallback?: string;   // model id to continue on when the session's model declines (for good) or stays overloaded (that turn)
  compact_at?: number; // owner ceiling in tokens; absent = a share of the model's window
  idle_compact?: false; // false: no summary is prepared while the session is idle (src/engine/compact.ts)
  // An agent compacts when the steps it is expected to take would read more than a summary costs (src/engine/price-compact.ts):
  // true or false for its whole tree, set on a session at the top (a trial's arm sets it there); absent = by the window only.
  compact_by_price?: boolean;
  // The share of the model's window an agent compacts at, and whether its waits get a cache plan: for the agent's
  // whole tree, set on its first agent (a trial's arm, src/admin/setting-trials.ts); absent = the owner's `agents` setting.
  compact_share?: number;
  cache_plan?: boolean;
  // An agent told at a run of read-only steps what each step costs and what else there is (src/engine/read-run.ts):
  // "batch" (parallel reads), "reader" (that, and an Explore agent on the reader model) or "code" (that, and run_code
  // for the reads it knows it needs), for its whole tree, set at the top (a trial's arm).
  read_runs?: "batch" | "reader" | "code";
  // Old tool results become stubs and earlier thinking is left out when the cache has lapsed (src/engine/cold-clear.ts):
  // true or false for its whole tree, set at the top (a trial's arm); absent = off.
  cold_clear?: boolean;
  // A new model tried in a role by this session's whole tree: set at the top (a trial's arm, src/engine/model-trial.ts).
  trial?: { role: "reader" | "small" | "builder"; model: string };
  speed?: string;      // a speed offer id of the model's listing; absent = standard
  // Marks, daemon state every client shares (src/server/routes/marks.ts).
  pinned_ms?: number;  // pinned at; absent = not pinned
  tags?: string[];
  done_ms?: number;    // the owner marked the work finished; their next prompt clears it
  failed_ms?: number;  // the last turn ended in a failure; the next turn's start clears it
  fail_seen_ms?: number; // the failure (its failed_ms) the owner has looked at, on any device; 0: not looked at
  agents_failed_ms?: number; // when an agent under it last failed (its tree's root keeps it); news until agents_fail_seen_ms is that time
  agents_fail_seen_ms?: number; // the agents' failure (its agents_failed_ms) the owner has looked at, on any device
  last_end?: string;   // why the last turn ended (turn_end's reason: end_turn, interrupted, restart, error...)
  stopped_by?: string | null; // who stopped it, when it ended as interrupted (a word of src/core/stoppers.ts)
  accept_messages?: boolean; // false: messages from other sessions are refused
  peer_turns?: number; // turns other sessions may start before the owner speaks here again
  max_steps?: number;  // model steps one turn may take; absent = no budget
  cap_usd?: number;    // a dollar cap for this session and everything it starts (src/automation/caps.ts); absent = none
  cap_from?: number;   // when the cap began: what it counts the tree's spend from
  skill_mode?: string; // a skill kept on as standing instructions
  acp_switches?: Record<string, boolean>; // an ACP agent's boolean options as the owner set them, by id: sent before its next prompt
  cache_long?: boolean; // an agent's request came after a pause near its short cache lifetime: it asks for the long one from then on
  drop_thinking?: boolean; // the provider refused this session's sent-back thinking once: "drop_block" from then on
  mcp_off?: string[];  // MCP servers (the owner's, by name) turned off for this session alone: their tools are not offered to it (src/tools/catalog.ts sessionOff)
  image_edge?: number; // px: the image limit the provider stated when it refused a request; larger images are sent scaled to it
  images_out?: string[]; // images (imageKey) the provider refused a request over: sent as a note from then on (src/engine/image-fit.ts)
  results_short?: string[]; // tool results (their call ids) sent shortened to their start and end after a provider refused a request as too large (src/engine/size-fit.ts)
  // The first time a request of this session was repaired so its wire takes it, per kind of repair: when, the
  // message's place in the request, the call id and the turn; never content (src/providers/project.ts).
  repairs?: Record<string, { ts: number; message: number; call?: string; turn?: string }>;
  folder_id?: string;  // the owner's folder of sessions it is filed in (src/server/routes/session-folders.ts)
  project?: string;    // a project's id, or "none"; absent = the project that holds its folder (src/server/routes/projects.ts)
  helper?: boolean; // the owner's always-on helper conversation (src/helper/)
  // The last turn failed because the provider asked for a wait longer than a turn waits: the session
  // continues by itself at `at`, while the failure `after` is still the last thing in it (src/engine/turn.ts).
  // `round`: how many times in a row it already did, each wait twice the one before.
  continue_at?: { at: number; after: string; round?: number };
};

// `anchor`: the session's head when it was queued (the branch it was written on).
export type QueueItem = { id: string; session_id: string; text: string; images?: ImageBlock[]; steer: boolean; pos: number; created: number; anchor?: string; meta?: Record<string, unknown> };

// `asked`: a question that is not the call's own input (an MCP server asked
// it while the call ran): who asks, its words as plain text, the fields, what
// the card says besides (what was wrong with the last answer, fields left
// out), and that the owner can decline it.
// `id`: one per question asked, so a card knows a new question from the one before it on the same call.
// `round`: how often this one was asked before (an answer that did not fit is asked again).
// `sensitive`: a field looks like a secret; an answer is sent only when the owner says to send it anyway.
// `secret` (a question): its answer is typed masked.
export type AskedQuestion = { id: string; header?: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; optional?: boolean; secret?: boolean };
// `label`: what the card says the message is (default: the server's own words).
// `link`: a page the server sends the owner to (MCP URL elicitation). The page
// shows it and the owner opens it in their own browser; nothing of Keel's
// opens or fetches it. `waiting`: the owner went to it, and the card waits for
// the step there to be done.
export type AskedLink = { url: string; host: string; waiting?: boolean };
export type Asked = { id: string; from: string; label?: string; message: string; questions: AskedQuestion[]; notes?: string[]; note?: string; round?: number; sensitive?: boolean; link?: AskedLink };
export type PendingQuestion = { session_id: string; call_id: string; parent_id?: string; asked?: Asked };

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
  | { t: "error"; error: ErrorRecord; repeat?: true } // repeat: one more of a row that said it already (ErrorPlace.repeat)
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
  // `sessions_level`: how far the session list had moved when this socket was subscribed (Bus.sessionsLevel).
  | { t: "hello"; pid: number; started_ms: number; ui?: string; sessions_level?: number }
  | { t: "replayed"; cursors: Record<string, number> }
  | { t: "draft"; session_id: string; blocks: DraftBlocks; rev?: number }
  | { t: "pong"; nonce?: number };
// What a client sends. `resume`: each named session is caught up after `seq`.
// With `only` these are the sessions the socket hears in full from now on;
// `watch` names more of them that need no catching up (their snapshot is on
// its way, or they are another daemon's) and `feeds` the feeds of
// src/server/scope.ts. Without `only` the socket hears every session's
// stream, as every client did before: a page of an earlier build, a script.
// `sub` adds to what the socket hears, `unsub` takes away. `ping` asks for a pong.
export type ClientFrame =
  | { op: "resume"; cursors: Record<string, number>; only?: boolean; watch?: string[]; feeds?: string[] }
  | { op: "sub"; cursors?: Record<string, number>; watch?: string[]; feeds?: string[] }
  | { op: "unsub"; watch?: string[]; feeds?: string[] }
  | { op: "ping"; nonce?: number };

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
  // Where it happened, newest first: one entry per session (src/core/error-sites.ts).
  sites?: ErrorSite[];
  // Set when every occurrence was healed by a retry of its request: it is not
  // an open failure. An occurrence that is not healed takes it away.
  recovered_ts?: number;
  // On a record read for one session (atSession): when the kind last happened anywhere; `ts` is that session's last.
  kind_ts?: number;
  // Not stored: the store could not take this row (why, in its words). It is
  // kept in memory, shown, and written once the store takes rows again.
  unwritten?: string;
};

// One kind of failure in one session: how often, when, and where its latest
// occurrence there was (turn and span). `healed`: how many of them a retry of
// the request made good.
export type ErrorSite = {
  session_id: string;
  title?: string;
  count: number;
  healed: number;
  first_ts: number;
  ts: number;
  healed_ts?: number;
  turn_event?: string;
  span_id?: string;
};

// Live, not stored: what the turn is doing besides streaming.
export type TurnStatus =
  | { kind: "idle" }
  // `unreachable`: the provider cannot be reached since then; the request waits for it
  // and is not counted (no attempt, no time of the next try: src/providers/outage.ts).
  // `limit`: the retry waits in its account's line, which holds the model's requests (src/providers/admission.ts): why, in its words.
  | { kind: "retry"; attempt: number; max: number; at: number; message: string; unreachable?: number; limit?: string } // max 0: no count (an overloaded model is tried until it has room)
  // `plan`: the history is too long for one request and is read as a
  // transcript in that many requests, with what they are estimated to send
  // (`cost` in dollars when the model has a price) and how many are done.
  | { kind: "compacting"; auto: boolean; plan?: { requests: number; done: number; input_tokens: number; cost?: number; steps_left_out?: number } }
  // Waiting on the model's first output of this request (`connected`: when the
  // provider answered; bytes since then, a keep-alive say, are not output), or
  // on tools to finish.
  // `preparing`: the request is not sent yet; images of the history are being
  // scaled for it (src/engine/image-fit.ts).
  // `quiet`: the reply was streaming and stopped: when its last output came.
  // Told once the silence passes STREAM_QUIET_MS; the next output ends it.
  // `limit`: the request waits in its account's line while the account's limit holds requests
  // (src/providers/admission.ts): until when the account said, and why, in its words.
  | { kind: "model"; since: number; model: string; connected?: number; preparing?: "images"; quiet?: number; limit?: { until?: number; why: string; spend?: true } }
  | { kind: "tool"; since: number; names: string[] };
