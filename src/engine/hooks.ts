import type { Message, Session, StoredEvent, ToolResultBlock, TurnStatus, Usage } from "../core/types.ts";
import type { ModelInfo, ProviderRequest, ProviderResult } from "../providers/types.ts";
import type { Tool, ToolContext } from "../tools/types.ts";

// One tool call as the turn is about to run it.
export type ToolCall = { id: string; tool: Tool; input: any; ctx: ToolContext };

// What a beforeTool hook may answer: refuse the call (the reason is the tool
// result the model sees), or run it with a changed input or context (a
// sandbox sets ctx.wrapSpawn). Nothing means "no opinion".
export type ToolGate = void | { deny: string } | { input?: any; ctx?: Partial<ToolContext> };

// Points where feature modules join the turn loop without editing it.
export type TurnHooks = {
  // Extra text for the system prompt; called once per session (the prompt is
  // frozen), with the model the session's first request goes to.
  system?: (s: Session, model?: ModelInfo) => string | Promise<string>;
  // Text of the session's own part of the prompt, after the cache split (a
  // project's instructions): it never enters the prefix other sessions share.
  // Rendered and kept like the rest; Engine.forgetSystem has it made again.
  sessionSystem?: (s: Session, model?: ModelInfo) => string | Promise<string>;
  // Change the request just before it is sent (compaction, volatile-tail notes).
  // Must keep the prefix stable: append, never rewrite earlier messages.
  // Runs for every purpose: a hook that answers the newest prompt or rebuilds
  // the messages from the branch does so for `purpose: "turn"` only (a summary
  // or side request carries its own ask, which the branch does not hold).
  beforeRequest?: (s: Session, req: ProviderRequest) => ProviderRequest | Promise<ProviderRequest>;
  // Every provider call, turn steps, summaries and side answers alike, for
  // measuring only: the request exactly as sent (after every beforeRequest and
  // the attachment projection), then its answer or its failure (`aborted`: the
  // turn was stopped; a retry may follow). `req` is the same object in all three.
  requestSent?: (s: Session, req: ProviderRequest) => void;
  requestDone?: (s: Session, req: ProviderRequest, res: ProviderResult) => void;
  requestFailed?: (s: Session, req: ProviderRequest, err: unknown, aborted: boolean) => void;
  // Each streamed piece of the answer, side answers too (they never reach the bus).
  requestDelta?: (s: Session, req: ProviderRequest, d: { kind: string; text: string }) => void;
  afterResponse?: (s: Session, res: ProviderResult, messages: Message[]) => void | Promise<void>;
  // Before each tool call, in registration order; may wait (an approval). The
  // first deny wins and the call does not run. Watch call.ctx.signal.
  beforeTool?: (s: Session, call: ToolCall) => ToolGate | Promise<ToolGate>;
  // The input the tool runs with when it differs from the one shown and
  // recorded (a secret's value in place of its placeholder). Asked after every
  // beforeTool passed; call.input keeps what the model wrote.
  execInput?: (s: Session, call: ToolCall) => any;
  // After each call that ran, with its result (checkpoints, audit).
  afterTool?: (s: Session, call: ToolCall, result: ToolResultBlock) => void | Promise<void>;
  // For measuring only: every call that was dispatched, however it ended,
  // with the time the tool itself took (no approval wait, no afterTool hooks).
  toolRan?: (s: Session, call: ToolCall, result: ToolResultBlock, ran: { ms: number; outcome: "ok" | "error" | "interrupted" }) => void;
  // A tool result was stored: called in the same SQLite transaction as the
  // append, so what it records (a handback delivered) commits with the result.
  resultStored?: (s: Session, results: ToolResultBlock[]) => void;
  // After a step's tool results are stored, before the next model call (a
  // tool that asked for a fresh context gets its checkpoint here).
  stepDone?: (s: Session) => void | Promise<void>;
  // A turn is starting in the session, whatever started it (a prompt, a queued
  // one, a report, a continuation after a restart).
  turnStart?: (s: Session) => void;
  turnEnd?: (s: Session, reason: string) => void | Promise<void>;
  // At startup, a turn a daemon restart cut is about to continue by itself.
  // `stalled`: how many continuations in a row were cut before they finished a
  // step. A session's owner (an agent's record) answers "continue", or `hold`
  // with the reason it is not continued (shown in the session). No answer: the
  // engine's rule, which continues unless the count reached STALLED_MAX.
  cutTurn?: (s: Session, cut: { stalled: number }) => "continue" | { hold: string } | undefined;
  // A cut turn was not continued, for the reason given (a hook's, the engine's
  // rule, or a model that did not come back).
  cutTurnHeld?: (s: Session, why: string) => void;
  // A call a restart cut, with no stored result: what its approval recorded.
  // `denied`: the text the model gets (the owner's reason in it); `not_run`:
  // nothing answered it, so it never ran; `waiting`: its card is still open (or
  // was answered since), so the continued turn runs the call again and gets
  // that card back. Nothing known: it may have partly run.
  callOutcome?: (sessionId: string, callId: string) => { denied: string } | "not_run" | "waiting" | undefined;
  // The daemon stops and parks this session's turn (before its signal aborts).
  turnParking?: (sessionId: string) => void;
  // Before a compaction summarises the history (a memory tool reads it whole first).
  beforeCompact?: (s: Session) => void | Promise<void>;
  // What a summary of this session keeps above all, when the owner named nothing
  // (the helper's summary keeps their decisions and commitments, not files).
  compactFocus?: (s: Session) => string | undefined;
  // A session another agent answers (an ACP agent): its runner takes the whole
  // turn, keeps its own history, and stores what happened through `io`. The
  // first hook that returns a runner wins; the provider loop does not run.
  external?: (s: Session) => ExternalTurn | undefined;
};

export type ExternalIO = {
  signal: AbortSignal;
  events(): StoredEvent[];   // the branch shown, as it is now
  append(kind: StoredEvent["kind"], data: unknown): StoredEvent;
  delta(kind: "text" | "thinking", index: number, text: string): void;
  status(s: TurnStatus): void;
};
export type ExternalTurn = (io: ExternalIO) => Promise<{ reason: string; usage?: Usage }>;

const hooks: TurnHooks[] = [];
export const registerHooks = (h: TurnHooks) => void hooks.push(h);
export const allHooks = () => hooks;
