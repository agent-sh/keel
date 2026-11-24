// A tree's own figures in a live experiment: what every session of the tree spent and how long it
// worked, read once, when the tree is settled. Pure: Experiments.rows (src/admin/experiments.ts)
// reads the sums and the times, this decides which trees count and what they say.
//
// Which trees count is fixed by how they were assigned, never by what they did. The sample is the
// first `per_arm` trees of each arm in the order they were assigned (the cohort). A tree that is
// not settled yet has no figure, and a cohort tree that is settled has one, so the figures never
// come from the trees that happened to finish first: an arm whose trees last longer is read at the
// same trees as the other, and waits for them.
//
// Settled: nothing of the tree has been sent or has ended for `SETTLE_MS`. Every provider's longest
// prompt cache lifetime is an hour, so a tree quiet that long has been finished or has been waiting
// for someone; a later turn of it is a new piece of work and adds to nothing read here.
export const SETTLE_MS = 3_600_000;

export type TreeAssigned = { root: string; arm: string; ts: number };
// What the ledger holds of a tree: the sum of what its calls cost (all purposes), whether a call of
// it has no price, when its last call was sent; and its turns: the first start and the last end.
export type TreeSpent = { cost: number; unpriced: boolean; last_call: number };
export type TreeTurns = { first: number; end: number };
export type TreeFigures = { tree_cost_usd?: number; tree_ms?: number };

// The first `per_arm` roots of each arm by assignment order (time, then id).
export function cohort(assigned: readonly TreeAssigned[], per_arm: number): Set<string> {
  const taken = new Map<string, number>();
  const keep = new Set<string>();
  for (const a of [...assigned].sort((x, y) => x.ts - y.ts || (x.root < y.root ? -1 : x.root > y.root ? 1 : 0))) {
    const n = taken.get(a.arm) ?? 0;
    if (n >= per_arm) continue;
    taken.set(a.arm, n + 1);
    keep.add(a.root);
  }
  return keep;
}

export function treeFigures(o: {
  assigned: readonly TreeAssigned[]; spent: ReadonlyMap<string, TreeSpent>; turns: ReadonlyMap<string, TreeTurns>;
  per_arm: number; until: number; settle?: number;
}): Map<string, TreeFigures> {
  const out = new Map<string, TreeFigures>();
  const settle = o.settle ?? SETTLE_MS;
  for (const root of cohort(o.assigned, o.per_arm)) {
    const s = o.spent.get(root), t = o.turns.get(root);
    const last = Math.max(s?.last_call ?? 0, t?.end ?? 0);
    if (!last || last > o.until - settle) continue; // not settled, or nothing of it to read
    const f: TreeFigures = {};
    if (s && !s.unpriced) f.tree_cost_usd = s.cost;
    if (t) f.tree_ms = Math.max(0, t.end - t.first);
    if (Object.keys(f).length) out.set(root, f);
  }
  return out;
}
