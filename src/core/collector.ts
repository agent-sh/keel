// When the daemon asks the collector for a whole collection while it works.
//
// The daemon runs without the runtime's collector timer (src/core/relaunch.ts)
// and asks for a young collection once a second while it works. Old objects
// are looked at only when the old space has grown by a factor of what the
// last whole collection left: a request's texts and the bodies a turn read
// live long enough to be old, so under work the heap climbed for minutes from
// 200 to 700 or 900 MB with 40 MB of events kept, and resident memory with it,
// before one whole collection took it back to 200 (the daemon's peaks of
// 1.4 GB beside an idle size of 640 MB). Here a whole collection is asked for
// once the heap has grown by WHOLE_GROWTH and WHOLE_BYTES past what the last
// one left, at most once in WHOLE_GAP_MS: the heap stays within about twice
// what is live. A whole collection holds the loop; it is timed and counted.
export const WHOLE_GROWTH = 2;
export const WHOLE_BYTES = 192e6;
export const WHOLE_GAP_MS = 10_000;

export type Collector = { left: number; at: number };

// Whether to ask for a whole collection now, from the heap's size, what the last whole one left and when.
export function wholeDue(size: number, last: Collector, now: number): boolean {
  if (now - last.at < WHOLE_GAP_MS) return false;
  return size > last.left * WHOLE_GROWTH && size - last.left > WHOLE_BYTES;
}

// What the daemon's whole collections did since it started, for the resources report.
export type CollectorReport = { wholes: number; longest_ms: number; last_ms: number; left_bytes: number };
export const collected: CollectorReport = { wholes: 0, longest_ms: 0, last_ms: 0, left_bytes: 0 };
