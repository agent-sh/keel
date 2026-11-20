// Client state of the owner's helper (src/helper/): whether it is on, its
// session, its mail source, the events it was told about, and the
// remembered list. Fed by REST and the helper's feature frames.
import { useSyncExternalStore } from "react";
import type { DigestEvent } from "../../../src/helper/policy.ts";
import type { MemoryRecord } from "../../../src/helper/records.ts";
import { api, onFeature, reportError } from "./store.ts";
import { navigate } from "./ui.ts";

export type { DigestEvent, MemoryRecord };
export type HelperView = {
  on: boolean;
  session_id: string | null;
  mail_every_min: number;
  wake_gap_min: number;
  last_wake: number | null;
  mail: { id: string; label: string; available: boolean; account?: string; can: { modify: boolean; send: boolean; calendar: boolean } };
  events: DigestEvent[];
};
type State = { view: HelperView | null; memory: MemoryRecord[] };

let state: State = { view: null, memory: [] };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export function useHelper<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => sel(state));
}

export async function loadHelper(): Promise<HelperView> {
  const [view, mem] = await Promise.all([api<HelperView>("/api/helper"), api<{ items: MemoryRecord[] }>("/api/helper/memory")]);
  set({ view, memory: mem.items });
  return view;
}
loadHelper().catch(reportError);
onFeature({
  frame(f) {
    if (f.name === "helper") set({ view: f.data });
    else if (f.name === "helper_memory") set({ memory: f.data.items });
  },
  reconnect: () => void loadHelper().catch(reportError),
});

export async function setHelper(p: Partial<Pick<HelperView, "on" | "mail_every_min" | "wake_gap_min">>) {
  set({ view: await api<HelperView>("/api/helper", { method: "PUT", body: JSON.stringify(p) }) });
}

// Opens the helper's conversation; the first open turns it on, with its
// panel open (the Bridge brings back the panel kept for a session).
export async function openHelper() {
  let v = state.view ?? (await loadHelper());
  if (!v.on || !v.session_id) {
    await setHelper({ on: true });
    v = state.view!;
    if (!v.session_id) return;
    const kept = JSON.parse(localStorage.getItem("keel.stationPanel") ?? "{}") as Record<string, string>;
    localStorage.setItem("keel.stationPanel", JSON.stringify({ ...kept, [v.session_id]: "helper" }));
  }
  if (v.session_id) navigate({ name: "session", id: v.session_id });
}

const json = (b: unknown) => ({ method: "POST", body: JSON.stringify(b) });
export type MemoryInput = { key?: string; value?: string; kind?: string; aliases?: string[]; topics?: string[] };
export const addMemory = (p: MemoryInput) => api("/api/helper/memory", json(p));
export const editMemory = (key: string, p: MemoryInput) => api(`/api/helper/memory/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(p) });
export const dropMemory = (key: string) => api(`/api/helper/memory/${encodeURIComponent(key)}`, { method: "DELETE" });
export const checkMail = () => api<{ new: number; important: number }>("/api/helper/check", { method: "POST" });
