// A session's PR Steward watch (src/steward/watch.ts), per session: read when
// a view of the session shows its worktree chip, again on its "steward" frames.
import { useEffect, useSyncExternalStore } from "react";
import type { Watch } from "../../../src/steward/rules.ts";
import { STATE_WORD } from "../../../src/core/state-words.ts";
import { api, onFeature, reportError, reportUnlessGone } from "./store.ts";

export type { Watch };
export type StewardView = { watch: Watch | null; limits: { tries: number; pushes: number; turns: number; days: number } };

let byId: Record<string, StewardView | undefined> = {};
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export async function loadSteward(id: string): Promise<void> {
  byId = { ...byId, [id]: await api<StewardView>(`/api/sessions/${id}/steward`) };
  changed();
}

export async function setSteward(id: string, on: boolean, o: { stay?: boolean; bots?: string[] } = {}): Promise<void> {
  byId = { ...byId, [id]: await api<StewardView>(`/api/sessions/${id}/steward`, on ? { method: "POST", body: JSON.stringify(o) } : { method: "DELETE" }) };
  changed();
}

export function useSteward(id: string): StewardView | undefined {
  useEffect(() => { if (!(id in byId)) loadSteward(id).catch(reportError); }, [id]);
  return useSyncExternalStore(subscribe, () => byId[id]);
}

// What the chip says of the watch, in a word and a tone.
export function stewardWord(w: Watch | null | undefined): { word: string; tone: "ok" | "work" | "warn" | "off" } {
  if (!w) return { word: "Off", tone: "off" };
  if (w.state === "watching") return { word: "Watching", tone: "ok" };
  if (w.state === "fixing") return { word: "Fixing", tone: "work" };
  if (w.end === "green") return { word: STATE_WORD.done, tone: "ok" };
  if (w.end === "capped" || w.end === "unreadable" || w.end === "removed") return { word: STATE_WORD.stop, tone: "warn" };
  if (w.end === "merged" || w.end === "closed") return { word: w.end === "merged" ? "Merged" : "Closed", tone: "off" };
  return { word: "Off", tone: "off" };
}

onFeature({
  frame(f) {
    if (f.name === "steward" && f.session_id && f.session_id in byId) loadSteward(f.session_id).catch(reportUnlessGone);
  },
  reconnect() {
    for (const id of Object.keys(byId)) loadSteward(id).catch(reportUnlessGone);
  },
});
