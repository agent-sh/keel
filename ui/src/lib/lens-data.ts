// What the page keeps of the lenses it read (components/Lens.tsx): the last few sessions' lens, so one
// opened again draws at once and reads only what came since, and a lens read ahead of the press
// (lib/open-ahead.ts) that the view takes when it opens.
import type { LensItem } from "../../../src/core/lens.ts";
import type { StoredEvent } from "../../../src/core/types.ts";
import { api } from "./store.ts";

export type LensPage = {
  items: LensItem[]; events: Record<string, StoredEvent>; stable: number; stable_id: string | null;
  last: { id: string; seq: number } | null; earlier?: boolean; whole?: boolean;
  // (The page's own mark) a first read of the newest FIRST_TURNS turns only: the rest is read next.
  part?: true;
};

// A first read reaches back this many turns: the newest screen of a long coordinator is in them, and the daemon
// answers them in a few milliseconds where the whole lens (thousands of turns) takes it a tenth of a second.
export const FIRST_TURNS = 200;

// A few lenses: each holds the bodies of its shown items, a few hundred kilobytes for a long coordinator.
const KEEP = 6;
const kept = new Map<string, LensPage>();
const reading = new Map<string, Promise<LensPage>>();

export const keptLens = (session: string) => kept.get(session) ?? null;

export function keepLens(session: string, page: LensPage) {
  kept.delete(session);
  kept.set(session, page);
  while (kept.size > KEEP) kept.delete(kept.keys().next().value!);
}

export function forgetLens(session: string) { kept.delete(session); }

// The lens read from its start, or after the last turn's end the page holds (`after`, `at`).
export const readLens = (session: string, after?: { stable: number; stable_id: string | null }) =>
  api<LensPage>(`/api/sessions/${session}/lens${after?.stable && after.stable_id ? `?after=${after.stable}&at=${encodeURIComponent(after.stable_id)}` : ""}`);

// The first read of a session's lens: its newest turns, marked a part when there are more.
export const readFirst = (session: string) =>
  api<LensPage>(`/api/sessions/${session}/lens?turns=${FIRST_TURNS}`).then((r): LensPage => (r.earlier ? { ...r, part: true } : r));

// A first read on its way (read ahead): the view's first read is that one.
export const lensOnItsWay = (session: string) => reading.get(session);

export function lensAhead(session: string) {
  if (kept.has(session) || reading.has(session)) return;
  const p = readFirst(session);
  reading.set(session, p);
  p.then((r) => { if (!kept.has(session)) keepLens(session, r); }, () => {}).finally(() => reading.delete(session));
}
