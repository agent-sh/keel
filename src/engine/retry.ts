import { zonedClock } from "../core/clock.ts";
import { unreachable } from "../providers/unreachable.ts";
import { OUTAGE } from "../providers/outage.ts";

// Provider calls that fail for a passing reason (rate limit, overload, a 5xx,
// a dropped stream) are tried again with exponential backoff. Anything else
// (a bad request, auth, a bug) fails at once. The numbers follow the leading
// harnesses (see research/loop-and-turns.md): base 0.5 s doubling to a 32 s cap,
// 10 attempts, and a provider's retry-after wins when it sends one.
export const RETRY = { max: 10, baseMs: 500, capMs: 32_000 };
// The longest a turn waits for one retry. A provider that asks for longer is
// not retried sooner than it said: the turn ends with the time it named.
export const RETRY_WAIT_MAX_MS = Number(process.env.KEEL_RETRY_WAIT_MAX_MS) || 5 * 60_000;

// An actionable provider failure, not a server fault or a retry of its own.
export class RetryTooLong extends Error {
  readonly span_id?: string;

  // When the provider said the wait is over: an owner's session continues by itself then.
  readonly retryAt: number;

  constructor(cause: unknown, retryAt: number) {
    const time = zonedClock(retryAt);
    super(`${errorText(cause)} (the provider asked to wait until ${time}, longer than a turn waits; resume after that)`, { cause });
    this.name = "RetryTooLong";
    this.retryAt = retryAt;
    const span = (cause as { span_id?: unknown } | null)?.span_id;
    if (typeof span === "string") this.span_id = span;
  }
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const PASSING = /overloaded|rate.?limit|terminated|econnreset|econnrefused|etimedout|socket|network|stream (ended|closed)|premature close|fetch failed|timed? ?out|internal server error|service unavailable/i;

export function retryable(e: unknown): boolean {
  const err = e as any;
  if (!err || err.name === "AbortError") return false;
  // A provider that was not reached is tried again; the engine waits for it without counting (src/providers/outage.ts).
  if (unreachable(e)) return true;
  // A driver's own classification (ProviderError) wins when it gives one.
  if (typeof err.kind === "string" && typeof err.retryable === "boolean") return err.retryable;
  const status = Number(err.status ?? err.statusCode ?? 0);
  if (status) return RETRY_STATUS.has(status) || status >= 500;
  if (/APIConnection(Timeout)?Error/.test(err.constructor?.name ?? "") || /APIConnection/.test(err.name ?? "")) return true;
  const type = err.error?.error?.type ?? err.error?.type ?? err.type;
  if (type === "overloaded_error" || type === "rate_limit_error" || type === "api_error") return true;
  return PASSING.test(String(err.message ?? ""));
}

// Milliseconds the provider asked us to wait, if it said.
export function retryAfterMs(e: unknown): number | undefined {
  const own = (e as any)?.retryAfterMs;
  if (typeof own === "number" && own >= 0) return own;
  const h = (e as any)?.headers;
  const get = (k: string) => (typeof h?.get === "function" ? h.get(k) : h?.[k]) as string | undefined;
  const ms = Number(get?.("retry-after-ms"));
  if (ms > 0) return ms;
  const s = get?.("retry-after");
  if (!s) return undefined;
  const n = Number(s);
  if (n >= 0 && Number.isFinite(n)) return n * 1000;
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// An answer that the model is at capacity: Anthropic's 529 overloaded_error, an HTTP 503,
// Bedrock's serviceUnavailableException (its documentation: "a transient capacity error",
// to be retried with exponential backoff and jitter). It is neither an outage (the provider
// answered, and its other models may have room) nor a broken reply: the turn waits it out,
// past the counted retries, the backoff growing to RETRY_WAIT_MAX_MS. That is Claude Code's
// way for unattended sessions (CLAUDE_CODE_RETRY_WATCHDOG retries 529 without a count, backing
// off up to five minutes); most of Keel's turns are agents' and run with nobody watching.
export function overloaded(e: unknown): boolean {
  const err = e as any;
  if (!err || unreachable(e)) return false;
  if (typeof err.kind === "string") return err.kind === "overloaded";
  // (A stream's error event keeps the API's own error as `wireError`: src/providers/wires/anthropic.ts.)
  const type = err.wireError?.type ?? err.error?.error?.type ?? err.error?.type ?? err.type;
  return type === "overloaded_error" || Number(err.status ?? 0) === 529;
}
// What an overloaded model's answers share as one Errors row (ErrorPlace.group, carried on the
// error as `group`): the model, not the words, which differ by the path each answer came by
// (a stream's exception, an HTTP status) though they are one cause.
export const overloadedGroup = (model: string) => `overloaded: ${model}`;
// How long a turn waits out an overloaded model: as long as a provider that cannot be reached
// is waited for (a week, src/providers/outage.ts), after which it will not have room either.
export const capacityMaxMs = () => OUTAGE.maxMs;
// Whether a failed request is sent again: a passing failure within the counted retries, or, for
// a request that waits out an overloaded model (`since`: its first overloaded answer), an
// overloaded answer within capacityMaxMs of that.
export function retriesLeft(e: unknown, attempt: number, since?: number, now = Date.now()): boolean {
  if (!retryable(e)) return false;
  if (since !== undefined && overloaded(e)) return now - since < capacityMaxMs();
  return attempt + 1 < RETRY.max;
}

// What decides whether a turn whose model answers that it is overloaded goes on on the session's
// fallback model, for the rest of that turn (the next turn tries its own model first).
// `tries`: the overloaded answers this request already waited after. `overloadedMs`: how long the
// model has answered overloaded, as the daemon saw it across its sessions (the first such answer
// of the overload still going on). `nextWaitMs`: the wait before the next try. `cacheMs`: how long
// the provider keeps the session's cache on this model (none: the wire keeps none Keel can count
// on). `cachedAt`: when a request last read or wrote that cache (0: never).
export type MoveFacts = { tries: number; overloadedMs: number; nextWaitMs: number; asked?: boolean; cacheMs?: number; cachedAt: number; now: number };
// Why it moves: the provider asked for a wait longer than a turn waits (the turn would end), the
// overload is an outage by the daemon's measure, or the counted retries are spent and the model's
// cache would be cold by the next try anyway.
export type MoveWhy = "asked" | "outage" | "cold";

// Moving costs one cold cache: the fallback reads none of the session's context, so the whole
// of it is written there once, and once more on the session's model at the next turn when its
// own cache expired meanwhile. Waiting costs only time. So:
// - a burst within the counted retries is waited out on the warm cache, as before: the bursts the
//   providers send heal within seconds (a burst of twelve answers, test/e2e/provider-failures);
// - past the counted retries (where Claude Code moves to its fallback, after its ten retries), it
//   moves when the cache it would keep is cold by the next try: nothing is lost by moving then;
// - an overload that has lasted OUTAGE.alertMs moves whatever the cache: five minutes is where
//   the daemon calls a provider's interruption an outage and tells the owner (src/providers/outage.ts),
//   and the backoff past it is minutes a try, so a warm cache is not worth holding the work for;
// - a wait the provider asked for, longer than a turn waits, would end the turn: it moves.
export function movesToFallback(f: MoveFacts): MoveWhy | undefined {
  if (f.asked && f.nextWaitMs > RETRY_WAIT_MAX_MS) return "asked";
  if (f.overloadedMs >= OUTAGE.alertMs) return "outage";
  if (f.tries < RETRY.max - 1) return undefined;
  if (!f.cacheMs || !f.cachedAt || f.now + f.nextWaitMs - f.cachedAt >= f.cacheMs) return "cold";
  return undefined;
}

// The wait before try `attempt + 1`: what the provider asked for, else 0.5 s doubling with a
// quarter's jitter either way, to 32 s; an overloaded model's grows on, and never past
// RETRY_WAIT_MAX_MS with its jitter (a wait over that is only ever one the provider asked for).
export function backoffMs(attempt: number, e?: unknown): number {
  const asked = retryAfterMs(e);
  if (asked !== undefined) return asked;
  const full = overloaded(e);
  const exp = Math.min(full ? RETRY_WAIT_MAX_MS : RETRY.capMs, RETRY.baseMs * 2 ** attempt);
  const ms = Math.round(exp * (0.75 + Math.random() * 0.5));
  return full ? Math.min(ms, RETRY_WAIT_MAX_MS) : ms;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function errorText(e: unknown): string {
  const err = e as any;
  const msg = String(err?.error?.error?.message ?? err?.message ?? String(e));
  // A provider's failure already names its status ("Amazon Bedrock: HTTP 503: ..."): said once.
  const status = err?.status && !msg.includes(`HTTP ${err.status}`) ? `HTTP ${err.status}: ` : "";
  return `${status}${msg}`.slice(0, 300);
}
