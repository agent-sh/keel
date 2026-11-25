import { expect, test } from "bun:test";
import { joinRuns, lensItems, runWords, type EndFacts, type InputFacts, type Mark } from "./lens.ts";

// A branch from kinds: `u:<class>` an input, `s` a turn's start, `a` a reply, `e` its end, `r` a tool result.
function branch(spec: string) {
  const line: Mark[] = [];
  const inputs: Record<string, InputFacts> = {};
  const ends: Record<string, EndFacts> = {};
  spec.split(" ").forEach((w, i) => {
    const id = `e${i + 1}`;
    const [k, arg] = w.split(":");
    const kind = { u: "user", s: "turn_start", a: "assistant", e: "turn_end", r: "tool_result", n: "note" }[k!]!;
    line.push({ id, seq: i + 1, ts: (i + 1) * 60_000, kind });
    if (k === "u") inputs[id] = arg === "you" ? {} : arg === "steer" ? { origin: "steer" } : arg === "restart" ? { origin: "restart" } : arg === "fail" ? { kind: "subagent", status: "failed" } : arg === "land" ? { kind: "landing", landed: 2 } : { kind: arg };
    if (k === "e") ends[id] = { reason: arg ?? "end_turn", cost: 0.5, ms: 1000 };
  });
  return { line, input: (id: string) => inputs[id], end: (id: string) => ends[id] };
}

test("the owner's turn shows his message and its last reply, the work between folded, and the harness's turns as one run", () => {
  const b = branch("u:you s a r a e u:subagent s a e u:fail s a e:error u:land s a e");
  const { items, stable } = lensItems(b.line, b.input, b.end);
  expect(items.map((x) => x.t)).toEqual(["you", "run", "reply", "run"]);
  expect(items[0]).toMatchObject({ id: "e1" });
  expect(items[2]).toMatchObject({ id: "e5", turn: { cost: 0.5 } });
  const run = items[3]!;
  expect(run.t === "run" && run.facts).toMatchObject({ turns: 3, reports: 2, failed: 2, landed: 2, cost: 1.5 });
  expect(stable).toBe(18);
  expect(items.some((x) => x.open)).toBe(false);
});

test("a run that goes on past the last turn's end is open from there, and joins the run before once read again", () => {
  const b = branch("u:you s a e u:subagent s a e u:wait s a");
  const { items, stable } = lensItems(b.line, b.input, b.end);
  expect(stable).toBe(8);
  expect(items.map((x) => [x.t, !!x.open])).toEqual([["you", false], ["reply", false], ["run", false], ["run", true]]);
  const one = joinRuns(items);
  expect(one.length).toBe(3);
  expect(one[2]!.t === "run" && one[2]!.facts).toMatchObject({ turns: 2, reports: 1, wakes: 1, steps: 2 });
  expect(runWords(one[2] as any, { live: true }).came).toBe("Working");
});

test("a steer into the harness's turn is the owner's, and so is its reply; a restart goes on with whose turn it was", () => {
  const b = branch("u:subagent s a u:steer a e:restart u:restart s a e");
  const { items } = lensItems(b.line, b.input, b.end);
  // (The cut turn's last reply, then the reply of the turn the restart went on with: his too.)
  expect(items.map((x) => x.t)).toEqual(["run", "you", "reply", "reply"]);
  expect(items.map((x) => (x.t === "run" ? x.first : x.id))).toEqual(["e1", "e4", "e5", "e9"]);
});
