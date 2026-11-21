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

// What a refresh read (rows from `since` on, newest first) over what the
// panel holds, read last at `asOf`.
// - The reply is whole (no `next`): its rows replace their old selves and
//   anything else that recent; the older rows stay as they are.
// - The reply stopped at its limit, or at a filter's bound (something has
//   been open for more than a page of rows): `next` is where it stopped, and
//   the held rows older than that stay, with the pages loaded below them.
// - Where it stopped is newer than the last read: more arrived than one
//   reply holds, so what is held no longer joins it. The reply is then the
//   list, with its own cursor: nothing is read twice and no gap is shown as whole.
export function mergeSince(cur: Held, fresh: TimelinePage, since: number, asOf: number): Held {
  const have = new Set(fresh.rows.map((r) => r.id));
  if (!fresh.next) return { ...cur, rows: [...fresh.rows, ...cur.rows.filter((r) => r.ts < since && !have.has(r.id))] };
  const cut = fresh.next.indexOf(":");
  const at = { ts: Number(fresh.next.slice(0, cut)), id: fresh.next.slice(cut + 1) };
  if (!(at.ts <= asOf - 1000)) return { rows: fresh.rows, next: fresh.next, scanned: fresh.scanned };
  const older = (r: TimelineRow) => r.ts < at.ts || (r.ts === at.ts && r.id < at.id);
  return { ...cur, rows: [...fresh.rows, ...cur.rows.filter((r) => older(r) && !have.has(r.id))] };
}
