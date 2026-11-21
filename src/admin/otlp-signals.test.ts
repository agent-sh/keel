import { expect, test } from "bun:test";
import { OtlpExporter } from "./otlp.ts";
import { BOUNDS, Meter, metricInterval, promptEvent, signalEndpoint, signalOn, spanEvent, spanMetrics, toOtlpLogs, toOtlpMetrics, type Point } from "./otlp-signals.ts";
import type { Span } from "./trace.ts";

const base = { session_id: "s1", error_id: null, replayable: false, trace_id: "0".repeat(16) + "a".repeat(16), parent_id: null } as const;
const req = (o: Partial<Span> = {}): Span => ({
  ...base, span_id: "bbbbbbbbbbbbbbbb", kind: "request", name: "chat m", start_ms: 1_700_000_000_000, end_ms: 1_700_000_001_500, status: "ok", error: null, error_type: null,
  attrs: { route: "bedrock:m", model: "m", attempt: 1, shape: { purpose: "turn" }, wire: { status: 200 }, result: { usage: { input: 4, output: 7, cache_read: 100, cache_write: 0 } } }, ...o,
});
const failed = req({ span_id: "cccccccccccccccc", status: "error", error: "HTTP 402: no credit for CANARY-acct-7731 at /home/owner/work", error_type: "quota", attrs: { route: "bedrock:m", model: "m", attempt: 2, http_status: 402, shape: { purpose: "turn" } } });
const tool: Span = { ...base, span_id: "dddddddddddddddd", kind: "tool", name: "execute_tool Bash", start_ms: 1_700_000_001_000, end_ms: 1_700_000_001_030, status: "ok", error: null, error_type: null, attrs: { tool: "Bash", call_id: "c1", input_bytes: 20, result_bytes: 5 } };

test("finished spans add up to delta sums and duration histograms, and a collect starts the next window from none", () => {
  const m = new Meter();
  let first = 0;
  m.onFirst = () => first++;
  for (const s of [req(), req(), failed, tool, req({ status: "running", end_ms: null })]) spanMetrics(m, s);
  const out = toOtlpMetrics(m.collect(1_700_000_010_000), { "service.name": "keel" });
  const metrics = out.resourceMetrics[0]!.scopeMetrics[0]!.metrics as any[];
  const attr = (p: any, k: string) => p.attributes.find((a: any) => a.key === k)?.value?.stringValue;
  const points = (name: string) => metrics.find((x) => x.name === name)?.[name.endsWith("duration") ? "histogram" : "sum"].dataPoints as any[];
  expect(metrics.map((x) => x.name).sort()).toEqual(["keel.request.count", "keel.request.duration", "keel.token.usage", "keel.tool.count", "keel.tool.duration"]);
  // Two that went well and one that failed, each its own series; the running one is not counted.
  expect(points("keel.request.count").map((p) => [attr(p, "keel.status"), attr(p, "error.type") ?? null, attr(p, "gen_ai.provider.name"), p.asInt])).toEqual([["ok", null, "aws.bedrock", "2"], ["error", "quota", "aws.bedrock", "1"]]);
  // Tokens by kind; a kind with none has no point.
  expect(points("keel.token.usage").map((p) => [attr(p, "gen_ai.token.type"), p.asInt])).toEqual([["input", "8"], ["output", "14"], ["cache_read", "200"]]);
  const d = points("keel.request.duration").find((p) => attr(p, "keel.status") === "ok");
  expect([d.count, d.sum, d.explicitBounds, d.bucketCounts[BOUNDS.findIndex((b) => 1.5 <= b)], d.bucketCounts.length]).toEqual(["2", 3, BOUNDS, "2", BOUNDS.length + 1]);
  expect([metrics[0].sum.aggregationTemporality, metrics[0].sum.isMonotonic, d.timeUnixNano]).toEqual([1, true, "1700000010000000000"]);
  // No session, no text of the failure: a collector keeps one series per attribute set.
  for (const word of ["s1", "CANARY", "no credit"]) expect(JSON.stringify(out)).not.toContain(word);
  expect([first, m.collect().length]).toEqual([1, 0]);
  spanMetrics(m, tool);
  expect([first, m.collect().map((p) => p.name)]).toEqual([2, ["keel.tool.count", "keel.tool.duration"]]);
});

test("a span and a prompt go out as events that name what happened and hold none of its words", () => {
  const prompt = promptEvent({ session_id: "s1", ts: 1_700_000_000_000, data: { text: "fix the CANARY-acct-7731 bug", images: [{}] } });
  const out = toOtlpLogs([prompt, spanEvent(req())!, spanEvent(failed)!, spanEvent(tool)!], { "service.name": "keel" });
  const [p, ok, err, t] = out.resourceLogs[0]!.scopeLogs[0]!.logRecords as any[];
  const attr = (r: any, k: string) => { const v = r.attributes.find((a: any) => a.key === k)?.value; return v?.stringValue ?? v?.intValue; };
  expect([p.eventName, attr(p, "keel.prompt.length"), attr(p, "keel.prompt.files"), attr(p, "keel.prompt.origin"), p.traceId]).toEqual(["keel.user_prompt", "28", "1", "owner", undefined]);
  expect([ok.eventName, ok.severityText, ok.traceId, ok.spanId, attr(ok, "gen_ai.usage.input_tokens"), attr(ok, "keel.duration_ms"), attr(ok, "gen_ai.conversation.id")]).toEqual(["keel.api_request", "INFO", base.trace_id, "bbbbbbbbbbbbbbbb", "104", "1500", "s1"]);
  expect([err.eventName, err.severityNumber, attr(err, "error.type"), attr(err, "http.response.status_code")]).toEqual(["keel.api_error", 17, "quota", "402"]);
  expect([t.eventName, attr(t, "gen_ai.tool.name"), attr(t, "keel.tool.result_bytes")]).toEqual(["keel.tool_result", "Bash", "5"]);
  for (const word of ["CANARY", "no credit", "fix the"]) expect(JSON.stringify(out)).not.toContain(word);
  // A wait and a span still running are in the traces only.
  expect([spanEvent({ ...tool, kind: "wait" }), spanEvent(req({ status: "running" }))]).toEqual([null, null]);
});

test("a signal is off until the owner or the OpenTelemetry selector turns it on, and goes beside the traces", () => {
  expect([signalOn("metrics", null, {}), signalOn("metrics", true, {}), signalOn("logs", null, { OTEL_LOGS_EXPORTER: "console, otlp" }), signalOn("logs", false, { OTEL_LOGS_EXPORTER: "otlp" }), signalOn("metrics", null, { OTEL_LOGS_EXPORTER: "otlp" })]).toEqual([false, true, true, false, false]);
  expect(signalEndpoint("metrics", "http://c:6006/v1/traces", { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://other/m" })).toEqual({ url: "http://c:6006/v1/metrics", from: "setting" });
  expect(signalEndpoint("logs", "https://c/api/public/otel/v1/traces/", {})).toEqual({ url: "https://c/api/public/otel/v1/logs", from: "setting" });
  // A traces address of another shape names no place for the others: nothing is guessed.
  expect(signalEndpoint("logs", "http://c/ingest", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://e:4318" })).toBeNull();
  expect(signalEndpoint("logs", null, { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://e/own", OTEL_EXPORTER_OTLP_ENDPOINT: "http://e:4318" })).toEqual({ url: "http://e/own", from: "env" });
  expect(signalEndpoint("metrics", null, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://e:4318/" })).toEqual({ url: "http://e:4318/v1/metrics", from: "env" });
  expect(signalEndpoint("metrics", null, {})).toBeNull();
  expect([metricInterval({}), metricInterval({ OTEL_METRIC_EXPORT_INTERVAL: "5000" }), metricInterval({ OTEL_METRIC_EXPORT_INTERVAL: "x" })]).toEqual([60_000, 5000, 60_000]);
});

test("the exporter posts another signal's batch with that signal's body and names it in a failure", async () => {
  const got: { path: string; body: any }[] = [];
  let status = 200;
  const sink = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (r) => { got.push({ path: new URL(r.url).pathname, body: await r.json() }); return new Response("{}", { status }); } });
  const fails: string[] = [];
  const out = new OtlpExporter<Point>({ "service.name": "keel" }, async () => null, (e) => fails.push(e.message), toOtlpMetrics, "OTLP metrics export");
  try {
    out.configure({ url: `http://127.0.0.1:${sink.port}/v1/metrics`, from: "setting" });
    out.push({ name: "keel.turn.count", unit: "{turn}", attrs: {}, start_ms: 1, end_ms: 2, sum: 3 });
    await out.flush();
    expect([got[0]!.path, got[0]!.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt, out.state.sent]).toEqual(["/v1/metrics", "3", 1]);
    status = 404;
    out.push({ name: "keel.turn.count", unit: "{turn}", attrs: {}, start_ms: 2, end_ms: 3, sum: 1 });
    await out.flush();
    // Kept for the next try, and the failure says which signal it was.
    expect([out.state.queued, out.state.failures, fails[0]]).toEqual([1, 1, expect.stringContaining("OTLP metrics export to http://127.0.0.1")]);
  } finally {
    out.stop();
    sink.stop(true);
  }
});
