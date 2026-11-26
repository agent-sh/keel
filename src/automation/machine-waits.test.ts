// The machine's account of what waits for it: a tree once, a short heavy wait silent, a question kept apart.
import { expect, test } from "bun:test";
import { account, QUIET_MS, RELEASES, waitsLong } from "./machine-waits.ts";

const now = 1_000_000;

test("a heavy-only wait is in the account once it outlasts the quiet time, with what lets it go", () => {
  const w = { tree: "t1", title: "Fix the parser", since: now - QUIET_MS, cause: "heavy" as const, why: "every slot is taken" };
  expect(account([w], new Set(), now)).toEqual({ trees: 1, held: 0, heavy: 1, asking: 0, oldest: { title: "Fix the parser", since: now - QUIET_MS, cause: "heavy", releases: `${RELEASES.heavy} (every slot is taken)` } });
  // A wait of a few seconds says nothing.
  expect(account([{ ...w, since: now - 2000 }], new Set(), now)).toMatchObject({ trees: 0, oldest: null });
});

test("a tree held by the load and waiting in the heavy line twice is one tree; the oldest wait is named", () => {
  const waits = [
    { tree: "t1", title: "Fix the parser", since: now - 40_000, cause: "load" as const },
    { tree: "t1", title: "Its checker", since: now - 90_000, cause: "heavy" as const },
    { tree: "t1", title: "Its checker", since: now - 30_000, cause: "heavy" as const },
    { tree: "t2", title: "Docs", since: now - 5_000, cause: "load" as const },
  ];
  const a = account(waits, new Set(), now);
  expect(a).toMatchObject({ trees: 2, held: 2, heavy: 1, asking: 0 });
  expect(a.oldest).toMatchObject({ title: "Its checker", cause: "heavy", releases: RELEASES.heavy });
});

test("a tree that also asks a question counts for its wait and is said to ask, never folded into the wait", () => {
  const waits = [{ tree: "t1", title: "A", since: now - 60_000, cause: "load" as const }, { tree: "t2", title: "B", since: now - 20_000, cause: "load" as const }];
  expect(account(waits, new Set(["t2", "t9"]), now)).toMatchObject({ trees: 2, held: 2, asking: 1 });
});

test("a call in the heavy line marks its step a wait for the machine only past the quiet time", () => {
  expect(waitsLong(undefined, 100_000)).toBe(false);
  expect(waitsLong(100_000 - QUIET_MS + 1, 100_000)).toBe(false);
  expect(waitsLong(100_000 - QUIET_MS, 100_000)).toBe(true);
});
