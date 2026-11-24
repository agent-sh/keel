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

export type Decide = { area: string; action: "land" | "back" | "drop" | "undo"; note?: string; agents?: string[]; branches?: string[]; repo?: string | null };
export const decide = (id: string, d: Decide) =>
  api<{ ok: true; outcome?: string; view?: TreeView }>(`/api/sessions/${id}/tree-review/decide`, { method: "POST", body: JSON.stringify({ ...d, repo: d.repo ?? undefined }) });

// The branches of an area's landing order that would conflict when landed: one that conflicts with the base, or
// with a branch of the order that lands before it (its agent rebases it onto that one). The first of two
// that meet is safe; the rest are not.
export function wouldConflict(view: TreeView, order: string[]): string[] {
  const step = new Map(view.order.steps.flatMap((s, i) => s.branches.map((b) => [b, i] as const)));
  const base = new Set(view.branches.filter((b) => b.base_conflict).map((b) => b.branch));
  const before = (b: string) => view.pairs.some((p) => {
    if (!p.conflict || (p.a !== b && p.b !== b)) return false;
    const other = p.a === b ? p.b : p.a;
    return order.includes(other) && (step.get(other) ?? 0) < (step.get(b) ?? 0);
  });
  return order.filter((b) => base.has(b) || before(b));
}

// A branch's color in the review: its place in the list, through the lane tokens (styles.css).
export const LANES = 6;
export const laneOf = (i: number) => `var(--lane-${(i % LANES) + 1})`;
