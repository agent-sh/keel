// Ported from the Rust keel's wave3_alerts witnesses: a push for a question
// waits for it to go unanswered away from the desk, and a held push asks the
// lock probe at a growing interval.
import { expect, test } from "bun:test";
import { holdThenSend } from "./hold.ts";

function run(opts: { needsAnswer: boolean; desk: boolean[]; openUntil?: number }) {
  const slept: number[] = [];
  let t = 0, probes = 0, sent = false;
  const done = holdThenSend({
    needsAnswer: opts.needsAnswer,
    stillOpen: () => t < (opts.openUntil ?? Infinity),
    atDesk: () => opts.desk[probes++] ?? false,
    sleep: async (ms) => { slept.push(ms); t += ms; },
    send: async () => { sent = true; },
  });
  return done.then((r) => ({ r, sent, slept, probes }));
}

test("a question waits 20 s and goes out when nobody answered it away from the desk", async () => {
  const x = await run({ needsAnswer: true, desk: [false] });
  expect(x).toMatchObject({ r: true, sent: true, slept: [20_000] });
});

test("answered within the wait: nothing is sent", async () => {
  const x = await run({ needsAnswer: true, desk: [false], openUntil: 5_000 });
  expect(x.sent).toBe(false);
});

test("held at the desk, probed at a growing interval, sent once the owner left", async () => {
  const x = await run({ needsAnswer: true, desk: [true, true, true, true, true, true, true, false] });
  expect(x.sent).toBe(true);
  expect(x.slept).toEqual([20_000, 1000, 2000, 4000, 8000, 16_000, 20_000, 20_000]);
});

test("held at the desk and answered there: dropped", async () => {
  const x = await run({ needsAnswer: true, desk: [true, true, true], openUntil: 22_500 });
  expect(x.sent).toBe(false);
});

test("news that needs no answer goes at once, unless the owner is at the desk", async () => {
  expect((await run({ needsAnswer: false, desk: [false] })).sent).toBe(true);
  expect((await run({ needsAnswer: false, desk: [true] })).sent).toBe(false);
});
