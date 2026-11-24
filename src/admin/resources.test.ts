import { expect, test } from "bun:test";
import { growthPerHour, intervalCpu, memorySplit, rssStep, swapFrom, type RssPoint } from "./resources.ts";

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

// What of the daemon is in swap, from the kernel's own files: the process's status and its unit's two swap files.
test("swap is read for the process and for its unit, with the unit's limit", () => {
  const status = "Name:\tkeel\nVmRSS:\t  204800 kB\nVmSwap:\t   51200 kB\nThreads:\t40\n";
  expect(swapFrom(status, "73400320\n", "max\n")).toEqual({ process_bytes: 51200 * 1024, unit_bytes: 73400320 });
  // A unit that may not swap says so by a limit of 0; nothing in swap is 0, not absent.
  expect(swapFrom("VmSwap:\t       0 kB\n", "0\n", "0\n")).toEqual({ process_bytes: 0, unit_bytes: 0, unit_limit_bytes: 0 });
  // No unit of its own to read (no cgroup files): the process alone.
  expect(swapFrom(status, "", "")).toEqual({ process_bytes: 51200 * 1024 });
  // Whose the unit is: the daemon's own service when a service manager runs it, else the scope of the terminal it was started from.
  expect(swapFrom(status, "1\n", "max\n", "/user.slice/user-1000.slice/user@1000.service/app.slice/keel-bun.service", true)).toMatchObject({ unit: "keel-bun.service", own: true });
  expect(swapFrom(status, "1\n", "max\n", "/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-1.scope", false)).toMatchObject({ unit: "vte-spawn-1.scope", own: false });
  // A service that is not the daemon's (it was started by hand inside another unit's shell) is not its own either.
  expect(swapFrom(status, "1\n", "max\n", "/system.slice/ssh.service", false)).toMatchObject({ unit: "ssh.service", own: false });
});

// The unit `keel service install` writes keeps the daemon's memory out of swap.
test("the service unit sets no swap for the daemon", async () => {
  const { unitFor } = await import("./unit.ts");
  expect(unitFor({ command: ["/usr/local/bin/keel"], bind: "127.0.0.1:4680" })).toMatch(/^\[Service\][^[]*^MemorySwapMax=0$/ms);
});

// Where the daemon's memory is: the kernel's split of what is resident (its
// own memory, and mapped files such as its binary) and the runtime's
// (JavaScript objects, the heap's reserve, memory held outside it by buffers).
test("the daemon's memory is split into the kernel's and the runtime's parts", () => {
  const text = "VmRSS:\t  667180 kB\nRssAnon:\t  622084 kB\nRssFile:\t   45096 kB\nRssShmem:\t       0 kB\n";
  expect(memorySplit(text, { heapUsed: 200, heapTotal: 300, external: 40, arrayBuffers: 30 })).toEqual({
    anon_bytes: 622084 * 1024, file_bytes: 45096 * 1024, heap_used_bytes: 200, heap_total_bytes: 300, external_bytes: 40, array_buffers_bytes: 30,
  });
});

test("a process's command line is shown with the values the vault knows hidden", async () => {
  const { vault } = await import("../safety/secrets.ts");
  const { shown } = await import("./resources.ts");
  const secret = "plgv-" + "q8Zr2Lx7Wm4Tn6Yd";
  const e = vault.add(secret, "a setting of the plugin test", "card", null);
  try {
    const out = shown(["node", "server.js", `--key=${secret}`].join("\0"));
    expect(out).not.toContain(secret);
    expect(out.split("\0").slice(0, 2)).toEqual(["node", "server.js"]);
  } finally { vault.forget((e as { id: string }).id); }
});

// A step of the daemon's memory: over 200 MB within 10 s, told once, from the lowest sample of the window.
const MB = 1024 * 1024;
const series = (rows: [number, number][]): RssPoint[] => rows.map(([s, mb]) => ({ ts_ms: s * 1000, rss_bytes: mb * MB }));
test("a step of over 200 MB in 10 s is found once, with the sample it is measured from", () => {
  const all = series([[0, 500], [5, 500], [10, 980], [15, 990], [20, 1240], [25, 1240]]);
  // Samples every 5 s: the +480 MB lands at 10 s, and what follows it is not the same step.
  expect(rssStep(all.slice(0, 2))).toBeNull();
  const first = rssStep(all.slice(0, 3))!;
  expect([first.from.ts_ms, first.to.rss_bytes / MB]).toEqual([5000, 980]);
  expect(rssStep(all.slice(0, 4), first.to.ts_ms)).toBeNull(); // 980 to 990 only
  const second = rssStep(all.slice(0, 5), first.to.ts_ms)!;
  expect([second.from.rss_bytes / MB, second.to.rss_bytes / MB]).toEqual([980, 1240]); // from the lowest sample since the step told
  // Without the mark of the step told, the next sample would tell it again (its window still holds the low sample).
  expect(rssStep(all.slice(0, 4))).not.toBeNull();
  // Growth over a longer time is not a step: 150 MB in 10 s, twice, with 10 s between.
  expect(rssStep(series([[0, 500], [10, 650], [20, 800], [30, 950]]))).toBeNull();
  // Exactly the size is not over it, and a fall is none.
  expect(rssStep(series([[0, 500], [5, 700]]))).toBeNull();
  expect(rssStep(series([[0, 1500], [5, 500]]))).toBeNull();
  // An idle daemon samples every 30 s: the sample before stands for the window.
  expect(rssStep(series([[0, 500], [30, 760]]))?.from.ts_ms).toBe(0);
  expect(rssStep(series([[0, 500], [200, 900]]))).toBeNull();
  // One that is older than the window is not the lowest of it.
  expect(rssStep(series([[0, 100], [24, 500], [28, 600], [35, 750]]))).toBeNull();
});

test("growth an hour is the slope of the last hour's samples, not the rise from the start", () => {
  const hour = (mb: (min: number) => number) => Array.from({ length: 61 }, (_, i) => ({ ts_ms: i * 60_000, rss_bytes: mb(i) * MB }));
  // 100 MB at the start, 1 GB for the whole hour: no growth now, though 900 MB above the start.
  expect(growthPerHour(hour(() => 1000), 3600_000)).toBeCloseTo(0, 3);
  // 2 MB a minute is 120 MB an hour.
  expect(growthPerHour(hour((m) => 1000 + 2 * m), 3600_000)! / MB).toBeCloseTo(120, 3);
  // Samples older than the hour are not read.
  const old = [{ ts_ms: 0, rss_bytes: 100 * MB }, ...hour(() => 1000).map((p) => ({ ...p, ts_ms: p.ts_ms + 7200_000 }))];
  expect(growthPerHour(old, 7200_000 + 3600_000)! / MB).toBeCloseTo(0, 3);
  // Under ten minutes of samples: not known.
  expect(growthPerHour(hour((m) => 1000 + m).slice(0, 8), 7 * 60_000)).toBeNull();
});
