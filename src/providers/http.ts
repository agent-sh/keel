// One HTTP path for every fetch-based driver: the request, the classification
// of a failed answer, and the retry of a step that has shown nothing yet.
import { keyShaped } from "../core/conceal.ts";
import { chunks } from "../core/proc.ts";
import { EventStreamDecoder } from "./aws.ts";
import { gatewayDown } from "./unreachable.ts";
import { JsonArrayDecoder, SseDecoder, type SseEvent } from "./sse.ts";
import { keptHeaders, redactHeaders, requestId, safeUrl, wire } from "./wiretap.ts";

// "unreachable": the request never got an answer from the provider (src/providers/unreachable.ts);
// "network": an answer began and broke, or went silent.
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

// What a transport threw before any response: the provider was not reached. The
// runtime's code goes with its words when they do not say it ("Unable to connect").
export function notReached(label: string, e: unknown, secrets: string[] = []): ProviderError {
  const msg = scrub(String((e as Error)?.message ?? e), secrets);
  const code = (e as any)?.code;
  return new ProviderError("unreachable", `${label}: ${msg}${typeof code === "string" && !msg.includes(code) ? ` (${code})` : ""}`);
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
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error ?? j;
    msg = typeof e === "string" ? e : e?.message ?? j.message ?? j.detail ?? body;
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
  if (status === 401 || status === 403) return new ProviderError("auth", text, status);
  if (status === 402 || /insufficient_quota|quota|billing|credit|balance|usage limit|plan limit/.test(low) && status === 429)
    return new ProviderError("quota", text, status, wait);
  // A model the plan does not include, sent as a 429 by some plans: waiting does not help.
  if (/(does not|doesn't) (yet )?include access|not (available|included) (on|in|with) your (current )?(subscription|plan)/.test(low)) return new ProviderError("invalid", text, status);
  if (status === 429) return new ProviderError("rate", text, status, wait);
  // A gateway's or a local broker's own 502, 503 or 504: the provider was not reached.
  if (!/overloaded/.test(low) && gatewayDown(status, body)) return new ProviderError("unreachable", text, status, wait);
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
  // The provider accepted the request (a 2xx): its answer begins.
  onAnswer?: () => void;
  // Called once on a refused credential (`err`: the refusal): a driver with a
  // refreshable sign-in renews and returns fresh headers for one resend.
  onAuthFailure?: (err: ProviderError) => Promise<Record<string, string> | null>;
  // Headers that depend on the exact body bytes and the time (AWS SigV4), made per attempt.
  sign?: (body: string) => Record<string, string>;
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
    try {
      const body = JSON.stringify(o.body);
      const sent = { "content-type": "application/json", accept: o.format === "json_array" ? "application/json" : "text/event-stream", ...headers, ...o.sign?.(body) };
      if (w) Object.assign(w, { method: "POST", url: safeUrl(o.url), req_headers: redactHeaders(sent), body_bytes: Buffer.byteLength(body), transport: "http", resent_after_auth: renewed || undefined });
      res = await fetch(o.url, { method: "POST", headers: sent, body, signal: guard.signal });
    } catch (e) {
      const stalled = guard.stalled();
      if (stalled) throw stalled;
      if (o.signal.aborted) throw new ProviderError("cancelled", "cancelled");
      throw notReached(o.label, e, o.secrets);
    }
    try { o.onHeaders?.(res.headers); } catch {}
    if (w) Object.assign(w, { status: res.status, request_id: requestId(res.headers), res_headers: keptHeaders(res.headers), headers_ms: Date.now() - t0 });
    if (res.ok) break;
    const text = await res.text().catch(() => "");
    if (w) w.error_body = clip(scrub(text, o.secrets), 2000);
    const err = classify(o.label, res.status, res.headers, scrub(text, o.secrets));
    if (err.kind === "auth" && o.onAuthFailure && !renewed) {
      const h = await o.onAuthFailure(err);
      if (h) { headers = h; continue; }
    }
    throw err;
  }
  try { o.onAnswer?.(); } catch {}
  const dec = o.format === "json_array" ? new JsonArrayDecoder()
    : res.headers.get("content-type")?.includes("application/vnd.amazon.eventstream") ? new EventStreamDecoder() : new SseDecoder();
  try {
    for await (const chunk of chunks(res.body!)) {
      guard.touch();
      if (w) { w.bytes_in = (w.bytes_in ?? 0) + chunk.length; w.last_ms = Date.now(); }
      for (const ev of dec.push(chunk)) {
        if (w) { w.events = (w.events ?? 0) + 1; w.last_event = ev.event ?? /"type"\s*:\s*"([^"]{1,60})"/.exec(ev.data.slice(0, 200))?.[1]; }
        yield ev;
      }
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
  const late = (page: number) => new ProviderError("server", `${label}: the model listing took more than ${Math.round(ms / 1000)} s (it was on page ${page}); ${out.length} models were read and the list is not complete`);
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

// A GET that returns JSON, for listings. `until`: the time the whole listing
// this page belongs to must be done by; the request is cut then at the latest.
export async function getJson(label: string, url: string, headers: Record<string, string>, secrets: string[] = [], until?: number): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(until === undefined ? 30_000 : Math.max(1, Math.min(30_000, until - Date.now()))) });
  } catch (e) {
    throw notReached(label, e, secrets);
  }
  const text = await r.text();
  if (!r.ok) throw classify(label, r.status, r.headers, scrub(text, secrets));
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("server", `${label}: the listing is not JSON`);
  }
}
