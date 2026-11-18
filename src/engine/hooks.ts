import type { Message, Session } from "../core/types.ts";
import type { ProviderRequest, ProviderResult } from "../providers/types.ts";

// Points where feature modules join the turn loop without editing it.
export type TurnHooks = {
  // Extra text for the system prompt; called once per session (the prompt is frozen).
  system?: (s: Session) => string | Promise<string>;
  // Change the request just before it is sent (compaction, volatile-tail notes).
  // Must keep the prefix stable: append, never rewrite earlier messages.
  beforeRequest?: (s: Session, req: ProviderRequest) => ProviderRequest | Promise<ProviderRequest>;
  afterResponse?: (s: Session, res: ProviderResult, messages: Message[]) => void | Promise<void>;
  turnEnd?: (s: Session, reason: string) => void | Promise<void>;
};

const hooks: TurnHooks[] = [];
export const registerHooks = (h: TurnHooks) => void hooks.push(h);
export const allHooks = () => hooks;
