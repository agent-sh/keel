import { expect, test } from "bun:test";
import { toOtlp } from "./otlp.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { KEEP_REQUEST_BYTES, SPAN_DAYS, packRequest, parseTraceparent, requestShape, type Span, toolSpanId, traceIdOf, traceparent, Tracer, turnPlace, turnSpanId } from "./trace.ts";

// A tracer over a store of its own, with the hooks it registered.
function tracer() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "trace-test-"));
  const store = new Store(dir);
  const t = new Tracer(store, new Bus(), () => false);
  return { dir, store, t, hooks: allHooks().at(-1)!, close: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

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

const req = (text: string) => ({ model: "m", system: "", tools: [], messages: [{ role: "user", content: [{ type: "text", text }] }] }) as any;

test("a shape's message size is UTF-8 bytes", () => {
  // 7 characters, 10 bytes: the accent is 2 bytes and the euro sign 3.
  const said = req("h\u00e9llo \u20ac");
  const ascii = requestShape(req("hello E")).message_bytes;
  expect(ascii).toBe(JSON.stringify(req("hello E").messages[0].content).length);
  expect(requestShape(said).message_bytes).toBe(ascii + 3);
});

test("the cutoff for keeping a request counts UTF-8 bytes", () => {
  // Under the limit counted in characters, over it encoded: not kept.
  const big = req("\u20ac".repeat(6_000_000));
  const json = JSON.stringify(big);
  expect(json.length).toBeLessThan(KEEP_REQUEST_BYTES);
  expect(Buffer.byteLength(json)).toBeGreaterThan(KEEP_REQUEST_BYTES);
  expect(packRequest(big)).toBeNull();

  // An under-limit request comes back as it was sent.
  const said = req("h\u00e9llo \u20ac");
  const packed = packRequest({ ...said, signal: new AbortController().signal, onHeaders: () => {} });
  expect(JSON.parse(gunzipSync(packed!).toString("utf8"))).toEqual(said);
});

test("a tool span's input and result sizes are UTF-8 bytes", () => {
  const x = tracer();
  try {
    const s = x.store.createSession({ workspace: x.dir, model: "p:m" });
    x.hooks.toolRan!(s, { id: "c1", tool: { name: "Bash" }, input: { command: "\u00e9" } } as any, { type: "tool_result", tool_use_id: "c1", content: "\u20ac\u20ac" } as any, { ms: 1, outcome: "ok" });
    const a = x.t.span(toolSpanId(s.id, "c1"))!.attrs;
    expect([a.input_bytes, a.result_bytes]).toEqual(['{"command":"e"}'.length + 1, 6]);
  } finally {
    x.close();
  }
});

test("a retry is replayable only while the span that kept its request is", () => {
  const x = tracer();
  try {
    const s = x.store.createSession({ workspace: x.dir, model: "p:m" });
    const edge = Date.now() - SPAN_DAYS * 86_400_000;
    const sent = req("again");
    const add = (id: string, start: number, kept: { request?: Uint8Array; request_in?: string }) =>
      x.store.db.run(
        "INSERT INTO spans (span_id, trace_id, session_id, kind, name, start_ms, end_ms, status, error, error_type, attrs, request) VALUES (?, ?, ?, 'request', 'chat m', ?, ?, 'error', 'HTTP 529', 'overloaded', ?, ?)",
        [id, `trace-${id}`, s.id, start, start + 5, JSON.stringify(kept.request_in ? { request_in: kept.request_in } : {}), kept.request ?? null],
      );
    // The first failed attempt keeps the request; its retry points there. One pair straddles the retention edge.
    add("old-first", edge - 60_000, { request: packRequest(sent)! });
    add("old-retry", edge + 60_000, { request_in: "old-first" });
    add("new-first", edge + 120_000, { request: packRequest(sent)! });
    add("new-retry", edge + 180_000, { request_in: "new-first" });
    expect(x.t.span("old-retry")!.replayable).toBe(true);
    expect(x.t.request("old-retry")).toEqual(sent);

    x.t.prune();
    expect(x.t.span("old-first")).toBeUndefined();
    expect(x.t.span("old-retry")).toMatchObject({ status: "error", error_type: "overloaded", replayable: false });
    expect(x.t.request("old-retry")).toBeUndefined();
    expect(x.t.traces(s.id).map((t) => [t.span_id, t.replayable])).toEqual([["new-retry", true], ["new-first", true], ["old-retry", false]]);
    expect(x.t.trace("trace-old-retry").map((t) => t.replayable)).toEqual([false]);
    expect(x.t.request("new-retry")).toEqual(sent);
  } finally {
    x.close();
  }
});
