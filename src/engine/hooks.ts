import type { Message, Session, StoredEvent, ToolResultBlock, TurnStatus, Usage } from "../core/types.ts";
import type { ProviderRequest, ProviderResult } from "../providers/types.ts";
import type { Tool, ToolContext } from "../tools/types.ts";

// One tool call as the turn is about to run it.
export type ToolCall = { id: string; tool: Tool; input: any; ctx: ToolContext };

// What a beforeTool hook may answer: refuse the call (the reason is the tool
// result the model sees), or run it with a changed input or context (a
// sandbox sets ctx.wrapSpawn). Nothing means "no opinion".
export type ToolGate = void | { deny: string } | { input?: any; ctx?: Partial<ToolContext> };

// Points where feature modules join the turn loop without editing it.
export type TurnHooks = {
  // Extra text for the system prompt; called once per session (the prompt is frozen).
  system?: (s: Session) => string | Promise<string>;
  // Change the request just before it is sent (compaction, volatile-tail notes).
  // Must keep the prefix stable: append, never rewrite earlier messages.
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
  // After each call that ran, with its result (checkpoints, audit).
  afterTool?: (s: Session, call: ToolCall, result: ToolResultBlock) => void | Promise<void>;
  // For measuring only: every call that was dispatched, however it ended,
  // with the time the tool itself took (no approval wait, no afterTool hooks).
  toolRan?: (s: Session, call: ToolCall, result: ToolResultBlock, ran: { ms: number; outcome: "ok" | "error" | "interrupted" }) => void;
  // After a step's tool results are stored, before the next model call (a
  // tool that asked for a fresh context gets its checkpoint here).
  stepDone?: (s: Session) => void | Promise<void>;
  turnEnd?: (s: Session, reason: string) => void | Promise<void>;
  // Before a compaction summarises the history (a memory tool reads it whole first).
  beforeCompact?: (s: Session) => void | Promise<void>;
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
