// The pace of a session's unattended turns, the pure part (src/automation/pace.ts runs it).
//
// A turn nobody started (a wake, an agent's report, a loop's run, a monitor's batch, a goal's next turn)
// rereads the session's whole context. Of a coordinator's turns most began within minutes of the
// previous one's end, each for one input, and a turn that took a second input cost about half a turn
// more, not a second turn. So an input that comes within the pace of the last unattended turn's end waits
// for the pace to pass, and everything that waited then goes as one input.
//
// Only an input its sender marked as able to wait is paced, and only until its own deadline (a loop's
// next run, a wait's timeout). Everything else goes at once and takes what waits with it: an agent's
// question, failure or stop, a failure notice, a timer the model set, a wait that timed out. The
// owner's own messages never reach this rule (they go through the engine's queue), and a turn that
// carries his word sets no pace for the next one.

// Minutes. The default for a session the owner talks to, from a day of a coordinator's turns replayed
// through this rule: 5 minutes merged about a third of its unattended turns for a median wait of about a
// minute; 10 merged more but doubled the waits, and below 3 little merged. An agent is not paced unless its
// session says so: its parent waits on it.
export const PACE_DEFAULT_MIN = 5;
// The most a session's pace may be: past an hour the longest a provider keeps a cache, and a session
// that wants less often should use a loop.
export const PACE_MAX_MIN = 60;

// One part that waits. `paced`: its sender marked it able to wait. `by`: when it must go at the latest.
export type PacePart = { paced: boolean; by?: number };

export type PaceIn = {
  paceMs: number;
  // When the session's last unattended turn ended, if one did since the daemon started.
  lastEnd?: number;
  // How long the session's cache surely lives from its last request (0: no cache to keep).
  life?: number;
  now: number;
  parts: readonly PacePart[];
};
export type PaceOut = { go: true } | { go: false; at: number };

// What a request needs of a cache's lifetime before it ends: a minute, or a quarter of a short one
// (as the cache plans count it, src/engine/cache-plans.ts marginOf).
export const lifeMargin = (life: number) => Math.min(60_000, Math.floor(life / 4));

export function decide(p: PaceIn): PaceOut {
  if (!(p.paceMs > 0) || p.lastEnd === undefined || !p.parts.length) return { go: true };
  if (p.parts.some((x) => !x.paced)) return { go: true };
  let at = p.lastEnd + p.paceMs;
  // Never past the cache: a wait that lapses it rewrites the whole context, which costs more than a turn.
  if (p.life && p.life > 0) at = Math.min(at, p.lastEnd + p.life - lifeMargin(p.life));
  for (const x of p.parts) if (x.by !== undefined) at = Math.min(at, x.by);
  return at <= p.now ? { go: true } : { go: false, at };
}

// The pace of a session in ms: its own setting (minutes, 0 is off), else the owner's default for a
// session he talks to; an agent has none unless its session sets one.
export function paceMsOf(own: number | undefined, fallback: number, top: boolean): number {
  const min = own !== undefined ? own : top ? fallback : 0;
  return Number.isFinite(min) && min > 0 ? Math.min(min, PACE_MAX_MIN) * 60_000 : 0;
}

// A setting's value, checked: minutes from 0 to PACE_MAX_MIN.
export const badPace = (v: unknown): string | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= PACE_MAX_MIN ? undefined : `a pace is minutes from 0 (off) to ${PACE_MAX_MIN}`;
