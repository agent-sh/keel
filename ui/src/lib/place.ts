// Where the owner was in each session's conversation, and how far they have
// read it. Two different things, kept apart:
//   the place: what stood at the top of their view (an event, and how far its
//     row's top was from the view's top), or that they were following the end;
//   the read mark: the last event that was on screen with them present, and
//     when. What came after it is new to them: the conversation shows where
//     that starts.
// Both are named by an event, never by a scroll offset in pixels: between two
// visits parts are loaded, rows fold and a turn goes on, and a pixel offset
// means another line by then.
//
// Kept per device, in this browser's storage: a place is where this screen
// stood (a phone and a desk do not share a view), and it must survive a
// reload and a daemon restart without the daemon. Bounded: the sessions
// visited longest ago go first.
//
// Two tabs share the storage. A tab writes only the sessions it changed, over
// what the storage holds then: a place another tab kept for another session
// is never written over by a tab that only read it. A place is kept in the
// page as the owner scrolls (a conversation looks at most once in WRITE_MS)
// and written to the storage once they have stopped for SETTLE_MS, at the
// latest MAX_WAIT_MS after the first change, and at once when the page is
// hidden or leaves, or a conversation leaves it: scrolling writes nothing.
export type Place = {
  end?: boolean;    // following the end
  ev?: string;      // else: the event whose row (or step) stood at the top of the view
  off?: number;     // how far that row's top was from the view's top, in px (negative: above it)
  h?: number;       // the row's height then: at another width the offset is scaled by it
  read?: string;    // the last event seen with the owner present
  readSeq?: number; // its place in the session's order
  readAt?: number;  // when
  view?: "conversation" | "stream"; // how the conversation is shown here (lib/lens-view.ts), when the owner chose
  at: number;       // when this was last written
};

const KEY = "keel.places";
export const PLACES_MAX = 200;
export const WRITE_MS = 500;
export const SETTLE_MS = 1000;
export const MAX_WAIT_MS = 10_000;
let all: Record<string, Place> | undefined;
// The sessions this tab changed since its last write (a removed one too).
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let first = 0; // when the oldest change not yet written was made
function later() {
  const now = Date.now();
  first ||= now;
  clearTimeout(timer);
  timer = setTimeout(flushPlaces, Math.max(0, Math.min(SETTLE_MS, first + MAX_WAIT_MS - now)));
}

function stored(): Record<string, Place> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Place>) : {};
  } catch {
    return {};
  }
}
const load = (): Record<string, Place> => (all ??= stored());

// The newest `max` of them.
export function bound(places: Record<string, Place>, max = PLACES_MAX): Record<string, Place> {
  const ids = Object.keys(places);
  if (ids.length <= max) return places;
  return Object.fromEntries(ids.sort((a, b) => (places[b]!.at ?? 0) - (places[a]!.at ?? 0)).slice(0, max).map((id) => [id, places[id]!]));
}

// What a tab writes: the storage as it is now, with this tab's own changes over it. A session of
// `changed` that `mine` no longer has was removed here, and is removed there.
export function merged(there: Record<string, Place>, mine: Record<string, Place>, changed: Iterable<string>): Record<string, Place> {
  const out = { ...there };
  for (const id of changed) {
    if (mine[id]) out[id] = mine[id]!;
    else delete out[id];
  }
  return out;
}

export const placeOf = (session: string): Place | undefined => load()[session];

export function putPlace(session: string, patch: Partial<Place>) {
  const m = load();
  m[session] = { ...m[session], ...patch, at: Date.now() };
  dirty.add(session);
  later();
}
// A session that was deleted keeps no place.
export function dropPlace(session: string) {
  const m = load();
  if (!m[session]) return;
  delete m[session];
  dirty.add(session);
  later();
}
export function flushPlaces() {
  clearTimeout(timer);
  timer = undefined;
  first = 0;
  if (!all || !dirty.size) return;
  all = bound(merged(stored(), all, dirty));
  dirty.clear();
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* a full or closed storage: the place lives for this page */ }
}
if (typeof addEventListener === "function") {
  addEventListener("pagehide", flushPlaces);
  // (A phone's page that goes to the background may never be told it leaves.)
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPlaces(); });
  // Another tab wrote: what it kept is what this tab reads from now on, under its own changes not yet written.
  addEventListener("storage", (e) => { if ((e as StorageEvent).key === KEY && all) all = merged(stored(), all, dirty); });
}

// The offset of a row's top from the view's top, at the row's height now: a
// place inside a tall row (a long reply) is the same share of it at another width.
export function offsetAt(p: Pick<Place, "off" | "h">, height: number): number {
  const off = p.off ?? 0;
  if (!p.h || off >= 0 || Math.abs(height - p.h) < 2) return off;
  return Math.round(off * (height / p.h));
}

// Where what is new to the owner starts, among the events shown: the events
// after the read mark, oldest first (the first of them that has a row is
// where the rule stands). "before": the mark is older than everything shown,
// so what is new starts in a part that is not on the page. Nothing when the
// mark is the last of them, or when it cannot be told (no mark, or a mark that
// is neither among the events shown nor older than them: another branch).
export function newAfter<E extends { id: string; seq: number }>(events: readonly E[], mark: Pick<Place, "read" | "readSeq"> | undefined): E[] | "before" {
  if (!mark?.read || !events.length) return [];
  const i = events.findIndex((e) => e.id === mark.read);
  if (i >= 0) return events.slice(i + 1);
  return mark.readSeq !== undefined && mark.readSeq < events[0]!.seq ? "before" : [];
}

// Whether an event is later than the read mark (so the mark may move to it). The mark only moves forward.
export function isLater(mark: Pick<Place, "read" | "readSeq"> | undefined, ev: { id: string; seq: number }): boolean {
  if (!mark?.read) return true;
  if (mark.read === ev.id) return false;
  return mark.readSeq === undefined || ev.seq > mark.readSeq;
}
