// What kind of failure a provider call ended with, in a few stable classes,
// so failures can be counted per provider and model over time. A driver's own
// classification (ProviderError.kind) wins; then the HTTP status; then words
// of the message. This table is the one place the classes are named; which
// failures are "unreachable" (the request could not be sent) is said in
// src/providers/unreachable.ts, and a turn waits those out instead of failing
// (src/providers/outage.ts).
import { imageRefusal } from "../providers/image-limits.ts";
import { unreachable, unreachableText } from "../providers/unreachable.ts";

export const ERROR_CLASSES = [
  "rate_limit", "overloaded", "server", "stream_drop", "unreachable", "context_overflow", "auth", "quota", "refusal", "image", "invalid_request", "other",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

const KIND: Record<string, ErrorClass> = {
  rate: "rate_limit", overloaded: "overloaded", server: "server", network: "stream_drop", unreachable: "unreachable", context: "context_overflow",
  auth: "auth", quota: "quota", invalid: "invalid_request",
};

const WORDS: [RegExp, ErrorClass][] = [
  [/overloaded|serviceunavailable|unable to process your request/i, "overloaded"],
  [/rate.?limit|too many requests|throttl/i, "rate_limit"],
  [/prompt is too long|context.?(window|length)|maximum context|too many tokens|input is too long|input token count|exceeds? the maximum number of tokens|exceed.{0,30}context/i, "context_overflow"],
  [/unauthori[sz]ed|forbidden|invalid.{0,12}(api.?key|token|credential)|expired.{0,12}token|no credentials/i, "auth"],
  [/quota|billing|insufficient.{0,10}(credit|balance|funds)|payment/i, "quota"],
  [/econnreset|etimedout|socket|terminated|stream (ended|closed|broke|went silent)|premature close|fetch failed|network|timed? ?out/i, "stream_drop"],
  [/internal server error|service unavailable|bad gateway/i, "server"],
];

// The words of a connection that never opened: a refused or unresolved address, a socket that could
// not be opened (Bun: "Unable to connect. Is the computer able to access the url?").
const NEVER_OPENED = /\b(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ConnectionRefused|FailedToOpenSocket)\b|\bUnable to connect\b|getaddrinfo/i;

// The class of a failed request from the text it is stored as (a turn's error, a retry's message):
// an "HTTP 429: ..." opening, or one after the provider's name ("Amazon Bedrock: HTTP 503: ..."), gives its status.
export function classOfText(message: string): ErrorClass {
  const status = Number(/^(?:[^:\n]{1,60}: )?HTTP (\d{3}):/.exec(message)?.[1] ?? 0);
  return errorClass({ status, message }) ?? "other";
}

// null: not a failure of the call (a driver said it was cancelled). Whether
// the owner stopped it is the caller's signal, checked before this: an abort
// while that signal is live came from the transport (a deadline, a dropped
// connection) or from nowhere known, and is counted as a dropped stream.
export function errorClass(e: unknown): ErrorClass | null {
  const err = e as any;
  if (!err || err.kind === "cancelled") return null;
  // A request refused over one of its images (a size limit, a format, bytes
  // the provider could not decode): told from the other invalid requests.
  if (imageRefusal(e)) return "image";
  // The request could not be sent (the driver said so, or a stored message does).
  if (unreachable(e) || (!err.kind && !err.status && !err.statusCode && unreachableText(String(err.message ?? err ?? "")))) return "unreachable";
  // A transport failure the driver could not place, whose words are those of a connection that never
  // opened: no stream was open to drop. Said as what the failure box says, for display and counting
  // only; whether a request may be sent again uncounted is the driver's proof alone.
  if ((err.kind === "network" || !err.kind) && !err.status && NEVER_OPENED.test(String(err.message ?? err ?? ""))) return "unreachable";
  if (typeof err.kind === "string" && KIND[err.kind]) return KIND[err.kind]!;
  if (err.name === "AbortError" || err.name === "TimeoutError") return "stream_drop";
  const status = Number(err.status ?? err.statusCode ?? 0);
  const msg = String(err.message ?? err ?? "");
  if (status === 429) return "rate_limit";
  // (A 503 is the provider at capacity, as its drivers read it: src/providers/http.ts classify.)
  if (status === 529 || status === 503) return "overloaded";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 413) return "context_overflow";
  if (status === 408) return "stream_drop";
  if (status >= 500) return /overloaded/i.test(msg) ? "overloaded" : "server";
  if (status === 400) return /too long|context|maximum/i.test(msg) ? "context_overflow" : "invalid_request";
  for (const [re, c] of WORDS) if (re.test(msg)) return c;
  return "other";
}
