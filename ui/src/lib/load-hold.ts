// Agent trees that wait for the machine, as the page last heard it (src/automation/load-hold.ts): read when the
// socket opens, then from its `load_hold` frames.
import { useSyncExternalStore } from "react";
import type { LoadHoldView } from "../../../src/automation/load-hold.ts";
import { api, onFeature, readAtOpen } from "./store.ts";

export type { LoadHoldView };
let now: LoadHoldView | null = null;
const subs = new Set<() => void>();
const set = (next: LoadHoldView) => { now = next; subs.forEach((f) => f()); };

let bound = false;
function bind() {
  if (bound) return;
  bound = true;
  const read = () => api<LoadHoldView>("/api/load-hold").then(set);
  onFeature({ frame: (f) => { if (f.name === "load_hold") set(f.data as LoadHoldView); }, reconnect: readAtOpen(read, "load hold") });
}

export function useLoadHold(): LoadHoldView | null {
  bind();
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => now);
}
