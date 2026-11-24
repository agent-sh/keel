// One HTTP path for every fetch-based driver: the request, the classification
// of a failed answer, and the retry of a step that has shown nothing yet.
import { keyShaped } from "../core/conceal.ts";
import { chunks } from "../core/proc.ts";
import { EventStreamDecoder } from "./aws.ts";
import { directBrokerOrigin, refusedOrigins } from "./broker-address.ts";
import { BILLING_WORDS } from "./account.ts";
import { gatewayDown, neverSent } from "./unreachable.ts";
import { JsonArrayDecoder, SseDecoder, type SseEvent } from "./sse.ts";
import { keptHeaders, redactHeaders, requestId, safeUrl, wire } from "./wiretap.ts";

// "unreachable": evidence the model request could not be sent (src/providers/unreachable.ts).
// "network": an ambiguous transport failure or a response that broke or went silent.
export type ErrorKind = "auth" | "rate" | "quota" | "overloaded" | "network" | "unreachable" | "invalid" | "context" | "server" | "cancelled";

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
    return this.kind === "rate" || this.kind === "overloaded" || this.kind === "network" || this.kind === "unreachable" || this.kind === "server";
  }
}

// A fetch failed before it returned headers. Only an explicit connect-stage
// error makes the request safe to resend without counting a retry.
export function fetchFailure(label: string, e: unknown, secrets: string[] = [], url?: string): ProviderError {
  const msg = scrub(String((e as Error)?.message ?? e), secrets);
  const code = (e as any)?.code ?? (e as any)?.cause?.code;
  const error = new ProviderError(neverSent(e) ? "unreachable" : "network", `${label}: ${msg}${typeof code === "string" && !msg.includes(code) ? ` (${code})` : ""}`);
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") {
    const origin = url && directBrokerOrigin(url);
    if (origin) refusedOrigins.set(error, origin);
  }
  return error;
}

// No key where the provider looks for one. The provider is not set up: nothing
// was asked and nothing was refused, so a listing treats it as a state, not a failure.
export class NoKey extends ProviderError {
  constructor(message: string) {
    super("auth", message);
  }
}

// Strip anything that looks like a credential before a message is shown or stored.
export function scrub(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length > 6) out = out.split(s).join("<redacted>");
  return keyShaped(out);
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
  let envelope = false;
  try {
    const j = JSON.parse(body);
    envelope = !!j && typeof j === "object" && !Array.isArray(j) && ("error" in j || "message" in j || "__type" in j);
    const e = Array.isArray(j) ? j[0]?.error : j?.error ?? j;
    msg = typeof e === "string" ? e : e?.message ?? j?.message ?? j?.detail ?? body;
    if (typeof msg !== "string") msg = JSON.stringify(msg);
  } catch {}
  const text = `${label}: HTTP ${status}: ${clip(scrub(msg.trim() || "no body"))}`;
  const low = body.toLowerCase();
  const wait = retryAfter(headers);
  if (/context.{0,20}(length|window)|too many tokens|prompt is too long|maximum context|input.{0,20}too long|input token count|exceeds? the maximum number of tokens|exceed.{0,20}token limit|exceed.{0,30}context/.test(low))
    return new ProviderError("context", text, status);
  // A credential that could not be read in time (a keyring or a credential
  // helper behind a local broker that did not answer under load) is a passing
  // failure of this machine, not a refusal of the credential: it is tried
  // again like a dropped connection. A refused credential says nothing of time.
  if ((status === 401 || status === 403) && /did not answer in time|timed? ?out/.test(low)) return new ProviderError("network", text, status);
  // An account out of credit or suspended for billing, in any 4xx its provider sends it as (Anthropic's is a 400, a key suspended for billing a 403),
  // in a provider's phrase or code only (src/providers/account.ts).
  if (status !== 429 && status >= 400 && status < 500 && BILLING_WORDS.test(low)) return new ProviderError("quota", text, status, wait);
  if (status === 401 || status === 403) return new ProviderError("auth", text, status);
  // A 402 is the account's when the provider sent it; a web page sent as one is a proxy's, said as it is.
  if (status === 402 && startsHtml(body)) return new ProviderError("invalid", text, status);
  if (status === 402 || /insufficient_quota|quota|billing|credit|balance|usage limit|plan limit/.test(low) && status === 429)
    return new ProviderError("quota", text, status, wait);
  // A model the plan does not include, sent as a 429 by some plans: waiting does not help.
  if (/(does not|doesn't) (yet )?include access|not (available|included) (on|in|with) your (current )?(subscription|plan)/.test(low)) return new ProviderError("invalid", text, status);
  if (status === 429) return new ProviderError("rate", text, status, wait);
  // The broker named an upstream DNS or connection failure, not just a 5xx.
  if (gatewayDown(status, body)) return new ProviderError("unreachable", text, status, wait);
  // A 503 is the model at capacity when the provider says so: its own JSON error (Bedrock's
  // documented 503 is a capacity error), or words of overload or capacity. Any other 503 (a
  // gateway's HTML page) is a server fault with the bounded retries.
  if (status === 529 || /overloaded/.test(low) || (status >= 500 && /capacity/.test(low)) || (status === 503 && (envelope || /unable to process|serviceunavailable/.test(low)))) return new ProviderError("overloaded", text, status, wait);
  if (status >= 500) return new ProviderError("server", text, status, wait);
  return new ProviderError("invalid", text, status);
}

// Only method-preserving redirects within the API origin (or an HTTP upgrade
// on the same hostname) can carry the request and its credentials.
const redirected = (r: Response) => r.status >= 300 && r.status < 400 && !!r.headers.get("location");
async function apiFetch(url: string, request: RequestInit, sign?: (url: string) => Record<string, string> | undefined) {
  for (let hops = 0; ; hops++) {
    const headers = { ...request.headers, ...sign?.(url) };
    const r = await fetch(url, { ...request, redirect: "manual", headers }).catch((e) => {
      // A later-hop refusal did not happen at the original broker address.
      if (hops) throw new ProviderError("network", "the redirected provider request did not answer");
      throw e;
    });
    if ((r.status !== 307 && r.status !== 308) || hops >= 3 || !redirected(r)) return r;
    let next: URL;
    const from = new URL(url);
    try { next = new URL(r.headers.get("location")!, from); } catch { return r; }
    const upgrade = from.protocol === "http:" && next.protocol === "https:" && from.hostname === next.hostname;
    if (next.username || next.password || (next.origin !== from.origin && !upgrade)) return r;
    void r.body?.cancel().catch(() => {});
    url = next.href;
  }
}
const html = (r: Response) => /^(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(r.headers.get("content-type") ?? "");
const mayBePortal = (r: Response) => r.ok || r.status === 401 || r.status === 403;
const intercepted = (r: Response) => r.status === 511 || redirected(r) || (mayBePortal(r) && html(r));
const portal = (label: string, r: Response) => new ProviderError("unreachable", `${label}: got a web page or redirect instead of the provider API`, r.status);
const startsHtml = (text: string) => text.trimStart().startsWith("<");

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
  const touch = (after = ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; ctl.abort(); }, after);
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
  connectWaitMs?: number;
  // The provider accepted the request (a 2xx): its answer begins.
  onAnswer?: () => void;
  // Called once on a refused credential (`err`: the refusal): a driver with a
  // refreshable sign-in renews and returns fresh headers for one resend.
  onAuthFailure?: (err: ProviderError) => Promise<Record<string, string> | null>;
  // Headers that depend on the exact body bytes and the time (AWS SigV4), made per attempt.
  sign?: (body: string, url: string) => Record<string, string>;
  // The most bytes a request body may be on this host. A larger one is not
  // sent: it is refused here as too large (a 413), as the host would answer it
  // if it said so (some answer a server error instead, every time).
  maxBodyBytes?: number;
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
  const w = wire();
  for (let renewed = false; ; renewed = true) {
    const t0 = Date.now();
    const body = JSON.stringify(o.body);
    const bytes = Buffer.byteLength(body);
    if (o.maxBodyBytes && bytes > o.maxBodyBytes) {
      const mb = (n: number) => `${Math.round(n / 100_000) / 10} MB`;
      throw new ProviderError("invalid", `${o.label}: request_too_large: the request is ${mb(bytes)}, over the ${mb(o.maxBodyBytes)} this host takes; it was not sent`, 413);
    }
    const sent = { "content-type": "application/json", accept: o.format === "json_array" ? "application/json" : "text/event-stream", ...headers };
    if (w) Object.assign(w, { method: "POST", url: safeUrl(o.url), req_headers: redactHeaders(sent), body_bytes: bytes, transport: "http", resent_after_auth: renewed || undefined });
    const headersMs = o.connectWaitMs && Math.min(o.connectWaitMs, streamIdleMs(o.idleMs));
    if (headersMs) guard.touch(headersMs);
    try {
      res = await apiFetch(o.url, { method: "POST", headers: sent, body, signal: guard.signal }, (url) => o.sign?.(body, url));
    } catch (e) {
      const stalled = guard.stalled();
      if (stalled) {
        if (headersMs) throw Object.assign(new ProviderError("network", `${o.label}: no response headers in ${Math.round(headersMs / 1000)} s`), { probeBeforeRetry: true });
        throw stalled;
      }
      if (o.signal.aborted) throw new ProviderError("cancelled", "cancelled");
      if (e instanceof ProviderError) throw e;
      throw fetchFailure(o.label, e, o.secrets, o.url);
    }
    guard.touch();
    try { o.onHeaders?.(res.headers); } catch {}
    if (w) Object.assign(w, { status: res.status, request_id: requestId(res.headers), res_headers: keptHeaders(res.headers), headers_ms: Date.now() - t0 });
    if (intercepted(res)) { void res.body?.cancel().catch(() => {}); throw portal(o.label, res); }
    if (res.ok) break;
    // A truncated error body is not a broker's explicit connect failure.
    const text = await res.text().catch(() => "");
    if (mayBePortal(res) && startsHtml(text)) throw portal(o.label, res);
    if (w) w.error_body = clip(scrub(text, o.secrets), 2000);
    const err = classify(o.label, res.status, res.headers, scrub(text, o.secrets));
    if (err.kind === "auth" && o.onAuthFailure && !renewed) {
      const h = await o.onAuthFailure(err);
      if (h) { headers = h; continue; }
    }
    throw err;
  }
  const dec = o.format === "json_array" ? new JsonArrayDecoder()
    : res.headers.get("content-type")?.includes("application/vnd.amazon.eventstream") ? new EventStreamDecoder() : new SseDecoder();
  try {
    let leading = true, answered = false;
    const bom = new TextDecoder();
    const answer = () => { if (!answered) { answered = true; try { o.onAnswer?.(); } catch {} } };
    const body = res.body;
    for await (const chunk of body ? chunks(body) : []) {
      guard.touch();
      if (leading) {
        // Empty/whitespace frames do not validate the API. Keep streaming the
        // same bytes to the decoder; never buffer a portal page in the request.
        const first = bom.decode(chunk, { stream: true }).trimStart();
        if (first.startsWith("<")) throw portal(o.label, res);
        if (first) {
          leading = false;
        }
      }
      if (w) { w.bytes_in = (w.bytes_in ?? 0) + chunk.length; w.last_ms = Date.now(); }
      for (const ev of dec.push(chunk)) {
        answer();
        if (w) { w.events = (w.events ?? 0) + 1; w.last_event = ev.event ?? /"type"\s*:\s*"([^"]{1,60})"/.exec(ev.data.slice(0, 200))?.[1]; }
        yield ev;
      }
    }
    for (const ev of dec.finish()) { answer(); yield ev; }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const stalled = guard.stalled();
    if (stalled) throw stalled;
    if (o.signal.aborted) throw new ProviderError("cancelled", "cancelled");
    throw new ProviderError("network", `${o.label}: the stream broke: ${scrub((e as Error).message, o.secrets)}`);
  }
}

// More pages than any listing has: a server whose pages never end is stopped here.
export const MAX_PAGES = 200;
// One deadline for a whole listing, however many pages it has: twice what one
// page gets. A registry refresh and a turn that waits for a model's listing
// wait on every page, so a slow paged server holds them this long, not a page's
// time for each page.
export const LISTING_MS = 60_000;

// Every page of a listing, from its first: `read` gives a page's rows and the
// cursor of the page after it (none at the end), and passes `until` to the
// request so a page that hangs is cut at the listing's deadline. A cursor the
// server gave before would read the same pages again without end, and a
// listing of more pages than MAX_PAGES is not one either: the listing fails
// and says so, as does one that passes its deadline, and the pages read so far
// are not taken for the whole list.
export async function allPages<T>(label: string, read: (cursor: string, until: number) => Promise<{ rows: T[]; next?: unknown }>, ms = LISTING_MS): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  const until = Date.now() + ms;
  const late = (page: number) => listingTimeout(`${label}: the model listing took more than ${Math.round(ms / 1000)} s (it was on page ${page}); ${out.length} models were read and the list is not complete`);
  let cursor = "";
  for (let page = 1; ; page++) {
    if (page > 1 && Date.now() >= until) throw late(page);
    const d = await read(cursor, until).catch((e) => { throw Date.now() >= until ? late(page) : e; });
    out.push(...d.rows);
    const next = d.next ? String(d.next) : "";
    if (!next) return out;
    if (seen.has(next) || page >= MAX_PAGES) {
      const why = seen.has(next) ? `page ${page} names a page cursor it gave before` : `it has more than ${MAX_PAGES} pages`;
      throw new ProviderError("server", `${label}: the model listing does not end (${why}); ${out.length} models were read and the list is not complete`);
    }
    seen.add(next);
    cursor = next;
  }
}

const listingTimeout = (message: string) => Object.assign(new ProviderError("server", message), { listingTimeout: true });

// A GET that returns JSON, for listings. `until`: the time the whole listing
// this page belongs to must be done by; the request is cut then at the latest.
export async function getJson(label: string, url: string, headers: Record<string, string>, secrets: string[] = [], until?: number, sign?: (url: string) => Record<string, string> | undefined): Promise<any> {
  let r: Response;
  const signal = AbortSignal.timeout(until === undefined ? 30_000 : Math.max(1, Math.min(30_000, until - Date.now())));
  try {
    r = await apiFetch(url, { headers: { accept: "application/json", ...headers }, signal }, sign);
  } catch (e) {
    if (signal.aborted) throw listingTimeout(`${label}: the listing timed out`);
    if (e instanceof ProviderError) throw e;
    throw fetchFailure(label, e, secrets, url);
  }
  if (intercepted(r)) { void r.body?.cancel().catch(() => {}); throw portal(label, r); }
  const text = await r.text().catch((e) => {
    if (signal.aborted) throw listingTimeout(`${label}: the listing timed out`);
    throw new ProviderError("network", `${label}: the listing response broke: ${scrub(String((e as Error)?.message ?? e), secrets)}`);
  });
  if (mayBePortal(r) && startsHtml(text)) throw portal(label, r);
  if (!r.ok) throw classify(label, r.status, r.headers, scrub(text, secrets));
  try {
    const result = JSON.parse(text);
    if (result === null || typeof result !== "object") throw new Error("not a listing");
    return result;
  } catch {
    throw new ProviderError("server", `${label}: the listing is not JSON`);
  }
}
