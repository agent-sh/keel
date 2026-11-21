// The sessions that wait on the owner, in the order they are answered: the
// one that has waited longest first. Pure: the page gives it the sessions and
// each one's word (lib/watch.ts), so whatever makes a session read "needs
// you" (an approval, a question, a plan, a message that did not go) is in it.

type Row = { id: string; parent_id?: string | null; archived?: boolean; updated: number };

// `own` says whether a session holds a request itself. A session that needs
// the owner only because an agent it started asks (it holds nothing itself)
// is left out: the agent's own session is in the order, and that is where the
// answer is given.
export function waitingOrder(list: Row[], word: (id: string) => string | undefined, own: (id: string) => boolean): string[] {
  const need = list.filter((s) => !s.archived && word(s.id) === "need");
  const asking = new Set(need.map((s) => s.parent_id).filter(Boolean));
  return need
    .filter((s) => own(s.id) || !asking.has(s.id))
    // A session that waits is not written to: its last change is when it began to wait.
    .sort((a, b) => a.updated - b.updated || (a.id < b.id ? -1 : 1))
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
