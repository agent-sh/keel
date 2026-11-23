import { expect, test } from "bun:test";
import { within, yamlWithin } from "./yaml-bound.ts";
import { hooksOf } from "../tools/skills.ts";

// Anchors that stand for 9^6 values in a few hundred bytes.
const bomb = (depth: number) => {
  let y = "name: x\na0: &a0 [x,x,x,x,x,x,x,x,x]\n";
  for (let i = 1; i <= depth; i++) y += `a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(",")}]\n`;
  return y + `hooks:\n  Stop: *a${depth}\n`;
};

test("YAML aliases are counted where they are used, and the text before it is parsed", () => {
  expect("problem" in yamlWithin(bomb(6), 400_000)).toBe(true);
  expect("problem" in yamlWithin("x".repeat(500_001), 400_000)).toBe(true);
  expect(yamlWithin("a: [1, 2]\n", 100)).toEqual({ value: { a: [1, 2] } });
  expect(within({ a: [1, 2] }, 4)).toBe(true);
  expect(within({ a: [1, 2] }, 3)).toBe(false);
  const t0 = performance.now();
  const r = hooksOf(`---\n${bomb(6)}---\nBody\n`);
  expect(r.problem).toContain("aliases");
  expect(performance.now() - t0).toBeLessThan(1_000);
});
