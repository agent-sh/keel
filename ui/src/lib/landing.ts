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

// The owner lands several branches in order: each is queued after the one before it landed, and the run stops at the
// first that is refused or leaves the queue (what is behind it was meant to be built on it). `step` is told each
// branch as it is queued. The queue itself decides what passes: this only decides when the next is asked for.
export type LandRun = { landed: string[]; stopped?: { branch: string; why: string } };
export async function landInOrder(id: string, branches: string[], step: (branch: string) => void, stop?: () => boolean): Promise<LandRun> {
  const landed: string[] = [];
  for (const branch of branches) {
    if (stop?.()) return { landed };
    step(branch);
    const had = new Set((byId[id]?.entries ?? []).map((e) => e.id));
    const r = await queueBranches(id, [branch]);
    if (r.refused.length) return { landed, stopped: { branch, why: r.refused.map((x) => x.why).join("; ") } };
    // The entry this call made: one of the branch that the queue did not hold before.
    const mine = () => byId[id]?.entries.filter((e) => e.branch === branch && !had.has(e.id)).sort((a, b) => b.created - a.created)[0];
    for (;;) {
      const e = mine();
      if (e && !isLive(e)) {
        if (e.state === "landed") { landed.push(branch); break; }
        return { landed, stopped: { branch, why: e.why ?? (e.state === "removed" ? "it was taken out of the queue" : "it left the queue") } };
      }
      if (stop?.()) return { landed };
      await new Promise<void>((done) => { const f = () => { subs.delete(f); clearTimeout(t); done(); }; const t = setTimeout(f, 3000); subs.add(f); });
      if (!mine() || isLive(mine()!)) await loadLanding(id).catch(() => {});
    }
  }
  return { landed };
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
