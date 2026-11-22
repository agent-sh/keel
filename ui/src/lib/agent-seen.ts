// Which ended agents the owner has not looked at yet. An agent that ends is
// marked on its row in the tree until it is seen: its own session or the
// session that started it (where its report lands) was on screen in a page
// the owner was at, or they cleared the marks. Kept per browser; an agent that
// ended before this browser first looked is not news.
import { useSyncExternalStore } from "react";

type Kept = { since: number; seen: Record<string, number> };
const KEY = "keel.agentsSeen";
const MOST = 400;

// Nothing is written when the module loads: a first visit leaves no key behind until the page is
// in use (another part reads "any key of ours" as "this browser ran Keel before").
let stored = false;
function load(): Kept {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Kept> | null;
    if (v && typeof v.since === "number") { stored = true; return { since: v.since, seen: v.seen ?? {} }; }
  } catch {}
  return { since: Date.now(), seen: {} };
}
let kept = load();
const subs = new Set<() => void>();
function save(next: Kept) {
  kept = next;
  stored = true;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  subs.forEach((f) => f());
}
// When this browser first looked is kept from the first time the page reports where its owner is.
export function keepSince() {
  if (stored) return;
  stored = true;
  try { localStorage.setItem(KEY, JSON.stringify(kept)); } catch {}
}

type Ended = { id: string; status: string; ended?: number | null };
// Pure: an agent that ended after `since` and whose end was not seen.
export const endedUnseen = (a: Ended, k: Kept): boolean =>
  a.status !== "running" && a.status !== "waiting" && !!a.ended && a.ended > k.since && k.seen[a.id] !== a.ended;

export function useAgentsSeen(): Kept {
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => kept);
}
export const agentsSeen = () => kept;

// These agents' ends were seen.
export function seeAgents(list: Ended[]) {
  const fresh = list.filter((a) => endedUnseen(a, kept));
  if (!fresh.length) return;
  const seen = { ...kept.seen, ...Object.fromEntries(fresh.map((a) => [a.id, a.ended!])) };
  // The oldest marks go first: an agent that old ended before `since` moved past it.
  const ids = Object.keys(seen);
  save({ since: kept.since, seen: ids.length > MOST ? Object.fromEntries(ids.sort((x, y) => seen[y]! - seen[x]!).slice(0, MOST).map((id) => [id, seen[id]!])) : seen });
}
// Every end up to now was seen ("Clear all unread").
export const seeAllAgents = () => save({ since: Date.now(), seen: {} });
