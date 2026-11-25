import { expect, test } from "bun:test";
import { join } from "node:path";
import { closureOf, holds, pageGraph, sizeOf } from "./page-graph.ts";

// Feature: the page's start loads what every view needs and no more. The start is the entry chunk
// and the bridge chunk with what each imports statically (the home page loads exactly these). The
// budget is its size (minified bytes, before compression) with a little room, and a card that a
// view draws only when something asks (an approval) is not in it: it is fetched by the view that
// draws it. Raise the number only for a start that really draws more.
const START = 1_320_000;
const ENTRY = 960_000;
const NOT_AT_START = ["ui/src/components/ApprovalCard.tsx"];

test("the page's start stays within its size budget and leaves out the card drawn on demand", async () => {
  const g = await pageGraph(join(import.meta.dir, ".."));
  const start = new Set<string>([g.entry, ...g.chunks[g.entry]!.static, ...closureOf(g, "ui/src/components/Bridge.tsx")]);
  expect(g.chunks[g.entry]!.bytes).toBeLessThan(ENTRY);
  expect(sizeOf(g, start)).toBeLessThan(START);
  for (const f of NOT_AT_START) expect(holds(g, start, f)).toBe(false);
});
