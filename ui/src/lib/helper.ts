// Client state of the owner's helper (src/helper/): whether it is on, its
// session, its mail source, the events it was told about, and the
// remembered list. Fed by REST and the helper's feature frames.
import { useSyncExternalStore } from "react";
import type { DigestEvent } from "../../../src/helper/policy.ts";
import type { Look } from "../../../src/helper/error-look.ts";
import type { MemoryRecord } from "../../../src/helper/records.ts";
import { api, onFeature, readAtOpen } from "./store.ts";
import { navigate, rememberPanel } from "./ui.ts";

export type { DigestEvent, Look, MemoryRecord };
export type HelperView = {
  on: boolean;
  session_id: string | null;
  mail_every_min: number;
  wake_gap_min: number;
  last_wake: number | null;
  mail: { id: string; label: string; available: boolean; account?: string; can: { modify: boolean; send: boolean; calendar: boolean } };
  events: DigestEvent[];
  // Its look (src/helper/persona.ts): the name it answers to, the picture, and the pictures waiting to be picked.
  name: string;
  named: boolean;
  avatar: { url: string; from: "made" | "upload"; model?: string; prompt?: string } | null;
  avatar_prompt: string;
  avatar_model: string | null;
  candidates: { id: string; url: string; model: string }[];
};
type State = { view: HelperView | null; memory: MemoryRecord[]; looks: Look[] };

let state: State = { view: null, memory: [], looks: [] };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export function useHelper<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => sel(state));
}

export async function loadHelper(): Promise<HelperView> {
  const [view, mem, looks] = await Promise.all([api<HelperView>("/api/helper"), api<{ items: MemoryRecord[] }>("/api/helper/memory"), api<{ looks: Look[] }>("/api/helper/looks")]);
  set({ view, memory: mem.items, looks: looks.looks });
  return view;
}
onFeature({
  frame(f) {
    if (f.name === "helper") set({ view: f.data });
    else if (f.name === "helper_memory") set({ memory: f.data.items });
    else if (f.name === "helper_looks") set({ looks: f.data.looks });
  },
  reconnect: readAtOpen(loadHelper),
});

export async function setHelper(p: Partial<Pick<HelperView, "on" | "mail_every_min" | "wake_gap_min">> & { name?: string | null }) {
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
    rememberPanel(v.session_id, "helper");
  }
  if (v.session_id) navigate({ name: "session", id: v.session_id });
}

const json = (b: unknown) => ({ method: "POST", body: JSON.stringify(b) });
export type MemoryInput = { key?: string; value?: string; kind?: string; aliases?: string[]; topics?: string[] };
export const addMemory = (p: MemoryInput) => api("/api/helper/memory", json(p));
export const editMemory = (key: string, p: MemoryInput) => api(`/api/helper/memory/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(p) });
export const dropMemory = (key: string) => api(`/api/helper/memory/${encodeURIComponent(key)}`, { method: "DELETE" });
export const checkMail = () => api<{ new: number; important: number }>("/api/helper/check", { method: "POST" });

// The name and the picture (src/helper/persona.ts).
export type ImageModel = { id: string; provider: string; model: string; name: string; billing: "subscription" | "per_token" };
export type ImageModels = { models: ImageModel[]; failed: { provider: string; label: string; error: string }[] };
const view = (v: HelperView) => set({ view: v });
export const imageModels = () => api<ImageModels>("/api/helper/avatar/models");
export const makeAvatars = (b: { prompt: string; model: string; n?: number }) => api<HelperView>("/api/helper/avatar/make", json(b)).then(view);
export const pickAvatar = (id: string) => api<HelperView>("/api/helper/avatar/pick", json({ id })).then(view);
export const uploadAvatar = (file: Blob) => api<HelperView>("/api/helper/avatar", { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } }).then(view);
export const removeAvatar = () => api<HelperView>("/api/helper/avatar", { method: "DELETE" }).then(view);
export const askLook = (cause: string) => api<{ look: Look }>(`/api/helper/looks/${encodeURIComponent(cause)}/ask`, { method: "POST" });
// The look that stands for an error row, when the helper has one.
export const lookOf = (looks: readonly Look[], errorId: string) => looks.find((l) => l.error_ids.includes(errorId));

export type KeelRepo = ({ repo: { dir: string; from: "running" | "setting" | "build"; commit?: string } } | { problem: string }) & { setting: string | null };
export const keelRepo = () => api<KeelRepo>("/api/helper/keel-repo");
export const setKeelRepo = (dir: string | null) => api("/api/settings", { method: "PATCH", body: JSON.stringify({ helper: { keel_repo: dir } }) });
