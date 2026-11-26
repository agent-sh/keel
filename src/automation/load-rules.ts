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
// How many: a tree's share of the load is taken as the load over the trees that work now. A held tree adds no
// load, so it is not counted: counting it would make each share small and keep a held tree waiting until the
// load fell far under the line. The share counts every process of the machine as Keel's, so with other load on
// the machine it is larger than a tree really adds: the hold takes fewer trees at a time and lets them go later,
// never the other way. Holding takes the newest trees first, as many as the load over the line is shares;
// letting go takes the oldest held trees first, as many shares as fit under the line. With every tree held the
// load is not Keel's: once it is under the line the oldest held tree goes, and its load says the next share.
//
// Hysteresis: a held tree is let go only when the load plus its share stays under the line, so a release does
// not by its own share put the machine over again; between the line less one share and the line nothing
// changes. Each change waits one more time constant (a minute) before the next, so the load has shown what the
// last change did before it is read again.
//
// A wait has a cap (MAX_WAIT_MS): a tree held that long goes on, and while the machine is still over the
// newest tree that works takes its place, so the count held stays and the load does not move by it. A tree let
// go by the cap is not held again for as long, so every tree gets its turn when load that is not Keel's keeps
// the machine over: the hold paces the trees, it never stops one for good.
//
// A tree that starts while trees are held and the machine has no room for one more share waits from its start:
// a new spawn does not take the room a held tree waits for.

export const SETTLE_MS = 60_000;
// A reading every five seconds: the kernel updates its load averages that often.
export const SAMPLE_MS = 5_000;
// Ten time constants of the load average: by then holding a tree has shown all it does for the load, and a
// longer wait no longer paces the machine, it only starves the tree (its parent and the owner wait on its work).
export const MAX_WAIT_MS = 10 * SETTLE_MS;

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
  // When each held tree was held.
  at: Record<string, number>;
  // Trees the cap let go, and until when they are not held again.
  rested: Record<string, number>;
  // The last share of a working tree (0: none read yet), for when every tree is held.
  each: number;
  // The trees the cap let go in this decision (their parents are told).
  capped: string[];
};

export const IDLE: LoadState = { held: [], changed_at: 0, since: null, at: {}, rested: {}, each: 0, capped: [] };

export function over(readings: Reading[], now: number): boolean {
  const last = readings.filter((r) => now - r.at <= SETTLE_MS);
  // The readings cover the minute, a sample's gap aside.
  if (!last.length || now - Math.min(...last.map((r) => r.at)) < SETTLE_MS - SAMPLE_MS) return false;
  return last.every((r) => r.load1 > r.threads);
}

export function share(load: number, working: number): number {
  return load / Math.max(1, working);
}

const pick = <K extends string>(o: Record<K, number>, keep: (k: string, v: number) => boolean) =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => keep(k, v as number))) as Record<string, number>;

export function decide(st: LoadState, readings: Reading[], trees: Tree[], now: number): LoadState {
  const live = new Set(trees.map((t) => t.key));
  // A held tree with no unattended work left (it ended, was stopped, its owner took it) is no longer held.
  let held = st.held.filter((k) => live.has(k));
  let at = pick(st.at, (k) => held.includes(k));
  // A tree the cap let go keeps its rest until it expires, even between its turns (it is not held again at once).
  const rested = pick(st.rested, (_k, until) => until > now);
  let changed = st.changed_at;
  const last = readings.at(-1);
  const out = (h: string[], o: Partial<LoadState> = {}): LoadState => {
    const a = pick(at, (k) => h.includes(k));
    return { held: h, changed_at: changed, since: h.length ? (st.since ?? now) : null, at: a, rested, each: st.each, capped: [], ...o };
  };
  if (!last) return out(held, { since: held.length ? st.since : null });
  const isOver = over(readings, now);
  const newestFirst = (ts: Tree[]) => [...ts].sort((a, b) => b.started - a.started || (a.key < b.key ? 1 : -1));
  // The cap: a tree held MAX_WAIT_MS goes on, and while the machine is over the newest working tree takes its place.
  const capped = held.filter((k) => now - (at[k] ?? now) >= MAX_WAIT_MS);
  if (capped.length) {
    held = held.filter((k) => !capped.includes(k));
    for (const k of capped) rested[k] = now + MAX_WAIT_MS;
    if (isOver) {
      const takers = newestFirst(trees.filter((t) => !held.includes(t.key) && !(t.key in rested))).slice(0, capped.length);
      for (const t of takers) { held.push(t.key); at[t.key] = now; }
    }
  }
  const free = trees.filter((t) => !held.includes(t.key));
  const each = free.length ? share(last.load1, free.length) : st.each || share(last.load1, trees.length);
  const room = last.load1 + each <= last.threads;
  const settled = now - changed >= SETTLE_MS;
  const since = held.length ? (st.since ?? now) : null;
  const done = (h: string[], o: Partial<LoadState> = {}) => out(h, { each, capped, since: h.length ? since : null, ...o });
  const candidates = free.filter((t) => !(t.key in rested));
  if (isOver && settled && candidates.length) {
    const n = Math.max(1, Math.ceil((last.load1 - last.threads) / each));
    const newest = newestFirst(candidates).slice(0, n);
    for (const t of newest) at[t.key] = now;
    held = [...held, ...newest.map((t) => t.key)];
    changed = now;
    return done(held, { changed_at: now, since: since ?? now });
  }
  // With every tree held the load is not Keel's: under the line the oldest goes, and the next reading says its share.
  const idle = !free.length && last.load1 <= last.threads;
  if (held.length && settled && (room || idle)) {
    const n = idle ? 1 : Math.max(1, Math.floor((last.threads - last.load1) / each));
    const byAge = new Map(trees.map((t) => [t.key, t.started]));
    const oldest = [...held].sort((a, b) => byAge.get(a)! - byAge.get(b)! || (a < b ? -1 : 1)).slice(0, n);
    held = held.filter((k) => !oldest.includes(k));
    changed = now;
    return done(held, { changed_at: now });
  }
  // A tree that started after the hold began, while there is no room for its share, waits from its start.
  if (held.length && !room && since !== null) {
    const fresh = candidates.filter((t) => t.started >= since).map((t) => t.key);
    for (const k of fresh) at[k] = now;
    if (fresh.length) held = [...held, ...fresh];
  }
  return done(held);
}

// The words of a held step's status.
export const loadWhy = (r: { load1: number; threads: number }) => `the machine is busy: load ${Math.round(r.load1)} on ${r.threads} threads`;
