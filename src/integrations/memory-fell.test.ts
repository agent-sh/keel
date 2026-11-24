import { expect, test } from "bun:test";
import { watchFell, type FellDeps } from "./memory-fell.ts";
import { recallFell, type MemoryPath, type Standing, type Window } from "./memory-meter.ts";

const stand = (path: MemoryPath, recent: Window, day: Window): Standing => ({ path, recent, day, fell: recallFell(path, recent, day) });
const DAY: Window = { answered: 600, hits: 160 };

function world(initial: Standing[]) {
  const marks = new Set<string>(), alerts: string[] = [], settled: string[] = [];
  let now = initial;
  const deps: FellDeps = { standing: async () => now, open: () => new Set(marks), mark: (p, on) => void (on ? marks.add(p) : marks.delete(p)), raise: (f, t) => void alerts.push(`${f.path}: ${t.title} | ${t.body}`), settle: (p) => void settled.push(p) };
  return { deps, alerts, marks, settled, set: (s: Standing[]) => void (now = s) };
}

test("a fall of recall is told once, with its numbers, until recall was measured back", async () => {
  const w = world([stand("store_prompt", { answered: 86, hits: 1 }, DAY)]);
  await watchFell(w.deps);
  expect(w.alerts).toHaveLength(1);
  expect(w.alerts[0]).toContain("1 of the last 86 answers");
  expect(w.alerts[0]).toContain("160 of 600");
  // The next looks, hours later, tell nothing more.
  await watchFell(w.deps); await watchFell(w.deps);
  expect(w.alerts).toHaveLength(1);
  // Too few answers to say it recovered (a quiet night): still the same fall, and it falls again below the line.
  w.set([stand("store_prompt", { answered: 5, hits: 3 }, DAY)]);
  await watchFell(w.deps);
  w.set([stand("store_prompt", { answered: 86, hits: 2 }, DAY)]);
  await watchFell(w.deps);
  expect(w.alerts).toHaveLength(1);
  // Measured back above half of the day's share: the mark clears, and the next fall is told.
  w.set([stand("store_prompt", { answered: 60, hits: 18 }, DAY)]);
  await watchFell(w.deps);
  expect(w.marks.size).toBe(0);
  expect(w.settled).toEqual(["store_prompt"]);
  w.set([stand("store_prompt", { answered: 80, hits: 1 }, DAY)]);
  await watchFell(w.deps);
  expect(w.alerts).toHaveLength(2);
});

test("a path that did not fall tells nothing", async () => {
  const w = world([stand("store_prompt", { answered: 60, hits: 18 }, DAY), stand("store_tool", { answered: 4, hits: 0 }, DAY)]);
  expect(await watchFell(w.deps)).toEqual([]);
});
