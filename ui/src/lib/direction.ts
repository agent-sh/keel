// The visual direction of the shell: layout, type, color and motion.
// Chosen with ?direction=<id> (kept for the next visit) or in Settings.
import { useSyncExternalStore } from "react";

export const DIRECTIONS = [
  { id: "bridge", name: "Bridge", hint: "Every live session open side by side, a station each." },
  { id: "wake", name: "Wake", hint: "All sessions on one time chart; the open one reads like a logbook." },
  { id: "watch", name: "Night watch", hint: "Triage first: sessions sorted by what they need from you. Dark only." },
  { id: "classic", name: "Classic", hint: "The single-column layout." },
] as const;
export type Direction = (typeof DIRECTIONS)[number]["id"];

const valid = (v: string | null): v is Direction => DIRECTIONS.some((d) => d.id === v);

function initial(): Direction {
  const q = new URLSearchParams(location.search).get("direction");
  if (valid(q)) {
    localStorage.setItem("keel.direction", q);
    return q;
  }
  const saved = localStorage.getItem("keel.direction");
  return valid(saved) ? saved : "classic";
}

let current: Direction = initial();
const subs = new Set<() => void>();
// The night watch is dark only; ui.ts reads the direction when it applies the theme.
const apply = () => {
  document.documentElement.dataset.direction = current;
  import("./ui.ts").then((m) => m.reapplyTheme());
};
apply();

export function setDirection(d: Direction) {
  current = d;
  localStorage.setItem("keel.direction", d);
  const u = new URL(location.href);
  if (u.searchParams.has("direction")) {
    u.searchParams.set("direction", d);
    history.replaceState(history.state, "", u);
  }
  apply();
  subs.forEach((f) => f());
}
export const getDirection = () => current;
export const useDirection = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => current);
