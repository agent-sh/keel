// Pure functions over the event tree, shared by the daemon and the page.
import type { StoredEvent } from "./types.ts";

// The branch that ends at `head`, oldest first.
export function lineage(events: StoredEvent[], head: string | null): StoredEvent[] {
  if (!head) return [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const out: StoredEvent[] = [];
  const seen = new Set<string>();
  for (let e = byId.get(head); e && !seen.has(e.id); e = e.parent ? byId.get(e.parent) : undefined) {
    seen.add(e.id);
    out.push(e);
  }
  return out.reverse();
}

// The newest event at or below `id`: where the branch that grew from it ends.
export function leafOf(events: StoredEvent[], id: string): string {
  const children = new Map<string, StoredEvent[]>();
  for (const e of events) if (e.parent) (children.get(e.parent) ?? children.set(e.parent, []).get(e.parent)!).push(e);
  let best = events.find((e) => e.id === id);
  if (!best) return id;
  const stack = [best];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.seq > best.seq) best = e;
    stack.push(...(children.get(e.id) ?? []));
  }
  return best.id;
}

// The other versions of a prompt: user events with the same parent, in order.
export function versions(events: StoredEvent[], e: StoredEvent): StoredEvent[] {
  if (e.kind !== "user") return [e];
  return events.filter((x) => x.kind === "user" && x.parent === e.parent && !x.data.origin);
}
