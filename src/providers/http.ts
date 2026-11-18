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

export type StreamOpts = {
  label: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  format?: "sse" | "json_array";
  secrets?: string[];
  // Called on a 401 once: a driver with a refreshable sign-in renews and
  // returns fresh headers for one resend.
  onAuthFailure?: () => Promise<Record<string, string> | null>;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); rej(new ProviderError("cancelled", "cancelled")); }, { once: true });
  });

// Opens the stream, retrying what failed before any byte of the answer
// (network, 429 within a minute, 5xx). Returns the events as they arrive.
export async function* streamEvents(o: StreamOpts): AsyncGenerator<SseEvent> {
  let headers = o.headers;
  let refreshed = false;
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(o.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: o.format === "json_array" ? "application/json" : "text/event-stream", ...headers },
        body: JSON.stringify(o.body),
        signal: o.signal,
      });
    } catch (e) {
      if (o.signal.aborted) throw new ProviderError("cancelled", "cancelled");
      const err = new ProviderError("network", `${o.label}: ${scrub((e as Error).message, o.secrets)}`);
      if (attempt < 2) { await sleep(2000 * 2 ** attempt, o.signal); continue; }
      throw err;
    }
    if (res.ok) break;
    const text = await res.text().catch(() => "");
    const err = classify(o.label, res.status, res.headers, scrub(text, o.secrets));
    if (err.kind === "auth" && o.onAuthFailure && !refreshed) {
      refreshed = true;
      const h = await o.onAuthFailure();
      if (h) { headers = h; attempt--; continue; }
    }
    const wait = err.retryAfterMs ?? 2000 * 2 ** attempt;
    if (err.retryable && attempt < 2 && wait <= 60_000) { await sleep(wait, o.signal); continue; }
    throw err;
  }
  const dec = o.format === "json_array" ? new JsonArrayDecoder() : new SseDecoder();
  try {
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) yield* dec.push(chunk);
    yield* dec.finish();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
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
