import { expect, test } from "bun:test";
import { join } from "node:path";
import { closureOf, holds, pageGraph, sizeOf, wideStart, withPreloads } from "./page-graph.ts";

// Feature: the page's start loads what every view needs and no more. The start is the entry chunk
// and the chunks of the bridge and of the session list, each with what it imports statically (a
// wide window draws all of these at its first view). The budget is its size (minified bytes, before
// compression) with a little room. What a view draws only when something asks stays out of the
// start: the approval card, the find bar, the incident band, the speech engine. The session list and
// the side panel are not in the entry chunk, so the script that runs first stays small. Raise a
// number only for a start that really draws more. A wide window's page names the start's chunks in
// its head (withPreloads), so the first paint does not wait for the chain the browser would find them
// by, a chunk at a time: the rail and the bridge are drawn at about the time the entry runs.
const START = 1_320_000;
const ENTRY = 760_000;
const NOT_AT_START = [
  "ui/src/components/ApprovalCard.tsx",
  "ui/src/components/AsksPanel.tsx",
  "ui/src/components/FindBar.tsx",
  "ui/src/components/IncidentBand.tsx",
  "ui/src/components/Switcher.tsx",
  "ui/src/lib/asks-list.ts",
  "ui/src/lib/speech.ts",
  "ui/src/lib/dictation-run.ts",
  "ui/src/lib/talk-run.ts",
  // The home row needs a text check, not the daemon's command analysis.
  "src/safety/risk-words.ts",
];
const NOT_IN_ENTRY = ["ui/src/components/Sidebar.tsx", "ui/src/components/SidePanel.tsx"];

test("the page's start stays within its size budget and leaves out what is drawn on demand", async () => {
  const g = await pageGraph(join(import.meta.dir, ".."));
  const start = new Set<string>([g.entry, ...g.chunks[g.entry]!.static, ...closureOf(g, "ui/src/components/Bridge.tsx"), ...closureOf(g, "ui/src/components/Sidebar.tsx")]);
  expect(g.chunks[g.entry]!.bytes).toBeLessThan(ENTRY);
  expect(sizeOf(g, start)).toBeLessThan(START);
  for (const f of NOT_AT_START) expect(holds(g, start, f), f).toBe(false);
  for (const f of NOT_IN_ENTRY) expect(holds(g, [g.entry], f)).toBe(false);
  // The page names every chunk of the start but the entry, once each, for a window that is not a phone's.
  const page = withPreloads(g.html, g);
  const named: string[] = JSON.parse(/var n of (\[[^\]]*\])/.exec(page)![1]!);
  expect(new Set(named)).toEqual(new Set([...start].filter((c) => c !== g.entry)));
  expect(named).toEqual(wideStart(g));
  expect(page.indexOf("modulepreload")).toBeLessThan(page.indexOf('<link rel="stylesheet"'));
});
