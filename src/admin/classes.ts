// What kind of failure a provider call ended with, in a few stable classes,
// so failures can be counted per provider and model over time. A driver's own
// classification (ProviderError.kind) wins; then the HTTP status; then words
// of the message.
export const ERROR_CLASSES = [
  "rate_limit", "overloaded", "server", "stream_drop", "context_overflow", "auth", "quota", "refusal", "invalid_request", "other",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

const KIND: Record<string, ErrorClass> = {
  rate: "rate_limit", overloaded: "overloaded", server: "server", network: "stream_drop", context: "context_overflow",
  auth: "auth", quota: "quota", invalid: "invalid_request",
};

const WORDS: [RegExp, ErrorClass][] = [
  [/overloaded/i, "overloaded"],
  [/rate.?limit|too many requests|throttl/i, "rate_limit"],
  [/prompt is too long|context.?(window|length)|maximum context|too many tokens|input is too long/i, "context_overflow"],
  [/unauthori[sz]ed|forbidden|invalid.{0,12}(api.?key|token|credential)|expired.{0,12}token|no credentials/i, "auth"],
  [/quota|billing|insufficient.{0,10}(credit|balance|funds)|payment/i, "quota"],
  [/econnreset|econnrefused|etimedout|socket|terminated|stream (ended|closed|broke|went silent)|premature close|fetch failed|network|timed? ?out/i, "stream_drop"],
  [/internal server error|service unavailable|bad gateway/i, "server"],
];

// null: not a failure of the call (a driver said it was cancelled). Whether
// the owner stopped it is the caller's signal, checked before this: an abort
// while that signal is live came from the transport (a deadline, a dropped
// connection) or from nowhere known, and is counted as a dropped stream.
export function errorClass(e: unknown): ErrorClass | null {
  const err = e as any;
  if (!err || err.kind === "cancelled") return null;
  if (typeof err.kind === "string" && KIND[err.kind]) return KIND[err.kind]!;
  if (err.name === "AbortError" || err.name === "TimeoutError") return "stream_drop";
  const status = Number(err.status ?? err.statusCode ?? 0);
  const msg = String(err.message ?? err ?? "");
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 413) return "context_overflow";
  if (status === 408) return "stream_drop";
  if (status >= 500) return /overloaded/i.test(msg) ? "overloaded" : "server";
  if (status === 400) return /too long|context|maximum/i.test(msg) ? "context_overflow" : "invalid_request";
  for (const [re, c] of WORDS) if (re.test(msg)) return c;
  return "other";
}
