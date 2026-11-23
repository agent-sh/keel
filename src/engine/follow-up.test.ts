import { describe, expect, test } from "bun:test";
import { capsuleText, costFrom, decideFollowUp, missingFrom, rereadBytes, taskShape, type FollowUpFacts } from "./follow-up.ts";

// The shapes are follow-ups read from a real ledger of agent work (a replay
// of 335 messages to finished agents): the context each had, its cache, the
// task it had just finished and the capsule it would get.
const FABLE = { input: 8, output: 40, cache_read: 0.2, cache_write: 10 };
const shape = (o: Partial<FollowUpFacts>): FollowUpFacts => ({
  used: 0, prefix: 0, warm: true, long: true, price: FABLE, steps: 1, growth: 0, capsule: 0, reread: 0, ended: "completed", ...o,
});

describe("where a follow-up to a finished agent starts", () => {
  test("a large context whose cache lapsed starts fresh from the capsule", () => {
    // 474K tokens, idle 83 minutes past a one-hour cache, its last task 54 steps.
    const p = decideFollowUp(shape({ used: 474_159, prefix: 99_921, warm: false, steps: 54, growth: 3_101, capsule: 9_234, reread: 18_767, missing: ["ui/src/lib/switch.ts"] }));
    expect(p.way).toBe("capsule");
    expect(p.costs.capsule!).toBeLessThan(p.costs.carry! / 2);
    expect(p.tokens.capsule).toBe(99_921 + 9_234);
    expect(p.why).toContain("cache lapsed");
    // What the message names is counted in the words, not named: they are told in timelines.
    expect(p.why).toContain("1 of them named in the message");
    expect(p.why).not.toContain("switch.ts");
  });

  test("a large context with a warm cache starts fresh too: reading it every step costs more than writing a capsule once", () => {
    const p = decideFollowUp(shape({ used: 480_537, prefix: 96_236, warm: true, steps: 99, growth: 1_900, capsule: 7_401, reread: 7_100 }));
    expect(p.way).toBe("capsule");
    expect(p.why).toContain("cache warm");
  });

  test("a small warm context with a short task ahead goes on in its context", () => {
    // 111K tokens of which 66K are the prompt and tools, a 9-step task: going on and a fresh start cost nearly the same,
    // and the fresh start's step to find its place tips it.
    const p = decideFollowUp(shape({ used: 111_056, prefix: 65_632, warm: true, long: false, steps: 9, growth: 9_809, capsule: 7_980 }));
    expect(p.way).toBe("carry");
    expect(p.costs.carry!).toBeLessThan(p.costs.capsule!);
  });

  test("the same context after its cache lapsed starts fresh", () => {
    const p = decideFollowUp(shape({ used: 114_405, prefix: 66_271, warm: false, long: false, steps: 12, growth: 7_366, capsule: 7_964 }));
    expect(p.way).toBe("capsule");
  });

  test("an agent whose last task was cut mid-work goes on in its context, whatever it costs", () => {
    const p = decideFollowUp(shape({ used: 635_626, prefix: 90_000, warm: false, steps: 40, growth: 2_000, capsule: 22_525, ended: "failed" }));
    expect(p.way).toBe("carry");
    expect(p.why).toContain("failed mid-work");
    expect(decideFollowUp(shape({ used: 106_619, prefix: 49_550, steps: 188, capsule: 9_168, ended: "stopped" })).way).toBe("carry");
  });

  test("a model with no listed price (a plan) goes on in its context", () => {
    const p = decideFollowUp(shape({ used: 566_593, prefix: 19_135, price: undefined, steps: 23, growth: 3_079, capsule: 9_818 }));
    expect(p.way).toBe("carry");
    expect(p.costs).toEqual({});
    expect(p.why).toContain("price is not known");
  });

  test("a summary prepared while it was idle, smaller than the capsule, is taken", () => {
    const p = decideFollowUp(shape({ used: 474_159, prefix: 99_921, warm: false, steps: 54, growth: 3_101, capsule: 30_000, prepared: 9_000 }));
    expect(p.way).toBe("summary");
    expect(p.why).toContain("prepared while it was idle");
  });

  test("the owner's choice goes first", () => {
    const big = { used: 474_159, prefix: 99_921, warm: false, steps: 54, growth: 3_101, capsule: 9_234 };
    expect(decideFollowUp(shape({ ...big, force: "carry" }))).toMatchObject({ way: "carry", forced: true });
    // A summary with none prepared is written at the start of the work.
    const s = decideFollowUp(shape({ ...big, force: "summary" }));
    expect(s).toMatchObject({ way: "summary", forced: true });
    expect(s.why).toContain("written now");
    const small = decideFollowUp(shape({ used: 111_056, prefix: 65_632, steps: 9, growth: 9_809, capsule: 7_980, force: "capsule" }));
    expect(small).toMatchObject({ way: "capsule", forced: true });
  });

  test("files read again count against a fresh start", () => {
    const base = { used: 160_000, prefix: 30_000, warm: true, long: true, steps: 20, growth: 1_500, capsule: 8_000 };
    expect(decideFollowUp(shape(base)).way).toBe("capsule");
    // The same follow-up that must read 120K of files again goes on.
    expect(decideFollowUp(shape({ ...base, reread: 120_000 })).way).toBe("carry");
  });
});

describe("the pieces of the price", () => {
  test("a step reads the context from the cache and writes what it adds", () => {
    // One step from 100K of which all is cached: 100K read at $0.2/M.
    expect(costFrom(100_000, 100_000, { steps: 1, growth: 0, long: false, price: FABLE })).toBeCloseTo(0.02, 6);
    // Cold: written at the long lifetime's rate, twice the input price.
    expect(costFrom(100_000, 0, { steps: 1, growth: 0, long: true, price: FABLE })).toBeCloseTo(1.6, 6);
    // Two steps: the second reads the start and writes its growth.
    expect(costFrom(100_000, 100_000, { steps: 2, growth: 1_000, long: false, price: FABLE })).toBeCloseTo(0.02 + 0.02 + 0.01, 6);
    expect(costFrom(1, 1, { steps: 1, growth: 0, long: false })).toBeUndefined();
  });

  test("a task's shape: its steps and what each added", () => {
    expect(taskShape([])).toEqual({ steps: 1, growth: 0 });
    expect(taskShape([50_000])).toEqual({ steps: 1, growth: 0 });
    expect(taskShape([50_000, 52_000, 54_000])).toEqual({ steps: 3, growth: 2_000 });
    // A compaction in the task left it smaller: it added nothing on the whole.
    expect(taskShape([300_000, 40_000])).toEqual({ steps: 2, growth: 0 });
  });

  test("what the message names that the context holds and the capsule leaves out", () => {
    const history = "edited src/a.ts and src/b.ts; commit 464212e4d";
    const named = ["src/a.ts", "src/b.ts", "src/new.ts", "464212e4d"];
    expect(missingFrom(named, "Files written: src/a.ts", (x) => history.includes(x))).toEqual(["src/b.ts", "464212e4d"]);
  });

  test("the files a fresh start reads again, at their newest read", () => {
    const events: any[] = [
      { kind: "assistant", data: { blocks: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/w/src/a.ts" } }] } },
      { kind: "tool_result", data: { results: [{ tool_use_id: "r1", content: "x".repeat(100) }] } },
      { kind: "assistant", data: { blocks: [{ type: "tool_use", id: "r2", name: "Read", input: { file_path: "/w/src/a.ts" } }] } },
      { kind: "tool_result", data: { results: [{ tool_use_id: "r2", content: "x".repeat(300) }] } },
      { kind: "assistant", data: { blocks: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/w/src/new.ts", content: "y".repeat(50) } }] } },
      { kind: "assistant", data: { blocks: [{ type: "tool_use", id: "r3", name: "Read", input: { file_path: "/w/src/other.ts" } }] } },
      { kind: "tool_result", data: { results: [{ tool_use_id: "r3", content: "z".repeat(1000) }] } },
    ];
    expect(rereadBytes(events, ["src/a.ts", "src/new.ts"])).toBe(350);
    expect(rereadBytes(events, [])).toBe(0);
  });

  test("the capsule's words carry the report as the parent got it", () => {
    const t = capsuleText({ title: "Fix the gate", report: "Head abc1234. All checks pass.", tasks: 2 });
    expect(t).toContain('agent "Fix the gate"');
    expect(t).toContain("(task 3)");
    expect(t).toContain("Head abc1234. All checks pass.");
    expect(capsuleText({ title: "x", report: "  ", tasks: 0 })).toContain("(It wrote no report.)");
  });
});
