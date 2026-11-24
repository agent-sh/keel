import { describe, expect, test } from "bun:test";
import { cacheState, capsuleText, costFrom, decideFollowUp, missingFrom, rereadBytes, storyOf, taskShape, type FollowUpFacts } from "./follow-up.ts";

// The shapes are those of follow-ups to finished agents: the context each
// had, its cache, the task it had just finished and the capsule it would get.
// A price per million tokens, with cache writes above input and reads far below.
const PRICE = { input: 8, output: 40, cache_read: 0.2, cache_write: 10 };
const shape = (o: Partial<FollowUpFacts>): FollowUpFacts => ({
  used: 0, prefix: 0, warm: true, long: true, price: PRICE, steps: 1, growth: 0, capsule: 0, reread: 0, ended: "completed", ...o,
});

describe("where a follow-up to a finished agent starts", () => {
  test("a large context whose cache lapsed starts fresh from the capsule", () => {
    // A large context idle past its cache's lifetime, after a long task.
    const p = decideFollowUp(shape({ used: 475_000, prefix: 100_000, warm: false, steps: 54, growth: 3_100, capsule: 9_200, reread: 18_800, missing: ["ui/src/lib/switch.ts"] }));
    expect(p.way).toBe("capsule");
    expect(p.costs.capsule!).toBeLessThan(p.costs.carry! / 2);
    expect(p.tokens.capsule).toBe(100_000 + 9_200);
    expect(p.why).toContain("cache lapsed");
    // What the message names is counted in the words, not named: they are told in timelines.
    expect(p.why).toContain("1 of them named in the message");
    expect(p.why).not.toContain("switch.ts");
  });

  test("a large context with a warm cache starts fresh too: reading it every step costs more than writing a capsule once", () => {
    const p = decideFollowUp(shape({ used: 480_000, prefix: 96_000, warm: true, steps: 99, growth: 1_900, capsule: 7_400, reread: 7_100 }));
    expect(p.way).toBe("capsule");
    expect(p.why).toContain("cache warm");
  });

  test("a small warm context with a short task ahead goes on in its context", () => {
    // Most of the context is the prompt and tools, and the task is short: going on and a fresh start cost nearly the same,
    // and the fresh start's step to find its place tips it.
    const p = decideFollowUp(shape({ used: 111_000, prefix: 65_600, warm: true, long: false, steps: 9, growth: 9_800, capsule: 7_980 }));
    expect(p.way).toBe("carry");
    expect(p.costs.carry!).toBeLessThan(p.costs.capsule!);
  });

  test("the same context after its cache lapsed starts fresh", () => {
    const p = decideFollowUp(shape({ used: 114_000, prefix: 66_000, warm: false, long: false, steps: 12, growth: 7_400, capsule: 8_000 }));
    expect(p.way).toBe("capsule");
  });

  test("an agent whose last task was cut mid-work goes on in its context, whatever it costs", () => {
    const p = decideFollowUp(shape({ used: 635_000, prefix: 90_000, warm: false, steps: 40, growth: 2_000, capsule: 22_500, ended: "failed" }));
    expect(p.way).toBe("carry");
    expect(p.why).toContain("failed mid-work");
    expect(decideFollowUp(shape({ used: 106_000, prefix: 49_500, steps: 188, capsule: 9_200, ended: "stopped" })).way).toBe("carry");
  });

  test("a model with no listed price (a plan) goes on in its context", () => {
    const p = decideFollowUp(shape({ used: 566_000, prefix: 19_000, price: undefined, steps: 23, growth: 3_100, capsule: 9_800 }));
    expect(p.way).toBe("carry");
    expect(p.costs).toEqual({});
    expect(p.why).toContain("price is not known");
  });

  test("a summary prepared while it was idle, smaller than the capsule, is taken", () => {
    const p = decideFollowUp(shape({ used: 475_000, prefix: 100_000, warm: false, steps: 54, growth: 3_100, capsule: 30_000, prepared: 9_000 }));
    expect(p.way).toBe("summary");
    expect(p.why).toContain("prepared while it was idle");
  });

  test("the owner's choice goes first", () => {
    const big = { used: 475_000, prefix: 100_000, warm: false, steps: 54, growth: 3_100, capsule: 9_200 };
    expect(decideFollowUp(shape({ ...big, force: "carry" }))).toMatchObject({ way: "carry", forced: true });
    // A summary with none prepared is written at the start of the work.
    const s = decideFollowUp(shape({ ...big, force: "summary" }));
    expect(s).toMatchObject({ way: "summary", forced: true });
    expect(s.why).toContain("written now");
    const small = decideFollowUp(shape({ used: 111_000, prefix: 65_600, steps: 9, growth: 9_800, capsule: 7_980, force: "capsule" }));
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
    expect(costFrom(100_000, 100_000, { steps: 1, growth: 0, long: false, price: PRICE })).toBeCloseTo(0.02, 6);
    // Cold: written at the long lifetime's rate, twice the input price.
    expect(costFrom(100_000, 0, { steps: 1, growth: 0, long: true, price: PRICE })).toBeCloseTo(1.6, 6);
    // Two steps: the second reads the start and writes its growth.
    expect(costFrom(100_000, 100_000, { steps: 2, growth: 1_000, long: false, price: PRICE })).toBeCloseTo(0.02 + 0.02 + 0.01, 6);
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

  test("a cache the wire does not time is warm for sure only by its own lifetime, and perhaps warm up to the longest", () => {
    const margin = (life: number) => Math.min(60_000, Math.floor(life / 4));
    const now = 10 * 60 * 60_000, min = 60_000;
    // A wire that says nothing of its lifetime (sure 0): perhaps warm within its longest, lapsed past it.
    expect(cacheState({ touched: now - 3 * min, now, sure: 0, max: 5 * min, margin })).toBe("maybe");
    expect(cacheState({ touched: now - 20 * min, now, sure: 0, max: 60 * min, margin })).toBe("maybe");
    expect(cacheState({ touched: now - 61 * min, now, sure: 0, max: 60 * min, margin })).toBe("lapsed");
    // A known lifetime decides alone.
    expect(cacheState({ touched: now - 3 * min, now, sure: 5 * min, max: 60 * min, margin })).toBe("warm");
    expect(cacheState({ touched: now - 20 * min, now, sure: 5 * min, max: 60 * min, margin })).toBe("lapsed");
    expect(cacheState({ touched: now - 20 * min, now, own: 30 * min, sure: 0, max: 60 * min, margin })).toBe("warm");
    expect(cacheState({ touched: 0, now, sure: 0, max: 60 * min, margin })).toBe("lapsed");
  });

  test("a cache that may be warm prices each way between its warm and its lapsed cost", () => {
    const f = { used: 300_000, prefix: 40_000, steps: 20, growth: 2_000, capsule: 8_000, long: false };
    const warm = decideFollowUp(shape({ ...f, warm: true })), cold = decideFollowUp(shape({ ...f, warm: false }));
    const maybe = decideFollowUp(shape({ ...f, warm: false, maybe: true }));
    expect(maybe.costs.carry!).toBeCloseTo((warm.costs.carry! + cold.costs.carry!) / 2, 6);
    expect(maybe.costs.capsule!).toBeCloseTo((warm.costs.capsule! + cold.costs.capsule!) / 2, 6);
    expect(maybe.maybe).toBe(true);
    expect(maybe.why).toContain("perhaps warm");
  });

  test("the capsule keeps the story of the summary before it, and the agent's title as an attribute gave it", () => {
    const t = capsuleText({ title: "Fix the gate", report: "Head abc1234.", tasks: 1, before: "STORY-OLD: chose Z." });
    expect(t).toContain("STORY-OLD: chose Z.");
    expect(t.indexOf("STORY-OLD")).toBeLessThan(t.indexOf("Head abc1234."));
    expect(storyOf("## Statements\nThe conversation's own words:\n- session: \"never push\"\n\n## Story\nSTORY-OLD: chose Z.")).toBe("STORY-OLD: chose Z.");
    expect(storyOf("A handoff note.")).toBe("A handoff note.");
  });

  test("the capsule's words carry the report as the parent got it", () => {
    const t = capsuleText({ title: "Fix the gate", report: "Head abc1234. All checks pass.", tasks: 2 });
    expect(t).toContain('agent "Fix the gate"');
    expect(t).toContain("(task 3)");
    expect(t).toContain("Head abc1234. All checks pass.");
    expect(capsuleText({ title: "x", report: "  ", tasks: 0 })).toContain("(It wrote no report.)");
  });

  test("a capsule's story carries no framing of the capsule before it: six follow-ups hold one intro", () => {
    let story: string | undefined;
    let text = "";
    for (let i = 1; i <= 6; i++) {
      text = capsuleText({ title: "Fix the gate", report: `Report ${i}.`, tasks: i - 1, before: story });
      story = storyOf(`## Statements\n- none\n\n## Story\n${text}`);
    }
    expect(text.match(/You are agent/g)).toHaveLength(1);
    expect(text.match(/Your reports of the work so far/g)).toHaveLength(1);
    expect(text.match(/What your context held before/g)).toHaveLength(1);
    for (let i = 1; i <= 6; i++) expect(text).toContain(`Report ${i}.`);
    expect(text.length).toBeLessThan(1_500);
  });
});
