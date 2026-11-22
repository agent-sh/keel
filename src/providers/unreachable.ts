// Only evidence that the model request could not be sent earns an uncounted
// outage wait. No headers is not evidence: a reset or timeout can lose an
// answer after the upstream accepted the request. This module also loads in
// the browser, through the failure classes, so it has no imports.
const CONNECT_CODES = /^(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL|ConnectionRefused|FailedToOpenSocket|UND_ERR_CONNECT_TIMEOUT|ConnectTimeoutError)$/;

// Only call this at the transport boundary, not on a provider's message or
// on a stream error. Some fetch implementations put the code on the cause.
export function neverSent(e: unknown): boolean {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = err?.code ?? err?.cause?.code;
  return typeof code === "string" && CONNECT_CODES.test(code);
}

// A broker explicitly says it could not resolve or connect to the upstream.
// Do not infer that from the HTTP status, HTML, debug fields or a reset.
const BROKER_CONNECT = /^the (?:[\w-]+ )*broker could not (?:reach|connect to) \S+:\s*(?:getaddrinfo\s+|connect\s+)?(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b/i;
export function gatewayDown(status: number, body: string): boolean {
  if (status !== 502 && status !== 503 && status !== 504) return false;
  try {
    const json = JSON.parse(body);
    // A provider error envelope is not transport evidence. The broker's
    // explicit top-level message is a separate wire shape.
    return !!json && typeof json === "object" && !Array.isArray(json) && !("error" in json) && !("type" in json) &&
      typeof json.message === "string" && BROKER_CONNECT.test(json.message.trim());
  } catch {
    return BROKER_CONNECT.test(body.trim());
  }
}

// A driver proved it at the transport boundary. Raw exception text and SDK
// connection error names can include post-send failures, so neither is proof.
export function unreachable(e: unknown): boolean {
  return (e as { kind?: unknown } | null)?.kind === "unreachable";
}

// For display only, when a stored error has no structured class or status.
export function unreachableText(message: string): boolean {
  const status = /\bHTTP (502|503|504):\s*(.*)/.exec(message);
  if (status) return gatewayDown(Number(status[1]), status[2]!);
  return /^(?:[^:]+:\s*)?getaddrinfo\s+(EAI_AGAIN|ENOTFOUND)\b/i.test(message);
}
