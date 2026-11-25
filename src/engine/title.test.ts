import { expect, test } from "bun:test";
import { cleanTitle, derivedTitle, titleOwed, titlePrompt, weakStart } from "./title.ts";

const ev = (kind: string, data: any) => ({ id: Math.random().toString(36), session_id: "s", seq: 0, parent: null, kind, data, ts: 0 }) as any;
const reply = (text: string) => ev("assistant", { blocks: [{ type: "text", text }] });

test("a model's answer is cut to the title it holds, three words at most", () => {
  expect(cleanTitle('Title: "Cart discount rounding."\nBecause the owner asked.')).toBe("Cart discount rounding");
  expect(cleanTitle("**Uploader retries**")).toBe("Uploader retries");
  expect(cleanTitle("# \u201cMove parser\u201d")).toBe("Move parser");
  expect(cleanTitle("\n\n")).toBe("");
  // A longer answer keeps its first three words, with no stray mark at the cut.
  expect(cleanTitle('Title: "Fix the cart discount rounding."')).toBe("Fix the cart");
  expect(cleanTitle("Refactor checkout, cents, and tests")).toBe("Refactor checkout, cents");
  expect(cleanTitle("Refactor the whole checkout module to integer cents")).toBe("Refactor the whole");
  // One very long word is still cut by characters.
  const long = cleanTitle("x".repeat(120));
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long.endsWith("\u2026")).toBe(true);
});

test("the title request asks for three words at most", () => {
  const p = titlePrompt(["Fix the cart total"], "Done.");
  expect(p).toContain("in 3 words at most");
  expect(p).not.toMatch(/3 to 6/);
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

test("a model's title longer than three words, from before, is made again once; the owner's never", () => {
  const line = [ev("user", { text: "Fix the cart discount rounding in checkout" }), reply("Fixed.")];
  expect(titleOwed("model", line, "Fix the cart discount rounding")).toBe(true);
  expect(titleOwed("start", line, "Greeting and then the cart work")).toBe(true);
  // The title made again is three words: nothing is owed after it.
  expect(titleOwed("model", line, "Cart discount rounding")).toBe(false);
  // The owner's title and a hook's are never made again, however long.
  expect(titleOwed("", line, "My long name for the cart work")).toBe(false);
  expect(titleOwed("hook", line, "A hook's long name for the work")).toBe(false);
  // The first prompt's own words wait for the reply as before.
  expect(titleOwed("prompt", [line[0]], "Fix the cart discount rounding in checkout")).toBe(false);
});

test("a title is derived when it is empty or only the first prompt's words", () => {
  const prompt = "Fix the cart discount rounding in the checkout flow\nsecond line";
  expect(derivedTitle("", prompt)).toBe(true);
  expect(derivedTitle("Fix the cart discount rounding in the checkout flow", prompt)).toBe(true);
  // The source cut it longer or shorter than the first line: its first 40 characters still match.
  expect(derivedTitle("Fix the cart discount rounding in the checkout flow second line and more", prompt)).toBe(true);
  expect(derivedTitle("Fix the cart discount rounding in", prompt)).toBe(false);
  expect(derivedTitle("Checkout rounding (named by the owner)", prompt)).toBe(false);
  expect(derivedTitle("Fix", "Fix")).toBe(true);
  expect(derivedTitle("Mine", "Fix")).toBe(false);
});
