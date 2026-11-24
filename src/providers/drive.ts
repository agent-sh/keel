// Runs one request through a wire codec over a byte transport (HTTP, or a
// plugin's chunks): build the body, feed the events to the parser, return the
// step. A stream that ends before the wire's final event keeps what it showed.
import { timed } from "../admin/stall.ts";
import type { SseEvent } from "./sse.ts";
import { ProviderError, streamEvents, type StreamOpts } from "./http.ts";
import { reportUsage } from "./reported.ts";
import type { Delta, ProviderRequest, ProviderResult } from "./types.ts";
import type { WireCodec, WireCtx } from "./wires/common.ts";

export async function runEvents(
  codec: WireCodec,
  req: ProviderRequest,
  ctx: WireCtx,
  onDelta: (d: Delta) => void,
  events: (body: Record<string, any>) => AsyncIterable<SseEvent>,
): Promise<ProviderResult> {
  const made = timed(() => "making a model request's body from the conversation", () => codec.body(req, ctx));
  const body = req.extraBody ? { ...made, ...req.extraBody } : made;
  let shown = false;
  const parser = codec.parser(req, ctx, (d) => { shown = true; onDelta(d); });
  try {
    for await (const ev of events(body)) {
      parser.event(ev);
      if (parser.finished && ev.data === "[DONE]") break;
    }
  } catch (e) {
    // A stream that broke or was stopped after it counted the prompt: the failure says what it reported.
    throw reportUsage(e, parser.usage);
  }
  const res = parser.result();
  if (!parser.finished) {
    if (!shown && !res.blocks.length) throw reportUsage(new ProviderError("network", "the stream ended before the model answered"), parser.usage);
    res.stop = "incomplete";
  }
  return res;
}

export const httpEvents = (o: Omit<StreamOpts, "body" | "signal">, req: ProviderRequest) => (body: Record<string, any>) =>
  streamEvents({ ...o, headers: req.extraHeaders ? { ...o.headers, ...req.extraHeaders } : o.headers, body, signal: req.signal, onHeaders: req.onHeaders, connectWaitMs: req.connectWaitMs, onAnswer: req.onAnswer });

export const ctxFor = (providerId: string, req: ProviderRequest, efforts: string[], legacyIsMine = false): WireCtx => ({
  origin: `${providerId}:${req.model}`,
  sessionKey: req.sessionKey ?? "",
  efforts,
  legacyIsMine,
});
