import { describe, expect, test } from "bun:test";
import { budgetOfMeta, budgetWords, closingText, mergeBudget, parseBudget, spentOn } from "./budget.ts";

const used = (steps: number, minutes: number, usd: number) => ({ steps, ms: minutes * 60_000, usd });

describe("an agent's budget", () => {
  test("each limit is reached at its value, not before", () => {
    expect(spentOn({ steps: 3 }, used(2, 0, 0))).toBeUndefined();
    expect(spentOn({ steps: 3 }, used(3, 0, 0))).toBe("steps");
    expect(spentOn({ minutes: 1 }, used(0, 0.99, 0))).toBeUndefined();
    expect(spentOn({ minutes: 1 }, used(0, 1, 0))).toBe("minutes");
    expect(spentOn({ usd: 0.05 }, used(9, 9, 0.049))).toBeUndefined();
    expect(spentOn({ usd: 0.05 }, used(9, 9, 0.051))).toBe("usd");
  });

  test("no budget is never spent, and the first limit reached is named", () => {
    expect(spentOn(undefined, used(1e6, 1e6, 1e6))).toBeUndefined();
    expect(spentOn({ steps: 10, usd: 1 }, used(2, 0, 3))).toBe("usd");
    expect(spentOn({ steps: 2, usd: 1 }, used(2, 0, 3))).toBe("steps");
  });

  test("a budget given to a tool is checked", () => {
    expect(parseBudget(undefined)).toBeUndefined();
    expect(parseBudget({})).toBeUndefined();
    expect(parseBudget({ steps: 3, usd: "0.5" })).toEqual({ steps: 3, usd: 0.5 });
    expect(() => parseBudget({ steps: 0 })).toThrow("above 0");
    expect(() => parseBudget({ steps: 2.5 })).toThrow("whole");
    expect(() => parseBudget({ turns: 3 })).toThrow("not turns");
    expect(() => parseBudget(5)).toThrow("object");
  });

  test("a definition's frontmatter sets one, and the call's limits win", () => {
    expect(budgetOfMeta({ budget_steps: "12" })).toEqual({ steps: 12 });
    expect(budgetOfMeta({ maxTurns: "12" })).toBeUndefined();
    expect(budgetOfMeta({ budget_minutes: "30", budget_usd: "5" })).toEqual({ minutes: 30, usd: 5 });
    expect(budgetOfMeta({ budget_steps: "none" })).toBeUndefined();
    expect(mergeBudget({ steps: 12, usd: 5 }, { steps: 3 })).toEqual({ steps: 3, usd: 5 });
    expect(mergeBudget(undefined, undefined)).toBeUndefined();
  });

  test("the last step's words name the limit and what was used", () => {
    expect(budgetWords({ steps: 3, minutes: 10, usd: 0.05 })).toBe("3 steps, 10 minutes, $0.05");
    expect(closingText({ steps: 3 }, used(3, 0, 0), "steps")).toContain("spent (3 steps; used 3 steps)");
    expect(closingText({ usd: 2 }, used(0, 0, 2.31), "usd")).toContain("($2; used $2.31)");
    expect(closingText({ usd: 0.004 }, used(0, 0, 0.00481), "usd")).toContain("($0.004; used $0.0048)");
    expect(budgetWords({ usd: 0.5 })).toBe("$0.50");
  });
});
