// The order cards are listed in, for the daemon and the page alike.
//
// The calls of one reply are judged side by side, so whichever check ends
// first opens its card first. A card keeps where its call stands in the
// model's reply (`reply`: the reply's event and the call's index), and the
// cards of one reply list in that order, whatever the checks' timing. Cards of
// different replies, of different sessions and cards with no place (older
// ones, a call no reply made) keep the order they opened in.
export type Placed = { id: string; session_id: string; created: number; reply?: { seq: number; index: number } };

// Oldest first. A reply's cards stand where its first-opened card stands, in call order; ties by time, then id.
export function cardOrder<T extends Placed>(list: readonly T[]): T[] {
  const first = new Map<string, number>();
  for (const a of list) if (a.reply) {
    const k = `${a.session_id}:${a.reply.seq}`;
    first.set(k, Math.min(first.get(k) ?? Infinity, a.created));
  }
  const at = (a: T) => (a.reply ? first.get(`${a.session_id}:${a.reply.seq}`)! : a.created);
  return [...list].sort((a, b) => at(a) - at(b)
    || (a.reply && b.reply && a.session_id === b.session_id && a.reply.seq === b.reply.seq ? a.reply.index - b.reply.index : 0)
    || a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
