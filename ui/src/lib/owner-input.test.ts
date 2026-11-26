import { expect, test } from "bun:test";
import { INPUT_TYPES, ownerInput } from "./owner-input.ts";

test("a pointer passing over a page that has no focus is not the owner; a press, a key, a wheel or a touch is", () => {
  expect(ownerInput("pointermove", false)).toBe(false);
  expect(ownerInput("pointermove", true)).toBe(true);
  for (const t of ["keydown", "pointerdown", "wheel", "touchstart", "touchmove"]) expect(ownerInput(t, false)).toBe(true);
  expect(INPUT_TYPES).toContain("pointermove");
});
