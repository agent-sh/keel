// The agents under a session, at any depth, in the order they were started (a branch before the next
// sibling), each with its path: the agents between the session and it, itself last. A view of a
// session shows what its whole tree asks (components/automation/ChildApprovals.tsx), and the
// inbox opens an agent's request on the session that started the tree (`rootOf`).
export type Node = { id: string; session_id: string; parent_id: string; title: string; created: number };
export type Below<T extends Node> = { agent: T; path: T[] };

export function below<T extends Node>(agents: Record<string, T>, root: string): Below<T>[] {
  const by = new Map<string, T[]>();
  for (const a of Object.values(agents)) (by.get(a.parent_id) ?? by.set(a.parent_id, []).get(a.parent_id)!).push(a);
  const out: Below<T>[] = [];
  const seen = new Set<string>([root]);
  const walk = (from: string, path: T[]) => {
    for (const a of (by.get(from) ?? []).sort((x, y) => x.created - y.created || (x.id < y.id ? -1 : 1))) {
      if (seen.has(a.session_id)) continue; // (a loop in the records ends here)
      seen.add(a.session_id);
      const here = [...path, a];
      out.push({ agent: a, path: here });
      walk(a.session_id, here);
    }
  };
  walk(root, []);
  return out;
}

// The session at the top of the tree `id` is in: its parents followed while they are known.
export function rootOf(parentOf: (id: string) => string | null | undefined, id: string): string {
  const seen = new Set([id]);
  let at = id;
  for (let up = parentOf(at); up && !seen.has(up); up = parentOf(at)) { seen.add(up); at = up; }
  return at;
}
