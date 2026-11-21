// The one number the daemon's loop and its stall watcher share (stall.ts
// writes it, stall-watch-worker.ts reads it): a count that changes at every
// write, and in its low bits how many milliseconds from now the loop will
// write again at the latest. A loop that is later than its own word is held.
// Zero: no loop is watched (its timer has not started, or was stopped).
export const ALLOW_BITS = 11;
export const ALLOW_MASK = (1 << ALLOW_BITS) - 1;
export const packBeat = (seq: number, allowMs: number): number => ((seq & 0xfffff) << ALLOW_BITS) | Math.min(ALLOW_MASK, Math.max(0, Math.round(allowMs)));
