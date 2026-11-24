// The order of the search palette's own sessions when nothing is typed: what waits for the owner,
// then what failed, then the rest by recency; and its groups, with a machine's sessions after
// this machine's. Read from the session's watch word (src/core/watch.ts), never its own state.
import type { Watch } from "./watch.ts";

type Ranked = { id: string; updated: number };
const FIRST: Partial<Record<Watch, number>> = { need: 0, fail: 1, declined: 1 };
const rank = (w: Watch | undefined) => (w ? FIRST[w] : undefined) ?? 2;

// A stable order: need, failed, then newest first.
export function ranked<T extends Ranked>(list: T[], watches: Record<string, Watch>): T[] {
  return [...list].sort((a, b) => rank(watches[a.id]) - rank(watches[b.id]) || b.updated - a.updated);
}

// Where a group stands among the palette's groups; "Sessions on <machine>" follows "Sessions".
export const MACHINE_GROUP = "Sessions on ";
export function groupIndex(order: string[], group: string): number {
  const at = order.indexOf(group);
  return at >= 0 ? at : group.startsWith(MACHINE_GROUP) ? order.indexOf("Sessions") + 0.5 : order.length;
}

// What an agent's row says in the place of its folder (an agent works in a worktree of its own).
export const agentOf = (parentTitle: string | undefined): string => (parentTitle === undefined ? "agent" : `agent of ${parentTitle || "New session"}`);
