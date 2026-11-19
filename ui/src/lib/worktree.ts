// Client state of managed worktrees, per session; refreshed by "worktree"
// feature frames. Also the start box's "in a new worktree" choice.
import { useEffect, useSyncExternalStore } from "react";
import type { WorktreeStatus } from "../../../src/worktree/manager.ts";
import { api, onFeature, reportError } from "./store.ts";

export type { WorktreeStatus };

let byId: Record<string, WorktreeStatus | null> = {};
let startInWorktree = localStorage.getItem("keel.startInWorktree") === "1";
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export async function loadWorktree(id: string) {
  const r = await api<{ worktree: WorktreeStatus | null }>(`/api/sessions/${id}/worktree`);
  byId = { ...byId, [id]: r.worktree };
  changed();
}

export function useWorktree(id: string): WorktreeStatus | null | undefined {
  useEffect(() => { if (!(id in byId)) loadWorktree(id).catch(reportError); }, [id]);
  return useSyncExternalStore(subscribe, () => byId[id]);
}

export const useStartInWorktree = () => useSyncExternalStore(subscribe, () => startInWorktree);
export function setStartInWorktree(v: boolean) {
  startInWorktree = v;
  localStorage.setItem("keel.startInWorktree", v ? "1" : "0");
  changed();
}

// Whether a folder is in a git repository (cached per folder).
const gitCache = new Map<string, Promise<boolean>>();
export const isGitFolder = (dir: string) => {
  if (!gitCache.has(dir)) gitCache.set(dir, api<{ git: boolean }>(`/api/worktrees/check?workspace=${encodeURIComponent(dir)}`).then((r) => r.git).catch(() => false));
  return gitCache.get(dir)!;
};

onFeature({
  frame(f) {
    if (f.name === "worktree" && f.session_id) loadWorktree(f.session_id).catch(reportError);
  },
  reconnect() {
    for (const id of Object.keys(byId)) loadWorktree(id).catch(reportError);
  },
});

// A new session in a fresh worktree of `workspace`'s repository.
export async function createInWorktree(text: string, model?: string, workspace?: string, images?: unknown[]) {
  const r = await api<{ session: { id: string }; worktree: WorktreeStatus }>("/api/worktrees", { method: "POST", body: JSON.stringify({ text, model, workspace, images }) });
  byId = { ...byId, [r.session.id]: r.worktree };
  changed();
  return r.session;
}

// Move a session between its main checkout and a worktree (its uncommitted work goes with it).
export async function handoff(id: string, to: "worktree" | "main") {
  const r = await api<{ moved: number; branch?: string }>(`/api/sessions/${id}/worktree/handoff`, { method: "POST", body: JSON.stringify({ to }) });
  await loadWorktree(id);
  return r;
}
