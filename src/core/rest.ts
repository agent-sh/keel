// Memory given back.
//
// At rest. A daemon that worked keeps memory it no longer uses: objects
// the collector has not looked at since (it looks when the heap grows, and
// a daemon at rest does not grow), the events of sessions nobody reads
// now, and under both the allocator's pages, which it can return only when
// nothing on them is alive. After a day of work a daemon rested at 350 to
// 400 MB with a heap of 35 to 80: three quarters of it pages the allocator
// held in its arenas. Once no turn has run for a minute it is all asked for
// back, once: the store gives up the events it keeps (a session read again
// is read from the store: some tens of milliseconds for 50,000 events) and
// its connection's cache, the collector makes whole collections, and the
// runtime shrinks its footprint (which asks the allocator to return its
// free pages). Not again until a turn has run: nothing is done
// periodically. Rest is told by turns, not by requests: a page that is
// open asks something every few seconds and allocates next to nothing.
//
// Under pressure. When the unit bounds the daemon's memory (MemoryHigh:
// src/admin/unit.ts), the kernel counts each time the group passes that
// bound, and from there it slows every allocation down to take memory
// back. The count is read with the daemon's tick; when it has risen, the
// store gives back the events it keeps beyond half its budget, memory is
// released as at rest, and the daemon says so once per stretch of pressure.
import { memoryEvents, memoryLimits } from "./cgroup.ts";

// No turn for this long, the daemon is at rest.
export const REST_AFTER_MS = 60_000;
// Pressure that returns within this long of the last is the same stretch: it is acted on, not said again.
const SAME_PRESSURE_MS = 10 * 60_000;

export type RestDeps = {
  // Frees what the store holds for speed alone (its connection's cache). `share`: also the kept events beyond that share of their budget; returns the bytes given back.
  store: { shrink(): void; giveBack(share: number): number };
  // Whole collections and the allocator's free pages. Given by the daemon; a test gives its own.
  release?: () => void;
  // The kernel's count of the times the group was over its throttle limit, when a limit is set.
  highEvents?: () => number | undefined;
  say?: (line: string) => void;
  rss?: () => number;
  clock?: () => number;
};

function releaseAll() {
  const B = (globalThis as { Bun?: { gc(whole: boolean): void; shrink?: () => void } }).Bun;
  if (!B) return;
  // Twice: what the first collection's finalizers let go of is collected by the second.
  B.gc(true);
  B.gc(true);
  B.shrink?.();
}

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

const G = globalThis as { __keelRest?: Rest };
// The daemon's own (the resources report reads what it gave back last).
export const restOf = (): Rest | undefined => G.__keelRest;

export class Rest {
  // The daemon worked since memory was last given back.
  private worked = true;
  private lastWork: number;
  private high: number | undefined;
  private pressedAt = -Infinity;
  private said: { at: number; before: number } | undefined;
  // What was given back last, for the resources report.
  last?: { at: number; why: "rest" | "pressure"; rss_before: number; rss_after?: number; events_bytes?: number };
  private clock: () => number;
  private rss: () => number;

  constructor(private deps: RestDeps) {
    this.clock = deps.clock ?? Date.now;
    this.rss = deps.rss ?? (() => process.memoryUsage().rss);
    this.lastWork = this.clock();
    this.high = this.events();
    G.__keelRest = this;
  }

  private events(): number | undefined {
    try { return this.deps.highEvents ? this.deps.highEvents() : memoryLimits().high ? memoryEvents()?.high : undefined; } catch { return undefined; }
  }

  // When the tick is next needed for this while the daemon is idle: at the minute after its last work, once.
  due(): number | undefined {
    return this.worked ? this.lastWork + REST_AFTER_MS : undefined;
  }

  // One look, from the daemon's tick. `working`: whether a turn runs now.
  tick(working: boolean, now = this.clock()) {
    // What the last release came to, read a tick later (the allocator returns its pages a moment after it is asked).
    if (this.said && now - this.said.at >= 5_000) {
      const after = this.rss();
      if (this.last) this.last.rss_after = after;
      this.said = undefined;
    }
    this.pressure(now);
    if (working) { this.worked = true; this.lastWork = now; return; }
    if (!this.worked || now - this.lastWork < REST_AFTER_MS) return;
    this.worked = false;
    // Nothing reads a session now: every kept event goes.
    let gave = 0;
    try { gave = this.deps.store.giveBack(0); } catch {}
    this.release("rest", now, gave);
  }

  private pressure(now: number) {
    const high = this.events();
    if (high === undefined) return;
    const rose = this.high !== undefined && high > this.high;
    this.high = high;
    if (!rose) return;
    const again = now - this.pressedAt < SAME_PRESSURE_MS;
    this.pressedAt = now;
    let gave = 0;
    try { gave = this.deps.store.giveBack(0.5); } catch {}
    const before = this.release("pressure", now, gave);
    if (!again) this.deps.say?.(`The daemon passed its unit's memory bound (MemoryHigh) at ${mb(before)} resident: it gave back ${mb(gave)} of kept events and what the collector and the allocator held. A session read again is read from the store. If this repeats, the bound is too low for the work (keel service update sets this build's; a drop-in sets another).`);
  }

  private release(why: "rest" | "pressure", now: number, events = 0): number {
    const before = this.rss();
    try { this.deps.store.shrink(); } catch {}
    try { (this.deps.release ?? releaseAll)(); } catch {}
    this.last = { at: now, why, rss_before: before, ...(events ? { events_bytes: events } : {}) };
    this.said = { at: now, before };
    return before;
  }
}
