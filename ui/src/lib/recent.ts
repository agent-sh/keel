// The sessions this page showed last, most recent first, kept in the page's own storage (not the daemon's:
// what one browser or device visited is its own). The switcher on Ctrl Tab reads it (lib/switcher.ts).
import { getUI, onUI } from "./ui.ts";

const KEY = "keel.recentSessions";
const KEEP = 30;
export const SHOWN = 6;

// `id` first, once, the list cut to what is kept.
export const bump = (list: readonly string[], id: string, keep = KEEP): string[] => [id, ...list.filter((x) => x !== id)].slice(0, keep);
// The first `n` of the list that still exist.
export const recentOf = (list: readonly string[], exists: (id: string) => boolean, n = SHOWN): string[] => list.filter(exists).slice(0, n);

const read = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};
let list = read();
export const recentList = () => list;

function note() {
  const r = getUI().route;
  if (r.name !== "session" || list[0] === r.id) return;
  list = bump(list, r.id);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}
onUI(note);
note();
