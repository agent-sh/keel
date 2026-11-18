// One HTTP path for every fetch-based driver: the request, the classification
// of a failed answer, and the retry of a step that has shown nothing yet.
import { JsonArrayDecoder, SseDecoder, type SseEvent } from "./sse.ts";

export type ErrorKind = "auth" | "rate" | "quota" | "overloaded" | "network" | "invalid" | "context" | "server" | "cancelled";

export class ProviderError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  // Read by the engine's retry policy. A quota that is spent does not pass by waiting.
  get retryable() {
    return this.kind === "rate" || this.kind === "overloaded" || this.kind === "network" || this.kind === "server";
  }
}

// Strip anything that looks like a credential before a message is shown or stored.
export function scrub(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length > 6) out = out.split(s).join("<redacted>");
  return out
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1<redacted>")
    .replace(/((?:api[_-]?)?key=)[^&\s"]+/gi, "$1<redacted>")
    .replace(/\b(sk|xai|AIza)[-_A-Za-z0-9]{16,}/g, "<redacted>");
}

const clip = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + "..." : s);

function retryAfter(h: Headers): number | undefined {
  const ms = h.get("retry-after-ms");
  if (ms && !isNaN(Number(ms))) return Number(ms);
  const s = h.get("retry-after");
  if (!s) return undefined;
  if (!isNaN(Number(s))) return Number(s) * 1000;
  const t = Date.parse(s);
  return isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

export function classify(label: string, status: number, headers: Headers, body: string): ProviderError {
  let msg = body;
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error ?? j;
    msg = typeof e === "string" ? e : e?.message ?? j.message ?? j.detail ?? body;
    if (typeof msg !== "string") msg = JSON.stringify(msg);
  } catch {}
  const text = `${label}: HTTP ${status}: ${clip(scrub(msg.trim() || "no body"))}`;
  const low = body.toLowerCase();
  const wait = retryAfter(headers);
  if (/context.{0,20}(length|window)|too many tokens|prompt is too long|maximum context|input.{0,20}too long/.test(low))
    return new ProviderError("context", text, status);
  if (status === 401 || status === 403) return new ProviderError("auth", text, status);
  if (status === 402 || /insufficient_quota|quota|billing|credit|balance|usage limit|plan limit/.test(low) && status === 429)
    return new ProviderError("quota", text, status, wait);
  if (status === 429) return new ProviderError("rate", text, status, wait);
  if (status === 529 || status === 503 || /overloaded/.test(low)) return new ProviderError("overloaded", text, status, wait);
  if (status >= 500) return new ProviderError("server", text, status, wait);
  return new ProviderError("invalid", text, status);
}

// A stream that sends nothing for this long is cut and raised as a passing
// network failure, so the engine's retries take it (Codex main: 300 s,
// `stream_idle_timeout_ms`). Per endpoint `stream_idle_timeout_ms` in
// providers.toml (a slow local model), else KEEL_STREAM_IDLE_MS.
export const streamIdleMs = (own?: number) => own || Number(process.env.KEEL_STREAM_IDLE_MS) || 300_000;

// An abort signal that also fires when `touch` is not called for `ms`.
export function idleGuard(outer: AbortSignal, ms: number, label: string) {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const onAbort = () => ctl.abort(outer.reason);
  if (outer.aborted) ctl.abort(outer.reason);
  else outer.addEventListener("abort", onAbort, { once: true });
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; ctl.abort(); }, ms);
  };
  touch();
  return {
    signal: ctl.signal,
    touch,
    // The error to throw when the guard (not the caller) cut the stream.
    stalled: () => (fired && !outer.aborted ? new ProviderError("network", `${label}: no data from the model for ${Math.round(ms / 1000)} s; the stream was cut`) : null),
    done: () => { clearTimeout(timer); outer.removeEventListener("abort", onAbort); },
  };
}

export type StreamOpts = {
  label: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  format?: "sse" | "json_array";
  secrets?: string[];
  idleMs?: number;
  onHeaders?: (h: Headers) => void;
  // Called on a 401 once: a driver with a refreshable sign-in renews and
  // returns fresh headers for one resend.
  onAuthFailure?: () => Promise<Record<string, string> | null>;
};

// Opens the stream: one attempt. Retries belong to the engine, which reads
// `kind`, `retryable`, `status` and `retryAfterMs` off the thrown error. The
// only resend here is the one after a 401 that renewed a sign-in.
export async function* streamEvents(o: StreamOpts): AsyncGenerator<SseEvent> {
  const guard = idleGuard(o.signal, streamIdleMs(o.idleMs), o.label);
  try {
    yield* stream(o, guard);
  } finally {
    guard.done();
  }
}

async function* stream(o: StreamOpts, guard: ReturnType<typeof idleGuard>): AsyncGenerator<SseEvent> {
  let headers = o.headers;
  let res: Response;
  for (let renewed = false; ; renewed = true) {
    try {
      res = await fetch(o.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: o.format === "json_array" ? "application/json" : "text/event-stream", ...headers },
        body: JSON.stringify(o.body),
        signal: guard.signal,
      });
    } catch (e) {
      const stalled = guard.stalled();
      if (stalled) throw stalled;
      if (o.signal.aborted) throw new ProviderError("cancelled", "cancelled");
      throw new ProviderError("network", `${o.label}: ${scrub((e as Error).message, o.secrets)}`);
    }
    try { o.onHeaders?.(res.headers); } catch {}
    if (res.ok) break;
    const text = await res.text().catch(() => "");
    const err = classify(o.label, res.status, res.headers, scrub(text, o.secrets));
    if (err.kind === "auth" && o.onAuthFailure && !renewed) {
      const h = await o.onAuthFailure();
      if (h) { headers = h; continue; }
    }
    throw err;
  }
  const dec = o.format === "json_array" ? new JsonArrayDecoder() : new SseDecoder();
  try {
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      guard.touch();
      yield* dec.push(chunk);
    }
    yield* dec.finish();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const stalled = guard.stalled();
    if (stalled) throw stalled;
    if (o.signal.aborted) throw new ProviderError("cancelled", "cancelled");
    throw new ProviderError("network", `${o.label}: the stream broke: ${scrub((e as Error).message, o.secrets)}`);
  }
}

// A GET that returns JSON, for listings.
export async function getJson(label: string, url: string, headers: Record<string, string>, secrets: string[] = []): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ProviderError("network", `${label}: ${scrub((e as Error).message, secrets)}`);
  }
  const text = await r.text();
  if (!r.ok) throw classify(label, r.status, r.headers, scrub(text, secrets));
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("server", `${label}: the listing is not JSON`);
  }
}
