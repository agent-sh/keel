import { expect, test } from "bun:test";
import { checksWords } from "./check-words.ts";

test("a partial pass names the check that did not run", () => {
  expect(checksWords({ passed: ["unit"], failed: [], notRun: ["typecheck"] })).toBe("passed: unit; not run: typecheck");
});
test("none run, a failure and all passed", () => {
  expect(checksWords({ passed: [], failed: [], notRun: ["unit", "e2e"] })).toBe("not run: unit, e2e");
  expect(checksWords({ passed: ["unit"], failed: ["typecheck"], notRun: [] })).toBe("check failed: typecheck");
  expect(checksWords({ passed: ["unit", "e2e"], failed: [], notRun: [] })).toBe("passed: unit, e2e");
});
