// Which blocks of a transcript are drawn, and what a block that is not drawn says.
import { expect, test } from "bun:test";
import { lineage } from "../../../src/core/tree.ts";
import type { StoredEvent } from "../../../src/core/types.ts";
import { buildRows, nextSiblings } from "./rows.ts";
import { heldWords, plain, windowOf, type Span } from "./window.ts";

// Ten blocks of 500 px each, the first at 0.
const spans: Span[] = Array.from({ length: 10 }, (_, i) => ({ key: i, top: i * 500, bottom: (i + 1) * 500 }));
const none = new Set<number>();

test("the blocks within a view of the view are drawn, and the newest two always", () => {
  // A view of 400 px over block 4.
  const got = windowOf(spans, { top: 2100, bottom: 2500 }, null, none);
  expect([...got].sort((a, b) => a - b)).toEqual([3, 4, 5, 8, 9]);
});

test("a drawn block leaves only when it is three views away, and a pinned one stays", () => {
  const was = new Set([0, 1, 2, 3, 8, 9]);
  // The view moved down to block 5: block 3 is within two views, blocks 0 to 2 are not.
  const got = windowOf(spans, { top: 2600, bottom: 3000 }, was, new Set([0]));
  expect([...got].sort((a, b) => a - b)).toEqual([0, 3, 4, 5, 6, 8, 9]);
});

test("Find looks for the words, not for the marks around them", () => {
  expect(plain("The change is in `notes/plan.md` and **keeps the public surface**.")).toBe("The change is in notes/plan.md and keeps the public surface.");
  expect(plain("See [the guide](https://example.com/x) now")).toBe("See the guide now");
  expect(plain("## Steps\n- one\n- two")).toBe("Steps\none\ntwo");
});

// What both engines copy of a drawn reply (measured in Chromium and WebKit: a selection's text and
// what Ctrl+C puts on the clipboard): a list item without its marker, a table row as its cells with
// a tab between them, no line for the rule under the head. A held block copies the same.
test("a held reply copies as the drawn one does: list items as their words, table rows as cells and tabs", () => {
  expect(plain("Totals:\n\n| File | Change |\n| :--- | ---: |\n| `a.ts` | +4 |\n| b \\| c | -1 |\n\nDone.")).toBe("Totals:\n\nFile\tChange\na.ts\t+4\nb | c\t-1\n\nDone.");
  expect(plain("a | b\n|---|---|\n1 | 2")).toBe("a\tb\n1\t2");
  expect(plain("1. one\n2. two\n- First: **x**")).toBe("one\ntwo\nFirst: x");
  // A pipe in a sentence, and a line of dashes under it, are no table.
  expect(plain("left | right\n---")).toBe("left | right\n---");
});

test("a held row says what its drawn row copies: a prompt's attachments, a run of work's lines", () => {
  const list: StoredEvent[] = [];
  const ev = (kind: StoredEvent["kind"], data: any): StoredEvent => {
    const e: StoredEvent = { id: `h${list.length + 1}`, session_id: "s", seq: list.length + 1, parent: list.at(-1)?.id ?? null, kind, data, ts: list.length + 1 };
    list.push(e);
    return e;
  };
  ev("user", { text: "Look at these", images: [{ type: "image", media_type: "image/png", data: "" }, { type: "attachment", id: "a1", name: "notes.txt", media_type: "text/plain", size: 2048 }, { type: "image", media_type: "image/png", data: "" }] });
  ev("turn_start", {});
  ev("assistant", { blocks: [{ type: "text", text: "First I **search**." }, { type: "tool_use", id: "c1", name: "Bash", input: { command: "rg -n token src" } }] });
  ev("tool_result", { results: [{ type: "tool_result", tool_use_id: "c1", content: "src/a.ts:1: token" }] });
  ev("assistant", { blocks: [{ type: "text", text: "Done." }] });
  ev("turn_end", { reason: "end_turn", ms: 1 });
  const rows = buildRows(undefined, lineage(list, list.at(-1)!.id), nextSiblings(undefined, list).map, false, () => false).blocks.flat();
  expect(heldWords(rows.find((r) => r.kind === "user")!)).toBe("Look at these\nAttached image 1\nnotes.txt\nAttached image 2");
  expect(heldWords(rows.find((r) => r.kind === "work")!)).toBe("First I search.\nRan rg -n token src");
});
