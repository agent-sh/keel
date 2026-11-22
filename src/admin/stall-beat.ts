// The one number the daemon's loop and its stall watcher share (stall.ts
// writes it, stall-watch-worker.ts reads it): a count that changes at every
// write, and in its low bits how many milliseconds from now the loop will
// write again at the latest. A loop that is later than its own word is held.
// Zero: no loop is watched (its timer has not started, or was stopped).
// The largest value of the low bits is no time at all: the loop is idle, it
// sleeps until something happens and gives no word for when. The watcher
// then looks for itself, once a second, whether the loop's thread sleeps.
//
// The cells the two share: the beat, then a count the loop raises (and
// notifies on) when the watcher is to look now instead of at its next time
// (work began, a message was posted to it), then the messages posted to it.
export const BEAT = 0, KICK = 1, SENT = 2;
export const ALLOW_BITS = 11;
export const ALLOW_MASK = (1 << ALLOW_BITS) - 1;
export const IDLE_ALLOW = ALLOW_MASK;
// The count part is never zero, so a beat is never read as "no loop".
export const packBeat = (seq: number, allowMs: number): number => (((seq % 0xfffff) + 1) << ALLOW_BITS) | Math.min(ALLOW_MASK - 1, Math.max(0, Math.round(allowMs)));
// The loop goes idle: no time is promised.
export const packIdle = (seq: number): number => (((seq % 0xfffff) + 1) << ALLOW_BITS) | IDLE_ALLOW;
