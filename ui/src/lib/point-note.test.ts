import { expect, test } from "bun:test";
import { pointFrom, pointNote, pointPieces, pointSize, withPoints, type Point } from "./point-note.ts";
import { classesOf, fileOf, idsIn } from "./point-table.macro.ts";

const dock: Point = { id: "a", name: "dock-jobs", image: "img-2", facts: [["where", "session-dock > dock-jobs"], ["source", "ui/src/components/DockNow.tsx:88 (DockNow)"], ["box", "96 x 22 px at 412, 771"]] };

test("a message carries what was pointed at under its words, each note naming its picture", () => {
  const text = withPoints("make this quieter ", [dock, { id: "b", name: "attach", facts: [["box", "30 x 30 px at 1, 2"]] }], ["img-1", "img-2"]);
  expect(text).toBe('make this quieter\n\n[Pointed at "dock-jobs"]\n  where: session-dock > dock-jobs\n  source: ui/src/components/DockNow.tsx:88 (DockNow)\n  box: 96 x 22 px at 412, 771\n  picture: image 2 of this message\'s 2\n\n[Pointed at "attach"]\n  box: 30 x 30 px at 1, 2');
  expect(withPoints("", [dock], ["img-2"])).toEndWith("  picture: the image of this message");
  expect(withPoints("plain", [], [])).toBe("plain");
});

test("a sent message is read back as its words and its notes", () => {
  const text = withPoints("first\n\nsecond", [dock], ["img-2"]) + "\n\nand more";
  const pieces = pointPieces(text);
  expect(pieces).toHaveLength(3);
  expect(pieces[0]).toEqual({ text: "first\n\nsecond" });
  expect(pieces[1]).toMatchObject({ name: "dock-jobs" });
  expect("facts" in pieces[1]! && pieces[1].facts.at(-1)).toEqual(["picture", "the image of this message"]);
  expect(pieces[2]).toEqual({ text: "and more" });
  // The owner's own bracketed line, with no facts under it, is their words.
  expect(pointPieces('[Pointed at "x"]\nnot a fact')).toEqual([{ text: '[Pointed at "x"]\nnot a fact' }]);
  expect(pointNote(pieces[1] as Point)).toContain("  source: ui/src/components/DockNow.tsx:88 (DockNow)");
});

test("a chip says where the element is written and its size, short", () => {
  expect(pointFrom(dock)).toBe("DockNow.tsx:88 (DockNow)");
  expect(pointFrom({ facts: [["source", "ui/src/components/Sidebar.tsx:334 (RowOf), ui/src/components/Sidebar.tsx:936 (Marks), where session-row is written"]] })).toBe("Sidebar.tsx:334 (RowOf)");
  expect(pointSize(dock)).toBe("96 x 22");
});

test("the table reads a file's test ids, written plainly, by a choice, from parts or as a prop, and its components", () => {
  expect(idsIn('"send"')).toEqual(["send"]);
  expect(idsIn('{on ? "allow-mine" : "allow-read"}')).toEqual(["allow-mine", "allow-read"]);
  expect(idsIn("{`row-${id}`}")).toEqual(["row-*"]);
  const f = fileOf(['const LIMIT = 3;', 'export function Dock({ a }: P) {', '  return <div data-testid="dock"><Line testid={a ? "dock-a" : undefined} /></div>;', '}', 'const Line = memo(function Line() {', '  const el = box.querySelector(\'[data-testid="other"]\');', '  return <i data-testid={`line-${n}`} />;', '});'].join("\n"));
  expect(f.c).toEqual([[2, "Dock"], [5, "Line"]]);
  expect(f.t).toEqual([["dock", 3], ["dock-a", 3], ["line-*", 7]]);
  const css: Record<string, [string, number]> = {};
  classesOf(".k-a, .k-b:hover { color: var(--k-not) }\n.k-a > .k-c { top: 0 }", "x.css", css);
  expect(css).toEqual({ "k-a": ["x.css", 1], "k-b": ["x.css", 1], "k-c": ["x.css", 2] });
});
