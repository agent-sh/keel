import { expect, test } from "bun:test";
import { intervalCpu } from "./resources.ts";

// Daemon 1,000 ms and a child 2,000 ms; a second later the daemon is at
// 1,100 and the child is gone: the interval used 100 ms (10%), not 0.
test("a child that ends does not erase the daemon's CPU, and a reused pid is another process", () => {
  const first = intervalCpu(new Map(), [{ pid: 1, started_ms: 0, cpu: 1000 }, { pid: 2, started_ms: 10, cpu: 2000 }], undefined);
  const next = intervalCpu(first.at, [{ pid: 1, started_ms: 0, cpu: 1100 }], 1000);
  expect([next.used, next.gone]).toEqual([100, 1]);
  // Pid 2 again, started after the last sample: all its CPU is this interval's.
  const reused = intervalCpu(next.at, [{ pid: 1, started_ms: 0, cpu: 1150 }, { pid: 2, started_ms: 2500, cpu: 30 }], 2000);
  expect(reused.used).toBe(80);
});
