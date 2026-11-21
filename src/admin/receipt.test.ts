// Receipt cases the e2e cannot make: a turn that never got an end (the loop
// always writes one), requests of every purpose under one turn, and a turn
// longer than one read. The store is real; the tracer answers with fixed spans.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { turnReceipt } from "./receipt.ts";
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
    expect(receipt.tools).toEqual([{ result_event_id: result.id, span_id: null, status: "ok" }]);
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
    const receipt = turnReceipt(t.store, t.tracer, start.id)!;
    expect(receipt.inputs).toEqual([{ event_id: first.id, origin: "owner", queue_id: null }]);
    expect(receipt.end).toMatchObject({ event_id: end.id, reason: "max_steps" });
    // The store's parsed copy of the session was not made for it.
    expect((t.store as any).kept.get(t.s.id)).toBeUndefined();
  } finally {
    t.close();
  }
});
