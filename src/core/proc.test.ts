// chunksUntil holds nothing of the chunks it has handed on, however long `stop` stays unsettled.
import { expect, test } from "bun:test";
import { chunksUntil } from "./proc.ts";

const CHUNK = 1 << 20;
const COUNT = 400;

// A stream of `COUNT` chunks of 1 MiB, each made when it is asked for.
const source = () => {
  let n = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) { if (n++ < COUNT) c.enqueue(new Uint8Array(CHUNK).fill(n & 255)); else c.close(); },
  }, { highWaterMark: 0 });
};

test("a stop that never comes does not keep the chunks that were read", async () => {
  const stop = new Promise<void>(() => {});
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  let n = 0;
  for await (const c of chunksUntil(source(), stop)) n += c.length > 0 ? 1 : 0;
  Bun.gc(true);
  expect(n).toBe(COUNT);
  // 400 MiB went through: a leak of them is hundreds of MiB.
  expect((process.memoryUsage().rss - before) / (1 << 20)).toBeLessThan(120);
});

test("it ends when stop settles, and cancels what is left of the stream", async () => {
  let cancelled = false;
  let n = 0;
  const s = new ReadableStream<Uint8Array>({
    async pull(c) { await Bun.sleep(1); c.enqueue(new Uint8Array(8)); n++; },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  let go!: () => void;
  const stop = new Promise<void>((r) => (go = r));
  let seen = 0;
  for await (const _ of chunksUntil(s, stop)) { if (++seen === 3) go(); }
  expect(seen).toBeGreaterThanOrEqual(3);
  expect(seen).toBeLessThanOrEqual(4);
  await Bun.sleep(10);
  expect(cancelled).toBe(true);
});

test("a read that waits when stop settles ends at once", async () => {
  const s = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } }, { highWaterMark: 0 });
  const stop = Bun.sleep(30);
  const got: Uint8Array[] = [];
  for await (const c of chunksUntil(s, stop)) got.push(c);
  expect(got).toHaveLength(0);
});
