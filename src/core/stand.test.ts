import { expect, test } from "bun:test";
import { resultText, standLine } from "./stand.ts";
import { hhmm } from "./watch.ts";

const T = Date.UTC(2026, 10, 26, 10, 0);
const MIN = 60_000;

test("a working session says what runs, for how long, when its wait gives up, its agents and its last result", () => {
  const s = standLine({ watch: "work", agents: 3, parked: 1, why: "command", text: "Command in background: make test", since: T - 4 * MIN, deadline: T + 20 * MIN,
    result: { kind: "check", what: "unit", ok: false, at: T - 10 * MIN } }, T);
  expect(s.brief).toBe("Command in background: make test");
  expect(s.full).toBe(`Command in background: make test, for 4m. Its wait gives up at ${hhmm(T + 20 * MIN)}. 2 agents at work, 1 waiting. Last: unit failed at ${hhmm(T - 10 * MIN)}`);
});

test("at rest the line is the last result, and nothing when there is none", () => {
  expect(standLine({ watch: "done", agents: 0, result: { kind: "landed", what: "keel/fix-x", ok: true, at: T, head: "3c73ce59bab" } }, T).brief).toBe("landed keel/fix-x (3c73ce5)");
  expect(standLine({ watch: "idle", agents: 0 }, T)).toEqual({ brief: "", full: "" });
  expect(resultText({ kind: "left", what: "b", ok: false, at: T })).toBe("b left the landing queue");
});

test("a command that runs keeps its own first letter in the whole line", () => {
  expect(standLine({ watch: "work", agents: 0, why: "tool", text: "bun test --slow", since: T - 6000 }, T).full).toBe("bun test --slow, for 6s");
});

test("a wait says when it is due, and a session whose agents work says them", () => {
  expect(standLine({ watch: "wait", agents: 0, why: "timer", text: "Timer: check", since: T - MIN, until: T + 5 * MIN }, T).full).toBe(`Timer: check, due ${hhmm(T + 5 * MIN)}`);
  expect(standLine({ watch: "work", agents: 2, why: "agents" }, T)).toEqual({ brief: "", full: "" });
  expect(standLine({ watch: "done", agents: 2 }, T).brief).toBe("2 agents at work");
});
