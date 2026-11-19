import { expect, test } from "bun:test";
import { toOtlp } from "./otlp.ts";
import { parseTraceparent, type Span, toolSpanId, traceIdOf, traceparent, turnPlace, turnSpanId } from "./trace.ts";

const parentTurn = "019a0000-0000-7000-8000-00000000aaaa";
const childTurn = "019a0000-0000-7000-8000-00000000bbbb";
const childLater = "019a0000-0000-7000-8000-00000000cccc";

test("a subagent's first turn sits under the spawn call in the parent's trace; later turns link to it", () => {
  const trace = traceIdOf(parentTurn);
  const call = toolSpanId("parent", "toolu_1");
  expect(call).toMatch(/^[0-9a-f]{16}$/);
  expect(toolSpanId("parent", "toolu_1")).toBe(call);
  expect(toolSpanId("other", "toolu_1")).not.toBe(call);
  const spawn = parseTraceparent(traceparent(trace, call));
  expect(spawn).toEqual({ trace, span: call });

  expect(turnPlace(parentTurn, null, false)).toEqual({ trace, span: turnSpanId(trace), parent: null, links: [] });
  const first = turnPlace(childTurn, spawn, true);
  expect(first).toEqual({ trace, span: turnSpanId(traceIdOf(childTurn)), parent: call, links: [] });
  expect(first.span).not.toBe(turnSpanId(trace));
  const later = turnPlace(childLater, spawn, false);
  expect(later).toEqual({ trace: traceIdOf(childLater), span: turnSpanId(traceIdOf(childLater)), parent: null, links: [{ trace_id: trace, span_id: call }] });

  expect(parseTraceparent("00-" + "0".repeat(32) + "-" + call + "-01")).toBeNull();
  expect(parseTraceparent("garbage")).toBeNull();

  const span: Span = { span_id: later.span, trace_id: later.trace, parent_id: null, session_id: "child", kind: "turn", name: "invoke_agent", start_ms: 1, end_ms: 2, status: "ok", error: null, error_type: null, error_id: null, attrs: { model: "m", links: later.links }, replayable: false };
  const [out] = toOtlp([span], {}).resourceSpans[0]!.scopeSpans[0]!.spans;
  expect(out!.links).toEqual([{ traceId: trace, spanId: call }]);
});
