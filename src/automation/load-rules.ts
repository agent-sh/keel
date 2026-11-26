// Which agent trees wait for the machine (src/automation/load-hold.ts runs it). Pure: readings, trees and the
// last decision in, the next decision out.
//
// The line is the machine's thread count: a 1-minute load above it means work queues for a processor, and the
// owner's own turns and his desktop slow down with it.
//
// Over: every reading of the last minute is above the line, and the readings cover that minute. The kernel's
// 1-minute load is an average that moves with a time constant of one minute, so a reading of a few seconds
// (a build that starts) holds nothing, and a load that stays up a whole minute is the machine's, not a spike.
//
// How many: a tree's share of the load is taken as the load over the trees with unattended work (held ones
// included). It counts every process of the machine as Keel's, so with other load on the machine the share is
// larger than a tree really adds: the hold takes fewer trees at a time and lets them go later, never the other
// way. Holding takes the newest trees first, as many as the load over the line is shares; letting go takes the
// oldest held trees first, as many shares as fit under the line.
//
// Hysteresis: a held tree is let go only when the load plus its share stays under the line, so a release does
// not by its own share put the machine over again; between the line less one share and the line nothing
// changes. Each change waits one more time constant (a minute) before the next, so the load has shown what the
// last change did before it is read again.
//
// A tree that starts while trees are held and the machine has no room for one more share waits from its start:
// a new spawn does not take the room a held tree waits for.

export const SETTLE_MS = 60_000;
// A reading every five seconds: the kernel updates its load averages that often.
export const SAMPLE_MS = 5_000;

export type Reading = { at: number; load1: number; threads: number };
// A tree with unattended work now: its key (the agent a top session started, or the top session's own turn
// that nobody at the keyboard started) and when it started.
export type Tree = { key: string; started: number };
export type LoadState = {
  // Held trees, in the order they were held.
  held: string[];
  // When the last hold or release was made (0: none yet).
  changed_at: number;
  // When the current hold began (the first tree held), null while nothing is held.
  since: number | null;
};

export const IDLE: LoadState = { held: [], changed_at: 0, since: null };

export function over(readings: Reading[], now: number): boolean {
  const last = readings.filter((r) => now - r.at <= SETTLE_MS);
  // The readings cover the minute, a sample's gap aside.
  if (!last.length || now - Math.min(...last.map((r) => r.at)) < SETTLE_MS - SAMPLE_MS) return false;
  return last.every((r) => r.load1 > r.threads);
}

export function share(load: number, trees: number): number {
  return load / Math.max(1, trees);
}

export function decide(st: LoadState, readings: Reading[], trees: Tree[], now: number): LoadState {
  const live = new Set(trees.map((t) => t.key));
  // A held tree with no unattended work left (it ended, was stopped, its owner took it) is no longer held.
  let held = st.held.filter((k) => live.has(k));
  let changed = st.changed_at;
  const last = readings.at(-1);
  if (!last) return { held, changed_at: changed, since: held.length ? st.since : null };
  const each = share(last.load1, trees.length);
  const free = trees.filter((t) => !held.includes(t.key));
  const room = last.load1 + each <= last.threads;
  const settled = now - changed >= SETTLE_MS;
  const since = held.length ? st.since : null;
  if (over(readings, now) && settled && free.length) {
    const n = Math.max(1, Math.ceil((last.load1 - last.threads) / each));
    const newest = [...free].sort((a, b) => b.started - a.started || (a.key < b.key ? 1 : -1)).slice(0, n);
    held = [...held, ...newest.map((t) => t.key)];
    return { held, changed_at: now, since: since ?? now };
  }
  if (held.length && room && settled) {
    const n = Math.max(1, Math.floor((last.threads - last.load1) / each));
    const byAge = new Map(trees.map((t) => [t.key, t.started]));
    const oldest = [...held].sort((a, b) => byAge.get(a)! - byAge.get(b)! || (a < b ? -1 : 1)).slice(0, n);
    held = held.filter((k) => !oldest.includes(k));
    changed = now;
    return { held, changed_at: changed, since: held.length ? since : null };
  }
  // A tree that started after the hold began, while there is no room for its share, waits from its start.
  if (held.length && !room && since !== null) {
    const fresh = free.filter((t) => t.started >= since).map((t) => t.key);
    if (fresh.length) held = [...held, ...fresh];
  }
  return { held, changed_at: changed, since: held.length ? since : null };
}

// The words of a held step's status.
export const loadWhy = (r: { load1: number; threads: number }) => `the machine is busy: load ${Math.round(r.load1)} on ${r.threads} threads`;
