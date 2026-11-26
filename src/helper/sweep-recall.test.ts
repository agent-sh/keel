// The sweep's recall figures: facts of a native memory, what later steps used of them, the mistakes a
// note forbids made anyway, the one improvement of a system, and when a number moved.
import { expect, test } from "bun:test";
import { indexFacts, judge, lineOf, moved, nextOf, recallOf, stepOf, summaryFacts, STEPS_MAX } from "./sweep-recall.ts";

const step = (text: string, ...calls: { name: string; input: unknown }[]) => stepOf({ blocks: [{ type: "text", text }, ...calls.map((c, i) => ({ type: "tool_use", id: `c${i}`, ...c }))] });

test("an index line is a fact named by its title and its file's stem; a summary's bullets are facts", () => {
  const f = indexFacts("# Memory\n- [Landing queue](project_land_queue.md): the after step runs in the checkout\n- plain bullet with no link\n");
  expect(f).toEqual([
    { names: ["Landing queue", "project land queue"], text: "the after step runs in the checkout (project_land_queue.md)" },
    { names: [], text: "plain bullet with no link" },
  ]);
  expect(summaryFacts("Intro\n- builds: run the focused tests\n- a line\n").map((x) => x.names)).toEqual([["builds"], []]);
});

test("a step's words and calls: system text is not the model's, a shell call reads as the store's Bash", () => {
  const s = stepOf({ blocks: [{ type: "text", text: "said" }, { type: "text", text: "harness", system: true }, { type: "tool_use", id: "1", name: "exec_command", input: { cmd: "git stash" } }] });
  expect(s.text).toBe("said");
  expect(s.acted).toBe("git stash");
  expect(s.calls).toEqual([{ tool_name: "Bash", tool_input: { command: "git stash" } }]);
  expect(stepOf(null)).toEqual({ text: "", acted: "", calls: [] });
});

test("a load is judged on the steps after it: a fact named or touched is used, a forbidden call is a repeated mistake", () => {
  const facts = indexFacts("- [Landing queue](land.md): the after step runs in the checkout\n- [Phone walk](phone.md): keeps shots from the dev desk\n- [Unused](unused.md): nothing here\n");
  const steps = [step("I will use the landing queue now"), step("ok", { name: "Bash", input: { command: "cat phone.md && git stash" } })];
  const j = judge(facts, ["git stash", "rm -rf"], steps);
  expect(j).toEqual({ given: 3, used: [true, true, false], broken: ["git stash"] });
  // Past STEPS_MAX replies a step is not read for the load.
  const late = [...Array.from({ length: STEPS_MAX }, () => step("nothing")), step("landing queue")];
  expect(judge(facts, [], late).used).toEqual([false, false, false]);
  // A note the session's tools read or wrote is used, however late.
  expect(judge(facts, [], late, ["/m/unused.md"]).used).toEqual([false, false, true]);
});

test("a day's recall sums the judged loads, counts tokens of every load, and ranks the bans by sessions", () => {
  const facts = indexFacts("- [A](a.md): one\n- [B](b.md): two\n");
  const r = recallOf([
    { facts, judged: { given: 2, used: [true, false], broken: ["git stash"] }, tokens: 100 },
    { facts, judged: { given: 2, used: [true, false], broken: ["git stash", "rm -rf"] }, tokens: 100 },
    { facts, judged: null, tokens: 50 },
  ]);
  expect(r).toMatchObject({ sessions: 3, judged: 2, given: 4, used: 2, mistakes: 3, tokens: 250 });
  expect(r.facts).toEqual([{ name: "A", given: 2, used: 2 }, { name: "B", given: 2, used: 0 }]);
  expect(r.broken[0]).toEqual({ ban: "git stash", sessions: 2 });
});

test("the improvement: a repeated mistake first, then facts never used, then what the system adds", () => {
  const base = { label: "x", given: 10, used: 2, mistakes: 0, tokens: 1000 };
  expect(nextOf(base)).toBeNull();
  const idle = nextOf({ ...base, facts: [{ name: "A", given: 4, used: 0 }, { name: "B", given: 1, used: 0 }, { name: "C", given: 5, used: 3 }] });
  expect(idle!.text).toContain("1 fact given and never used (A)");
  expect(idle!.text).toContain("about 400 tokens in the day");
  expect(nextOf({ ...base, days: 14, facts: [{ name: "A", given: 4, used: 0, tokens: 90 }] })!.text).toContain("about 90 tokens in 14 days");
  const ban = nextOf({ ...base, facts: [{ name: "A", given: 4, used: 0 }], broken: [{ ban: "git stash", sessions: 2 }] });
  expect(ban!.text).toContain("`git stash` ran after a note forbade it in 2 sessions");
  expect(nextOf({ ...base, extra: [{ text: "own", score: 5 }] })!.text).toBe("own");
});

test("a number moved: more mistakes, a share that changed on enough facts, tokens that doubled; else nothing", () => {
  const m = (given: number, used: number, mistakes = 0, tokens = 0) => ({ given, used, mistakes, tokens });
  expect(moved(undefined, m(40, 10), "t")).toBeNull();
  expect(moved(m(40, 10), m(40, 12), "t")).toBeNull();
  expect(moved(m(40, 10), m(40, 20), "t")).toBe("t: 50% of facts used, up from 25%");
  expect(moved(m(10, 1), m(10, 9), "t")).toBeNull(); // too few facts to tell
  expect(moved(m(40, 10, 0), m(40, 10, 1), "t")).toBe("t: 1 repeated mistake, up from 0");
  expect(moved(m(40, 10, 2), m(40, 10, 1), "t")).toBeNull();
  expect(moved(m(40, 10, 0, 3000), m(40, 10, 0, 7000), "t")).toBe("t: recall cost 7000 tokens, up from 3000");
  expect(moved(m(40, 10, 0, 300), m(40, 10, 0, 900), "t")).toBeNull();
});

test("the helper's line names each measured system once and leaves out the empty ones", () => {
  expect(lineOf([{ label: "a", short: "tacit", measure: { given: 10, used: 3, mistakes: 0, tokens: 1 } }, { label: "b", short: "Claude", measure: { given: 4, used: 1, mistakes: 2, tokens: 0 } }, { label: "c", short: "Codex", measure: { given: 0, used: 0, mistakes: 0, tokens: 0 } }]))
    .toBe("tacit 30% used; Claude 25% used, 2 repeats");
  expect(lineOf([])).toBe("nothing recalled to judge");
});
