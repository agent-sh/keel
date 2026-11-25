// The branches ready to land across the owner's sessions, as the page last heard them (src/server/routes/ready.ts):
// read when a view that shows them comes up, then from the `landings` frames, which carry the whole list whenever
// it changed. Not an alert and not counted anywhere: Home and the Inbox list them, nothing else reads them.
import { useEffect, useSyncExternalStore } from "react";
import type { LandCard } from "../../../src/board/card.ts";
import { api, onFeature, scope } from "./store.ts";
import { navigate, savePref } from "./ui.ts";

let now: LandCard[] = [];
let loaded = false;
const subs = new Set<() => void>();
const same = (a: LandCard[], b: LandCard[]) => a.length === b.length && a.every((c, i) => c.key === b[i]!.key && c.fp === b[i]!.fp);
function set(list: LandCard[]) {
  loaded = true;
  if (same(now, list)) return;
  now = list;
  subs.forEach((f) => f());
}

let bound = false;
let views = 0;
const read = () => api<{ cards: LandCard[] }>("/api/landings").then((r) => set(r.cards));
function bind() {
  if (bound) return;
  bound = true;
  onFeature({ frame: (f) => { if (f.name === "landings") set((f.data as { cards: LandCard[] }).cards); }, reconnect: () => { if (views) read().catch(() => {}); } });
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

// The cards that have nothing missing, ready first. While a view uses this the page hears the feed (a frame only
// when the list changed); it reads the list as the view comes up, since frames of the time between were not sent.
export function useReadyToLand(): LandCard[] {
  bind();
  const cards = useSyncExternalStore(subscribe, () => now);
  useEffect(() => {
    views++;
    const stop = scope.feed("landings");
    read().catch(() => {});
    return () => { views--; stop(); };
  }, []);
  return cards;
}
export const readyLoaded = () => loaded;

// Land one card as it was shown: the daemon refuses it when its facts are no longer these, and says why.
export async function landReady(c: LandCard): Promise<string | null> {
  try {
    await api(`/api/landings/${encodeURIComponent(c.key)}/land`, { method: "POST", body: JSON.stringify({ fp: c.fp }) });
    return null;
  } catch (e) {
    read().catch(() => {});
    return (e as Error).message;
  }
}

// The session's Landing panel, where its branches are queued and followed.
export function openLanding(c: LandCard) {
  navigate({ name: "session", id: c.chat_id });
  savePref("panel", "branches");
}
