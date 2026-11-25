// The forms a reviewer's keel__verdict call takes: what `land` may say, and what an empty call is told.
import { expect, test } from "bun:test";
import { landOf } from "./verdicts.ts";
import { VerdictTool } from "../server/routes/board.ts";
import { inputProblem } from "../tools/validate.ts";

test("land reads yes and no in the forms models send", () => {
  for (const v of ["yes", "Yes", " y ", "true", "TRUE", true, "approve", "approved", "land"]) expect(landOf(v)).toBe("yes");
  for (const v of ["no", "N", "false", false, "refuse", "refused", "reject", "block"]) expect(landOf(v)).toBe("no");
  for (const v of [undefined, null, "", "maybe", 1, {}, "yes but"]) expect(landOf(v)).toBeUndefined();
});

test("a call with string land true is not refused by the schema check", () => {
  expect(inputProblem(VerdictTool as any, { commit: "bc7f15e0a", land: "true", why: "ok" })).toBeUndefined();
  expect(inputProblem(VerdictTool as any, { commit: "bc7f15e0a", land: true, why: "ok" })).toBeUndefined();
});

test("an empty call is told its fields and an example that is itself a valid call", () => {
  const said = inputProblem(VerdictTool as any, {})!;
  expect(said).toContain("`commit` is missing");
  expect(said).toContain('For example: {"commit":');
  expect(inputProblem(VerdictTool as any, VerdictTool.inputExample)).toBeUndefined();
});
