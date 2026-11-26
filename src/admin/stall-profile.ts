// A run of stalls that name nothing samples the daemon's own main thread.
//
// The stall watcher reads the main thread from /proc (src/admin/stall-watch.ts) and sees no
// JavaScript frames, so code that holds the loop is named only when it is a section the daemon
// times. When such stalls keep coming ("outside anything it times", STORM.count of them within
// STORM.window_ms), the daemon starts the runtime's sampling profiler on its main thread for
// STORM.profile_ms (node:inspector's Profiler: it samples the thread that starts it, and between
// the stalls of such a run the loop is free to start it). What the samples hold is said in one
// Errors row: the functions of Keel's own code the main thread was in, with their share of the
// samples, and the profile is kept in the state folder (`profiles/`, the newest PROFILES_KEPT)
// for a closer look. At most one profile every STORM.gap_ms: a run that goes on is not profiled
// again until then.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STORM = { count: 5, window_ms: 120_000, profile_ms: 20_000, gap_ms: 30 * 60_000, interval_us: 1000 };
export const PROFILES_KEPT = 5;
// A function named in the row holds at least this share of the busy samples; at most TOP are named.
const SHARE_MIN = 0.03;
const TOP = 6;

// Whether the untimed stalls at `times` (ms, any order) call for a profile at `now`; `last`: when the last one started.
export function due(times: readonly number[], now: number, last: number | null, s = STORM): boolean {
  if (last !== null && now - last < s.gap_ms) return false;
  return times.filter((t) => t <= now && now - t <= s.window_ms).length >= s.count;
}

// The profile the inspector gives (the Chrome DevTools format a .cpuprofile file holds).
export type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber?: number };
export type ProfileNode = { id: number; callFrame: CallFrame; children?: number[] };
export type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas?: number[]; startTime: number; endTime: number };
export type Hot = { name: string; share: number; samples: number };
export type Summary = { samples: number; busy: number; busy_ms: number; ms: number; top: Hot[] };

const MARKS = new Set(["(root)", "(program)", "(idle)", "(garbage collector)"]);
// A frame of the daemon's own code: a script with a place (a native function or the runtime's own has no url).
const own = (f: CallFrame) => !!f.url && !f.url.startsWith("node:") && !f.url.startsWith("bun:") && !MARKS.has(f.functionName);
// Its place in the source, where the frame names a source file (a dev daemon); a compiled daemon's frames name
// its bundle, whose lines say nothing, so there the function's name is all.
const nameOf = (f: CallFrame) => {
  const name = f.functionName || "(anonymous)";
  const src = f.url.lastIndexOf("/src/");
  return src >= 0 ? `${name} (${f.url.slice(src + 1)}:${f.lineNumber + 1})` : name;
};

// Each busy sample is put to the innermost function of the daemon's own code on its stack, with the native
// function it was in when that is where the sample fell ("readFileSync in procTable (src/tools/jobs.ts:1259)").
// A sample of the collector counts as the collector's.
export function summarize(p: Profile): Summary {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const up = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) up.set(c, n.id);
  const count = new Map<string, number>();
  let busy = 0;
  for (const id of p.samples) {
    const leaf = byId.get(id);
    if (!leaf) continue;
    const fn = leaf.callFrame.functionName;
    if (fn === "(idle)" || fn === "(root)") continue;
    busy++;
    let name: string;
    if (fn === "(garbage collector)") name = "the garbage collector";
    else {
      let at: number | undefined = id, mine: ProfileNode | undefined;
      for (let i = 0; at !== undefined && i < 512; i++, at = up.get(at)) { const n = byId.get(at)!; if (own(n.callFrame)) { mine = n; break; } }
      const native = !own(leaf.callFrame) && fn && !MARKS.has(fn) ? fn : "";
      name = mine ? `${native && mine !== leaf ? `${native} in ` : ""}${nameOf(mine.callFrame)}` : native || "the runtime's own code";
    }
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  const ms = Math.max(0, (p.endTime - p.startTime) / 1000);
  const per = p.samples.length ? ms / p.samples.length : 0;
  const top = [...count].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([name, n]) => ({ name, samples: n, share: busy ? n / busy : 0 })).filter((h) => h.share >= SHARE_MIN);
  return { samples: p.samples.length, busy, busy_ms: Math.round(busy * per), ms: Math.round(ms), top };
}

// The row's words.
export function profileText(s: Summary, stalls: number): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const head = `The main thread was sampled for ${Math.round(s.ms / 1000)} s after ${stalls} stalls in code nothing times`;
  if (!s.busy) return `${head}: it was idle in all of it.`;
  const busyShare = s.ms ? ` (busy ${pct(Math.min(1, s.busy_ms / s.ms))} of the time)` : "";
  const named = s.top.length ? s.top.map((h) => `${pct(h.share)} ${h.name}`).join("; ") : "no function held more than a few percent of it";
  return `${head}${busyShare}: ${named}.`;
}

type Deps = {
  dir: string;
  // The row: its words and its context (the file, the figures).
  say: (text: string, context: Record<string, unknown>) => void;
  // (A test's own profiler; the runtime's otherwise.)
  sample?: (ms: number) => Promise<Profile>;
  now?: () => number;
  // (A test's own length of the profile; STORM.profile_ms otherwise.)
  profile_ms?: number;
};

// The runtime's sampling profiler on the thread that calls it.
async function sampleHere(ms: number): Promise<Profile> {
  const { Session } = await import("node:inspector");
  const s = new Session();
  s.connect();
  const post = (m: string, params: object = {}) => new Promise<any>((ok, no) => s.post(m, params, (e: unknown, r: unknown) => (e ? no(e) : ok(r))));
  try {
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: STORM.interval_us });
    await post("Profiler.start");
    await Bun.sleep(ms);
    return (await post("Profiler.stop")).profile as Profile;
  } finally {
    try { await post("Profiler.disable"); } catch {} // a session that broke: nothing to turn off
    s.disconnect();
  }
}

export class StallProfiler {
  private times: number[] = [];
  private last: number | null = null;
  running: Promise<void> | undefined;
  constructor(private d: Deps) {}

  // An untimed stall ended at `at`.
  stall(at: number) {
    const now = this.d.now?.() ?? Date.now();
    this.times = [...this.times.filter((t) => now - t <= STORM.window_ms), at];
    if (this.running || !due(this.times, now, this.last)) return;
    this.last = now;
    const stalls = this.times.length;
    this.running = this.run(stalls).finally(() => { this.running = undefined; });
  }

  private async run(stalls: number) {
    let p: Profile;
    try { p = await (this.d.sample ?? sampleHere)(this.d.profile_ms ?? STORM.profile_ms); } catch (e) {
      this.d.say(`The main thread could not be sampled after ${stalls} stalls in code nothing times: ${(e as Error).message}`, { kind: "stall profile" });
      return;
    }
    const s = summarize(p);
    let file: string | undefined;
    try {
      mkdirSync(this.d.dir, { recursive: true });
      file = join(this.d.dir, `stalls-${new Date(this.d.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-")}.cpuprofile`);
      writeFileSync(file, JSON.stringify(p));
      const old = readdirSync(this.d.dir).filter((n) => n.endsWith(".cpuprofile")).sort().reverse().slice(PROFILES_KEPT);
      for (const n of old) rmSync(join(this.d.dir, n), { force: true });
    } catch { file = undefined; } // the row says what it found without the file
    this.d.say(profileText(s, stalls), { kind: "stall profile", stalls, ms: s.ms, busy_ms: s.busy_ms, samples: s.samples, top: s.top, ...(file ? { file } : {}) });
  }
}
