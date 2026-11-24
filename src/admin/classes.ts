// What kind of failure a provider call ended with, in a few stable classes,
// so failures can be counted per provider and model over time. A driver's own
// classification (ProviderError.kind) wins; then the HTTP status; then words
// of the message. This table is the one place the classes are named; which
// failures are "unreachable" (the request could not be sent) is said in
// src/providers/unreachable.ts, and a turn waits those out instead of failing
// (src/providers/outage.ts).
import { ACCESS_WORDS, BILLING_WORDS, CREDENTIAL_WORDS, SIGNED_OUT_WORDS } from "../providers/account.ts";
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
  [/overloaded|at capacity|serviceunavailable|unable to process your request/i, "overloaded"],
  [/rate.?limit|too many requests|throttl/i, "rate_limit"],
  [/prompt is too long|context.?(window|length)|maximum context|too many tokens|input is too long|input token count|exceeds? the maximum number of tokens|exceed.{0,30}context/i, "context_overflow"],
  [BILLING_WORDS, "quota"],
  [/unauthori[sz]ed|forbidden|invalid.{0,12}(api.?key|token|credential)|expired.{0,12}token|no credentials/i, "auth"],
  [SIGNED_OUT_WORDS, "auth"],
  [/quota|payment/i, "quota"],
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
  // An account out of credit, in any 4xx (as src/providers/http.ts classify reads it), and a 429 in quota words.
  if (status === 402 || (status >= 400 && status < 500 && BILLING_WORDS.test(msg))) return "quota";
  if (status === 429) return /quota|credit|balance/i.test(msg) ? "quota" : "rate_limit";
  if (status === 529) return "overloaded";
  if (status === 401 || status === 403) return "auth";
  if (status === 413) return "context_overflow";
  if (status === 408) return "stream_drop";
  // (A 503 is the model at capacity only when its words say so, as src/providers/http.ts classify reads it.)
  if (status >= 500) return /overloaded|capacity|serviceunavailable|unable to process your request/i.test(msg) ? "overloaded" : "server";
  if (status === 400) return /too long|context|maximum/i.test(msg) ? "context_overflow" : "invalid_request";
  for (const [re, c] of WORDS) if (re.test(msg)) return c;
  return "other";
}

// The account state a failure says, when it says one: a refused or missing
// sign-in ("auth"), an account out of credit or suspended for billing
// ("billing"), or a model the account may not use ("access", that model's
// alone). Billing only in a provider's phrase or code, or the provider's own
// 402 (a web page sent as a 402 is a proxy's, not the account's word). A 403
// is the route's sign-in only in words of a credential or a sign-in: one that
// refuses a permission is the model's, or nothing of the account. A 429 in
// quota words without billing words is a plan's usage window, which passes
// by itself: not an account state.
export function accountState(e: unknown): "auth" | "billing" | "access" | undefined {
  const c = errorClass(e);
  const err = e as any;
  const status = Number(err?.status ?? err?.statusCode ?? 0);
  const msg = String(err?.message ?? err ?? "");
  if (c === "quota") {
    if (BILLING_WORDS.test(msg)) return "billing";
    return status === 402 && !PAGE.test(msg) ? "billing" : undefined;
  }
  if (c !== "auth") return ACCESS_WORDS.test(msg) && (status === 403 || !status) ? "access" : undefined;
  if (status === 403 && !CREDENTIAL_WORDS.test(msg) && !SIGNED_OUT_WORDS.test(msg)) return ACCESS_WORDS.test(msg) ? "access" : undefined;
  return "auth";
}
// A web page as a reply's body, as the stored text carries it ("P: HTTP 402: <html>...").
const PAGE = /(?:^|: )\s*<(?:!doctype|html|head|body|title)\b/i;
