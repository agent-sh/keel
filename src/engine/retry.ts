import { zonedClock } from "../core/clock.ts";
import { unreachable } from "../providers/unreachable.ts";

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

export function backoffMs(attempt: number, e?: unknown): number {
  const asked = retryAfterMs(e);
  if (asked !== undefined) return asked;
  const exp = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** attempt);
  return Math.round(exp * (0.75 + Math.random() * 0.5));
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
  const status = err?.status ? `HTTP ${err.status}: ` : "";
  const msg = err?.error?.error?.message ?? err?.message ?? String(e);
  return `${status}${msg}`.slice(0, 300);
}
