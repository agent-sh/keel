// What is told late because the daemon was down says so: a wait that fired
// after its time ("fired 14 min late: the daemon was down from 20:23 to
// 21:06"), a command that ended while no daemon watched it ("it ended at
// 20:27, while the daemon was down"). The words are here and pure; the
// downtime is the last daemon's end and this one's start (src/admin/life.ts).
import { localTime } from "./clock.ts";

export type Down = { from: number; to: number };

// The stretch this process's daemon was down before it started, when the one before it is known.
export function lastDown(): Down | undefined {
  // (To when it began to answer: a start's modules load for many seconds before that.)
  const life = (globalThis as { __keelLife?: { before: { down_ms: number } | null; started_ms: number; listening_ms?: number } }).__keelLife;
  return life?.before ? { from: life.before.down_ms, to: life.listening_ms ?? life.started_ms } : undefined;
}

// Late by less than this is the daemon's own pace (a probe a second, a busy loop), not worth a word.
export const LATE_MS = 60_000;
const hhmm = (ts: number) => localTime(ts).slice(0, 5);
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

// "14 min late: the daemon was down from 20:23 to 21:06", or nothing when it was not late.
// `due`: when it was meant to happen; `at`: when it did.
export function lateWords(due: number, at: number, down?: Down): string | undefined {
  if (at - due < LATE_MS) return undefined;
  const was = down && down.from < at && down.to > due ? `: the daemon was down from ${hhmm(down.from)} to ${hhmm(down.to)}` : "";
  return `${span(at - due)} late${was}`;
}

// "at 20:27, while the daemon was down" for a thing that ended in the downtime, else nothing.
export function whileDown(ended: number, down?: Down): string | undefined {
  return down && ended >= down.from - 1000 && ended < down.to ? `at ${hhmm(ended)}, while the daemon was down` : undefined;
}
