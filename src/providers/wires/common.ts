import type { Usage } from "../../core/types.ts";
import type { SseEvent } from "../sse.ts";
import type { WireRules } from "../project.ts";
import type { Delta, ProviderRequest, ProviderResult, Wire } from "../types.ts";

// What every wire codec gets besides the request.
export type WireCtx = {
  origin: string;         // "<provider>:<model>", stamped on opaque blocks
  sessionKey: string;
  efforts: string[];      // levels the model takes; empty: send none
  legacyIsMine?: boolean; // see project.ts
  // The route carries the harness's own text (TextBlock.system) as a system message among the turns
  // (the Anthropic wire, on the providers whose documentation says it takes one: src/providers/anthropic.ts).
  midSystem?: boolean;
  // What is repaired in the history; absent: what the wire refuses (each
  // driver's own rules). A test passes {} to get the history as it is stored.
  rules?: WireRules;
};

// The cache lifetimes a request on a wire can choose between
// (ProviderRequest.cacheLife), in ms. Anthropic Messages takes five minutes or
// an hour per breakpoint; on the other wires the provider sets the lifetime.
const LIVES: Partial<Record<Wire, { short: number; long: number }>> = { anthropic_messages: { short: 5 * 60_000, long: 60 * 60_000 } };
export const cacheLives = (wire?: Wire) => (wire ? LIVES[wire] : undefined);
// The lifetime a request asks for: its choice, else the wire's default (the
// Anthropic wire asks for an hour unless told "short", see wires/anthropic.ts).
export const askedLife = (wire: Wire | undefined, life: "short" | "long" | undefined) => {
  const l = cacheLives(wire);
  return l ? l[life ?? "long"] : undefined;
};

// How many blocks at the end of a user message are the harness's own text. Such a run is carried as a
// system (Anthropic) or developer (OpenAI) message after the rest of the message, never alone: a message
// that holds nothing else starts a turn, and the provider's rules (a system message follows a user turn)
// and the model's habit (it answers the user) both want the harness's words as that turn's user text.
export function operatorTail(content: readonly { type: string; system?: true }[]): number {
  let n = 0;
  for (let i = content.length - 1; i >= 0 && content[i]!.type === "text" && content[i]!.system === true; i--) n++;
  return n < content.length ? n : 0;
}

export interface WireParser {
  event(e: SseEvent): void;
  // The wire's final event arrived (only trailing frames can follow).
  readonly finished: boolean;
  // The counts the stream has reported so far (the parser's own object, filled in as events come):
  // what a request that fails or is stopped mid-stream was billed for (src/providers/reported.ts).
  readonly usage?: Usage;
  result(): ProviderResult;
}

export interface WireCodec {
  body(req: ProviderRequest, ctx: WireCtx): Record<string, any>;
  parser(req: ProviderRequest, ctx: WireCtx, onDelta: (d: Delta) => void): WireParser;
}

export const parseJson = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

export const parseArgs = (s: string): unknown => {
  if (!s.trim()) return {};
  return parseJson(s) ?? { _raw: s };
};

// The effort to send: the session's when the model lists it, else none.
export const effortFor = (req: ProviderRequest, ctx: WireCtx) =>
  req.effort && ctx.efforts.includes(req.effort) ? req.effort : undefined;
