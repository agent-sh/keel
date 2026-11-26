// When a run of untimed stalls samples the main thread, and what the samples are said to hold.
// No e2e reaches this: a page cannot make the daemon's loop stall in code nothing times.
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempTree } from "../../test/env.ts";
import { due, type Profile, profileText, StallProfiler, STORM, summarize } from "./stall-profile.ts";

test("a profile is due at the fifth untimed stall of two minutes, and not again within the gap", () => {
  const t = [0, 10_000, 20_000, 30_000];
  expect(due(t, 40_000, null)).toBe(false);
  expect(due([...t, 40_000], 40_000, null)).toBe(true);
  // Spread over more than the window: four of them count.
  expect(due([-200_000, ...t.slice(1), 40_000], 40_000, null)).toBe(false);
  expect(due([...t, 40_000], 40_000, 40_000 - STORM.gap_ms + 1)).toBe(false);
  expect(due([...t, 40_000], 40_000, 40_000 - STORM.gap_ms)).toBe(true);
});

// A profile of the shape the inspector gives: (root) > loop > procTable > readFileSync, (root) > (idle), and the collector.
const frame = (functionName: string, url = "", lineNumber = 0) => ({ functionName, url, lineNumber });
const PROFILE: Profile = {
  startTime: 0, endTime: 10_000_000,
  nodes: [
    { id: 1, callFrame: frame("(root)"), children: [2, 5, 6] },
    { id: 2, callFrame: frame("tick", "/x/src/core/pulse.ts", 70), children: [3] },
    { id: 3, callFrame: frame("procTable", "/x/src/tools/jobs.ts", 1258), children: [4] },
    { id: 4, callFrame: frame("readFileSync") },
    { id: 5, callFrame: frame("(idle)") },
    { id: 6, callFrame: frame("(garbage collector)") },
  ],
  samples: [4, 4, 4, 3, 5, 5, 5, 5, 5, 6],
};

test("each busy sample is the innermost function of Keel's own code, with the native function it fell in", () => {
  const s = summarize(PROFILE);
  expect(s).toMatchObject({ samples: 10, busy: 5, ms: 10_000, busy_ms: 5_000 });
  expect(s.top).toEqual([
    { name: "readFileSync in procTable (src/tools/jobs.ts:1259)", samples: 3, share: 0.6 },
    { name: "procTable (src/tools/jobs.ts:1259)", samples: 1, share: 0.2 },
    { name: "the garbage collector", samples: 1, share: 0.2 },
  ]);
  expect(profileText(s, 7)).toBe("The main thread was sampled for 10 s after 7 stalls in code nothing times (busy 50% of the time): 60% readFileSync in procTable (src/tools/jobs.ts:1259); 20% procTable (src/tools/jobs.ts:1259); 20% the garbage collector.");
  // A compiled daemon's frames name its bundle: the function's name is all.
  const bundled = summarize({ ...PROFILE, nodes: PROFILE.nodes.map((n) => (n.callFrame.url ? { ...n, callFrame: { ...n.callFrame, url: "/$bunfs/root/keel" } } : n)) });
  expect(bundled.top[0]!.name).toBe("readFileSync in procTable");
});

test("a run of untimed stalls samples the main thread once and says what it was in, with the profile kept", async () => {
  const dir = join(tempTree("keel-stall-profile-"), "profiles");
  const said: { text: string; context: Record<string, unknown> }[] = [];
  let now = 1_000_000;
  // The runtime's own profiler, for a short while, as the main thread spins in a function of this file.
  const p = new StallProfiler({ dir, say: (text, context) => void said.push({ text, context }), now: () => now, profile_ms: 400 });
  function spinsHere(until: number) { let x = 0; for (; performance.now() < until; ) x += Math.sqrt(x + 1); return x; }
  for (let i = 4; i > 0; i--) p.stall(now - i);
  expect(p.running).toBeUndefined();
  p.stall(now);
  expect(p.running).toBeDefined();
  // The loop is held in short turns, as it is between the stalls of such a run.
  const end = performance.now() + 350;
  for (; performance.now() < end; await Bun.sleep(1)) spinsHere(performance.now() + 20);
  await p.running;
  expect(said).toHaveLength(1);
  expect(said[0]!.text).toMatch(/^The main thread was sampled for 0 s after 5 stalls in code nothing times \(busy \d+% of the time\): \d+% (Math\.sqrt in )?spinsHere \(src\/admin\/stall-profile\.test\.ts:\d+\)/);
  const file = said[0]!.context.file as string;
  expect(existsSync(file)).toBe(true);
  // Another stall soon after: no second profile until the gap has passed.
  now += 60_000;
  for (let i = 5; i >= 0; i--) p.stall(now - i);
  expect(p.running).toBeUndefined();
  expect(readdirSync(dir)).toHaveLength(1);
});
