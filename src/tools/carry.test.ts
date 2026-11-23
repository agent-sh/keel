// How much of a result stays inline for what carrying it costs (pure: the
// engine sets it per step, the spill test covers the cut itself).
import { expect, test } from "bun:test";
import { FLOOR, inlineCap, laterRequests } from "./carry.ts";
import { OUTPUT_CAP } from "./spill.ts";

const price = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 };
const at = (context: number, steps: number, extra: Partial<Parameters<typeof inlineCap>[0]> = {}) =>
  inlineCap({ context, price, steps, room: 800_000 - context, growth: context / steps, output: 700, bytes: 4, ...extra });

test("the requests still to come: as many as the context had, no more than fit before its compaction", () => {
  expect(laterRequests({ steps: 40, room: 1e6, growth: 1000 })).toBe(40);
  expect(laterRequests({ steps: 40, room: 10_000, growth: 1000 })).toBe(10);
  expect(laterRequests({ steps: 0, room: 0, growth: 1000 })).toBe(1);
});

test("a long context that will run many steps keeps the least, a large one about to compact keeps more", () => {
  expect(at(400_000, 200)).toBe(FLOOR);
  // Near its compaction, at a large context: a step to read the rest back costs more than carrying it.
  const near = at(300_000, 200, { room: 20_000, growth: 10_000 });
  expect(near).toBeGreaterThan(FLOOR);
  expect(near).toBeLessThan(OUTPUT_CAP);
  // The same context with many steps to come keeps less.
  expect(at(300_000, 200, { room: 1e9, growth: 10_000 })).toBeLessThan(near);
  // No price to weigh: the cap every result had.
  expect(inlineCap({ context: 400_000, steps: 200, room: 1, growth: 1, output: 700, bytes: 4 })).toBe(OUTPUT_CAP);
  // A tier above the context's size is priced at its own rates.
  const tiered = { ...price, tiers: [{ above: 200_000, input: 50, output: 250, cache_read: 50, cache_write: 62.5 }] };
  expect(at(300_000, 200, { room: 20_000, growth: 10_000, price: tiered })).toBeGreaterThan(near);
});
