// The list a view keeps of a whole session grows by the events the page
// holds after its last one, and keeps what the page later lets go of.
import { expect, test } from "bun:test";
import type { StoredEvent } from "../../../src/core/types.ts";
import { grown } from "./rows.ts";

const ev = (seq: number): StoredEvent => ({ id: `e${seq}`, session_id: "s", seq, parent: seq > 1 ? `e${seq - 1}` : null, kind: "note", data: {}, ts: seq });
const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

test("events held after the list's last one are added; a trim of the held list takes nothing back", () => {
  let list = run(1, 1000);
  expect(grown(list, run(801, 1000))).toBe(list);
  list = grown(list, run(801, 1300));
  expect(list.length).toBe(1300);
  // The page trimmed its own list to the newest part: the view's list is as it was.
  list = grown(list, run(1100, 1300));
  expect(list.length).toBe(1300);
  list = grown(list, run(1100, 1500));
  expect(list.map((e) => e.seq)).toEqual(run(1, 1500).map((e) => e.seq));
  expect(grown(list, undefined)).toBe(list);
});
