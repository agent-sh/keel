// Steers the owner is still typing go in one step. He sends a burst of one-line steers seconds apart, and each
// step of a long context reads the whole context again: a step that would take his steer while he types the
// next one in the same session's box waits for it. The page says when its box holds a message and when a key
// went into it (src/server/routes/drafts.ts, presence); the step goes once the box has been still for STILL_MS,
// or was sent (with a moment for the sent message to arrive), and at most GATHER_MAX_MS after it began waiting.
// Only the owner's own steers wait: an agent's or a peer's message never does, and a box that holds nothing
// waits for nothing. Pure.

export const STILL_MS = 3000;
export const GATHER_MAX_MS = 15_000;
// A box that emptied while the step waited was sent: its message is on its way (the box's presence and the
// message are two requests, in either order). The step waits this long for it, and goes as it arrives.
export const SENT_MS = 1000;

// `typed`: the newest key into a box that holds a message now (0: none holds one). `emptied`: when a box
// last emptied.
export type Typing = { typed: number; emptied: number };

// How long the step waits from `now` (0: it goes). `since`: when it began waiting. `arrived`: a steer of the
// owner's came while it waited.
export function gatherWait(t: Typing | undefined, now: number, since: number, arrived: boolean): number {
  const left = since + GATHER_MAX_MS - now;
  if (!t || left <= 0) return 0;
  if (t.typed && now - t.typed < STILL_MS) return Math.min(STILL_MS - (now - t.typed), left);
  if (!arrived && t.emptied > since && now - t.emptied < SENT_MS) return Math.min(SENT_MS - (now - t.emptied), left);
  return 0;
}
