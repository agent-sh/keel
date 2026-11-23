import { expect, test } from "bun:test";
import { intervalCpu, memorySplit, swapFrom } from "./resources.ts";

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
