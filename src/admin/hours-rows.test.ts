import { expect, test } from "bun:test";
import { hoursText, openerClass, paint, treeHours, type HourInput, type HourSpan } from "./hours-rows.ts";

const S = 1000, M = 60_000;
let n = 0;
const span = (session_id: string, parent_id: string | null, kind: string, name: string, start_ms: number, end_ms: number | null, extra: Partial<HourSpan> = {}): HourSpan =>
  ({ span_id: extra.span_id ?? `s${++n}`, parent_id, session_id, kind, name, start_ms, end_ms, ...extra });
const sum = (c: Record<string, number | undefined>) => Object.values(c).reduce<number>((a, b) => a + (b ?? 0), 0);

test("the strongest layer takes each moment, one class a run, and an uncovered moment is unknown", () => {
  const segs = paint([
    { from: 0, to: 100, cls: "keel", prio: 1 },
    { from: 10, to: 40, cls: "model", prio: 5 },
    { from: 30, to: 60, cls: "tools", prio: 3 },
    { from: 60, to: 70, cls: "tools", prio: 3 },
  ], 0, 120, "a");
  expect(segs.map((s) => [s.cls, s.from, s.to])).toEqual([["keel", 0, 10], ["model", 10, 40], ["tools", 40, 70], ["keel", 70, 100], ["unknown", 100, 120]]);
});

test("what started a turn says what the time before it waited for", () => {
  expect(openerClass({ kind: "steer" }, true)).toBe("review");
  expect(openerClass({ kind: "steer" }, false)).toBe("owner");
  expect(openerClass({ kind: "subagent" }, false)).toBe("agents");
  expect(openerClass({ kind: "wait" }, true)).toBe("wait");
  expect(openerClass({ origin: "restart" }, true)).toBe("restart");
  expect(openerClass(undefined, false)).toBe("owner");
});

// An agent's life: started, held for a slot, a turn of a request and a
// command, its report, its parent's review, a turn cut by a restart and resumed.
function agentLife(): HourInput {
  const a = "agent-1";
  const t0 = 1_000 * M;
  return {
    now: t0 + 60 * M, root: a,
    members: [{ session_id: a, parent_session: "parent", agent_id: "ag1", title: "Lane", start: t0, end: t0 + 40 * M, held: [t0] }],
    turns: [
      { session_id: a, start: t0 + 2 * M, end: t0 + 12 * M, opener: { kind: "task" } },
      { session_id: a, start: t0 + 20 * M, end: t0 + 25 * M, opener: { kind: "steer" } },
      { session_id: a, start: t0 + 30 * M, end: t0 + 40 * M, opener: { origin: "restart" } },
    ],
    spans: [
      span(a, null, "turn", "invoke_agent", t0 + 2 * M, t0 + 12 * M, { span_id: "T1" }),
      span(a, "T1", "request", "chat x", t0 + 2 * M, t0 + 6 * M),
      span(a, "T1", "tool", "execute_tool Bash", t0 + 6 * M + 10 * S, t0 + 11 * M, { tool: "Bash" }),
      span(a, null, "turn", "invoke_agent", t0 + 20 * M, t0 + 25 * M, { span_id: "T2" }),
      span(a, "T2", "request", "chat x", t0 + 20 * M, t0 + 25 * M),
      span(a, null, "turn", "invoke_agent", t0 + 30 * M, t0 + 40 * M, { span_id: "T3" }),
      span(a, "T3", "request", "chat x", t0 + 30 * M, t0 + 40 * M),
    ],
    waits: [],
    restarts: [{ from: t0 + 26 * M, to: t0 + 28 * M }],
  };
}

test("an agent's life is put in classes that add up to its wall time", () => {
  const input = agentLife();
  // The second turn was cut by the restart: it ran until the daemon went down.
  input.turns[1]!.end = input.spans[4]!.end_ms = input.spans[3]!.end_ms = 1_000 * M + 26 * M;
  const t = treeHours(input)!;
  expect(t.wall_ms).toBe(40 * M);
  expect(sum(t.classes)).toBe(40 * M);
  expect(t.accounted).toBe(1);
  expect(t.classes.slot).toBe(2 * M);
  expect(t.classes.model).toBe(4 * M + 6 * M + 10 * M);
  expect(t.classes.tools).toBe(5 * M - 10 * S);
  // Between its report and its parent's steer.
  expect(t.classes.review).toBe(8 * M);
  // Only that wait is read from what started the next turn; the rest is in records.
  expect(t.inferred).toBe(0.2);
  // Down two minutes, then two more until the cut turn went on.
  expect(t.classes.restart).toBe(4 * M);
  expect(t.classes.keel).toBe(10 * S + M);
  expect(t.top).toBe("model");
  expect(t.line).toBe("Of 40 min, the most went to model requests: 20 min (50%).");
});

test("a turn its events hold but no span covers is not accounted for", () => {
  const input = agentLife();
  input.spans = input.spans.filter((s) => !["T3"].includes(s.span_id) && s.parent_id !== "T3");
  const t = treeHours(input)!;
  expect(t.classes.unknown).toBe(10 * M);
  expect(t.accounted).toBe(0.75);
});

test("a tree's time is read along its critical path: the agent waited on longest", () => {
  const root = "root", fast = "fast", slow = "slow";
  const input: HourInput = {
    now: 100 * M, root,
    members: [
      { session_id: root, parent_session: null, title: "Coordinator", start: 0, end: 10 * M },
      { session_id: fast, parent_session: root, agent_id: "f", title: "Fast lane", start: 2 * M, end: 20 * M },
      { session_id: slow, parent_session: root, agent_id: "s", title: "Slow lane", start: 2 * M, end: 50 * M },
    ],
    turns: [
      { session_id: root, start: 0, end: 2 * M, opener: { kind: "owner" } },
      { session_id: root, start: 50 * M, end: 52 * M, opener: { kind: "subagent" } },
      { session_id: fast, start: 2 * M, end: 20 * M, opener: { kind: "task" } },
      { session_id: slow, start: 2 * M, end: 10 * M, opener: { kind: "task" } },
      { session_id: slow, start: 30 * M, end: 50 * M, opener: { kind: "wait" } },
    ],
    spans: [
      span(root, null, "turn", "invoke_agent", 0, 2 * M, { span_id: "R1" }),
      span(root, "R1", "request", "chat", 0, 2 * M),
      span(root, null, "turn", "invoke_agent", 50 * M, 52 * M, { span_id: "R2" }),
      span(root, "R2", "request", "chat", 50 * M, 52 * M),
      span(fast, null, "turn", "invoke_agent", 2 * M, 20 * M, { span_id: "F1" }),
      span(fast, "F1", "tool", "execute_tool Bash", 2 * M, 20 * M, { tool: "Bash" }),
      span(slow, null, "turn", "invoke_agent", 2 * M, 10 * M, { span_id: "S1" }),
      span(slow, "S1", "request", "chat", 2 * M, 10 * M),
      span(slow, null, "turn", "invoke_agent", 30 * M, 50 * M, { span_id: "S2" }),
      span(slow, "S2", "request", "chat", 30 * M, 50 * M),
    ],
    waits: [{ session_id: slow, from: 10 * M, to: 30 * M }],
    restarts: [],
  };
  input.members[0]!.end = 52 * M;
  const t = treeHours(input)!;
  expect(t.wall_ms).toBe(52 * M);
  expect(sum(t.classes)).toBe(52 * M);
  // The slow lane's model time and its wait, never the fast lane's command beside it.
  expect(t.classes).toEqual({ model: 2 * M + 8 * M + 20 * M + 2 * M, wait: 20 * M });
  expect(t.top_in[0]!.title).toBe("Slow lane");
  expect(t.line).toBe('Of 52 min, the most went to model requests: 32 min (62%), most in "Slow lane".');
  // Each agent's own split stays its own.
  expect(t.members.find((m) => m.session_id === fast)!.classes).toEqual({ tools: 18 * M });
  expect(t.members.find((m) => m.session_id === root)!.classes).toEqual({ model: 4 * M, agents: 48 * M });
  const text = hoursText(t);
  expect(text).toContain("Of the wall time: 100% from records, 0% read from what started the next turn");
  // How a tree is read is said with its numbers.
  expect(text).toContain("while a session waits for its agents, the time counts as the agent that ends last");
  expect(text).toContain('- s "Slow lane": 48 min; model 58%, waits 42%');
});

test("a class no record covers is said to be inferred: in the headline, the shares and the text form", () => {
  const root = "solo";
  const input: HourInput = {
    now: 100 * M, root,
    members: [{ session_id: root, parent_session: null, title: "Solo", start: 0, end: 35 * M }],
    turns: [
      { session_id: root, start: 0, end: 5 * M, opener: { kind: "owner" } },
      { session_id: root, start: 30 * M, end: 35 * M, opener: { kind: "owner" } },
    ],
    spans: [
      span(root, null, "turn", "invoke_agent", 0, 5 * M, { span_id: "A" }),
      span(root, "A", "request", "chat", 0, 5 * M),
      span(root, null, "turn", "invoke_agent", 30 * M, 35 * M, { span_id: "B" }),
      span(root, "B", "request", "chat", 30 * M, 35 * M),
    ],
    waits: [], restarts: [],
  };
  const t = treeHours(input)!;
  expect([t.top, t.inferred_ms.owner, t.recorded, t.inferred, t.accounted]).toEqual(["owner", 25 * M, 10 / 35, 25 / 35, 1]);
  expect(t.line).toBe("Of 35 min, the most went to waiting for the owner: 25 min (71%), read from what started the next turn (no record covers it).");
  const text = hoursText(t);
  expect(text).toContain("owner 25 min (71%, inferred), model 10 min (29%)");
  expect(text).toContain("Of the wall time: 28.5% from records, 71.4% read from what started the next turn");
});
