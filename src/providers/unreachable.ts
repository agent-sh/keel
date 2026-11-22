// A provider that cannot be reached: the one place that says which failures
// are that. (The wait they get is ./outage.ts.) This file imports nothing and
// reads nothing of the machine: the page loads it too, through the failure
// classes (src/admin/classes.ts).
//
// UNREACHABLE: the request never got an answer from the provider. A DNS
// failure, a connection refused, reset or timed out, a TLS failure, a socket
// closed before any response byte, a machine with no route, and a gateway or
// a local broker answering 502, 503 or 504 with a body of its own. No token
// was spent on such a request, so it is safe to send again any number of
// times, and it is not counted against the retries of a turn: the turn waits
// until the provider answers.
//
// Not that: a stream that broke after it began (the counted retries send the
// request again; when the retry cannot connect it is this), a status the
// provider itself sent (429, 500, 529: counted retries), and what waiting
// never heals (a 4xx, a refused credential, a refusal, a context over the
// window).

// What a transport says when it could not connect, by code and in words.
const TRANSPORT =
  /\b(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|EPIPE|EADDRNOTAVAIL|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|ConnectTimeoutError|CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_[A-Z_]+)\b|getaddrinfo|name resolution|could not (resolve|reach|connect)|unable to connect|connection (refused|reset|timed out|closed|failed|error)|connect timeout|socket connection was closed|socket hang up|network is unreachable|no route to host|fetch failed|failed to open socket|\boffline\b|bad gateway|gateway time-?out|upstream (connect|request) (error|timeout)|tls (handshake|connection|alert)|ssl (handshake|routines)|certificate|handshake (failed|timed out)/i;
// The request was answered and the answer then broke: not this class.
const BEGAN = /the stream (broke|ended|was cut)|during the answer|no data from the model|stream (ended|closed)|premature close/i;
// A class a driver gave that says the provider answered.
const ANSWERED_KINDS = new Set(["auth", "rate", "quota", "invalid", "context", "cancelled"]);

// A 502, 503 or 504 that a gateway, a proxy or a local broker made itself: it
// has no body, an HTML page, plain words, or a body that names a transport
// failure. A provider's own JSON error (an overload, a server fault) is not this.
export function gatewayDown(status: number, body: string): boolean {
  if (status !== 502 && status !== 503 && status !== 504) return false;
  const t = body.trim();
  if (!t || t.startsWith("<") || TRANSPORT.test(t)) return true;
  try { JSON.parse(t); return false; } catch { return true; }
}

// Whether a failed provider call never got an answer from the provider.
export function unreachable(e: unknown): boolean {
  const err = e as any;
  if (!err || err.name === "AbortError") return false;
  if (err.kind === "unreachable") return true;
  if (typeof err.kind === "string" && ANSWERED_KINDS.has(err.kind)) return false;
  // A driver that gave a class and a status read the body: it said what it is.
  const status = Number(err.status ?? err.statusCode ?? 0);
  if (status) return false;
  const msg = String(err.message ?? err ?? "");
  if (BEGAN.test(msg)) return false;
  return /APIConnection/.test(String(err.name ?? "")) || /APIConnection/.test(String(err.constructor?.name ?? "")) || TRANSPORT.test(msg);
}

// A request that provably never left this machine: no address for the name, no
// connection, no route. (A reset or a closed socket may have come after the
// request was read.) For a call that must not be sent twice, such as the
// renewal of a single-use token.
const NEVER_SENT = /\b(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ConnectionRefused|FailedToOpenSocket)\b|getaddrinfo|unable to connect|connection refused|network is unreachable|no route to host/i;
export const neverSent = (e: unknown) => NEVER_SENT.test(`${(e as any)?.code ?? ""} ${(e as any)?.message ?? e ?? ""}`);

// The same from the words alone (a failure read back from where it was stored).
export const unreachableText = (message: string) => !BEGAN.test(message) && TRANSPORT.test(message.replace(/HTTP (502|503|504): /, ""));
