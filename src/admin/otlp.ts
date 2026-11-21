// Spans out to an OpenTelemetry collector (Phoenix, Langfuse, Jaeger, Aspire,
// any OTLP/HTTP endpoint) as OTLP JSON, with the GenAI conventions' names
// (semantic-conventions-genai, main as of 2026-11): invoke_agent per turn,
// chat per model request, execute_tool per tool call. No SDK: one POST of
// resourceSpans per batch. Only shapes and numbers leave; never prompt text,
// replies, tool input or a failure's message (the conventions make content
// opt-in): a failed span goes out as status code 2 with its error.type class.
import type { KeySource } from "../providers/creds.ts";
import type { Span } from "./trace.ts";

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: AnyValue[] } };
type KV = { key: string; value: AnyValue };

const val = (v: unknown): AnyValue | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val).filter((x): x is AnyValue => !!x) } };
  return { stringValue: String(v) };
};
const kvs = (o: Record<string, unknown>): KV[] =>
  Object.entries(o).flatMap(([key, v]) => {
    const value = val(v);
    return value ? [{ key, value }] : [];
  });

// Keel's provider ids as the conventions name the providers; others stay as they are.
const PROVIDERS: Record<string, string> = { bedrock: "aws.bedrock", anthropic: "anthropic", openai: "openai", codex: "openai", xai: "x_ai", gemini: "gcp.gemini", vertex: "gcp.vertex_ai", mistral: "mistral_ai", groq: "groq", deepseek: "deepseek" };
export const providerName = (route: string) => {
  const id = route.includes(":") ? route.slice(0, route.indexOf(":")) : route;
  return PROVIDERS[id] ?? id;
};

const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const hostOf = (u?: string) => {
  try { return u ? new URL(u).hostname : undefined; } catch { return undefined; }
};

// Attributes every span of a session carries besides its own (its experiment and arm).
let sessionTags: (sessionId: string) => Record<string, unknown> = () => ({});
export const registerSessionTags = (f: typeof sessionTags) => void (sessionTags = f);

export function spanAttrs(s: Span): Record<string, unknown> {
  const a = s.attrs;
  const common = { "gen_ai.conversation.id": s.session_id, ...(s.error_type ? { "error.type": s.error_type } : {}), ...sessionTags(s.session_id) };
  if (s.kind === "turn") {
    return { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "keel", "gen_ai.request.model": a.model, "keel.turn.reason": a.reason, "keel.parent_session": a.parent_session, ...common };
  }
  if (s.kind === "tool") {
    return { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": a.tool, "gen_ai.tool.call.id": a.call_id, "keel.tool.input_bytes": a.input_bytes, "keel.tool.result_bytes": a.result_bytes, ...common };
  }
  const u = a.result?.usage ?? {};
  const read = u.cache_read ?? 0, write = u.cache_write ?? 0;
  const w = a.wire ?? {};
  return {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": providerName(a.route ?? ""),
    "gen_ai.request.model": a.model,
    "gen_ai.request.stream": true,
    "gen_ai.request.max_tokens": a.shape?.max_tokens,
    "gen_ai.request.reasoning.level": a.shape?.effort,
    "gen_ai.response.model": a.result?.response_model,
    "gen_ai.response.finish_reasons": a.result?.stop ? [a.result.stop] : undefined,
    // Input counts every prompt token, read from the cache or written to it too.
    "gen_ai.usage.input_tokens": a.result ? (u.input ?? 0) + read + write : undefined,
    "gen_ai.usage.output_tokens": a.result ? u.output ?? 0 : undefined,
    "gen_ai.usage.cache_read.input_tokens": a.result ? read : undefined,
    "gen_ai.usage.cache_write.input_tokens": a.result ? write : undefined,
    "gen_ai.response.time_to_first_chunk": typeof a.ttft_ms === "number" ? a.ttft_ms / 1000 : undefined,
    "server.address": hostOf(w.url),
    "http.response.status_code": w.status ?? a.http_status,
    "keel.request_id": w.request_id,
    "keel.attempt": a.attempt,
    "keel.purpose": a.shape?.purpose,
    "keel.replay_of": a.replay_of,
    "keel.messages": a.shape?.messages,
    "keel.tools": a.shape?.tools,
    ...common,
  };
}

export function toOtlp(spans: Span[], resource: Record<string, unknown>) {
  return {
    resourceSpans: [{
      resource: { attributes: kvs(resource) },
      scopeSpans: [{
        scope: { name: "keel" },
        spans: spans.map((s) => ({
          traceId: s.trace_id,
          spanId: s.span_id,
          ...(s.parent_id ? { parentSpanId: s.parent_id } : {}),
          ...(Array.isArray(s.attrs.links) && s.attrs.links.length ? { links: s.attrs.links.map((l: { trace_id: string; span_id: string }) => ({ traceId: l.trace_id, spanId: l.span_id })) } : {}),
          name: s.kind === "turn" ? "invoke_agent keel" : s.name,
          kind: s.kind === "request" ? 3 : 1, // CLIENT for a call out, INTERNAL otherwise
          startTimeUnixNano: nanos(s.start_ms),
          endTimeUnixNano: nanos(s.end_ms ?? s.start_ms),
          attributes: kvs(spanAttrs(s)),
          // The failure's text stays here: it can quote a provider's reply, a path or tool output.
          status: s.status === "error" ? { code: 2 } : s.status === "ok" ? { code: 1 } : {},
        })),
      }],
    }],
  };
}

// Where spans go: the setting, else OTEL_EXPORTER_OTLP_TRACES_ENDPOINT as given,
// else OTEL_EXPORTER_OTLP_ENDPOINT with /v1/traces (the OTLP exporter rules).
export function endpointOf(setting: string | null | undefined, env: Record<string, string | undefined>): { url: string; from: "setting" | "env" } | null {
  if (setting) return { url: setting, from: "setting" };
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return { url: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, from: "env" };
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) return { url: env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "") + "/v1/traces", from: "env" };
  return null;
}

// `k=v,k2=v2`, values percent-decoded (the OTLP header variables).
export function headersOf(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (v ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// The auth headers: a reference, never the secret. The setting names an
// environment variable or a keyring entry (read like a provider key, see
// providers/creds.ts) whose value is `k=v,k2=v2`, as OTEL_EXPORTER_OTLP_HEADERS
// is; without it those variables are read. The UI sees the names only.
export type HeaderRef = { env?: string; cred?: string };
export function headerRefError(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const r = v as HeaderRef;
  if (typeof v !== "object" || Array.isArray(v) || Object.keys(v).some((k) => k !== "env" && k !== "cred")) return "otlp_headers is { env } or { cred }, or null";
  if (!!r.env === !!r.cred) return "otlp_headers names one source: an environment variable (env) or a keyring entry (cred)";
  if (r.env !== undefined && (typeof r.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.env))) return "otlp_headers.env is an environment variable name";
  if (r.cred !== undefined && (typeof r.cred !== "string" || !/^[\w.@:/-]{1,200}$/.test(r.cred))) return "otlp_headers.cred is a keyring entry name";
  return undefined;
}

export type HeaderSource = { src: KeySource; label: string; from: "setting" | "env" };
export function headerSourceOf(ref: HeaderRef | null | undefined, env: Record<string, string | undefined>): HeaderSource | null {
  if (ref?.env) return { src: { env: ref.env }, label: `$${ref.env}`, from: "setting" };
  if (ref?.cred) return { src: { cred: ref.cred }, label: `keyring entry ${ref.cred}`, from: "setting" };
  for (const n of ["OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_HEADERS"]) if (env[n]) return { src: { env: n }, label: `$${n}`, from: "env" };
  return null;
}

export type HeadersShown = { label: string; from: "setting" | "env"; names: string[]; missing: boolean };
// What reading a source gave: the headers to send and how they show (names, never values).
export function headersRead(source: Pick<HeaderSource, "label" | "from">, value: string | null): { headers: Record<string, string>; shown: HeadersShown } {
  const headers = headersOf(value ?? undefined);
  return { headers, shown: { label: source.label, from: source.from, names: Object.keys(headers), missing: !Object.keys(headers).length } };
}

const BATCH = 512;
const QUEUE = 5000;

export type ExportState = { endpoint: string | null; from: "setting" | "env" | null; headers: HeadersShown | null; sent: number; dropped: number; failures: number; last_ok_ms: number | null; last_error: string | null; queued: number };

// Batches finished spans and posts them; a failed post waits 30 s, the spans kept.
export class OtlpExporter {
  private queue: Span[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backoffUntil = 0;
  private busy = false;
  private source: HeaderSource | null = null;
  state: ExportState = { endpoint: null, from: null, headers: null, sent: 0, dropped: 0, failures: 0, last_ok_ms: null, last_error: null, queued: 0 };

  // read: a source's value (providers/creds.ts key(), which caches a keyring read a few minutes).
  constructor(private resource: Record<string, unknown>, private read: (src: KeySource) => Promise<string | null>, private onFail: (e: Error) => void) {}

  configure(ep: { url: string; from: "setting" | "env" } | null, headers: HeaderSource | null = null) {
    // The counts are the current endpoint's: another endpoint starts from none.
    if (ep?.url !== this.state.endpoint) Object.assign(this.state, { endpoint: ep?.url ?? null, from: ep?.from ?? null, sent: 0, dropped: 0, failures: 0, last_ok_ms: null, last_error: null });
    if (headers?.label !== this.source?.label) this.state.last_error = null;
    this.source = headers;
    this.state.headers = headers ? { label: headers.label, from: headers.from, names: [], missing: false } : null;
    this.backoffUntil = 0;
    if (!ep) { this.queue = []; this.state.queued = 0; }
    if (headers) void this.headers().catch(() => {});
  }

  // The headers to send now; the state shows their names.
  private async headers(): Promise<Record<string, string>> {
    const src = this.source;
    if (!src) return {};
    const r = headersRead(src, await this.read(src.src));
    if (this.source === src) this.state.headers = r.shown;
    if (r.shown.missing) throw new Error(`OTLP export headers: ${src.label} ${src.src.cred ? "has no value in the keyring" : "is not set in the daemon's environment"} (it holds k=v pairs, as OTEL_EXPORTER_OTLP_HEADERS does)`);
    return r.headers;
  }

  push(s: Span) {
    if (!this.state.endpoint) return;
    this.queue.push(s);
    if (this.queue.length > QUEUE) { this.state.dropped += this.queue.length - QUEUE; this.queue.splice(0, this.queue.length - QUEUE); }
    this.state.queued = this.queue.length;
    this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(); }, 1000);
  }

  async flush() {
    if (this.busy || !this.state.endpoint || !this.queue.length) return;
    if (Date.now() < this.backoffUntil) { this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(); }, this.backoffUntil - Date.now()); return; }
    this.busy = true;
    const batch = this.queue.splice(0, BATCH);
    try {
      const headers = await this.headers();
      const r = await fetch(this.state.endpoint, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(toOtlp(batch, this.resource)), signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`OTLP export to ${this.state.endpoint}: HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
      this.state.sent += batch.length;
      this.state.last_ok_ms = Date.now();
      this.state.last_error = null;
    } catch (e) {
      this.queue.unshift(...batch);
      this.state.failures++;
      this.state.last_error = (e as Error).message;
      this.backoffUntil = Date.now() + 30_000;
      this.onFail(e instanceof Error && e.message.startsWith("OTLP") ? e : new Error(`OTLP export to ${this.state.endpoint}: ${(e as Error).message}`));
    } finally {
      this.busy = false;
      this.state.queued = this.queue.length;
      if (this.queue.length) this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(); }, Math.max(1000, this.backoffUntil - Date.now()));
    }
  }

  stop() { clearTimeout(this.timer); }
}
