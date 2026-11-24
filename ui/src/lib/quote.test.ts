import { expect, test } from "bun:test";
import { commentMessage, lineWords, QUOTE_MAX, quoteBlock, withQuote } from "./quote.ts";

test("a quote is every line behind a mark, blank lines kept as marks", () => {
  expect(quoteBlock("one\n\n  two\n")).toBe("> one\n>\n>   two");
  expect(quoteBlock("\n\nonly")).toBe("> only");
});

test("a long selection is cut and says by how much", () => {
  const q = quoteBlock("x".repeat(QUOTE_MAX + 40));
  expect(q.split("\n")).toHaveLength(2);
  expect(q).toEndWith("[40 more characters not quoted]");
});

test("a comment says where, quotes, then speaks", () => {
  expect(commentMessage("the reply", "a\nb", " why? ")).toBe("On the reply:\n> a\n> b\n\nwhy?");
});

test("a quote goes after the draft with a blank line, and leaves a line to write on", () => {
  expect(withQuote("", "a")).toBe("> a\n\n");
  expect(withQuote("see", "a")).toBe("see\n\n> a\n\n");
  expect(withQuote("see\n", "a")).toBe("see\n\n> a\n\n");
  expect(withQuote("see\n\n", "a")).toBe("see\n\n> a\n\n");
});

test("lines are said as one or a run", () => {
  expect(lineWords([4])).toBe("line 4");
  expect(lineWords([5, 3, 4])).toBe("lines 3 to 5");
  expect(lineWords([2, 3], true)).toBe("removed lines 2 to 3");
  expect(lineWords([])).toBe("");
});
