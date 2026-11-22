import { expect, test } from "bun:test";
import { editBody } from "./edit-body.ts";

test("what an edit writes is shown with it: a file's content, a replacement as what goes and what comes, a patch as it is", () => {
  // A whole file: its lines as they are.
  expect(editBody({ file_path: "a.md", content: "one\ntwo\n" })).toEqual({ lines: [{ text: "one" }, { text: "two" }] });
  expect(editBody({ file_path: "a.md", content: "" })).toEqual({ lines: [{ text: "(an empty file)", tone: "note" }] });
  // A replacement: what goes, then what comes.
  expect(editBody({ file_path: "a.ts", old_string: "let a = 1;\nlet b;", new_string: "const a = 1;" })).toEqual({
    lines: [{ text: "- let a = 1;", tone: "del" }, { text: "- let b;", tone: "del" }, { text: "+ const a = 1;", tone: "add" }],
  });
  expect(editBody({ file_path: "a.ts", old_string: "x", new_string: "y", replace_all: true })!.lines[0]).toEqual({ text: "every occurrence:", tone: "note" });
  // A notebook cell.
  expect(editBody({ notebook_path: "n.ipynb", new_source: "print(1)" })).toEqual({ lines: [{ text: "print(1)" }] });
  // A patch carries its own signs: shown as written, toned by them (a file header is not an added line).
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n same\n*** End Patch";
  expect(editBody({ patch })!.lines.map((l) => l.tone ?? "")).toEqual(["", "", "", "del", "add", "", ""]);
  expect(editBody(patch)!.lines).toHaveLength(7);
  expect(editBody({ input: patch })!.lines[4]).toEqual({ text: "+new", tone: "add" });
  // The daemon kept only the start of a long input: that start, as kept, and the card is told.
  expect(editBody({ _clipped: '{"file_path":"a","content":"xxxx' })).toEqual({ lines: [{ text: '{"file_path":"a","content":"xxxx' }], clipped: true });
  // Nothing it knows how to show: the card shows the path alone, as before.
  expect(editBody({ file_path: "a" })).toBeNull();
  expect(editBody(undefined)).toBeNull();
});
