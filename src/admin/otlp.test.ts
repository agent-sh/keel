import { expect, test } from "bun:test";
import { redactHeaders, safeUrl } from "../providers/wiretap.ts";
import { endpointOf, headersOf, toOtlp } from "./otlp.ts";
import type { Span } from "./trace.ts";

const base = { session_id: "s1", end_ms: 1_700_000_001_500, error_id: null, replayable: false } as const;

test("spans map to OTLP JSON with the GenAI names, ids as hex and times as nanosecond strings", () => {
  const turn: Span = { ...base, span_id: "aaaaaaaaaaaaaaaa", trace_id: "0".repeat(16) + "a".repeat(16), parent_id: null, kind: "turn", name: "invoke_agent", start_ms: 1_700_000_000_000, status: "error", error: "HTTP 402: no credit", error_type: "quota", attrs: { model: "bedrock:m", reason: "error" } };
  const req: Span = {
    ...base, span_id: "bbbbbbbbbbbbbbbb", trace_id: turn.trace_id, parent_id: turn.span_id, kind: "request", name: "chat m", start_ms: 1_700_000_000_250, status: "ok", error: null, error_type: null,
    attrs: { route: "bedrock:m", model: "m", attempt: 2, ttft_ms: 1500, shape: { purpose: "turn", effort: "high", max_tokens: 64000, messages: 3, tools: 9 }, wire: { url: "https://h.example/model/m", status: 200, request_id: "r-1" }, result: { response_model: "m", stop: "end_turn", usage: { input: 4, output: 7, cache_read: 100, cache_write: 20 } } },
  };
  const tool: Span = { ...base, span_id: "cccccccccccccccc", trace_id: turn.trace_id, parent_id: turn.span_id, kind: "tool", name: "execute_tool Bash", start_ms: 1_700_000_001_000, status: "ok", error: null, error_type: null, attrs: { tool: "Bash", call_id: "c1", input_bytes: 20, result_bytes: 5 } };
  const out = toOtlp([turn, req, tool], { "service.name": "keel" });
  const [t, r, x] = out.resourceSpans[0]!.scopeSpans[0]!.spans;
  const attr = (s: any, k: string) => s.attributes.find((a: any) => a.key === k)?.value;
  expect(t!.name).toBe("invoke_agent keel");
  expect(t!.status).toEqual({ code: 2, message: "HTTP 402: no credit" });
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
