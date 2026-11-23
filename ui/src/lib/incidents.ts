// The daemon's incidents as the page last heard them (src/automation/incidents.ts):
// read when the socket opens, then from its `incidents` frames. A frame carries
// the open ones whole and what cleared since the last frame; the read at open
// has what cleared in the last day.
import { useSyncExternalStore } from "react";
import type { Incident } from "../../../src/automation/incident-book.ts";
import { api, onFeature, readAtOpen } from "./store.ts";

export type Incidents = { open: Incident[]; cleared: Incident[] };
let now: Incidents = { open: [], cleared: [] };
const subs = new Set<() => void>();

function set(next: Incidents, merge: boolean) {
  // A frame's cleared list is what this daemon saw clear; the day's rows read at open stay beside it.
  const cleared = merge ? [...next.cleared, ...now.cleared.filter((c) => !next.cleared.some((x) => x.id === c.id) && !next.open.some((x) => x.id === c.id))] : next.cleared;
  now = { open: next.open, cleared: cleared.sort((a, b) => (b.cleared ?? 0) - (a.cleared ?? 0)).slice(0, 20) };
  subs.forEach((f) => f());
}

let bound = false;
function bind() {
  if (bound) return;
  bound = true;
  const read = () => api<Incidents>("/api/incidents").then((l) => set(l, false));
  onFeature({ frame: (f) => { if (f.name === "incidents") set(f.data as Incidents, true); }, reconnect: readAtOpen(read, "incidents") });
}

export function useIncidents(): Incidents {
  bind();
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => now);
}
