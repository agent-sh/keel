import { expect, test } from "bun:test";
import type { StoredEvent } from "../../../src/core/types.ts";
import { lastRewind, promptRows, promptRowsOf } from "./rewind.ts";

const ev = (seq: number, kind: string, data: Record<string, unknown> = {}) => ({ id: `e${seq}`, session_id: "s", seq, parent: seq > 1 ? `e${seq - 1}` : null, kind, data, ts: 0 }) as unknown as StoredEvent;

test("each prompt counts the files of the turns of its branch that it started", () => {
  const line = [ev(1, "user", { text: "first\nmore" }), ev(2, "turn_start"), ev(5, "user", { text: "second" }), ev(7, "turn_start")];
  const turns = [{ turn: 2, files: [1] }, { turn: 4, files: [1, 2, 3] }, { turn: 7, files: [1, 2] }];
  // (Turn 4 is another branch's: its start is not on this one.)
  expect(promptRows(line, turns).map((r) => [r.text, r.files])).toEqual([["first", 1], ["second", 2]]);
});

test("a rewind can be undone until a prompt comes after it", () => {
  const note = ev(3, "note", { kind: "rewound" });
  expect(lastRewind([ev(1, "user", { text: "a" }), ev(2, "turn_start"), note])?.id).toBe("e3");
  expect(lastRewind([ev(1, "user", { text: "a" }), note, ev(4, "user", { text: "b" })])).toBeUndefined();
});

test("prompts the daemon lists, past what the page holds, count their files like the page's own", () => {
  const prompts = [{ id: "a", seq: 1, text: "first" }, { id: "b", seq: 5, text: "", attachments: true }, { id: "c", seq: 9, text: "third" }];
  const rows = promptRowsOf(prompts, new Set([2, 6, 10]), [{ turn: 2, files: [1] }, { turn: 6, files: [1, 2] }, { turn: 8, files: [1] }, { turn: 10, files: [1] }]);
  expect(rows.map((r) => [r.text, r.files])).toEqual([["first", 1], ["(attachments)", 2], ["third", 1]]);
});
