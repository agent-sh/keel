import type { SseEvent } from "../sse.ts";
import type { Delta, ProviderRequest, ProviderResult } from "../types.ts";

// What every wire codec gets besides the request.
export type WireCtx = {
  origin: string;         // "<provider>:<model>", stamped on opaque blocks
  sessionKey: string;
  efforts: string[];      // levels the model takes; empty: send none
  legacyIsMine?: boolean; // see project.ts
};

export interface WireParser {
  event(e: SseEvent): void;
  // The wire's final event arrived (only trailing frames can follow).
  readonly finished: boolean;
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
