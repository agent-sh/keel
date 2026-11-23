// The page's Find: the places a conversation holds a text, in its order, and the key that opens it.
import { expect, test } from "bun:test";
import { findKey, placeAgain, placesOf, rangesOf, tally, unitsOf } from "./find.ts";

let seq = 0;
const ev = (kind: string, data: unknown, id = `e${++seq}`) => ({ id, session_id: "s", seq, parent: null, kind, data, ts: seq }) as any;

test("a call's input and output are one place, a reply's prose another, a prompt its words and files", () => {
  const events = [
    ev("user", { text: "Find the Quokka", images: [{ type: "attachment", name: "quokka.png" }] }, "u"),
    ev("assistant", { blocks: [{ type: "text", text: "Looking for quokka." }, { type: "tool_use", id: "c1", name: "Bash", input: { command: "rg quokka", description: "search" } }] }, "a"),
    ev("tool_result", { results: [{ tool_use_id: "c1", content: [{ type: "text", text: "zoo.txt: QUOKKA" }] }] }, "r"),
    ev("assistant", { stop: "refusal", blocks: [{ type: "text", text: "quokka" }] }, "x"),
  ];
  const units = unitsOf(events);
  expect(units.map((u) => [u.key, u.ev])).toEqual([["u", "u"], ["a", "a"], ["call:c1", "a"]]);
  const places = placesOf(units, [], "quokka", events[0].seq);
  // Twice in the prompt (its words and its file's name), once in the prose, twice in the call; not in the declined reply.
  expect(places.map((p) => `${p.key}#${p.k}`)).toEqual(["u#0", "u#1", "a#0", "call:c1#0", "call:c1#1"]);
});

test("the daemon's places stand before and after the part held, and a place the page holds is counted once", () => {
  const events = [ev("user", { text: "middle quokka" }, "m")];
  const first = events[0].seq;
  const outside = [
    { event: "old", seq: first - 10, count: 2 },
    { event: "a1", seq: first - 5, call: "c9", count: 1 },
    { event: "a1", seq: first - 4, call: "c9", count: 1 }, // the same call's output
    { event: "m", seq: first, count: 1 }, // the part grew: held now
    { event: "new", seq: first + 3, count: 1 },
  ];
  const places = placesOf(unitsOf(events), outside, "quokka", first);
  expect(places.map((p) => `${p.key}#${p.k}${p.held ? "" : "*"}`)).toEqual(["old#0*", "old#1*", "call:c9#0*", "call:c9#1*", "m#0", "new#0*"]);
  // The place that was current is found again in the new list, held or not.
  expect(placeAgain(places, { key: "call:c9", ev: "a1", call: "c9", k: 1, held: false })).toBe(3);
  expect(placeAgain(places, { key: "old", ev: "old", k: 5, held: false })).toBe(1);
  expect(placeAgain(places, null)).toBe(0);
  expect(placeAgain([], null)).toBe(-1);
});

test("a match is a range of the text as written, accents and case folded", () => {
  expect(rangesOf("Café, CAFE and cafe\u0301", "cafe")).toEqual([[0, 4], [6, 10], [15, 20]]);
  expect(rangesOf("aaa", "aa")).toEqual([[0, 2]]);
  expect(rangesOf("abc", "")).toEqual([]);
  expect(tally(0, 0, false)).toBe("No matches");
  expect(tally(2, 12, true)).toBe("3 of 12+");
});

test("the find key is the platform's: Cmd+F on a Mac, where Ctrl+F moves the caret; Ctrl+F elsewhere", () => {
  const k = (key: string, m: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>>) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });
  expect(findKey(k("f", { ctrlKey: true }), false)).toBe(true);
  expect(findKey(k("F", { ctrlKey: true }), false)).toBe(true);
  expect(findKey(k("f", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  expect(findKey(k("f", { metaKey: true }), false)).toBe(false);
  expect(findKey(k("f", { metaKey: true }), true)).toBe(true);
  expect(findKey(k("f", { ctrlKey: true }), true)).toBe(false);
});
