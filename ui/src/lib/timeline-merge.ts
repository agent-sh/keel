// How the Timeline panel's refresh joins what it holds: what it asks for, and
// what it does with the answer. Pure, so it is tested without a page.
import type { TimelinePage, TimelineRow } from "../../../src/admin/timeline-rows.ts";

export type Held = { rows: TimelineRow[]; next: string | null; scanned?: number };

// Where a refresh starts reading: nothing older than this can have changed.
// A row changes after it is written only while what it tells is still open (a
// running turn, a card, an agent, a wait), and "now" lists every one of
// those; everything else that is new is newer than the last read. A second
// of slack covers what was being written while that read ran.
export function refreshFrom(asOf: number, now: TimelinePage["now"]): number {
  return Math.min(asOf - 1000, ...(now?.lines ?? []).filter((l) => l.open).map((l) => l.ts));
}

// What a refresh read (every row from `since` on) over what the panel holds:
// the rows it read replace their old selves and anything else that recent, and
// the older rows stay as they are. Null when more arrived than one page
// holds: the list is then read again from the top, so no gap is shown as whole.
export function mergeSince(cur: Held, fresh: TimelinePage, since: number): Held | null {
  if (fresh.next) return null;
  const have = new Set(fresh.rows.map((r) => r.id));
  return { ...cur, rows: [...fresh.rows, ...cur.rows.filter((r) => r.ts < since && !have.has(r.id))] };
}

