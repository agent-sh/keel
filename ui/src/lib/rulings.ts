// Standing rulings (src/automation/rulings.ts) as the page reads them: what
// became of each answer of a session that could be kept (kept, just this
// once, or still open), read when a card of the session shows an offer and
// again on its "rulings" frames; and the owner's list in Settings.
import { Gavel } from "lucide-react";
import { createElement, lazy, useEffect, useSyncExternalStore } from "react";
import type { OfferMark, Ruling, Scope } from "../../../src/automation/rulings.ts";
import { settingsSections } from "./extend.ts";
import { api, onFeature, reportError, reportUnlessGone } from "./store.ts";

export type { OfferMark, Ruling, Scope };

let byId: Record<string, Record<string, OfferMark> | undefined> = {};
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const reading = new Map<string, Promise<void>>();

const put = (id: string, marks: OfferMark[]) => {
  byId = { ...byId, [id]: { ...byId[id], ...Object.fromEntries(marks.map((m) => [m.call_id, m])) } };
  changed();
};
function load(id: string): Promise<void> {
  const out = reading.get(id);
  if (out) return out;
  const read = api<{ offers: OfferMark[] }>(`/api/sessions/${id}/rulings`).then((r) => put(id, r.offers))
    .finally(() => { if (reading.get(id) === read) reading.delete(id); });
  reading.set(id, read);
  return read;
}

// What became of the answer of one call; undefined until it is read.
export function useOfferMark(sessionId: string | undefined, callId: string, wanted: boolean): OfferMark | undefined {
  useEffect(() => { if (wanted && sessionId && !(sessionId in byId)) load(sessionId).catch(reportError); }, [sessionId, wanted]);
  return useSyncExternalStore(subscribe, () => (sessionId ? byId[sessionId]?.[callId] : undefined));
}

export const keepRuling = async (sessionId: string, callId: string, scope: Scope) =>
  put(sessionId, [(await api<{ offer: OfferMark }>("/api/rulings", { method: "POST", body: JSON.stringify({ session_id: sessionId, call_id: callId, scope }) })).offer]);
export const justOnce = async (sessionId: string, callId: string) =>
  put(sessionId, [(await api<{ offer: OfferMark }>(`/api/sessions/${sessionId}/rulings/${encodeURIComponent(callId)}/one-off`, { method: "POST" })).offer]);
export const listRulings = async () => (await api<{ rulings: Ruling[] }>("/api/rulings")).rulings;
export const revokeRuling = async (id: string) => (await api<{ ruling: Ruling }>(`/api/rulings/${id}/revoke`, { method: "POST" })).ruling;

onFeature({
  frame(f) {
    if (f.name === "rulings" && f.session_id && f.session_id in byId && f.data?.call_id) put(f.session_id, [f.data as OfferMark]);
  },
  reconnect() {
    for (const id of Object.keys(byId)) { reading.delete(id); load(id).catch(reportUnlessGone); }
  },
});

settingsSections.add({
  id: "rulings",
  label: "Rulings",
  words: "rulings standing answers kept decisions questions revoke remember agents ask again",
  icon: createElement(Gavel, { className: "size-4" }),
  order: 21,
  component: lazy(() => import("../components/RulingsPanel.tsx").then((m) => ({ default: m.RulingsPanel }))),
});
