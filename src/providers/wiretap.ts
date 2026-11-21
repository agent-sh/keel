// What the HTTP layer saw of one model request, for its trace: the endpoint,
// the status, the provider's request id and a few headers, how long until the
// headers came, how much streamed and what the last event was. The engine
// opens a scope around each provider call; drivers need not know.
import { AsyncLocalStorage } from "node:async_hooks";

export type Wire = {
  method?: string;
  url?: string;
  status?: number;
  request_id?: string;
  req_headers?: Record<string, string>;
  res_headers?: Record<string, string>;
  body_bytes?: number;
  headers_ms?: number;
  events?: number;
  bytes_in?: number;
  last_event?: string;
  error_body?: string;
  resent_after_auth?: boolean;
  transport?: string;
  // What the projection repaired so the wire takes this request (the kinds, src/providers/project.ts).
  repairs?: string[];
};

export const wireScope = new AsyncLocalStorage<Wire>();
export const wire = (): Wire | undefined => wireScope.getStore();
// The current attempt's record per request object (the measuring hooks read it).
export const wireOf = new WeakMap<object, Wire>();

// Header names that carry the provider's id for one request, most specific first.
const ID_HEADERS = ["request-id", "x-request-id", "x-amzn-requestid", "x-amz-request-id", "x-goog-request-id", "openai-request-id", "x-trace-id", "cf-ray"];
// Answer headers worth keeping for a diagnosis; everything else is dropped.
const KEEP = /^(content-type|retry-after(-ms)?|x-ratelimit-.*|anthropic-ratelimit-.*|x-should-retry|openai-processing-ms|openai-model|x-amzn-errortype|x-amzn-bedrock-.*|server|via|date)$/i;
// A header whose name says it carries a credential is kept by name only.
const SECRET_NAME = /auth|key|token|secret|cookie|signature|credential|session|password/i;

export function requestId(h: Headers): string | undefined {
  for (const n of ID_HEADERS) {
    const v = h.get(n);
    if (v) return v;
  }
}

export function keptHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { if (KEEP.test(k)) out[k.toLowerCase()] = v.slice(0, 200); });
  return out;
}

// The request's headers with every credential replaced by its length.
export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = SECRET_NAME.test(k) ? `${v.length} chars, redacted` : v.slice(0, 200);
  return out;
}

// The endpoint without its query (a key may ride there) or credentials in the authority.
export function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    // A long run of letters and digits in the path is a token (a local broker's path key), not a name.
    const path = x.pathname.split("/").map((p) => (/^[A-Za-z0-9_-]{20,}$/.test(p) && /\d/.test(p) && /[A-Za-z]/.test(p) && !/^[a-z]+(-[a-z0-9]+)+$/.test(p) ? "[redacted]" : p)).join("/");
    return `${x.protocol}//${x.host}${path}${x.search ? "?[query]" : ""}`;
  } catch {
    return "[unparsed url]";
  }
}
