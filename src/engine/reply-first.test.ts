import { describe, expect, test } from "bun:test";
import { isAck, isQuestion, movesFor, replyFirst } from "./reply-first.ts";

describe("reply first", () => {
  test("a question by its mark or its opening word", () => {
    expect(isQuestion("why the loader sign on the side bar is not loading")).toBe(true);
    expect(isQuestion("does the task list matter?")).toBe(true);
    expect(isQuestion("Is it done?")).toBe(true);
    expect(isQuestion("fix it. did the tests pass?")).toBe(true);
    // An auxiliary opening with no mark is a request, not a question.
    expect(isQuestion("Is it done")).toBe(false);
    expect(isQuestion("do the tests first")).toBe(false);
    expect(isQuestion("have a look at the sidebar")).toBe(false);
    expect(isQuestion("can you rerun it")).toBe(false);
    expect(isQuestion("how about the other branch")).toBe(true);
    expect(isQuestion("למה זה איטי")).toBe(true);
    expect(isQuestion("you are using 8 cores for tsc")).toBe(false);
    expect(isQuestion("island map is broken")).toBe(false);
    expect(isQuestion("")).toBe(false);
  });

  test("an acknowledgment moves nothing; a question or an instruction does", () => {
    for (const t of ["thanks", "ok", "good", "OK, thanks!", "great 👍", "תודה", "lgtm"]) { expect(isAck(t)).toBe(true); expect(movesFor(t)).toBe(false); }
    for (const t of ["stop", "ok stop that", "good, now do the docs", "ok?", "thanks, why is it red?", "do the tests first"]) expect(movesFor(t)).toBe(true);
    expect(movesFor("  ")).toBe(false);
    expect(replyFirst([{ text: "thanks", owner: true }])).toBeUndefined();
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
