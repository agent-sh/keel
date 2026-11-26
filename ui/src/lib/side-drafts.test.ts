import { expect, test } from "bun:test";
import { draftOf, dropDrafts, moveDraft, setDraft, type SideDrafts } from "./side-drafts.ts";

test("a side draft is kept per session and thread, follows its thread when it moves, and goes on a clear", () => {
  const d: SideDrafts = new Map();
  setDraft(d, "a", "t1", "why this file?");
  setDraft(d, "b", undefined, "what failed?");
  expect([draftOf(d, "a", "t1"), draftOf(d, "a", undefined), draftOf(d, "b", undefined), draftOf(d, "b", "t1")]).toEqual(["why this file?", "", "what failed?", ""]);
  // The first answer gives b's new thread its id: the words typed meanwhile go with it.
  moveDraft(d, "b", undefined, "t9");
  expect([draftOf(d, "b", undefined), draftOf(d, "b", "t9")]).toEqual(["", "what failed?"]);
  // A thread that has words of its own keeps them.
  setDraft(d, "a", undefined, "next one");
  moveDraft(d, "a", "t1", undefined);
  expect(draftOf(d, "a", undefined)).toBe("next one");
  // Emptied words are no draft; a clear of one session leaves the other's.
  setDraft(d, "a", undefined, "  ");
  expect(draftOf(d, "a", undefined)).toBe("");
  dropDrafts(d, "b");
  expect([draftOf(d, "b", "t9"), d.size]).toEqual(["", 0]);
});
