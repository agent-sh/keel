// Connection changes the owner can read afterwards, in the activity list:
// when a page did not hear this daemon and for how long, and when a machine
// of the fleet was out of reach. One row per absence, written when it ends.
// Bounded: a source that flaps is listed a dozen times an hour, and the next
// row it gets says how many were left out; the list itself keeps 30 days.
import * as activity from "./activity.ts";

const PER_HOUR = 12;
const SHORTEST_MS = 1_000; // shorter is a blip nobody saw
const LONGEST_MS = 30 * 86400_000;
const listed = new Map<string, { at: number[]; left: number }>();

export function span(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

// Whether this source may be listed now; what it was not listed for comes back with the next row.
function room(source: string, now: number): { left: number } | null {
  const r = listed.get(source) ?? { at: [], left: 0 };
  listed.set(source, r);
  r.at = r.at.filter((t) => now - t < 3600_000);
  if (r.at.length >= PER_HOUR) { r.left++; return null; }
  r.at.push(now);
  const left = r.left;
  r.left = 0;
  return { left };
}

function record(source: string, sub: string, what: string, why: string, from: number, to: number, data: Record<string, unknown>, now = Date.now()): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const ms = to - from;
  if (ms < SHORTEST_MS || ms > LONGEST_MS || to > now + 60_000) return false;
  const ok = room(source, now);
  if (!ok) return false;
  activity.record("daemon", sub, null, `${what} for ${span(ms)}, from ${clock(from)}${why ? `: ${why}` : ""}${ok.left ? ` (${ok.left} more this hour not listed)` : ""}`, { connection: { ...data, from, to, ms } });
  return true;
}

// A page was cut off from this daemon: its socket went silent (the network, a tunnel) or closed.
export function pageAbsence(from: number, to: number, why: string): boolean {
  const silent = why === "silent";
  return record("page", "connection", "A page did not hear Keel", silent ? "its connection went silent" : "its connection closed", from, to, { who: "page", why: silent ? "silent" : "closed" });
}

// A machine of the fleet was out of reach.
export function machineAbsence(machine: { id: string; name: string }, from: number, to: number, reason?: string): boolean {
  return record(`machine:${machine.id}`, "machine", `${machine.name} was out of reach`, (reason ?? "").slice(0, 160), from, to, { who: "machine", machine: machine.id, name: machine.name, ...(reason ? { reason: reason.slice(0, 200) } : {}) });
}

// For tests: what was counted is forgotten.
export const reset = () => listed.clear();
