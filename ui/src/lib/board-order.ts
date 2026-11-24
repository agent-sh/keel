// The work board's cards in the order of the tree: an agent's own agents follow it, indented, and among
// the agents of one parent what needs the owner comes first, then what failed, what works, what is at rest
// (the newest first within each).
import type { Watch } from "../../../src/core/watch.ts";

type Row = { session_id: string; parent_id: string; created: number; id: string };

const TIER: Record<Watch, number> = { need: 0, fail: 1, declined: 1, work: 2, wait: 2, resume: 2, stop: 3, done: 3, idle: 3 };

// `root`: the session the board is of. A row whose parent is not on the board (older agents are left out of it)
// stands at the top. Every row comes out once; `indent` is its depth in what is shown.
export function treeOrder<T extends Row>(rows: readonly T[], root: string, watches: Record<string, Watch | undefined>): { row: T; indent: number }[] {
  const ids = new Set(rows.map((r) => r.session_id));
  const kids = new Map<string, T[]>();
  for (const r of rows) {
    const at = r.parent_id === root || !ids.has(r.parent_id) ? root : r.parent_id;
    kids.set(at, [...(kids.get(at) ?? []), r]);
  }
  const tier = (r: T) => TIER[watches[r.session_id] ?? "idle"];
  const out: { row: T; indent: number }[] = [];
  const seen = new Set<string>();
  const walk = (at: string, indent: number) => {
    for (const r of [...(kids.get(at) ?? [])].sort((a, b) => tier(a) - tier(b) || b.created - a.created || b.id.localeCompare(a.id))) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ row: r, indent });
      walk(r.session_id, indent + 1);
    }
  };
  walk(root, 0);
  // (A row no walk reached, its parent among its own descendants: shown, not lost.)
  for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); out.push({ row: r, indent: 0 }); walk(r.session_id, 1); }
  return out;
}
