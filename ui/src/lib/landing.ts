// The landing queue of a session's repository (src/landing/queue.ts): read
// when the Branches panel shows the session, again on its "landing" frames.
import { useEffect, useSyncExternalStore } from "react";
import type { Entry, QueueView } from "../../../src/landing/queue.ts";
import { api, onFeature, reportError, reportUnlessGone } from "./store.ts";

export type { Entry as LandingEntry, QueueView as LandingView };

let byId: Record<string, QueueView | undefined> = {};
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const reading = new Map<string, Promise<void>>();

export function loadLanding(id: string): Promise<void> {
  const out = reading.get(id);
  if (out) return out;
  const read = (async () => {
    const v = await api<QueueView>(`/api/sessions/${id}/landing`);
    byId = { ...byId, [id]: v };
    changed();
  })().finally(() => { if (reading.get(id) === read) reading.delete(id); });
  reading.set(id, read);
  return read;
}

export function useLanding(id: string): QueueView | undefined {
  useEffect(() => { if (!(id in byId)) loadLanding(id).catch(reportError); }, [id]);
  return useSyncExternalStore(subscribe, () => byId[id]);
}

// The owner queues branches of the session's repository.
export async function queueBranches(id: string, branches: string[]): Promise<{ refused: { branch: string; why: string }[]; warnings: string[] }> {
  const r = await api<{ refused: { branch: string; why: string }[]; warnings: string[]; view: QueueView }>(`/api/sessions/${id}/landing`, { method: "POST", body: JSON.stringify({ branches }) });
  byId = { ...byId, [id]: r.view };
  changed();
  return r;
}

export async function removeEntry(sessionId: string, entry: string) {
  await api(`/api/landing/${entry}`, { method: "DELETE" });
  await loadLanding(sessionId);
}

export const isLive = (e: Entry) => e.state === "queued" || e.state === "building" || e.state === "checking" || e.state === "resolving";

onFeature({
  frame(f) {
    if (f.name === "landing" && f.session_id && f.session_id in byId) loadLanding(f.session_id).catch(reportUnlessGone);
  },
  reconnect() {
    for (const id of Object.keys(byId)) loadLanding(id).catch(reportUnlessGone);
  },
});
