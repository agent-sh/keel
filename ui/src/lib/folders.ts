// Client state of the owner's folders of sessions
// (src/server/routes/session-folders.ts): loaded once and again on each
// "folders" frame and reconnect. Which folder a session is in is its own
// settings.folder_id, which comes with the session.
import { useSyncExternalStore } from "react";
import type { SessionFolder } from "../../../src/server/routes/session-folders.ts";
import { api, onFeature, readAtOpen, reportError } from "./store.ts";

export type { SessionFolder };
type State = { folders: SessionFolder[]; loaded: boolean };
let state: State = { folders: [], loaded: false };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };

const read = () => api<{ folders: SessionFolder[] }>("/api/session-folders").then((r) => set({ folders: r.folders, loaded: true }));
export const loadFolders = () => read().catch(reportError);
onFeature({ frame: (f) => { if (f.name === "folders") loadFolders(); }, reconnect: readAtOpen(read) });

export const getFolders = () => state;
export function useFolders<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}

// Top folders in order, each with its folders in order.
export function tree(list: SessionFolder[]) {
  const top = list.filter((f) => !f.parent_id || !list.some((p) => p.id === f.parent_id));
  return top.map((f) => ({ folder: f, kids: list.filter((k) => k.parent_id === f.id) }));
}
// "Parent / Child" for a folder's full name.
export const pathOf = (f: SessionFolder, list: SessionFolder[]) => {
  const p = f.parent_id ? list.find((x) => x.id === f.parent_id) : undefined;
  return p ? `${p.name} / ${f.name}` : f.name;
};

const patch = (id: string, body: Partial<SessionFolder>) => api(`/api/session-folders/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then(() => loadFolders());
export const folders = {
  // Made when the list has it, as a rename and a move are: the list held under the hand draws what
  // the owner did once the act has landed, and a folder that came a moment later was not drawn
  // until the hand had left the list.
  create: (name: string, parent_id: string | null = null) =>
    api<{ folder: SessionFolder }>("/api/session-folders", { method: "POST", body: JSON.stringify({ name, parent_id }) }).then(async (r) => { await loadFolders(); return r.folder; }),
  rename: (id: string, name: string) => patch(id, { name }),
  collapse: (id: string, collapsed: boolean) => patch(id, { collapsed }),
  remove: (id: string) => api(`/api/session-folders/${id}`, { method: "DELETE" }).then(() => loadFolders()),
  // Put `id` just before `target`, at target's level; with `into`, inside target (a top folder).
  place(id: string, target: SessionFolder, into: boolean) {
    // A folder that holds folders stays on top: it goes before the target instead.
    const holds = state.folders.some((f) => f.parent_id === id);
    if (into && !holds) return patch(id, { parent_id: target.id });
    const up = holds && target.parent_id ? state.folders.find((f) => f.id === target.parent_id) : undefined;
    if (up) target = up;
    const level = state.folders.filter((f) => f.parent_id === target.parent_id && f.id !== id);
    const i = level.findIndex((f) => f.id === target.id);
    const before = level[i - 1]?.pos ?? target.pos - 1;
    return patch(id, { parent_id: target.parent_id, pos: (before + target.pos) / 2 });
  },
  file: (sessionId: string, folder: string | null) => api(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ folder_id: folder }) }),
};
