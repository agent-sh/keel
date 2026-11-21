import { expect, test } from "bun:test";
import { redactHeaders, safeUrl } from "../providers/wiretap.ts";
import { endpointOf, headerRefError, headerSourceOf, headersOf, OtlpExporter, toOtlp } from "./otlp.ts";
import type { Span } from "./trace.ts";

const base = { session_id: "s1", end_ms: 1_700_000_001_500, error_id: null, replayable: false } as const;

test("spans map to OTLP JSON with the GenAI names, ids as hex and times as nanosecond strings", () => {
  const turn: Span = { ...base, span_id: "aaaaaaaaaaaaaaaa", trace_id: "0".repeat(16) + "a".repeat(16), parent_id: null, kind: "turn", name: "invoke_agent", start_ms: 1_700_000_000_000, status: "error", error: "HTTP 402: no credit for CANARY-acct-7731 at /home/owner/work", error_type: "quota", attrs: { model: "bedrock:m", reason: "error" } };
  const req: Span = {
    ...base, span_id: "bbbbbbbbbbbbbbbb", trace_id: turn.trace_id, parent_id: turn.span_id, kind: "request", name: "chat m", start_ms: 1_700_000_000_250, status: "ok", error: null, error_type: null,
    attrs: { route: "bedrock:m", model: "m", attempt: 2, ttft_ms: 1500, shape: { purpose: "turn", effort: "high", max_tokens: 64000, messages: 3, tools: 9 }, wire: { url: "https://h.example/model/m", status: 200, request_id: "r-1" }, result: { response_model: "m", stop: "end_turn", usage: { input: 4, output: 7, cache_read: 100, cache_write: 20 } } },
  };
  const tool: Span = { ...base, span_id: "cccccccccccccccc", trace_id: turn.trace_id, parent_id: turn.span_id, kind: "tool", name: "execute_tool Bash", start_ms: 1_700_000_001_000, status: "ok", error: null, error_type: null, attrs: { tool: "Bash", call_id: "c1", input_bytes: 20, result_bytes: 5 } };
  const out = toOtlp([turn, req, tool], { "service.name": "keel" });
  const [t, r, x] = out.resourceSpans[0]!.scopeSpans[0]!.spans;
  const attr = (s: any, k: string) => s.attributes.find((a: any) => a.key === k)?.value;
  expect(t!.name).toBe("invoke_agent keel");
  // A failure leaves as its code and class. Its text stays on the local span.
  expect(turn.error).toContain("CANARY-acct-7731");
  expect(t!.status).toEqual({ code: 2 });
  expect(JSON.stringify(out)).not.toContain("CANARY");
  expect(JSON.stringify(out)).not.toContain("no credit");
  expect([t!.traceId, t!.spanId]).toEqual([turn.trace_id, turn.span_id]);
  expect(t!.startTimeUnixNano).toBe("1700000000000000000");
  expect(attr(t, "error.type")).toEqual({ stringValue: "quota" });
  expect(r!.kind).toBe(3);
  expect(r!.parentSpanId).toBe("aaaaaaaaaaaaaaaa");
  expect(attr(r, "gen_ai.provider.name")).toEqual({ stringValue: "aws.bedrock" });
  expect(attr(r, "gen_ai.usage.input_tokens")).toEqual({ intValue: "124" });
  expect(attr(r, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "100" });
  expect(attr(r, "gen_ai.response.finish_reasons")).toEqual({ arrayValue: { values: [{ stringValue: "end_turn" }] } });
  expect(attr(r, "gen_ai.response.time_to_first_chunk")).toEqual({ doubleValue: 1.5 });
  expect(attr(r, "server.address")).toEqual({ stringValue: "h.example" });
  expect(attr(r, "gen_ai.conversation.id")).toEqual({ stringValue: "s1" });
  expect(attr(x, "gen_ai.tool.name")).toEqual({ stringValue: "Bash" });
  expect(attr(x, "gen_ai.tool.call.id")).toEqual({ stringValue: "c1" });
});

test("the endpoint follows the OTLP variables and the setting wins", () => {
  expect(endpointOf(null, {})).toBeNull();
  expect(endpointOf(null, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/" })).toEqual({ url: "http://c:4318/v1/traces", from: "env" });
  expect(endpointOf(null, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://t/x" })).toEqual({ url: "http://t/x", from: "env" });
  expect(endpointOf("http://s/v1/traces", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" })).toEqual({ url: "http://s/v1/traces", from: "setting" });
  expect(headersOf("Authorization=Basic%20abc, x-team = one")).toEqual({ Authorization: "Basic abc", "x-team": "one" });
});

test("what the wire record keeps of credentials: their length, never their value", () => {
  expect(redactHeaders({ Authorization: "Bearer abcdef", "x-api-key": "k123", "anthropic-version": "2023-06-01" })).toEqual({ authorization: "13 chars, redacted", "x-api-key": "4 chars, redacted", "anthropic-version": "2023-06-01" });
  expect(safeUrl("http://127.0.0.1:4/UqmzUakl95l9ofOAcGItBLbcsRi12YUz/model/global.anthropic.claude-haiku-5-5/invoke?key=s")).toBe("http://127.0.0.1:4/[redacted]/model/global.anthropic.claude-haiku-5-5/invoke?[query]");
  expect(safeUrl("https://u:p@api.example/v1/chat/completions")).toBe("https://api.example/v1/chat/completions");
});

test("auth headers come from a named source, are sent, and show by name only", async () => {
  expect(headerRefError({ env: "COLLECTOR_HEADERS" })).toBeUndefined();
  expect(headerRefError({ cred: "otlp-collector" })).toBeUndefined();
  expect(headerRefError({ env: "A", cred: "b" })).toContain("one source");
  expect(headerRefError({ env: "not a name" })).toContain("environment variable name");
  expect(headerRefError("Authorization=Bearer x")).toContain("or null");
  expect(headerSourceOf(null, { OTEL_EXPORTER_OTLP_HEADERS: "a=b" })).toEqual({ src: { env: "OTEL_EXPORTER_OTLP_HEADERS" }, label: "$OTEL_EXPORTER_OTLP_HEADERS", from: "env" });
  expect(headerSourceOf({ cred: "otlp-collector" }, { OTEL_EXPORTER_OTLP_HEADERS: "a=b" })?.src).toEqual({ cred: "otlp-collector" });

  const seen: (string | null)[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => (seen.push(r.headers.get("authorization")), Response.json({})) });
  const failed: string[] = [];
  const values: Record<string, string> = { COLLECTOR_HEADERS: "Authorization=Bearer%20s3cret" };
  const ex = new OtlpExporter({}, async (src) => (src.env ? values[src.env] ?? null : null), (e) => failed.push(e.message));
  const span: Span = { ...base, span_id: "dddddddddddddddd", trace_id: "e".repeat(32), parent_id: null, kind: "tool", name: "execute_tool Bash", start_ms: 1, status: "ok", error: null, error_type: null, attrs: {} };
  try {
    ex.configure({ url: `http://127.0.0.1:${server.port}/v1/traces`, from: "setting" }, headerSourceOf({ env: "COLLECTOR_HEADERS" }, {}));
    ex.push(span);
    await ex.flush();
    expect(seen).toEqual(["Bearer s3cret"]);
    expect(ex.state.headers).toEqual({ label: "$COLLECTOR_HEADERS", from: "setting", names: ["Authorization"], missing: false });
    expect(JSON.stringify(ex.state)).not.toContain("s3cret");

    // A source with no value sends nothing and says which source it read.
    ex.configure({ url: `http://127.0.0.1:${server.port}/v1/traces`, from: "setting" }, headerSourceOf({ env: "UNSET_HEADERS" }, {}));
    ex.push(span);
    await ex.flush();
    expect(seen).toHaveLength(1);
    expect(failed.at(-1)).toContain("$UNSET_HEADERS is not set");
    expect(ex.state.headers?.missing).toBe(true);
  } finally {
    ex.stop();
    server.stop(true);
  }
});

// A loopback collector: the span ids of each batch it got. `hold` keeps its
// answer back until `release(status)`.
function collector(hold = false) {
  const got: string[][] = [];
  let arrived = Promise.withResolvers<void>();
  let gate = Promise.withResolvers<number>();
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: async (r) => {
      got.push(((await r.json()) as any).resourceSpans[0].scopeSpans[0].spans.map((s: any) => s.spanId));
      arrived.resolve();
      return new Response("{}", { status: hold ? await gate.promise : 200 });
    },
  });
  return { got, ep: { url: `http://127.0.0.1:${server.port}/v1/traces`, from: "setting" as const }, arrived: () => arrived.promise, release: (status: number) => gate.resolve(status), stop: () => { gate.resolve(200); server.stop(true); } };
}
const sp = (id: string): Span => ({ ...base, span_id: id.padEnd(16, "0"), trace_id: "e".repeat(32), parent_id: null, kind: "tool", name: "execute_tool Bash", start_ms: 1, status: "ok", error: null, error_type: null, attrs: {} });
const ids = (...names: string[]) => names.map((n) => n.padEnd(16, "0"));

test("what waits or is in flight for one collector never reaches the next, and its late end changes nothing", async () => {
  const failed: string[] = [];
  for (const late of [500, 200]) {
    const a = collector(true), b = collector();
    const ex = new OtlpExporter({}, async () => null, (e) => failed.push(e.message));
    try {
      ex.configure(a.ep);
      ex.push(sp("a1"));
      const held = ex.flush();
      await a.arrived();
      ex.push(sp("a2")); // waits for A behind the batch in flight
      ex.configure(b.ep);
      expect(ex.state).toMatchObject({ endpoint: b.ep.url, queued: 0, sent: 0, failures: 0 });
      ex.push(sp("b1"));
      await ex.flush();
      expect(b.got).toEqual([ids("b1")]);
      // A answers late, with a failure or a success: B's counts, queue and backoff are as they were.
      a.release(late);
      await held;
      expect(ex.state).toMatchObject({ endpoint: b.ep.url, queued: 0, sent: 1, failures: 0, last_error: null });
      ex.push(sp("b2"));
      await ex.flush();
      expect(b.got).toEqual([ids("b1"), ids("b2")]);
      expect(a.got).toEqual([ids("a1")]);
      expect(ex.state).toMatchObject({ queued: 0, sent: 2, failures: 0 });
    } finally {
      ex.stop();
      a.stop();
      b.stop();
    }
  }
  expect(failed).toEqual([]);
});

test("a batch whose headers were still being read is not posted to the collector picked meanwhile", async () => {
  const a = collector(), b = collector();
  const failed: string[] = [];
  let reads = 0;
  const gate = Promise.withResolvers<void>();
  // The first read is configure's own; the flush's read is held.
  const ex = new OtlpExporter({}, async () => (++reads > 1 && (await gate.promise), "x-team=one"), (e) => failed.push(e.message));
  const source = headerSourceOf({ env: "COLLECTOR_HEADERS" }, {});
  try {
    ex.configure(a.ep, source);
    ex.push(sp("a1"));
    const held = ex.flush();
    ex.configure(b.ep, source);
    gate.resolve();
    await held;
    await ex.flush();
    expect([a.got, b.got]).toEqual([[], []]);
    expect(ex.state).toMatchObject({ endpoint: b.ep.url, queued: 0, sent: 0, failures: 0 });
    expect(failed).toEqual([]);
  } finally {
    ex.stop();
    a.stop();
    b.stop();
  }
});

test("turning the export off ends the batch in flight: nothing comes back into the queue", async () => {
  const a = collector(true);
  const failed: string[] = [];
  const ex = new OtlpExporter({}, async () => null, (e) => failed.push(e.message));
  try {
    ex.configure(a.ep);
    ex.push(sp("a1"));
    const held = ex.flush();
    await a.arrived();
    ex.configure(null);
    a.release(500);
    await held;
    expect(ex.state).toMatchObject({ endpoint: null, queued: 0, sent: 0, failures: 0, last_error: null });
    expect(failed).toEqual([]);
    // Pointed at the same collector again, it starts with nothing of before.
    ex.configure(a.ep);
    await ex.flush();
    expect(a.got).toEqual([ids("a1")]);
    expect(ex.state.queued).toBe(0);
  } finally {
    ex.stop();
    a.stop();
  }
});
