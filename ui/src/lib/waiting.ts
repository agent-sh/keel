// The sessions that wait on the owner, in the order they are answered: the
// order of the next-look queue (src/core/wait-rank.ts, lib/next-look.ts), the
// session whose wait costs most first, then the one that has waited longest.
// Pure: the page gives it each session's state as the daemon serves it
// (lib/watch.ts), so whatever makes a session read "needs you" (an approval, a
// question, a plan, a secret, a message that did not go) is in it, and with
// `also` a session that waits on a look (a failure the owner has not seen).

type Row = { id: string; archived?: boolean; updated: number };
// What the order reads of a session's state: its word, since when its reason
// stands, and the agent session the first thing that waits is in, if any.
type Told = { watch: string; since?: number; child?: string };

// `own` says whether a session holds a request itself. A session that needs
// the owner only because an agent it started asks (its state names that
// agent, and it holds nothing itself) is left out: the agent's own session
// is in the order, and that is where the answer is given.
// `cost`: the key of the costliest wait a session holds (none: 0).
export function waitingOrder(list: Row[], state: (id: string) => Told | undefined, own: (id: string) => boolean, cost: (id: string) => number = () => 0, also: (id: string) => boolean = () => false): string[] {
  const need = list.filter((s) => !s.archived && (state(s.id)?.watch === "need" || also(s.id)));
  const ids = new Set(need.map((s) => s.id));
  const at = (s: Row) => state(s.id)?.since ?? s.updated;
  return need
    .filter((s) => { const child = state(s.id)?.child; return own(s.id) || also(s.id) || !child || !ids.has(child); })
    .sort((a, b) => cost(b.id) - cost(a.id) || at(a) - at(b) || (a.id < b.id ? -1 : 1))
    .map((s) => s.id);
}

// The session to go to from `from`: the next one in the order, around its
// end; the first one from a session that does not wait. null when no other
// session waits.
export function nextWaiting(order: string[], from: string | null): string | null {
  const at = from ? order.indexOf(from) : -1;
  if (at < 0) return order[0] ?? null;
  return order.length > 1 ? order[(at + 1) % order.length]! : null;
}
