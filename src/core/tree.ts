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

// A part of one branch, for a reader that holds a long session in pages (the
// browser): `limit` events of the branch that ends at `head`, with the other
// versions of the prompts among them (the reader shows their count).
//   no place given: the newest events of the branch;
//   before: the events of the branch older than that seq, newest first to fill the page;
//   after: the events of the branch newer than that seq, oldest first;
//   around: the events around that one, on the session's branch when it is
//     there, else on the branch that grew from it.
// A page that is not read forward starts where a turn starts when one is
// within another `limit` events, so the rows of its first turn are whole.
// The newest events come with the start of the branch's last turn.
export type PageAsk = { limit: number; head?: string | null; before?: number; after?: number; around?: string };
export type Page = {
  events: StoredEvent[]; // in seq order
  head: string | null; // the end of the branch the page is a part of
  first: string | null; // the page's first and last event on that branch
  last: string | null;
  start: boolean; // the page reaches the branch's first event
  end: boolean; // the page reaches the branch's end
  on_head: boolean; // the branch is the session's own
};
export function pageOf(events: StoredEvent[], sessionHead: string | null, ask: PageAsk): Page | null {
  const limit = Math.max(1, Math.floor(ask.limit) || 1);
  let head = ask.head ?? sessionHead;
  let line: StoredEvent[];
  let a: number, b: number;
  if (ask.around) {
    const main = lineage(events, sessionHead);
    let i = main.findIndex((e) => e.id === ask.around);
    line = main;
    head = sessionHead;
    if (i < 0) {
      if (!events.some((e) => e.id === ask.around)) return null;
      head = leafOf(events, ask.around);
      line = lineage(events, head);
      i = line.findIndex((e) => e.id === ask.around);
    }
    a = Math.max(0, i - (limit >> 1));
    b = Math.min(line.length, a + limit);
  } else {
    line = lineage(events, head);
    if (head && !line.length) return null;
    if (ask.after !== undefined) {
      a = line.findIndex((e) => e.seq > ask.after!);
      if (a < 0) a = line.length;
      b = Math.min(line.length, a + limit);
    } else {
      b = ask.before === undefined ? line.length : line.findIndex((e) => e.seq >= ask.before!);
      if (b < 0) b = line.length;
      a = Math.max(0, b - limit);
    }
  }
  if (ask.after === undefined) {
    for (let k = a; k >= Math.max(0, a - limit); k--) {
      if (k === 0 || line[k - 1]!.kind === "turn_end") { a = k; break; }
    }
  }
  const part = line.slice(a, b);
  const out = new Map(part.map((e) => [e.id, e]));
  const parents = new Set(part.filter((e) => e.kind === "user" && !e.data.origin).map((e) => e.parent));
  if (parents.size) for (const e of events) if (e.kind === "user" && !e.data.origin && parents.has(e.parent)) out.set(e.id, e);
  // The newest events of the branch come with the start of its last turn (the reader's clock of a running turn).
  const start = ask.around || ask.before !== undefined || ask.after !== undefined ? undefined : line.findLast((e) => e.kind === "turn_start");
  if (start) out.set(start.id, start);
  return {
    events: [...out.values()].sort((x, y) => x.seq - y.seq),
    head, first: part[0]?.id ?? null, last: part.at(-1)?.id ?? null,
    start: a === 0, end: b === line.length, on_head: head === sessionHead,
  };
}
