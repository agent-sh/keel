import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import { branchNote, leftTurns, offBranch, unreadNotes } from "./branch-note.ts";

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

// An event whose body is counted when it is read: a body is a read from the table for a session at rest.
function counted(seq: number, kind: string, data: Record<string, unknown>, reads: number[]) {
  const e = { id: `e${seq}`, session_id: "s", seq, parent: null, kind, ts: 0 } as unknown as StoredEvent;
  Object.defineProperty(e, "data", { get() { reads.push(seq); return data; } });
  return e;
}

test("a branch with every turn on it reads no note's body", () => {
  const reads: number[] = [];
  const line = [counted(1, "turn_start", {}, reads), counted(2, "note", { kind: "prompt_update" }, reads), counted(3, "turn_start", {}, reads), counted(4, "note", { turns: [9] }, reads)];
  expect(leftTurns([1, 3], line)).toEqual([]);
  expect(offBranch([1, 3], line)).toEqual([]);
  expect(reads).toEqual([]);
});

test("only the notes after the first turn off the branch are read, each once", () => {
  const reads: number[] = [];
  const line = [
    counted(1, "turn_start", {}, reads), counted(2, "note", { kind: "prompt_update" }, reads),
    counted(5, "turn_start", {}, reads), counted(6, "note", { kind: "prompt_update" }, reads),
    counted(8, "note", { kind: "branch_files", turns: [4] }, reads), counted(9, "note", { kind: "prompt_update" }, reads),
  ];
  const read = new Map<string, readonly number[]>();
  // The turn at 3 is off the branch: the notes before it cannot tell it.
  expect(unreadNotes(line, 3, read).map((e) => e.seq)).toEqual([6, 8, 9]);
  expect(leftTurns([1, 3, 4, 5], line, read)).toEqual([3]);
  expect(reads.sort()).toEqual([6, 8, 9]);
  // Asked again: what was read is not read again.
  expect(unreadNotes(line, 3, read)).toEqual([]);
  reads.length = 0;
  expect(leftTurns([1, 3, 4, 5], line, read)).toEqual([3]);
  expect(reads).toEqual([]);
});
