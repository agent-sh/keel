// Receipt cases the e2e cannot make: a turn that never got an end (the loop
// always writes one), requests of every purpose under one turn, and a turn
// longer than one read. The store is real; the tracer answers with fixed spans.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { inputOrigin, turnReceipt } from "./receipt.ts";
import { type Span, type Tracer, traceIdOf, turnSpanId } from "./trace.ts";

const setup = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "receipt-"));
  const store = new Store(dir);
  const s = store.createSession({ model: "fixture:m", workspace: dir });
  let tip: string | null = null;
  const add = (kind: Parameters<Store["append"]>[1], data: unknown = {}) => {
    const e = store.append(s.id, kind, data, tip);
    tip = e.id;
    return e;
  };
  const spans: Span[] = [];
  const span = (turn: string, kind: Span["kind"], attrs: Record<string, unknown>): Span => {
    const trace = traceIdOf(turn);
    const root = kind === "turn";
    const sp: Span = { span_id: root ? turnSpanId(trace) : `${spans.length}`.padStart(16, "0"), trace_id: trace, parent_id: root ? null : turnSpanId(trace), session_id: s.id, kind, name: "fixture-span-name", start_ms: 1, end_ms: 2, status: "ok", error: null, error_type: null, error_id: null, attrs: { turn_event: turn, ...attrs }, replayable: false };
    spans.push(sp);
    return sp;
  };
  const tracer = { span: (id: string) => spans.find((x) => x.span_id === id), trace: (id: string) => spans.filter((x) => x.trace_id === id) } as unknown as Tracer;
  const close = () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { store, s, add, span, tracer, close };
};

test("a turn with no end keeps its own inputs and leaves the next turn's opener to that turn", () => {
  const t = setup();
  try {
    const first = t.add("user", { text: "first-prompt-marker" });
    const cut = t.add("turn_start");
    t.add("assistant", { blocks: [] });
    const steer = t.add("user", { text: "steer-marker", origin: "steer" });
    const result = t.add("tool_result", { results: [{ tool_use_id: "call-1", content: "tool-output-marker" }] });
    // No turn_end: the next prompt, a note before its turn, and that turn hang from here.
    const next = t.add("user", { text: "next-prompt-marker" });
    t.add("note", { text: "note-marker" });
    const later = t.add("turn_start");
    t.add("assistant", { blocks: [] });
    const end = t.add("turn_end", { reason: "end_turn" });

    const receipt = turnReceipt(t.store, t.tracer, cut.id)!;
    expect(receipt.inputs).toEqual([
      { event_id: first.id, origin: "owner", queue_id: null },
      { event_id: steer.id, origin: "steer", queue_id: null },
    ]);
    expect(receipt.tools).toEqual([{ result_event_id: result.id, span_id: null, status: "ok", name: null }]);
    expect(receipt.end).toBeNull();
    expect(JSON.stringify(receipt)).not.toContain("marker");
    expect(turnReceipt(t.store, t.tracer, later.id)).toMatchObject({
      inputs: [{ event_id: next.id, origin: "owner", queue_id: null }],
      end: { event_id: end.id, reason: "end_turn" },
    });
  } finally {
    t.close();
  }
});

test("each request says what it was for, from a fixed list", () => {
  const t = setup();
  try {
    t.add("user", { text: "prompt" });
    const start = t.add("turn_start");
    t.add("turn_end", { reason: "end_turn" });
    t.span(start.id, "turn", {});
    const shapes = [{ purpose: "turn" }, { purpose: "summary" }, { purpose: "reader" }, { purpose: "purpose-marker" }, undefined];
    const ids = shapes.map((shape, i) => t.span(start.id, "request", { attempt: i + 1, shape }).span_id);
    const receipt = turnReceipt(t.store, t.tracer, start.id)!;
    expect(receipt.requests.map((r) => [r.span_id, r.purpose, r.attempt]))
      .toEqual(["turn", "summary", "reader", "other", "other"].map((purpose, i) => [ids[i]!, purpose, i + 1]));
    expect(JSON.stringify(receipt)).not.toMatch(/marker|fixture-span-name/);
  } finally {
    t.close();
  }
});

test("a long turn is followed to its end without parsing the session", () => {
  const t = setup();
  try {
    const first = t.add("user", { text: "prompt" });
    const start = t.add("turn_start");
    for (let i = 0; i < 1100; i++) t.add("assistant", { blocks: [] });
    const end = t.add("turn_end", { reason: "max_steps" });
    t.add("user", { text: "after" });
    // (As after a start: the session is not in memory. One made in this process holds what was appended to it.)
    (t.store as any).forget(t.s.id);
    const receipt = turnReceipt(t.store, t.tracer, start.id)!;
    expect(receipt.inputs).toEqual([{ event_id: first.id, origin: "owner", queue_id: null }]);
    expect(receipt.end).toMatchObject({ event_id: end.id, reason: "max_steps" });
    // The store's parsed copy of the session was not made for it.
    expect((t.store as any).kept.get(t.s.id)).toBeUndefined();
  } finally {
    t.close();
  }
});

test("a failed call is named by its tool, with the exit code a shell result gives and no word of its output", () => {
  const t = setup();
  try {
    t.add("user", { text: "go" });
    const start = t.add("turn_start");
    t.span(start.id, "turn", {});
    t.add("assistant", { blocks: [] });
    const results = [
      { tool_use_id: "c1", content: "ok-one" },
      { tool_use_id: "c2", content: "Exit code 4\nfatal: output-marker", is_error: true },
      { tool_use_id: "c3", content: "File does not exist: /path-marker", is_error: true },
      { tool_use_id: "c4", content: "No tool named NoSuchTool.", is_error: true },
      { tool_use_id: "c5", content: "Denied by the owner: reason-marker", is_error: true },
    ];
    const names = ["Bash", "Bash", "Read", "NoSuchTool"];
    const spans = names.map((tool, i) => Object.assign(t.span(start.id, "tool", { tool, call_id: `c${i + 1}` }), { status: i ? "error" : "ok" }));
    const result = t.add("tool_result", { results });
    t.add("turn_end", { reason: "end_turn" });
    const receipt = turnReceipt(t.store, t.tracer, start.id)!;
    // It read "3 failed: call 1, call 2, call 3" where call 1 had passed.
    expect(receipt.tools).toEqual([
      { result_event_id: result.id, span_id: spans[0]!.span_id, status: "ok", name: "Bash" },
      { result_event_id: result.id, span_id: spans[1]!.span_id, status: "error", name: "Bash", exit: 4 },
      { result_event_id: result.id, span_id: spans[2]!.span_id, status: "error", name: "Read" },
      { result_event_id: result.id, span_id: spans[3]!.span_id, status: "error", name: "NoSuchTool", unknown: true },
      // A call a gate denied never ran: it has no span, and so no name.
      { result_event_id: result.id, span_id: null, status: "error", name: null },
    ]);
    expect(JSON.stringify(receipt)).not.toContain("marker");
  } finally {
    t.close();
  }
});

test("an input is named by what it is, not by how it arrived: never the owner's when it is another's", () => {
  // Read at the working turn's next step (steer) or after a Resume (queued).
  expect(inputOrigin({ kind: "channel", origin: "steer" })).toBe("channel");
  expect(inputOrigin({ kind: "channel", origin: "queued" })).toBe("channel");
  expect(inputOrigin({ kind: "loop", origin: "steer" })).toBe("loop");
  expect(inputOrigin({ kind: "peer", origin: "queued" })).toBe("peer");
  // A parent's message to its agent is stored as kind "steer": it is the parent's.
  expect(inputOrigin({ kind: "steer", origin: "steer" })).toBe("parent");
  // The owner's own steer and queued prompt stay theirs, and a restart note stays one.
  expect(inputOrigin({ origin: "steer" })).toBe("steer");
  expect(inputOrigin({ origin: "queued" })).toBe("queued");
  expect(inputOrigin({ origin: "restart", kind: "harness" })).toBe("restart");
  expect(inputOrigin(undefined)).toBe("owner");
});
