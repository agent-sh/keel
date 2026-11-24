// The tree review of a session (src/board/tree-review.ts): read when its dialog opens, on the owner's
// Refresh, and after a decision. One area's hunks are read when the area is shown.
import type { AreaDetail, TreeView } from "../../../src/board/tree-review.ts";
import { api } from "./store.ts";

export type { AreaDetail, TreeView };
export type { AreaHunk, TreeArea, TreeBranch, TreeOverlap, TreePair, Decision } from "../../../src/board/tree-review.ts";

const q = (repo?: string | null) => (repo ? `&repo=${encodeURIComponent(repo)}` : "");

export const readTree = (id: string, fresh = false, repo?: string | null) =>
  api<TreeView>(`/api/sessions/${id}/tree-review?${fresh ? "fresh=1" : ""}${q(repo)}`);

export const readArea = (id: string, key: string, repo?: string | null) =>
  api<AreaDetail>(`/api/sessions/${id}/tree-review/area?key=${encodeURIComponent(key)}${q(repo)}`);

export type Decide = { area: string; action: "land" | "back" | "drop" | "undo"; note?: string; agents?: string[]; repo?: string | null };
export const decide = (id: string, d: Decide) =>
  api<{ ok: true; outcome?: string; view?: TreeView }>(`/api/sessions/${id}/tree-review/decide`, { method: "POST", body: JSON.stringify({ ...d, repo: d.repo ?? undefined }) });

// A branch's color in the review: its place in the list, through the lane tokens (styles.css).
export const LANES = 6;
export const laneOf = (i: number) => `var(--lane-${(i % LANES) + 1})`;
