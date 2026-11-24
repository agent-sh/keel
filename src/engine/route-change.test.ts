import { expect, test } from "bun:test";
import { check, dueIn, judge, judgeMove, noteText, parentLine, ruleFor, type Rule, type Target } from "./route-change.ts";

const rule = (r: Partial<Rule> = {}): Rule => ({ role: "", minutes: 10, to: "b:big", ...r });
const listing: Target[] = [
  { id: "a:one", name: "One", provider: "a" },
  { id: "b:big", name: "Big", provider: "b", tools: true },
  { id: "c:chat", name: "Chat", provider: "c", tools: false },
];
const up = { out: "a", down: [], busy: [] };

test("the settings are checked before they are saved", () => {
  expect(check({ rules: [] })).toBeUndefined();
  expect(check({ rules: [rule({ role: "Explore", from: "a" })] })).toBeUndefined();
  expect(check({})).toMatch(/list/);
  expect(check({ rules: [rule({ minutes: 0 })] })).toMatch(/above 0/);
  expect(check({ rules: [rule({ minutes: Number.NaN })] })).toMatch(/above 0/);
  expect(check({ rules: [rule({ to: "big" })] })).toMatch(/provider:model/);
  expect(check({ rules: [rule({ to: "b:" })] })).toMatch(/provider:model/);
  expect(check({ rules: [rule({ from: "b" })] })).toMatch(/another provider/);
  expect(check({ rules: [rule({ from: "a:x" })] })).toMatch(/provider id/);
  expect(check({ rules: [rule(), { role: 3 }] })).toMatch(/^rule 2: role/);
});

test("a session that is no agent has no rule", () => {
  expect(ruleFor([rule()], undefined, "a")).toBeUndefined();
});

test("the rule that names the agent's type beats the one for every agent, and a named provider beats any", () => {
  const every = rule({ to: "b:every" });
  const explore = rule({ role: "explore", to: "b:explore" });
  const fromA = rule({ from: "a", to: "b:froma" });
  expect(ruleFor([every, explore], "Explore", "a")).toBe(explore);
  expect(ruleFor([every, explore], "general-purpose", "a")).toBe(every);
  expect(ruleFor([every, fromA], "general-purpose", "a")).toBe(fromA);
  expect(ruleFor([every, fromA], "general-purpose", "z")).toBe(every);
  // The type outweighs the provider.
  expect(ruleFor([fromA, explore], "Explore", "a")).toBe(explore);
  // The first of equals.
  expect(ruleFor([every, rule({ to: "c:later" })], "x", "a")).toBe(every);
  expect(ruleFor([rule({ role: "*" })], "x", "a")).toBeDefined();
});

test("a rule whose model is on the agent's provider is no rule", () => {
  expect(ruleFor([rule({ to: "a:two" })], "x", "a")).toBeUndefined();
});

test("the time is counted from when the route went out", () => {
  const r = rule({ minutes: 2 });
  expect(dueIn(r, 1_000, 1_000)).toBe(120_000);
  expect(dueIn(r, 1_000, 61_000)).toBe(60_000);
  // An agent that joins an outage that is old already is due at once.
  expect(dueIn(r, 1_000, 500_000)).toBe(0);
  expect(dueIn(rule({ minutes: 0.05 }), 0, 0)).toBe(3_000);
});

test("the model is a target only when it is listed, takes tools and is somewhere that works", () => {
  expect(judge(rule(), listing, up)).toEqual({ ok: true, model: listing[1]! });
  expect(judge(rule({ to: "b:gone" }), listing, up)).toMatchObject({ ok: false, why: "b:gone is not in the listing" });
  expect(judge(rule({ to: "c:chat" }), listing, up)).toMatchObject({ ok: false, why: "Chat takes no tools" });
  expect(judge(rule({ to: "a:one" }), listing, up)).toMatchObject({ ok: false, why: "One is on the provider that is out" });
  expect(judge(rule(), listing, { ...up, down: ["b"] })).toMatchObject({ ok: false, why: expect.stringContaining("cannot be reached either") });
  expect(judge(rule(), listing, { ...up, busy: ["b:big"] })).toMatchObject({ ok: false, why: expect.stringContaining("overloaded too") });
  expect(judge(rule(), listing, { ...up, shut: "out of credit" })).toMatchObject({ ok: false, why: expect.stringContaining("out of credit") });
});

test("what the agent and its parent are told", () => {
  const o = { why: "outage" as const, from: "One", to: "b:big", ms: 10 * 60_000 };
  expect(noteText({ ...o, to: "Big" })).toBe("The provider of One could not be reached for 10 min. By the owner's rule for a route that is out, this agent continues on Big from here and finishes there.");
  expect(noteText({ ...o, why: "overloaded", ms: 45_000 })).toMatch(/^One answered that it is overloaded for 45 s\./);
  const line = parentLine({ ...o, title: "Scout", id: "ag-1" });
  expect(line).toMatch(/^\[harness\] Agent "Scout" \(ag-1\) was waiting: the provider of One could not be reached for 10 min\./);
  expect(line).toContain("moved it to b:big");
  expect(line).not.toContain("—");
});

test("a move that would ask the owner is not made: an agent cannot be asked", () => {
  const ok = { warning: null, over: false, askUsd: 0.25 };
  // Nothing warm is lost: it goes, and costs nothing past staying.
  expect(judgeMove(ok, "Big")).toEqual({ ok: true });
  // A warm cache that costs less than the owner's limit: it goes, and the figure is told.
  expect(judgeMove({ ...ok, warning: { cost_usd: 0.1, cached_cost_usd: 0.01 } }, "Big")).toEqual({ ok: true, extra: 0.09000000000000001 });
  // At or past the limit: skipped, with the figure and the limit.
  const dear = judgeMove({ ...ok, warning: { cost_usd: 1.4, cached_cost_usd: 0.1 } }, "Big");
  expect(dear).toMatchObject({ ok: false, why: expect.stringContaining("$1.30 more than staying, past the $0.25") });
  expect(judgeMove({ ...ok, askUsd: 0, warning: { cost_usd: 0.1, cached_cost_usd: 0.1 } }, "Big")).toMatchObject({ ok: false });
  // A target with no price that loses a warm cache: its cost cannot be shown to be small.
  expect(judgeMove({ ...ok, warning: { cost_usd: undefined } }, "Big")).toMatchObject({ ok: false, why: expect.stringContaining("lists no price") });
  // A context past where the target compacts: not moved there.
  expect(judgeMove({ ...ok, over: true }, "Big")).toMatchObject({ ok: false, why: expect.stringContaining("does not fit Big") });
});

test("the move says what it carried and what it cost", () => {
  const o = { why: "outage" as const, from: "One", to: "Big", ms: 600_000 };
  expect(noteText({ ...o, effort: { from: "xhigh", to: "high" }, extra: 0.18 })).toContain("Effort xhigh is now high. Re-reading its context there costs about $0.18 more than staying.");
  expect(noteText({ ...o, effort: { from: "max" } })).toContain("does not take effort max: it runs at its default.");
  expect(noteText({ ...o, effort: { from: "high", to: "high" } })).not.toContain("Effort");
  expect(parentLine({ ...o, title: "Scout", id: "ag-1", extra: 0.005 })).toContain("it finishes there. Re-reading its context there costs about $0.005 more than staying. Its report");
});
