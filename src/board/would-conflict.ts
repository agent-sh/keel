// The branches of a tree review's landing order that would conflict when landed. Pure: the page names them
// on its buttons, and the server refuses to queue them unless the owner confirmed (src/server/routes/tree-review.ts).
import type { TreeView } from "./tree-review.ts";

// A branch conflicts with the base, or with a branch of the order that lands before it (its agent rebases it
// onto that one). The first of two that meet is safe; the rest are not.
export function wouldConflict(view: Pick<TreeView, "order" | "branches" | "pairs">, order: string[]): string[] {
  const step = new Map(view.order.steps.flatMap((s, i) => s.branches.map((b) => [b, i] as const)));
  const base = new Set(view.branches.filter((b) => b.base_conflict).map((b) => b.branch));
  const before = (b: string) => view.pairs.some((p) => {
    if (!p.conflict || (p.a !== b && p.b !== b)) return false;
    const other = p.a === b ? p.b : p.a;
    return order.includes(other) && (step.get(other) ?? 0) < (step.get(b) ?? 0);
  });
  return order.filter((b) => base.has(b) || before(b));
}
