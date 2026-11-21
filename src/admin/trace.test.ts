import { expect, test } from "bun:test";
import { toOtlp } from "./otlp.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { KEEP_REQUEST_BYTES, SPAN_DAYS, packRequest, parseTraceparent, requestShape, type Span, spawnContext, toolSpanId, traceIdOf, traceparent, Tracer, turnPlace, turnSpanId } from "./trace.ts";

// A tracer over a store of its own, with the hooks it registered. Closing takes
// the hooks away with the store: a turn of a later test file would call them.
function tracer(running = false) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "trace-test-"));
  const store = new Store(dir);
  const t = new Tracer(store, new Bus(), () => running);
  const hooks = allHooks().at(-1)!;
  return { dir, store, t, hooks, close: () => { allHooks().splice(allHooks().indexOf(hooks), 1); store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
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

test("a chain of spawns stays in the first turn's trace, each agent under the call that started it", () => {
  const x = tracer(true);
  try {
    const session = () => x.store.createSession({ workspace: x.dir, model: "p:m" });
    const [root, child, grand] = [session(), session(), session()];
    const turn = (s: { id: string }) => x.store.append(s.id, "turn_start", { model: "p:m" });
    // What a spawn does: the task prompt carries the context of the call that started the agent.
    const task = (s: { id: string }, from: { id: string }, call: string) => x.store.append(s.id, "user", { text: "task", kind: "task", traceparent: spawnContext(x.store, from.id, call) });
    const ran = (s: any, call: string) => x.hooks.toolRan!(s, { id: call, tool: { name: "Agent" }, input: {} } as any, { type: "tool_result", tool_use_id: call, content: "done" } as any, { ms: 1, outcome: "ok" });
    const end = (s: any) => { x.store.append(s.id, "turn_end", { reason: "end_turn" }); x.hooks.turnEnd!(s, "end_turn"); };

    const rootTurn = turn(root);
    const trace = traceIdOf(rootTurn.id);
    task(child, root, "c1");
    const childTurn = turn(child);
    task(grand, child, "c2");
    const grandTurn = turn(grand);
    end(grand);
    ran(child, "c2");
    end(child);
    ran(root, "c1");
    end(root);

    const [call1, call2] = [toolSpanId(root.id, "c1"), toolSpanId(child.id, "c2")];
    const span = (id: string) => turnSpanId(traceIdOf(id));
    const tree = (spans: { span_id: string; trace_id: string; parent_id: string | null }[]) => Object.fromEntries(spans.map((s) => [s.span_id, [s.trace_id, s.parent_id]]));
    const local = x.t.trace(trace);
    expect(tree(local)).toEqual({
      [span(rootTurn.id)]: [trace, null],
      [call1]: [trace, span(rootTurn.id)],
      [span(childTurn.id)]: [trace, call1],
      [call2]: [trace, span(childTurn.id)],
      [span(grandTurn.id)]: [trace, call2],
    });
    // What goes to a collector is the same tree.
    const sent = toOtlp(local, {}).resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(tree(sent.map((s: any) => ({ span_id: s.spanId, trace_id: s.traceId, parent_id: s.parentSpanId ?? null })))).toEqual(tree(local));

    // A later turn of each agent runs on its own time: its own trace, linked to its spawn call.
    x.store.append(child.id, "user", { text: "more" });
    const childLater = turn(child);
    end(child);
    x.store.append(grand.id, "user", { text: "more" });
    const grandLater = turn(grand);
    end(grand);
    const own = (id: string) => x.t.trace(traceIdOf(id)).map((s) => [s.span_id, s.parent_id, s.attrs.links]);
    expect(own(childLater.id)).toEqual([[span(childLater.id), null, [{ trace_id: trace, span_id: call1 }]]]);
    expect(own(grandLater.id)).toEqual([[span(grandLater.id), null, [{ trace_id: trace, span_id: call2 }]]]);
    expect(x.t.trace(trace).length).toBe(5);
    // A spawn from that later turn starts in the later turn's own trace.
    expect(parseTraceparent(spawnContext(x.store, child.id, "c3"))).toEqual({ trace: traceIdOf(childLater.id), span: toolSpanId(child.id, "c3") });
  } finally {
    x.close();
  }
});

test("a turn that never ran is not a spawned agent's first turn", () => {
  const x = tracer(true);
  try {
    const session = () => x.store.createSession({ workspace: x.dir, model: "p:m" });
    const [root, stopped, restarted, worked] = [session(), session(), session(), session()];
    const turn = (s: { id: string }) => x.store.append(s.id, "turn_start", { model: "p:m" });
    const rootTurn = turn(root);
    const trace = traceIdOf(rootTurn.id);
    const task = (s: { id: string }, call: string) => x.store.append(s.id, "user", { text: "task", kind: "task", traceparent: spawnContext(x.store, root.id, call) });
    const place = (s: { id: string }) => { const t = turn(s); return x.t.place(s.id, t); };

    // Stopped while the turn was set up, and closed unstarted when the daemon came back: a pair of no length.
    task(stopped, "c1");
    turn(stopped);
    x.store.append(stopped.id, "turn_end", { reason: "interrupted", ms: 0 });
    expect(place(stopped)).toMatchObject({ trace, parent: toolSpanId(root.id, "c1"), links: [] });
    task(restarted, "c2");
    turn(restarted);
    x.store.append(restarted.id, "turn_end", { reason: "restart", ms: 0, crashed: true, unstarted: true });
    expect(place(restarted)).toMatchObject({ trace, parent: toolSpanId(root.id, "c2"), links: [] });
    // A turn that ran, however short: the next one is a later turn, linked.
    task(worked, "c3");
    turn(worked);
    x.store.append(worked.id, "assistant", { blocks: [{ type: "text", text: "done" }], model: "p:m", usage: {}, stop: "end_turn" });
    x.store.append(worked.id, "turn_end", { reason: "end_turn", ms: 0 });
    expect(place(worked)).toMatchObject({ parent: null, links: [{ trace_id: trace, span_id: toolSpanId(root.id, "c3") }] });
  } finally {
    x.close();
  }
});

test("a spawn from a turn the tracer has placed reads no task prompt again", () => {
  const x = tracer(true);
  try {
    const session = () => x.store.createSession({ workspace: x.dir, model: "p:m" });
    const [root, child] = [session(), session()];
    const turn = (s: { id: string }) => x.store.append(s.id, "turn_start", { model: "p:m" });
    const trace = traceIdOf(turn(root).id);
    x.store.append(child.id, "user", { text: "task", kind: "task", traceparent: spawnContext(x.store, root.id, "c4") });
    const childTurn = turn(child);
    // The calling turn is placed when its first request or call is recorded.
    x.hooks.toolRan!(child as any, { id: "c5", tool: { name: "Agent" }, input: {} } as any, { type: "tool_result", tool_use_id: "c5", content: "done" } as any, { ms: 1, outcome: "ok" });
    const seen: string[] = [];
    const query = x.store.db.query.bind(x.store.db);
    (x.store.db as any).query = (sql: string) => (seen.push(sql), query(sql));
    const handed = spawnContext(x.store, child.id, "c5");
    (x.store.db as any).query = query;
    expect(parseTraceparent(handed)).toEqual({ trace, span: toolSpanId(child.id, "c5") });
    expect(x.t.span(turnSpanId(traceIdOf(childTurn.id)))!.trace_id).toBe(trace);
    expect(seen.filter((q) => q.includes("traceparent"))).toEqual([]);
  } finally {
    x.close();
  }
});

test("a turn the model declined is a failed turn in the list of traces, with the refusal's words", () => {
  const x = tracer(true);
  try {
    const s = x.store.createSession({ workspace: x.dir, model: "p:m" });
    const turn = (stop: string, details?: { explanation: string }) => {
      x.store.append(s.id, "turn_start", { model: "p:m" });
      const sent = { model: "m", system: "", tools: [], messages: [] } as any;
      x.hooks.requestSent!(s, sent);
      x.hooks.requestDone!(s, sent, { blocks: [], stop, stop_details: details, usage: {} } as any);
      x.store.append(s.id, "turn_end", { reason: stop });
      x.hooks.turnEnd!(s, stop);
    };
    turn("end_turn");
    turn("refusal", { explanation: "Declined for the test." });
    const [declined, answered] = x.t.traces(s.id);
    expect(answered).toMatchObject({ kind: "turn", status: "ok", error: null, error_type: null });
    expect(declined).toMatchObject({ kind: "turn", status: "error", error: "Declined for the test.", error_type: "refusal", attrs: { reason: "refusal" } });
    // And leaves for a collector as a failure of the refusal class.
    const out = toOtlp([declined!], {}).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(out.status).toEqual({ code: 2 });
    expect(out.attributes).toContainEqual({ key: "error.type", value: { stringValue: "refusal" } });
  } finally {
    x.close();
  }
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
