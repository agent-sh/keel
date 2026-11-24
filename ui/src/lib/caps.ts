// The dollar caps as the page last heard them (src/automation/caps.ts): read when the socket opens,
// then from the `caps` frames, which carry every cap whole whenever a figure changed. A session
// without a cap is not in the list.
import { useSyncExternalStore } from "react";
import type { CapRow } from "../../../src/automation/cap-rules.ts";
import { api, onFeature, readAtOpen } from "./store.ts";

let now = new Map<string, CapRow>();
const subs = new Set<() => void>();

// A row that told the same keeps its object, so the rows of the list that read it are not drawn again.
const same = (a: CapRow, b: CapRow) => a.usd === b.usd && a.level === b.level && a.spent === b.spent && a.burn_hour === b.burn_hour && a.ms_to_cap === b.ms_to_cap;
function set(list: CapRow[]) {
  const next = new Map(list.map((c) => [c.id, now.get(c.id) && same(now.get(c.id)!, c) ? now.get(c.id)! : c]));
  if (next.size === now.size && [...next].every(([id, c]) => now.get(id) === c)) return;
  now = next;
  subs.forEach((f) => f());
}

let bound = false;
function bind() {
  if (bound) return;
  bound = true;
  const read = () => api<{ caps: CapRow[] }>("/api/caps").then((r) => set(r.caps));
  onFeature({ frame: (f) => { if (f.name === "caps") set((f.data as { caps: CapRow[] }).caps); }, reconnect: readAtOpen(read, "caps") });
}

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

// The cap on a session, if it has one.
export function useCap(id: string): CapRow | undefined {
  bind();
  return useSyncExternalStore(subscribe, () => now.get(id));
}

const put = (id: string, init: RequestInit) => api<{ cap: CapRow | null }>(`/api/sessions/${id}/cap`, init).then((r) => {
  const next = new Map(now);
  if (r.cap) next.set(id, r.cap); else next.delete(id);
  set([...next.values()]);
  return r.cap;
});
// A cap of `usd` dollars (null: none) for the session and what it starts.
export const setCap = (id: string, usd: number | null) => put(id, { method: "PUT", body: JSON.stringify({ usd }) });
// One press: the cap doubled, and past what was spent.
export const raiseCap = (id: string) => put(id, { method: "POST", body: JSON.stringify({ raise: true }) });
