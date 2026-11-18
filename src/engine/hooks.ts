import type { Message, Session, ToolResultBlock } from "../core/types.ts";
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
  afterResponse?: (s: Session, res: ProviderResult, messages: Message[]) => void | Promise<void>;
  // Before each tool call, in registration order; may wait (an approval). The
  // first deny wins and the call does not run. Watch call.ctx.signal.
  beforeTool?: (s: Session, call: ToolCall) => ToolGate | Promise<ToolGate>;
  // After each call that ran, with its result (checkpoints, audit).
  afterTool?: (s: Session, call: ToolCall, result: ToolResultBlock) => void | Promise<void>;
  turnEnd?: (s: Session, reason: string) => void | Promise<void>;
};

const hooks: TurnHooks[] = [];
export const registerHooks = (h: TurnHooks) => void hooks.push(h);
export const allHooks = () => hooks;
