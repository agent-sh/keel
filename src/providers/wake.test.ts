// A machine's sleep leaves dead sockets in Bun's pool. The jump rule is pure; the probe is a server that goes
// silent on the sockets it already holds, as a network does after a resume, and a request after the wake must
// not wait on them.
import { afterAll, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { streamEvents } from "./http.ts";
import { slept, watchWake, woke, WAKE_JUMP_MS } from "./wake.ts";

test("a sleep is the wall clock running past the monotonic one by more than the jump", () => {
  const at = { wall: 1_000_000, mono: 5_000 };
  // An ordinary beat, a late one (a busy loop moves both clocks) and a clock a time server set back.
  expect(slept(at, { wall: at.wall + 10_000, mono: at.mono + 10_000 })).toBe(false);
  expect(slept(at, { wall: at.wall + 40_000, mono: at.mono + 40_000 })).toBe(false);
  expect(slept(at, { wall: at.wall - 5_000, mono: at.mono + 1_000 })).toBe(false);
  // A suspend: the monotonic clock stood still while the wall clock went on.
  expect(slept(at, { wall: at.wall + 120_000, mono: at.mono + 3_000 })).toBe(true);
  expect(slept(at, { wall: at.wall + WAKE_JUMP_MS + 3_001, mono: at.mono + 3_000 })).toBe(true);
  expect(slept(at, { wall: at.wall + WAKE_JUMP_MS + 3_000, mono: at.mono + 3_000 })).toBe(false);
});

test("the tick's member calls the purge when a beat finds the clocks apart, and not otherwise", () => {
  let wall = 1_000, mono = 0, woken = 0, run!: (now: number) => void;
  watchWake(() => woken++, ((_n: string, f: (now: number) => void) => { run = f; return () => {}; }) as any, { wall: () => wall, mono: () => mono });
  wall += 10_000; mono += 10_000; run(wall);
  expect(woken).toBe(0);
  wall += 300_000; mono += 2_000; run(wall);
  expect(woken).toBe(1);
  wall += 10_000; mono += 10_000; run(wall);
  expect(woken).toBe(1);
});

// A server that answers every request, and can go silent on all the connections it holds now.
let opened = 0;
const socks = new Set<Socket>();
const silent = new Set<Socket>();
const server = createServer((s) => {
  opened++;
  socks.add(s);
  s.on("data", () => { if (!silent.has(s)) s.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 15\r\n\r\ndata: {\"a\":1}\n\n"); });
  s.on("error", () => {});
  s.on("close", () => socks.delete(s));
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
afterAll(() => { for (const s of socks) s.destroy(); server.close(); });

const ask = async () => {
  const t = Date.now();
  const got: unknown[] = [];
  for await (const e of streamEvents({ label: "probe", url, headers: {}, body: {}, signal: new AbortController().signal, idleMs: 6_000 })) got.push(e);
  return { ms: Date.now() - t, got: got.length };
};

test("without a sleep requests keep reusing the connection; after one the first request does not wait on a dead socket", async () => {
  await ask();
  const before = opened;
  await ask();
  await ask();
  expect(opened).toBe(before);
  // The network drops what is sent on the sockets held now.
  for (const s of socks) silent.add(s);
  // The tick found the sleep: hosts are marked, the old sockets are probed out in the background.
  const purge = woke();
  const first = await ask();
  expect(first.got).toBeGreaterThan(0);
  expect(first.ms).toBeLessThan(1_500);
  await purge;
  // Clean: the pool is used again, and none of its sockets is a silent one.
  const mark = opened;
  const a = await ask();
  const b = await ask();
  expect(Math.max(a.ms, b.ms)).toBeLessThan(1_500);
  expect(opened - mark).toBeLessThanOrEqual(1);
}, 30_000);
