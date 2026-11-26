import { describe, expect, test } from "bun:test";
import { isQuestion, replyFirst } from "./reply-first.ts";

describe("reply first", () => {
  test("a question by its mark or its opening word", () => {
    expect(isQuestion("why the loader sign on the side bar is not loading")).toBe(true);
    expect(isQuestion("does the task list matter?")).toBe(true);
    expect(isQuestion("Is it done")).toBe(true);
    expect(isQuestion("למה זה איטי")).toBe(true);
    expect(isQuestion("you are using 8 cores for tsc")).toBe(false);
    expect(isQuestion("island map is broken")).toBe(false);
    expect(isQuestion("")).toBe(false);
  });

  test("only the owner's own steers get a note, worded by what they are", () => {
    expect(replyFirst([])).toBeUndefined();
    expect(replyFirst([{ text: "what is left?", owner: false }])).toBeUndefined();
    expect(replyFirst([{ text: "   ", owner: true }])).toBeUndefined();
    const ask = replyFirst([{ text: "what is left?", owner: true }])!;
    expect(ask).toStartWith("[harness]");
    expect(ask).toContain("Answer the question first");
    const tell = replyFirst([{ text: "the font is too big", owner: true }])!;
    expect(tell).toContain("what you take from it");
    expect(replyFirst([{ text: "the font is too big", owner: true }, { text: "and why?", owner: true }])).toContain("messages above");
  });
});
