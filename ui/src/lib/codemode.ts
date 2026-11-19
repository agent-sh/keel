// The calls each run_code program made, per program: loaded when its card is
// shown, kept current by "code_call" frames.
import { useEffect, useSyncExternalStore } from "react";
import type { CodeCall } from "../../../src/tools/codemode.ts";
import { api, onFeature, reportError } from "./store.ts";

export type { CodeCall };

const key = (sessionId: string, parent: string) => `${sessionId}\u0000${parent}`;
let byParent: Record<string, CodeCall[]> = {};
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const EMPTY: CodeCall[] = [];

async function load(sessionId: string, parent: string) {
  const r = await api<{ calls: CodeCall[] }>(`/api/sessions/${sessionId}/code-calls?parent=${encodeURIComponent(parent)}`);
  // A frame that came while the list loaded is newer than the list.
  const live = new Map((byParent[key(sessionId, parent)] ?? []).map((c) => [c.id, c]));
  const merged = r.calls.map((c) => (live.get(c.id)?.ended && !c.ended ? live.get(c.id)! : c));
  for (const c of live.values()) if (!merged.some((m) => m.id === c.id)) merged.push(c);
  byParent = { ...byParent, [key(sessionId, parent)]: merged.sort((a, b) => a.seq - b.seq) };
  changed();
}

export function useCodeCalls(sessionId: string | undefined, parent: string): CodeCall[] {
  useEffect(() => {
    if (sessionId && !(key(sessionId, parent) in byParent)) {
      byParent = { ...byParent, [key(sessionId, parent)]: [] };
      load(sessionId, parent).catch(reportError);
    }
  }, [sessionId, parent]);
  return useSyncExternalStore(subscribe, () => (sessionId ? byParent[key(sessionId, parent)] ?? EMPTY : EMPTY));
}

onFeature({
  frame(f) {
    if (f.name !== "code_call" || !f.session_id) return;
    const c = f.data as CodeCall;
    const k = key(f.session_id, c.parent);
    const list = (byParent[k] ?? []).filter((x) => x.id !== c.id);
    byParent = { ...byParent, [k]: [...list, c].sort((a, b) => a.seq - b.seq) };
    changed();
  },
  reconnect() {
    for (const k of Object.keys(byParent)) {
      const [sessionId, parent] = k.split("\u0000") as [string, string];
      load(sessionId, parent).catch(reportError);
    }
  },
});
