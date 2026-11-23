import { expect, test } from "bun:test";
import { cleanTitle, titleOwed, weakStart } from "./title.ts";

const ev = (kind: string, data: any) => ({ id: Math.random().toString(36), session_id: "s", seq: 0, parent: null, kind, data, ts: 0 }) as any;
const reply = (text: string) => ev("assistant", { blocks: [{ type: "text", text }] });

test("a model's answer is cut to the title it holds", () => {
  expect(cleanTitle('Title: "Fix the cart discount rounding."\nBecause the owner asked.')).toBe("Fix the cart discount rounding");
  expect(cleanTitle("**Add retries to the uploader**")).toBe("Add retries to the uploader");
  expect(cleanTitle("# \u201cMove parser to src\u201d")).toBe("Move parser to src");
  expect(cleanTitle("\n\n")).toBe("");
  const long = cleanTitle("Refactor the whole checkout module to integer cents and update every test that reads a price, then the docs");
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long.endsWith("\u2026")).toBe(true);
});

test("a greeting or a word or two holds no task yet", () => {
  for (const t of ["hi", "Hello!", "hey there", "good morning, how are you", "continue", "thanks a lot"]) expect(weakStart(t)).toBe(true);
  for (const t of ["Fix the cart total", "hi, the cart total is wrong when a discount is a percentage", "Refactor parser to cents"]) expect(weakStart(t)).toBe(false);
});

test("a title is owed after the first reply, and once more after a weak start's next reply", () => {
  const first = [ev("user", { text: "hi" }), reply("Hello.")];
  expect(titleOwed("prompt", first)).toBe(true);
  expect(titleOwed("prompt", [ev("user", { text: "hi" })])).toBe(false);
  expect(titleOwed("", first)).toBe(false);
  expect(titleOwed("model", first)).toBe(false);
  // A weak start waits for a second prompt and its reply.
  expect(titleOwed("start", first)).toBe(false);
  expect(titleOwed("start", [...first, ev("user", { text: "Fix the cart" })])).toBe(false);
  expect(titleOwed("start", [...first, ev("user", { text: "Fix the cart" }), reply("Fixed.")])).toBe(true);
  // A report or a wake is not the owner's prompt.
  expect(titleOwed("start", [...first, ev("user", { text: "report", kind: "subagent" }), reply("Read it.")])).toBe(false);
});
