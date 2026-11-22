// Pure functions over the event tree, shared by the daemon and the page.
import type { StoredEvent } from "./types.ts";

// The branch that ends at `head`, oldest first.
export function lineage(events: readonly StoredEvent[], head: string | null): StoredEvent[] {
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
export function leafOf(events: readonly StoredEvent[], id: string): string {
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
export function versions(events: readonly StoredEvent[], e: StoredEvent): StoredEvent[] {
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

// Where the events with a seq of at least `seq` start on a branch (a branch
// is in seq order: a parent is stored before its child).
export function firstAt(line: readonly StoredEvent[], seq: number): number {
  let lo = 0, hi = line.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (line[mid]!.seq >= seq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// How many branches a session has: its events that nothing was stored under.
// Events are in seq order and nearly every one continues the one before it,
// so only the parents reached from further on are kept in a set.
export function leafCount(all: readonly StoredEvent[]): number {
  let adjacent = 0;
  const far = new Set<string>();
  for (let i = 0; i < all.length; i++) {
    const p = all[i]!.parent;
    if (p === null) continue;
    if (i > 0 && all[i - 1]!.id === p) adjacent++;
    else far.add(p);
  }
  // A parent reached both ways is one parent.
  let both = 0;
  if (far.size) for (let i = 0; i + 1 < all.length; i++) if (all[i + 1]!.parent === all[i]!.id && far.has(all[i]!.id)) both++;
  return all.length - (adjacent + far.size - both);
}

// The texts of a turn's replies, oldest first: the text blocks of the replies
// stored before `end` (a place on the branch) back to the turn's prompt. A turn
// starts at a prompt; a restart or harness note inside it does not start one.
// `last`: the newest reply that has any text, going back over turns without
// (what "Copy the last reply" gives).
export function replyBefore(line: readonly StoredEvent[], end: number, last = false): string[] {
  const text: string[] = [];
  for (let i = Math.min(end, line.length) - 1; i >= 0; i--) {
    const e = line[i]!;
    if (e.kind === "user" && e.data.origin !== "restart" && e.data.origin !== "harness") { if (!last || text.length) break; continue; }
    if (e.kind === "assistant" && e.data.stop !== "refusal") text.unshift(...e.data.blocks.filter((b: any) => b.type === "text" && b.text.trim()).map((b: any) => b.text as string));
  }
  return text;
}

// Whether a part may start at `k`: at the branch's start, or after a turn's
// end and the failures stored right after it (they are shown with that end).
function turnEdge(line: readonly StoredEvent[], k: number): boolean {
  if (k === 0) return true;
  if (line[k]?.kind === "error") return false;
  let j = k - 1;
  while (j > 0 && line[j]!.kind === "error") j--;
  return line[j]!.kind === "turn_end";
}

// The page of a branch already walked (the daemon keeps the session's own):
// its edges are found by halving on seq and nothing outside it is read.
// `at`: the place of the event a page is asked around. `versions`: the
// owner's prompts stored under a parent.
// The places of the part a page asks for on a branch already walked: from `a` up to `b`, read from
// the events' kinds alone (no body), so a reader can have that part's bodies brought in first.
export function pageRange(line: readonly StoredEvent[], ask: { limit: number; before?: number; after?: number; at?: number }): [number, number] {
  const limit = Math.max(1, Math.floor(ask.limit) || 1);
  let a: number, b: number;
  if (ask.at !== undefined) {
    a = Math.max(0, ask.at - (limit >> 1));
    b = Math.min(line.length, a + limit);
  } else if (ask.after !== undefined) {
    a = firstAt(line, ask.after + 1);
    b = Math.min(line.length, a + limit);
  } else {
    b = ask.before === undefined ? line.length : firstAt(line, ask.before);
    a = Math.max(0, b - limit);
  }
  if (ask.after === undefined) {
    for (let k = a; k >= Math.max(0, a - limit); k--) {
      if (turnEdge(line, k)) { a = k; break; }
    }
  }
  // What failed in a turn is stored right after its end and shown with it: a part does not end between them.
  while (b > a && b < line.length && line[b]!.kind === "error") b++;
  return [a, b];
}

export function pageOfLine(line: readonly StoredEvent[], ask: { limit: number; before?: number; after?: number; at?: number }, versions: (parent: string | null) => readonly StoredEvent[], head: string | null, on_head: boolean): Page {
  const [a, b] = pageRange(line, ask);
  const part = line.slice(a, b);
  const out = new Map(part.map((e) => [e.id, e]));
  for (const e of part) if (e.kind === "user" && !e.data.origin) for (const v of versions(e.parent)) out.set(v.id, v);
  // The newest events of the branch come with the start of its last turn (the reader's clock of a running turn).
  if (ask.at === undefined && ask.before === undefined && ask.after === undefined) {
    for (let k = line.length - 1; k >= 0; k--) if (line[k]!.kind === "turn_start") { out.set(line[k]!.id, line[k]!); break; }
  }
  return {
    events: out.size === part.length ? part : [...out.values()].sort((x, y) => x.seq - y.seq),
    head, first: part[0]?.id ?? null, last: part.at(-1)?.id ?? null,
    start: a === 0, end: b === line.length, on_head,
  };
}

// The same from every event of a session, for a branch nobody keeps (another
// branch than the session's, an event of one): the branch is walked here.
export function pageOf(events: readonly StoredEvent[], sessionHead: string | null, ask: PageAsk): Page | null {
  let head = ask.head ?? sessionHead;
  let line: StoredEvent[];
  let at: number | undefined;
  if (ask.around) {
    line = lineage(events, sessionHead);
    head = sessionHead;
    at = line.findIndex((e) => e.id === ask.around);
    if (at < 0) {
      if (!events.some((e) => e.id === ask.around)) return null;
      head = leafOf(events, ask.around);
      line = lineage(events, head);
      at = line.findIndex((e) => e.id === ask.around);
    }
  } else {
    line = lineage(events, head);
    if (head && !line.length) return null;
  }
  // The versions of the prompts, grouped once when a prompt asks for them.
  let by: Map<string | null, StoredEvent[]> | undefined;
  const versions = (parent: string | null) => {
    if (!by) {
      by = new Map();
      for (const e of events) if (e.kind === "user" && !e.data.origin) (by.get(e.parent) ?? by.set(e.parent, []).get(e.parent)!).push(e);
    }
    return by.get(parent) ?? [];
  };
  return pageOfLine(line, { limit: ask.limit, before: ask.before, after: ask.after, at }, versions, head, head === sessionHead);
}
