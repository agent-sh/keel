import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import { branchNote, leftTurns } from "./branch-note.ts";

const ev = (seq: number, kind: string, data: Record<string, unknown> = {}) => ({ id: `e${seq}`, session_id: "s", seq, parent: null, kind, data, ts: 0 }) as unknown as StoredEvent;

test("a turn off the branch is left, one on it or already told is not", () => {
  const line = [ev(1, "user"), ev(2, "turn_start"), ev(9, "turn_start"), ev(10, "note", { kind: "branch_files", turns: [5] }), ev(11, "note", { kind: "rewind", turns: [7, 8] })];
  expect(leftTurns([2, 5, 6, 7, 9], line)).toEqual([6]);
  expect(leftTurns([2, 9], line)).toEqual([]);
});

test("the note names the files, at most thirty", () => {
  const n = branchNote(Array.from({ length: 33 }, (_, i) => `f${i}.txt`));
  expect(n.text).toContain("f29.txt and 3 more");
  expect(n.text).not.toContain("f30.txt");
  expect(branchNote(["b.txt"]).text).toContain("b.txt. This branch has not seen them");
});
