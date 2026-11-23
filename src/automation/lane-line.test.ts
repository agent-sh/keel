import { describe, expect, test } from "bun:test";
import { checksWords, hoursTail, laneLines, laneText, statedPlan, type LaneFacts, type LaneLine } from "./lane-line.ts";
import { stateWords } from "../core/state-words.ts";

const at = (h: number, m: number) => new Date(2026, 10, 21, h, m).getTime();
const NOW = at(14, 10);
const base = (over: Partial<LaneFacts>): LaneFacts => ({ now: NOW, live: true, said: stateWords({ watch: "work" }), ...over });
const byKey = (lines: LaneLine[]) => Object.fromEntries(lines.map((l) => [l.key, l])) as Record<LaneLine["key"], LaneLine>;

describe("an agent's lane in five lines", () => {
  test("working: its call as the transcript says it, the command it waits on and since when, its plan in its words", () => {
    const l = byKey(laneLines(base({
      doing: { text: "Running bun test", from: "tool", steps: 4, since: at(14, 0) },
      call: { line: "Running bun test", shell: true, since: at(14, 8) },
      state: { watch: "work", why: "tool", since: at(14, 8) },
      hours: { wall_ms: 600_000, classes: { model: 360_000, tools: 200_000, unknown: 40_000 } },
      worktree: true,
      git: { branch: "keel/x", head: "abc1234", subject: "Add a", commits: 1, files: 2, added: 10, removed: 1, names: ["a.ts", "b.ts"] },
      checks: { tree: [{ name: "unit", result: "fail", pass: 3, fail: 2, ended: at(14, 5) }], earlier: [] },
      plan: [{ text: "Write the test", status: "completed" }, { text: "Run the tests", status: "in_progress" }],
    })));
    // (A live agent's hours are not said: its running step has no record yet.)
    expect(l.doing).toMatchObject({ text: "Running bun test. 4 steps", from: "fact" });
    expect(l.waits).toMatchObject({ text: "Its command, running since 14:08 (2 min): Running bun test", from: "fact", at: at(14, 8) });
    expect(l.wrong).toMatchObject({ text: "Nothing failed in its scope", from: "fact" });
    expect(l.changed.text).toBe("2 files (+10 \u22121) on keel/x at abc1234 \u201cAdd a\u201d: a.ts, b.ts, 1 commit over its base. Checks on this tree: unit failed (2 failed)");
    expect(l.next).toMatchObject({ text: "\u201cRun the tests\u201d (its plan, 1 of 2 done)", from: "own" });
  });

  test("a sentence of its thinking is its own words, said as such", () => {
    const l = byKey(laneLines(base({ doing: { text: "Reading the schema.", from: "thinking", steps: 1, since: at(14, 0) } })));
    expect(l.doing).toMatchObject({ text: "\u201cReading the schema.\u201d (its thinking). 1 step", from: "own" });
  });

  test("waiting on a command it left in the background, with since when", () => {
    const l = byKey(laneLines(base({
      said: stateWords({ watch: "wait", why: "command" }),
      state: { watch: "wait", why: "wait", since: at(14, 1) },
      waitsOn: "background command j7 (the long build)",
      doing: { text: "Waiting for background command j7 (the long build)", from: "wait", steps: 2, since: at(14, 0) },
    })));
    expect(l.waits).toMatchObject({ text: "Background command j7 (the long build) since 14:01 (9 min)", tone: "wait" });
    expect(l.doing.text).toBe("No step runs: its turn ended, and it goes on when what it waits for comes. 2 steps");
    // Its line not made yet (a line is told at most every 15 s): the same, from what it waits on.
    expect(byKey(laneLines(base({ waitsOn: "background command j7", doing: { text: "", from: "none", steps: 1, since: at(14, 0) } }))).doing.text).toBe("No step runs: its turn ended, and it goes on when what it waits for comes. 1 step");
    // Its turn ended and the command works on: its session says so, and the line is the same.
    expect(byKey(laneLines(base({ state: { watch: "work", why: "command", since: at(14, 1) }, waitsOn: "background command j7 (the long build)" }))).waits.text).toBe("Background command j7 (the long build) since 14:01 (9 min)");
  });

  test("waiting on the owner: what it asks, since when", () => {
    const l = byKey(laneLines(base({ said: stateWords({ watch: "need", why: "question" }), state: { watch: "need", why: "question", text: "Which store should I use?", since: at(14, 6) } })));
    expect(l.waits).toMatchObject({ text: "You since 14:06 (4 min): Which store should I use?", tone: "need" });
  });

  test("in line for a slot of its parent", () => {
    expect(byKey(laneLines(base({ slot: true, state: { watch: "wait", since: at(14, 9) } }))).waits.text).toBe("A free agent slot of its parent since 14:09 (1 min)");
  });

  test("failed: its latest failure in its scope, with how often", () => {
    const l = byKey(laneLines(base({
      live: false,
      said: stateWords({ watch: "fail", cls: "quota" }),
      ended: { at: at(14, 3), steps: 1 },
      failure: { kind: "agent", cls: "quota", text: "Scripted: your credit balance is too low.\nmore", at: at(14, 3), count: 2 },
      wrote: { names: [], n: 0 },
    })));
    expect(l.doing.text).toStartWith(`${stateWords({ watch: "fail", cls: "quota" }).phrase} at 14:03 after 1 step`);
    expect(l.waits.text).toBe("Nothing: it has ended");
    expect(l.wrong).toMatchObject({ text: "It failed at 14:03, 2 times (quota): Scripted: your credit balance is too low.", tone: "fail" });
    expect(l.changed.text).toBe("No file written, no worktree of its own");
    expect(l.next.text).toBe("Nothing until a message continues it");
  });

  test("a failed agent with no recorded failure says the fact is missing", () => {
    const l = byKey(laneLines(base({ live: false, said: stateWords({ watch: "fail" }), ended: { at: at(14, 3), steps: 0 } })));
    expect(l.wrong.from).toBe("missing");
  });

  test("done: how it ended, the files it wrote, its report went to its parent", () => {
    const l = byKey(laneLines(base({
      live: false,
      said: stateWords({ watch: "done" }),
      ended: { at: at(14, 9), steps: 3 },
      hours: { wall_ms: 600_000, classes: { model: 360_000, tools: 200_000, unknown: 40_000 } },
      wrote: { names: ["a.ts", "b.ts", "c.ts", "d.ts"], n: 4 },
      checks: { tree: [], earlier: [{ name: "unit", result: "pass", pass: 5, fail: 0, ended: at(14, 4) }] },
      plan: [{ text: "Write it", status: "completed" }],
    })));
    expect(l.doing.text).toBe(`${stateWords({ watch: "done" }).phrase} at 14:09 after 3 steps. Of 10 min: model requests 6 min, commands and tools 3 min`);
    expect(l.changed.text).toBe("4 files written in the shared folder, no worktree of its own: a.ts, b.ts, c.ts and 1 more. No check ran on this tree; on an earlier one: unit passed (5 passed) at 14:04");
    expect(l.next.text).toBe("Nothing: its report went to its parent");
  });

  test("an ended agent with an open plan says what it left", () => {
    const l = byKey(laneLines(base({ live: false, said: stateWords({ watch: "stop" }), plan: [{ text: "Run the tests", status: "pending" }] })));
    expect(l.next).toMatchObject({ text: "Left in its plan, 0 of 1 done: \u201cRun the tests\u201d", from: "own" });
  });

  test("its worktree: files not committed are said so", () => {
    const g = { branch: "keel/b", head: "78fff1f", subject: "first", commits: 0, files: 1, dirty: 1, added: 0, removed: 0, names: ["notes/plan.md"] };
    expect(byKey(laneLines(base({ worktree: true, git: g }))).changed.text).toBe("1 file on keel/b at 78fff1f \u201cfirst\u201d, not committed: notes/plan.md");
    expect(byKey(laneLines(base({ worktree: true, git: { ...g, files: 3, dirty: 1, commits: 2, added: 5, removed: 2, names: ["a", "b", "c"] } }))).changed.text).toBe("3 files (+5 \u22122) on keel/b at 78fff1f \u201cfirst\u201d, 1 not committed: a, b, c, 2 commits over its base");
    expect(byKey(laneLines(base({ worktree: true, git: { ...g, files: 0, dirty: 0, names: [] } }))).changed.text).toBe("No file changed on keel/b at 78fff1f \u201cfirst\u201d");
  });

  test("a missing fact is said to be missing, never guessed", () => {
    const l = byKey(laneLines(base({ worktree: true })));
    expect(l.doing).toMatchObject({ text: "No step of its current task seen yet", from: "missing" });
    expect(l.changed).toMatchObject({ text: "Its worktree was not read", from: "missing" });
    expect(l.next).toMatchObject({ text: "It has stated no plan", from: "missing" });
    expect(byKey(laneLines(base({ worktree: true, git: { why: "not a git repository" } }))).changed.text).toBe("Its worktree could not be read: not a git repository");
    expect(byKey(laneLines(base({}))).changed).toMatchObject({ text: "What it wrote was not read", from: "missing" });
  });

  test("with no plan, its last sentence that states one, quoted", () => {
    expect(statedPlan("The schema has the column. Next I run the migration and check the counts.")).toBe("Next I run the migration and check the counts.");
    expect(statedPlan("Done. All 12 tests pass.")).toBe("");
    expect(statedPlan("```\nlet me = 1\n```\nNothing else.")).toBe("");
    const l = byKey(laneLines(base({ words: "Read the file. I'll fix the parser next." })));
    expect(l.next).toMatchObject({ text: "\u201cI'll fix the parser next.\u201d (its last words)", from: "own" });
  });

  test("checks: the newest run of each on its tree", () => {
    expect(checksWords({ tree: [{ name: "unit", result: "fail", pass: 1, fail: 1, ended: 1 }, { name: "unit", result: "pass", pass: 2, fail: 0, ended: 2 }, { name: "typecheck", result: "pass", pass: null, fail: null, ended: 3 }], earlier: [] }, NOW))
      .toBe("Checks on this tree: typecheck passed, unit passed (2 passed)");
    expect(checksWords({ tree: [], earlier: [] }, NOW)).toBe("No check ran on it");
    expect(checksWords(null, NOW)).toBe("");
  });

  test("hours: the two largest classes, nothing for an unaccounted rest", () => {
    expect(hoursTail({ wall_ms: 120_000, classes: { unknown: 100_000, owner: 20_000 } })).toBe("Of 2 min: waiting for the owner 20 s");
    expect(hoursTail({ wall_ms: 0, classes: {} })).toBe("");
    expect(hoursTail(null)).toBe("");
  });

  test("the text form: a line a key", () => {
    expect(laneText(laneLines(base({}))).split("\n").map((l) => l.split(":")[0])).toEqual(["Doing", "Waits for", "Went wrong", "Changed", "Next"]);
  });
});
