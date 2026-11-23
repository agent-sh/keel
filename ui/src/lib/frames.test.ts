import { expect, test } from "bun:test";
import { AT_WORK_MS, closed, ownersFocus, stops } from "./frames.ts";

// A frame of content takes the keyboard by the owner's press over it or their Tab into it.
test("a focus that entered a content frame is the owner's only with the pointer over it or a Tab just before", () => {
  const frame = (hover: boolean) => ({ matches: (sel: string) => sel === ":hover" && hover });
  expect(ownersFocus(frame(true), Infinity)).toBe(true);
  expect(ownersFocus(frame(false), 50)).toBe(true);
  // The review's case: the owner is in the message box, and the frame asks for the focus on a timer.
  expect(ownersFocus(frame(false), Infinity)).toBe(false);
  expect(ownersFocus(frame(false), 5000)).toBe(false);
});

// A frame the owner was in and left takes no keyboard until they come back to it.
test("a frame the owner left is closed until the pointer is over it or they Tab", () => {
  expect(closed({ focused: false, pointerOver: false, sinceTab: Infinity })).toBe(true);
  expect(closed({ focused: true, pointerOver: false, sinceTab: Infinity })).toBe(false);
  expect(closed({ focused: false, pointerOver: true, sinceTab: Infinity })).toBe(false);
  expect(closed({ focused: false, pointerOver: false, sinceTab: 100 })).toBe(false);
});

// The review's case: a frame that asks for the keyboard in a loop took all the owner typed.
test("a frame that takes the keyboard unasked a second time is stopped", () => {
  expect(stops(1)).toBe(false);
  expect(stops(2)).toBe(true);
  expect(stops(7)).toBe(true);
});

// The review's case: the owner clicked the message box and pasted 0.4 s later; the frame they
// had been in took the keyboard in between, and its first take was only given back.
test("a frame that takes the keyboard while the owner is at work in the page is stopped at once", () => {
  expect(stops(1, 400)).toBe(true);
  expect(stops(1, AT_WORK_MS - 1)).toBe(true);
  expect(stops(1, AT_WORK_MS)).toBe(false);
  expect(stops(1, 60_000)).toBe(false);
});
