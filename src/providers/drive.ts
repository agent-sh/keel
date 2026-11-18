// Runs one request through a wire codec over a byte transport (HTTP, or a
// plugin's chunks): build the body, feed the events to the parser, return the
// step. A stream that ends before the wire's final event keeps what it showed.
import type { SseEvent } from "./sse.ts";
import { ProviderError, streamEvents, type StreamOpts } from "./http.ts";
import type { Delta, ProviderRequest, ProviderResult } from "./types.ts";
import type { WireCodec, WireCtx } from "./wires/common.ts";

export async function runEvents(
  codec: WireCodec,
  req: ProviderRequest,
  ctx: WireCtx,
  onDelta: (d: Delta) => void,
  events: (body: Record<string, any>) => AsyncIterable<SseEvent>,
): Promise<ProviderResult> {
  const body = codec.body(req, ctx);
  let shown = false;
  const parser = codec.parser(req, ctx, (d) => { shown = true; onDelta(d); });
  for await (const ev of events(body)) {
    parser.event(ev);
    if (parser.finished && ev.data === "[DONE]") break;
  }
  const res = parser.result();
  if (!parser.finished) {
    if (!shown && !res.blocks.length) throw new ProviderError("network", "the stream ended before the model answered");
    res.stop = "incomplete";
  }
  return res;
}

export const httpEvents = (o: Omit<StreamOpts, "body" | "signal">, signal: AbortSignal) => (body: Record<string, any>) =>
  streamEvents({ ...o, body, signal });

export const ctxFor = (providerId: string, req: ProviderRequest, efforts: string[], legacyIsMine = false): WireCtx => ({
  origin: `${providerId}:${req.model}`,
  sessionKey: req.sessionKey ?? "",
  efforts,
  legacyIsMine,
});
