// Client state of managed worktrees, per session; refreshed by "worktree"
// feature frames. Also the start box's "in a new worktree" choice.
import { useEffect, useSyncExternalStore } from "react";
import type { BranchList, WorktreeStatus } from "../../../src/worktree/manager.ts";
import { api, onFeature, reportError, reportUnlessGone } from "./store.ts";

export type { BranchList, WorktreeStatus };

// Who wrote the head of a session that started at a pull request (src/safety/head-trust.ts).
export type HeadView = { held: boolean; state: "held" | "trusted" | "owner"; number: number; author: string | null; fork: boolean | null; why: string; base_ref: string | null; merge_base: string | null; head_commit: string };

let byId: Record<string, WorktreeStatus | null> = {};
let heads: Record<string, HeadView | null> = {};
let startInWorktree = localStorage.getItem("keel.startInWorktree") === "1";
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

// `shared`: a view that shows the status as it mounts takes the read another
// view of the session already has out (they mount together). A read after a
// change (a frame, a move) is always its own.
const reading = new Map<string, Promise<void>>();
export function loadWorktree(id: string, shared = false): Promise<void> {
  const out = shared ? reading.get(id) : undefined;
  if (out) return out;
  const read = (async () => {
    const r = await api<{ worktree: WorktreeStatus | null; head?: HeadView | null }>(`/api/sessions/${id}/worktree`);
    byId = { ...byId, [id]: r.worktree };
    heads = { ...heads, [id]: r.head ?? null };
    changed();
  })().finally(() => { if (reading.get(id) === read) reading.delete(id); });
  reading.set(id, read);
  return read;
}

export function useWorktree(id: string): WorktreeStatus | null | undefined {
  useEffect(() => { if (!(id in byId)) loadWorktree(id, true).catch(reportError); }, [id]);
  return useSyncExternalStore(subscribe, () => byId[id]);
}

export const useHead = (id: string): HeadView | null | undefined => useSyncExternalStore(subscribe, () => heads[id]);

export const useStartInWorktree = () => useSyncExternalStore(subscribe, () => startInWorktree);
export function setStartInWorktree(v: boolean) {
  startInWorktree = v;
  localStorage.setItem("keel.startInWorktree", v ? "1" : "0");
  changed();
}

// The branch a new worktree starts from, for one folder: set to the repository's default when the
// choice is shown (WorktreeBase), so what the box says is what is sent.
let picked: { workspace: string; base: string } = { workspace: "", base: "" };
export const useStartBase = (workspace: string) => useSyncExternalStore(subscribe, () => (picked.workspace === workspace ? picked.base : ""));
export const startBase = (workspace: string) => (picked.workspace === workspace ? picked.base : "");
export function setStartBase(workspace: string, base: string) {
  picked = { workspace, base };
  changed();
}

// A pull request to start at (its number or address), for one folder: it replaces the base branch.
let pr: { workspace: string; value: string } = { workspace: "", value: "" };
export const useStartPr = (workspace: string) => useSyncExternalStore(subscribe, () => (pr.workspace === workspace ? pr.value : ""));
export const startPr = (workspace: string) => (pr.workspace === workspace ? pr.value.trim() : "");
export function setStartPr(workspace: string, value: string) {
  pr = { workspace, value };
  changed();
}

// The branches to start from, read when the choice is shown.
export const loadBranches = (dir: string) => api<BranchList>(`/api/worktrees/branches?workspace=${encodeURIComponent(dir)}`);

// Whether a folder is in a git repository (cached per folder).
const gitCache = new Map<string, Promise<boolean>>();
export const isGitFolder = (dir: string) => {
  if (!gitCache.has(dir)) gitCache.set(dir, api<{ git: boolean }>(`/api/worktrees/check?workspace=${encodeURIComponent(dir)}`).then((r) => r.git).catch((e) => (reportError(e, { at: "git check" }), false)));
  return gitCache.get(dir)!;
};

onFeature({
  frame(f) {
    if (f.name === "worktree" && f.session_id) loadWorktree(f.session_id).catch(reportError);
  },
  reconnect() {
    for (const id of Object.keys(byId)) loadWorktree(id).catch(reportUnlessGone);
  },
});

// A new session in a fresh worktree of `workspace`'s repository.
export async function createInWorktree(text: string, model?: string, workspace?: string, images?: unknown[], base?: string, pr?: string) {
  const r = await api<{ session: { id: string }; worktree: WorktreeStatus }>("/api/worktrees", { method: "POST", body: JSON.stringify({ text, model, workspace, images, ...(pr ? { pr } : { base: base || undefined }) }) });
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
