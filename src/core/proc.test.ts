// chunksUntil holds nothing of the chunks it has handed on, however long `stop` stays unsettled.
import { expect, test } from "bun:test";
import { chunksUntil, outputOf } from "./proc.ts";

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

// outputOf(): a child's whole output, read once it has ended.
const sh = (script: string) => Bun.spawn(["sh", "-c", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

test("outputOf gives both pipes and the code of a child that exits", async () => {
  const r = await outputOf(sh("printf out; printf err >&2; exit 3"));
  expect(r).toEqual({ code: 3, out: "out", err: "err", signal: null, timedOut: false, aborted: false, cut: false });
});

test("a child past its time is stopped, and what it wrote before is returned", async () => {
  const r = await outputOf(sh("printf before; printf said >&2; exec sleep 30"), { timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(r.signal).toBe("SIGKILL");
  expect(r.out).toBe("before");
  expect(r.err).toBe("said");
});

test("an abort stops the child, and what it wrote before is returned", async () => {
  const ac = new AbortController();
  const p = sh("printf before; exec sleep 30");
  setTimeout(() => ac.abort(), 200);
  const r = await outputOf(p, { signal: ac.signal });
  expect(r.aborted).toBe(true);
  expect(r.timedOut).toBe(false);
  expect(r.out).toBe("before");
  const pre = new AbortController();
  pre.abort();
  expect((await outputOf(sh("exec sleep 30"), { signal: pre.signal })).aborted).toBe(true);
});

test("a 100 MB output comes whole, or capped to its head", async () => {
  const whole = await outputOf(sh("head -c 100000000 /dev/zero | tr '\\0' x"));
  expect(whole.out.length).toBe(100_000_000);
  expect(whole.cut).toBe(false);
  const capped = await outputOf(sh("printf head; head -c 100000000 /dev/zero | tr '\\0' x"), { cap: 1000 });
  expect(capped.out.length).toBe(1000);
  expect(capped.out.startsWith("headxx")).toBe(true);
  expect(capped.cut).toBe(true);
}, 30_000);

test("a stderr flood is kept to its tail, and stdout comes whole beside it", async () => {
  const r = await outputOf(sh("printf result; head -c 50000000 /dev/zero | tr '\\0' e >&2; printf ' last' >&2"), { cap: 64, keep: "tail" });
  expect(r.out).toBe("result");
  expect(r.err.length).toBe(64);
  expect(r.err.endsWith("eee last")).toBe(true);
  expect(r.cut).toBe(true);
  expect(r.code).toBe(0);
}, 30_000);

test("what the child left holding a pipe is stopped before the read", async () => {
  const p = Bun.spawn(["sh", "-c", "printf x; sleep 30 & exit 0"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  const t0 = Date.now();
  const r = await outputOf(p, { exited: () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} } });
  expect(r.out).toBe("x");
  expect(Date.now() - t0).toBeLessThan(10_000);
});

test("with a grace, a pipe that a process outside the group holds open is read no longer than it", async () => {
  const p = Bun.spawn(["sh", "-c", "printf x; setsid sleep 30 & exit 0"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const t0 = Date.now();
  const r = await outputOf(p, { graceMs: 200 });
  expect(r.out).toBe("x");
  expect(r.cut).toBe(true);
  expect(Date.now() - t0).toBeLessThan(5_000);
});

test("the time limit still stops a group whose background process holds a pipe after the child's end", async () => {
  const p = Bun.spawn(["sh", "-c", "printf hi; sleep 30 & exit 0"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  const t0 = Date.now();
  const r = await outputOf(p, { timeoutMs: 200, kill: () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} } });
  expect(r.out).toBe("hi");
  expect(r.code).toBe(0);
  expect(r.timedOut).toBe(true);
  expect(Date.now() - t0).toBeLessThan(5_000);
}, 40_000);

test("an abort still stops a group whose background process holds a pipe after the child's end", async () => {
  const p = Bun.spawn(["sh", "-c", "printf hi; sleep 30 & exit 0"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  const r = await outputOf(p, { signal: ac.signal, kill: () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} } });
  expect(r.out).toBe("hi");
  expect(r.aborted).toBe(true);
  expect(Date.now() - t0).toBeLessThan(5_000);
}, 40_000);
