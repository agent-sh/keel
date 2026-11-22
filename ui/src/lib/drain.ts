// The daemon's drain as the page last heard it: from the stop signal or the
// restart the owner asked for until the process ends, the daemon takes no new
// work and lets its running turns finish. The page says so at once and the
// whole time, in one sentence (the band across the top, the logo's word):
// a daemon that is going is not "Connected".
import { useSyncExternalStore } from "react";

export type Drain = { restart: boolean; running: number };
let drain: Drain | null = null;
const subs = new Set<() => void>();

// What the daemon said of its drain (`draining` of its status, null when it takes work),
// and how many sessions still have a turn running.
export function setDrain(draining: { restart?: boolean } | null | undefined, running: number | string[] | undefined) {
  const n = Array.isArray(running) ? running.length : typeof running === "number" ? running : (drain?.running ?? 0);
  const next = draining ? { restart: !!draining.restart, running: n } : null;
  if (next?.restart === drain?.restart && next?.running === drain?.running) return;
  drain = next;
  subs.forEach((f) => f());
}
export const getDrain = () => drain;
export const useDrain = (): Drain | null => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => drain);

// "Keel is restarting: 2 turns finishing." The count is the daemon's own, as it last told it.
export function drainWords(d: Drain): string {
  const what = d.restart ? "Keel is restarting" : "Keel is stopping";
  return d.running > 0 ? `${what}: ${d.running} turn${d.running === 1 ? "" : "s"} finishing.` : `${what}.`;
}
