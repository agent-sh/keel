// A restart asked while the owner is at a page waits until they step away.
// A restart cuts every page's socket and the turns at work, and a message the
// owner types in that minute can wait behind it with no answer of its own. So a
// restart that does not say it must go now (`keel restart` without --now, a
// landing script that calls it) is held here: it goes when the away detector
// (src/admin/away.ts: no input in a page for its gap) says the owner is away, or
// when it has waited WAIT_MAX_MS, whichever comes first. Restarts asked while one
// waits are joined into it: one restart, with every reason, the longest drain
// time asked. A restart that must not wait (the owner's own, from the page; an
// urgent build, `keel restart --now`) goes at once and takes the waiting one with it.
// A stop (`keel drain`) is never held. Pure decisions here; the daemon runs them
// (src/admin/daemon.ts) and says the wait in its status, so the page's band and
// the command line say the same thing.

// How long a restart waits for the owner to step away at most. A restart is
// still owed: past this it goes even while they are at a page.
export const waitMaxMs = () => Number(process.env.KEEL_RESTART_WAIT_MS) || 30 * 60_000;
// How often a waiting restart looks again whether the owner is away.
export const LOOK_MS = 10_000;

export type RestartAsk = { at: number; timeoutMs: number; reason?: string };
// What a waiting restart is, as the status tells it.
export type RestartWaiting = { since_ms: number; until_ms: number; asks: number; reasons: string[]; timeout_ms: number };

// Whether the restart that waits goes now: "away" (the owner stepped away), "bound" (it waited its longest), or null.
export function dueNow(w: Pick<RestartWaiting, "until_ms">, here: boolean, now: number): "away" | "bound" | null {
  if (!here) return "away";
  if (now >= w.until_ms) return "bound";
  return null;
}

// A restart asked: joined into the one that waits, or a new wait. Its bound stays the first ask's,
// so a stream of asks cannot hold a restart past it.
export function join(w: RestartWaiting | null, a: RestartAsk, maxMs = waitMaxMs()): RestartWaiting {
  const reasons = [...(w?.reasons ?? [])];
  if (a.reason && !reasons.includes(a.reason)) reasons.push(a.reason);
  return {
    since_ms: w?.since_ms ?? a.at,
    until_ms: w?.until_ms ?? a.at + maxMs,
    asks: (w?.asks ?? 0) + 1,
    reasons: reasons.slice(-5),
    timeout_ms: Math.max(w?.timeout_ms ?? 0, a.timeoutMs),
  };
}

// The reason the log line and the drain carry for a joined restart.
export function joinedReason(w: RestartWaiting, why: "away" | "bound" | "now"): string {
  const asked = w.reasons.length ? w.reasons.join("; ") : "asked";
  const n = w.asks > 1 ? ` (${w.asks} restarts joined)` : "";
  const when = why === "away" ? "once you stepped away" : why === "bound" ? "after waiting its longest for you to step away" : "at once";
  return `${asked}${n}, ${when}`.slice(0, 120);
}

// What `keel restart` prints for a restart that waits.
export function waitingWords(w: RestartWaiting, hhmm: (ms: number) => string): string {
  const joined = w.asks > 1 ? `, ${w.asks} restarts joined into one` : "";
  return `the restart waits while you are at a page: it goes when you step away, by ${hhmm(w.until_ms)} at the latest${joined}. keel restart --now restarts at once`;
}
