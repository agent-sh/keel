// The overlap forecast of a session's repository, per session: its live
// branches and the pairs that would conflict (src/worktree/overlap-scan.ts).
// Read when a view of the session shows it, again on its "overlap" frames.
import { useEffect, useSyncExternalStore } from "react";
import type { Pair, View } from "../../../src/worktree/overlap-scan.ts";
import { api, onFeature, reportError, reportUnlessGone } from "./store.ts";

export type { Pair, View as OverlapView };

let byId: Record<string, View | undefined> = {};
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const reading = new Map<string, Promise<void>>();

export function loadOverlap(id: string, fresh = false): Promise<void> {
  const out = reading.get(id);
  if (out && !fresh) return out;
  const read = (async () => {
    const v = await api<View>(`/api/sessions/${id}/overlap${fresh ? "/check" : ""}`, fresh ? { method: "POST" } : undefined);
    byId = { ...byId, [id]: v };
    changed();
  })().finally(() => { if (reading.get(id) === read) reading.delete(id); });
  reading.set(id, read);
  return read;
}

export function useOverlap(id: string): View | undefined {
  useEffect(() => { if (!(id in byId)) loadOverlap(id).catch(reportError); }, [id]);
  return useSyncExternalStore(subscribe, () => byId[id]);
}

// The conflicts of the session's own branch: with another live branch, or with the base.
export const mineOf = (v: View | undefined): Pair[] => (v?.mine ? v.pairs.filter((p) => p.conflict && (p.a === v.mine || (!p.base && p.b === v.mine))) : []);
// The other side of a pair, as `branch` sees it.
export const otherOf = (p: Pair, branch: string) => (p.a === branch ? { branch: p.b, session: p.b_session } : { branch: p.a, session: p.a_session });

onFeature({
  frame(f) {
    if (f.name === "overlap" && f.session_id && f.session_id in byId) loadOverlap(f.session_id).catch(reportUnlessGone);
  },
  reconnect() {
    for (const id of Object.keys(byId)) loadOverlap(id).catch(reportUnlessGone);
  },
});
