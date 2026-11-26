// The branches ready to land across the owner's sessions, as the page last heard them (src/server/routes/ready.ts):
// read when a view that shows them comes up, then from the `landings` frames, which carry the whole list whenever
// it changed. Not an alert and not counted anywhere: Home and the Inbox list them, nothing else reads them.
import { useEffect, useSyncExternalStore } from "react";
import type { LandCard } from "../../../src/board/card.ts";
import { api, onFeature, readAtOpen, scope } from "./store.ts";
import { navigate, savePref } from "./ui.ts";

// An approved branch no card shows: its board's rows left it out (src/integrations/mobile/landings.ts).
export type NotShown = { chat_id: string; agent_id: string; branch: string; why: string };
type Ready = { cards: LandCard[]; not_shown: NotShown[] };
let now: Ready = { cards: [], not_shown: [] };
let loaded = false;
const subs = new Set<() => void>();
const same = (a: Ready, b: Ready) => a.cards.length === b.cards.length && a.cards.every((c, i) => c.key === b.cards[i]!.key && c.fp === b.cards[i]!.fp)
  && a.not_shown.length === b.not_shown.length && a.not_shown.every((n, i) => n.agent_id === b.not_shown[i]!.agent_id);
function set(r: Partial<Ready>) {
  loaded = true;
  const next = { cards: r.cards ?? [], not_shown: r.not_shown ?? [] };
  if (same(now, next)) return;
  now = next;
  subs.forEach((f) => f());
}

let bound = false;
let views = 0;
let reading: Promise<void> | undefined;
const read = () => reading ??= api<Ready>("/api/landings").then(set).finally(() => { reading = undefined; });
function bind(): boolean {
  if (bound) return false;
  bound = true;
  onFeature({ frame: (f) => { if (f.name === "landings") set(f.data as Ready); }, reconnect: readAtOpen(() => views ? read() : Promise.resolve(), "ready to land") });
  return true;
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

// The cards that have nothing missing, ready first, and the approved branches no card shows. While a view uses this
// the page hears the feed (a frame only when the list changed); it reads the list as the view comes up, since frames
// of the time between were not sent.
export function useReadyToLand(): Ready {
  const got = useSyncExternalStore(subscribe, () => now);
  useEffect(() => {
    const first = ++views === 1;
    const stop = scope.feed("landings");
    if (!bind() && first) read().catch(() => {});
    return () => { views--; stop(); };
  }, []);
  return got;
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
