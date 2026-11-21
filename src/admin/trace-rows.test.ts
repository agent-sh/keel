// The account of a turn's time, on fixed spans: which stretches no span
// covers and what each is called, and the sums by kind.
import { expect, test } from "bun:test";
import { type SpanLite, turnAccount, turnGaps, waitLabel } from "./trace-rows.ts";

const span = (id: string, kind: string, name: string, start: number, end: number | null, attrs: Record<string, any> = {}, parent: string | null = "turn"): SpanLite =>
  ({ span_id: id, parent_id: parent, kind, name, start_ms: start, end_ms: end, attrs });

test("a turn's gaps are the stretches between its spans, each said as what it most likely was", () => {
  const spans = [
    span("turn", "turn", "invoke_agent", 1_000, 20_000, {}, null),
    span("queue", "wait", "queue wait", 0, 1_000),
    span("r1", "request", "chat m", 1_400, 2_000, { attempt: 1 }),
    span("w1", "wait", "retry wait", 2_010, 6_010, { attempt: 1, max: 4 }),
    span("r2", "request", "chat m", 6_020, 7_000, { attempt: 2 }),
    span("a1", "wait", "approval wait", 7_050, 12_000, { tool: "Bash" }),
    span("t1", "tool", "execute_tool Bash", 12_600, 13_000, { tool: "Bash" }),
    span("t2", "tool", "execute_tool Read", 12_700, 15_000, { tool: "Read" }),
    span("r3", "request", "chat m", 16_500, 19_000, { attempt: 1 }),
    // A subagent's turn under a call is not a direct span of this turn.
    span("child", "turn", "invoke_agent", 12_650, 12_900, {}, "t1"),
  ];
  expect(turnGaps(spans, "turn")).toEqual([
    { after: null, start_ms: 1_000, end_ms: 1_400, label: "Starting the turn: its prompt, system and tools" },
    { after: "a1", start_ms: 12_000, end_ms: 12_600, label: "Before Bash: hooks and checks" },
    { after: "t2", start_ms: 15_000, end_ms: 16_500, label: "After Read: hooks, then the next request" },
    { after: "r3", start_ms: 19_000, end_ms: 20_000, label: "Ending the turn: hooks and what its end sets off" },
  ]);
  // Requests 600 + 980 + 2500, tools side by side counted once (12.6 to 15), waits 4000 + 4950, and what is left.
  expect(turnAccount(spans, "turn")).toEqual({ total: 19_000, request: 4_080, tool: 2_400, wait: 8_950, other: 3_570 });
  expect(spans.filter((s) => s.kind === "wait").map(waitLabel)).toEqual(["Queue wait", "Retry wait before attempt 2", "Approval wait for Bash"]);
});

test("a running turn has no end gap while a span of it still runs, and an unknown turn has none", () => {
  const spans = [span("turn", "turn", "invoke_agent", 0, null, {}, null), span("r1", "request", "chat m", 300, 900), span("t1", "tool", "execute_tool Bash", 950, null, { tool: "Bash" })];
  expect(turnGaps(spans, "turn", 60_000)).toEqual([{ after: null, start_ms: 0, end_ms: 300, label: "Starting the turn: its prompt, system and tools" }]);
  // Between steps, with nothing running: the gap until now is the daemon's own work.
  expect(turnGaps(spans.slice(0, 2), "turn", 5_000).at(-1)).toEqual({ after: "r1", start_ms: 900, end_ms: 5_000, label: "Since then: the next step is being prepared" });
  expect(turnGaps(spans, "nope")).toEqual([]);
  expect(turnAccount(spans, "turn", 2_000)).toEqual({ total: 2_000, request: 600, tool: 1_050, wait: 0, other: 350 });
});
