import { describe, expect, test } from "bun:test";
import { againSpecs, owedSides, readTookBy, resumed, type Sides } from "./sides.ts";

describe("a run a restart cut", () => {
  const done = { state: "done" as const, commit: "b", ms: 1000, cpu_ms: 800, shots: 4 };
  test("goes on at the side it was on: a finished side keeps its result", () => {
    const sides: Sides = { before: done, after: { state: "running", commit: "h" } };
    const has = (s: string) => (s === "before" ? 4 : 0);
    expect(owedSides(sides, has)).toEqual(["after"]);
    const r = resumed(sides, has);
    expect(r.before).toEqual(done);
    expect(r.after).toEqual({ state: "waiting", commit: "h" });
  });

  test("a side whose pictures are gone is taken again, a failed one is not", () => {
    expect(owedSides({ before: done, after: { state: "failed", commit: "h", why: "exit 1" } }, () => 0)).toEqual(["before"]);
  });

  test("the base again is owed only when it was asked for, with the specs it named", () => {
    const sides: Sides = { before: done, after: done, again: { state: "running", commit: "b", specs: ["a.spec.ts"] } };
    expect(owedSides(sides, (s) => (s === "again" ? 0 : 4))).toEqual(["again"]);
    expect(resumed(sides, (s) => (s === "again" ? 0 : 4)).again).toEqual({ state: "waiting", commit: "b", specs: ["a.spec.ts"] });
  });
});

describe("the specs the base is taken again with", () => {
  const took = readTookBy("board-1920x1040-light.png\ttest/e2e/work-board.spec.ts\nerr-390x844-dark.png\ttest/e2e/errors.spec.ts\n");
  const all = ["test/e2e/errors.spec.ts", "test/e2e/heavy.spec.ts", "test/e2e/work-board.spec.ts"];
  test("only those that took a picture that differs", () => {
    expect(againSpecs(["board-1920x1040-light.png"], took, all)).toEqual(["test/e2e/work-board.spec.ts"]);
  });
  test("every spec when a picture's spec is not known", () => {
    expect(againSpecs(["board-1920x1040-light.png", "other.png"], took, all)).toEqual(all);
  });
});
