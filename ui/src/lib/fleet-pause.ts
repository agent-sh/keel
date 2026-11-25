// The fleet pause as the page last heard it (src/automation/fleet-pause.ts): read when the socket opens,
// then from its `fleet_pause` frames. One switch holds every start the owner did not make.
import { useSyncExternalStore } from "react";
import { api, onFeature, readAtOpen } from "./store.ts";

export type FleetPause = { paused: boolean; since: number | null };
let now: FleetPause = { paused: false, since: null };
const subs = new Set<() => void>();

function set(next: FleetPause) {
  if (next.paused === now.paused && next.since === now.since) return;
  now = { paused: next.paused, since: next.since };
  subs.forEach((f) => f());
}

let bound = false;
function bind() {
  if (bound) return;
  bound = true;
  const read = () => api<FleetPause>("/api/fleet-pause").then(set);
  onFeature({ frame: (f) => { if (f.name === "fleet_pause") set(f.data as FleetPause); }, reconnect: readAtOpen(read, "fleet pause") });
}

export function useFleetPause(): FleetPause {
  bind();
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => now);
}

// `stopRunning`: the turns running now that the owner did not start end too.
export const pauseFleet = (stopRunning = false) => api<FleetPause & { stopped: string[] }>("/api/fleet-pause", { method: "POST", body: JSON.stringify({ on: true, stop_running: stopRunning }) }).then((r) => (set(r), r));
export const resumeFleet = () => api<FleetPause>("/api/fleet-pause", { method: "POST", body: JSON.stringify({ on: false }) }).then((r) => (set(r), r));
