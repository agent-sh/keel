// Metrics and events out to an OpenTelemetry collector, beside the traces
// (otlp.ts): OTLP/HTTP JSON to /v1/metrics and /v1/logs. Both are made from
// what the traces already hold, a finished span, plus the prompt and turn-end
// events of the bus. As with the traces, only shapes and numbers leave: a
// model's name, a tool's name, counts, durations, tokens, cost and a failure's
// class. Never prompt text, a reply, tool input or output, or a failure's
// message. A metric carries no session id (a collector keeps one series per
// attribute set); an event does, with its trace and span ids.
import { kvs, nanos, providerName } from "./otlp.ts";
import type { Span } from "./trace.ts";

// ---- metrics

// One series' value over a window: a sum, or a histogram over BOUNDS.
export type Point = { name: string; unit: string; attrs: Record<string, unknown>; start_ms: number; end_ms: number } & ({ sum: number } | { count: number; total: number; buckets: number[] });

// Seconds: the bucket boundaries the GenAI conventions give for a duration.
export const BOUNDS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];

type Series = { name: string; unit: string; attrs: Record<string, unknown>; sum?: number; count?: number; total?: number; buckets?: number[] };

// What was measured since the last collect, per metric and attribute set.
// Deltas: a collect hands the window over and starts from none.
export class Meter {
  private series = new Map<string, Series>();
  private since = Date.now();
  // Called when a window gets its first measurement.
  onFirst?: () => void;

  private at(name: string, unit: string, attrs: Record<string, unknown>): Series {
    const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null).sort(([a], [b]) => a.localeCompare(b)));
    const key = `${name}\u0000${JSON.stringify(clean)}`;
    let s = this.series.get(key);
    if (!s) {
      if (!this.series.size) this.onFirst?.();
      this.series.set(key, (s = { name, unit, attrs: clean }));
    }
    return s;
  }

  add(name: string, unit: string, attrs: Record<string, unknown>, value: number) {
    if (!(value > 0)) return;
    const s = this.at(name, unit, attrs);
    s.sum = (s.sum ?? 0) + value;
  }

  record(name: string, unit: string, attrs: Record<string, unknown>, value: number) {
    if (!(value >= 0)) return;
    const s = this.at(name, unit, attrs);
    s.buckets ??= new Array(BOUNDS.length + 1).fill(0);
    const i = BOUNDS.findIndex((b) => value <= b);
    s.buckets[i < 0 ? BOUNDS.length : i]!++;
    s.count = (s.count ?? 0) + 1;
    s.total = (s.total ?? 0) + value;
  }

  collect(now = Date.now()): Point[] {
    const out = [...this.series.values()].map((s): Point => {
      const base = { name: s.name, unit: s.unit, attrs: s.attrs, start_ms: this.since, end_ms: now };
      return s.buckets ? { ...base, count: s.count!, total: s.total!, buckets: s.buckets } : { ...base, sum: s.sum ?? 0 };
    });
    this.series.clear();
    this.since = now;
    return out;
  }
}

const seconds = (s: Span) => ((s.end_ms ?? s.start_ms) - s.start_ms) / 1000;
// ok, error or interrupted: a span still running is not measured.
const outcome = (s: Span) => (s.status === "running" ? undefined : s.status);

// A finished span as measurements.
export function spanMetrics(m: Meter, s: Span) {
  const a = s.attrs;
  const status = outcome(s);
  if (!status) return;
  if (s.kind === "turn") {
    const at = { "gen_ai.request.model": a.model, "keel.status": status };
    m.add("keel.turn.count", "{turn}", { ...at, "error.type": s.error_type }, 1);
    m.record("keel.turn.duration", "s", at, seconds(s));
  } else if (s.kind === "request") {
    const at = { "gen_ai.request.model": a.model, "gen_ai.provider.name": providerName(a.route ?? "") };
    m.add("keel.request.count", "{request}", { ...at, "keel.status": status, "error.type": s.error_type, "keel.purpose": a.shape?.purpose }, 1);
    m.record("keel.request.duration", "s", { ...at, "keel.status": status }, seconds(s));
    const u = a.result?.usage;
    if (u) for (const [type, n] of [["input", u.input], ["output", u.output], ["cache_read", u.cache_read], ["cache_write", u.cache_write]] as const) m.add("keel.token.usage", "{token}", { ...at, "gen_ai.token.type": type }, n ?? 0);
  } else if (s.kind === "tool") {
    const at = { "gen_ai.tool.name": a.tool, "keel.status": status };
    m.add("keel.tool.count", "{call}", at, 1);
    m.record("keel.tool.duration", "s", at, seconds(s));
  }
}

const DELTA = 1; // AGGREGATION_TEMPORALITY_DELTA

export function toOtlpMetrics(points: Point[], resource: Record<string, unknown>) {
  const by = new Map<string, Point[]>();
  for (const p of points) by.set(p.name, [...(by.get(p.name) ?? []), p]);
  return {
    resourceMetrics: [{
      resource: { attributes: kvs(resource) },
      scopeMetrics: [{
        scope: { name: "keel" },
        metrics: [...by].map(([name, ps]) => {
          const time = (p: Point) => ({ attributes: kvs(p.attrs), startTimeUnixNano: nanos(p.start_ms), timeUnixNano: nanos(p.end_ms) });
          return "sum" in ps[0]!
            ? { name, unit: ps[0]!.unit, sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints: ps.map((p) => ({ ...time(p), ...(Number.isInteger((p as { sum: number }).sum) ? { asInt: String((p as { sum: number }).sum) } : { asDouble: (p as { sum: number }).sum }) })) } }
            : { name, unit: ps[0]!.unit, histogram: { aggregationTemporality: DELTA, dataPoints: ps.map((p) => { const h = p as Extract<Point, { count: number }>; return { ...time(p), count: String(h.count), sum: h.total, bucketCounts: h.buckets.map(String), explicitBounds: BOUNDS }; }) } };
        }),
      }],
    }],
  };
}

// ---- events

export type LogEvent = { name: string; ts_ms: number; error?: boolean; trace_id?: string; span_id?: string; attrs: Record<string, unknown> };

// A finished span as an event. A wait (a card open, a retry's pause) is in the traces only.
export function spanEvent(s: Span): LogEvent | null {
  const a = s.attrs;
  const status = outcome(s);
  if (!status || s.kind === "wait") return null;
  const base = { ts_ms: s.end_ms ?? s.start_ms, trace_id: s.trace_id, span_id: s.span_id, error: status === "error" };
  const common = { "gen_ai.conversation.id": s.session_id, "keel.status": status, "keel.duration_ms": Math.round((s.end_ms ?? s.start_ms) - s.start_ms), "error.type": s.error_type };
  if (s.kind === "turn") return { ...base, name: "keel.turn", attrs: { ...common, "gen_ai.request.model": a.model, "keel.turn.reason": a.reason } };
  if (s.kind === "tool") return { ...base, name: "keel.tool_result", attrs: { ...common, "gen_ai.tool.name": a.tool, "gen_ai.tool.call.id": a.call_id, "keel.tool.input_bytes": a.input_bytes, "keel.tool.result_bytes": a.result_bytes } };
  const u = a.result?.usage;
  return {
    ...base, name: status === "error" ? "keel.api_error" : "keel.api_request",
    attrs: {
      ...common, "gen_ai.request.model": a.model, "gen_ai.provider.name": providerName(a.route ?? ""), "keel.attempt": a.attempt, "keel.purpose": a.shape?.purpose,
      "http.response.status_code": a.wire?.status ?? a.http_status,
      ...(u ? { "gen_ai.usage.input_tokens": (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0), "gen_ai.usage.output_tokens": u.output ?? 0, "gen_ai.usage.cache_read.input_tokens": u.cache_read ?? 0, "gen_ai.usage.cache_write.input_tokens": u.cache_write ?? 0 } : {}),
    },
  };
}

// A prompt that reached a session: that it came, from whom and how long it is. Never its words.
export function promptEvent(e: { session_id: string; ts: number; data?: any }): LogEvent {
  const d = e.data ?? {};
  return { name: "keel.user_prompt", ts_ms: e.ts, attrs: { "gen_ai.conversation.id": e.session_id, "keel.prompt.origin": d.kind ?? d.origin ?? "owner", "keel.prompt.length": String(d.text ?? "").length, "keel.prompt.files": (d.images ?? []).length } };
}

export function toOtlpLogs(events: LogEvent[], resource: Record<string, unknown>) {
  return {
    resourceLogs: [{
      resource: { attributes: kvs(resource) },
      scopeLogs: [{
        scope: { name: "keel" },
        logRecords: events.map((e) => ({
          timeUnixNano: nanos(e.ts_ms),
          observedTimeUnixNano: nanos(e.ts_ms),
          severityNumber: e.error ? 17 : 9,
          severityText: e.error ? "ERROR" : "INFO",
          eventName: e.name,
          body: { stringValue: e.name },
          attributes: kvs({ "event.name": e.name, ...e.attrs }),
          ...(e.trace_id ? { traceId: e.trace_id } : {}),
          ...(e.span_id ? { spanId: e.span_id } : {}),
        })),
      }],
    }],
  };
}

// ---- where they go

export type Signal = "metrics" | "logs";
// Whether a signal is sent: the owner's setting, else the OpenTelemetry
// selector for it (OTEL_METRICS_EXPORTER, OTEL_LOGS_EXPORTER) naming otlp.
// Off by default: a collector that takes only traces answers 404 to the rest.
export function signalOn(signal: Signal, setting: boolean | null | undefined, env: Record<string, string | undefined>): boolean {
  if (typeof setting === "boolean") return setting;
  return (env[`OTEL_${signal.toUpperCase()}_EXPORTER`] ?? "").split(",").map((s) => s.trim()).includes("otlp");
}

// A signal's address: beside the traces' when the owner set that one (its
// /v1/traces becomes /v1/metrics or /v1/logs), else the signal's own OTLP
// variable as given, else OTEL_EXPORTER_OTLP_ENDPOINT with the signal's path.
export function signalEndpoint(signal: Signal, traces: string | null | undefined, env: Record<string, string | undefined>): { url: string; from: "setting" | "env" } | null {
  if (traces) return /\/v1\/traces\/?$/.test(traces) ? { url: traces.replace(/\/v1\/traces\/?$/, `/v1/${signal}`), from: "setting" } : null;
  const own = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
  if (own) return { url: own, from: "env" };
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) return { url: env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "") + `/v1/${signal}`, from: "env" };
  return null;
}

// How long a window of measurements waits before it is sent:
// OTEL_METRIC_EXPORT_INTERVAL (milliseconds), else that variable's default.
export const metricInterval = (env: Record<string, string | undefined>) => {
  const n = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  return n > 0 ? n : 60_000;
};
