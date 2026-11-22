// The order of the session list, and what holds it still. Pure: the same
// inputs give the same answer (Sidebar.tsx and ListArrange.tsx draw it).
//
// Position is the owner's: by default a row's place comes from when its
// session was made (newest first in its folder, folders by name), so no turn
// that starts or ends anywhere moves it. What a session needs is said by its
// mark, its word and the line above the list, never by where the row is. The
// orders that do move rows (recent activity, state) are choices in the
// Arrange menu.
//
// Under the hand nothing moves, whatever the order: while the pointer is in
// the list or the keyboard is on a row, the list is drawn in the order it had
// when the hand arrived. A session that went away stays as a dimmed row, one
// that arrived waits at the list's end, and both take their place when the
// hand has left. What the owner did themselves (archived a row, opened a new
// session) is not held.
//
// A row is one line by default: the mark, the title, the time, and the reason
// where the title leaves it room. Two lines, with the reason always there, is
// a choice. Either way every row of the list is as high as every other.
import { inBackground } from "../../../src/core/state-words.ts";
import { LIST_TIER, WATCH_RANK, type Watch } from "../../../src/core/watch.ts";

export type Arrange = { group: "project" | "mine" | "folder" | "flat"; sort: "created" | "recent" | "name" | "state"; hideDone: boolean; lines: "one" | "two" };
export const DEFAULT: Arrange = { group: "folder", sort: "created", hideDone: false, lines: "one" };

// What the browser keeps: the arrangement, the version of its defaults, and
// whether the note about the changed default is still to be read.
const VERSION = 2;
export type Kept = { arrange: Arrange; note: boolean };
export const keep = (k: Kept): string => JSON.stringify({ ...k.arrange, v: VERSION, ...(k.note ? { note: true } : {}) });

// The arrangement as kept, brought to this version once. Before it the
// default sorted by recent activity, and every order put what needs the owner
// first: an arrangement kept then that sorts by recent activity is on the new
// default now, and its menu says so until it was read. `used`: the browser
// has run Keel before (a first visit has nothing to be told).
export function readArrange(raw: string | null, used: boolean): Kept {
  let o: Record<string, unknown> = {};
  try { o = raw ? JSON.parse(raw) ?? {} : {}; } catch { /* a value nobody can read is the default */ }
  const pick = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);
  const now = o.v === VERSION;
  const sort = pick(o.sort, ["created", "recent", "name", "state"] as const, DEFAULT.sort);
  return {
    arrange: {
      group: pick(o.group, ["project", "mine", "folder", "flat"] as const, DEFAULT.group),
      sort: !now && sort === "recent" ? DEFAULT.sort : sort,
      hideDone: o.hideDone === true,
      lines: pick(o.lines, ["one", "two"] as const, DEFAULT.lines),
    },
    // Told once to whom the order changed under: they had the old default (recent activity). One who
    // chose by state keeps it, and by name rows already kept their place.
    note: now ? o.note === true : used && (raw === null || o.sort === undefined || o.sort === "recent"),
  };
}

type Row = { id: string; title: string; created: number; updated: number; workspace: string; machine?: string | null };
const name = (s: Row) => s.title || "New session";
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// The order of rows within a list. By creation and by name a row's place does
// not depend on its state. By recent activity and by state it does, as those
// orders always did: what needs the owner first, then what failed, what
// waits, what works, what is at rest.
export function order<T extends Row>(a: Pick<Arrange, "sort">, watches: Record<string, Watch>): (x: T, y: T) => number {
  const tier = (s: T) => LIST_TIER[watches[s.id] ?? "idle"];
  // (Two made in the same millisecond: ids are in the order they were made.)
  const made = (x: T, y: T) => y.created - x.created || y.id.localeCompare(x.id);
  if (a.sort === "created") return made;
  if (a.sort === "name") return (x, y) => name(x).localeCompare(name(y)) || made(x, y);
  if (a.sort === "state") return (x, y) => tier(x) - tier(y) || WATCH_RANK[watches[x.id] ?? "idle"] - WATCH_RANK[watches[y.id] ?? "idle"] || y.updated - x.updated || made(x, y);
  return (x, y) => tier(x) - tier(y) || y.updated - x.updated || made(x, y);
}

// Sessions by working folder (and machine), each folder's in the list's
// order. The folders stand by name where rows keep their place, and by their
// newest work where rows move with it.
export function folders<T extends Row>(sessions: T[], a: Pick<Arrange, "sort">, watches: Record<string, Watch>): { key: string; ws: string; machine?: string; list: T[] }[] {
  const cmp = order<T>(a, watches);
  const by = new Map<string, T[]>();
  for (const s of sessions) {
    const k = `${s.machine ?? ""}\u0000${s.workspace}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(s);
  }
  const out = [...by.entries()].map(([key, list]) => ({ key, ws: list[0]!.workspace, machine: list[0]!.machine ?? undefined, list: list.sort(cmp) }));
  const still = a.sort === "created" || a.sort === "name";
  const newest = (l: T[]) => l.reduce((n, s) => Math.max(n, s.updated), 0);
  return out.sort((x, y) => (still ? base(x.ws).localeCompare(base(y.ws)) || x.ws.localeCompare(y.ws) : a.sort === "state" ? cmp(x.list[0]!, y.list[0]!) : newest(y.list) - newest(x.list)) || x.key.localeCompare(y.key));
}

// The list while the hand is on it. `was`: the sessions the list was drawn
// from when the hand arrived, as they were then (their order comes from
// them). `now`: the sessions it would be drawn from now. `own(id)`: the owner
// acted on that session, so it is as it is now. `mine(id)`: a session that
// came is the owner's own (they made or opened it from this page), so it
// takes its place at once. The answer: `list`, to order
// by (a session still here is the one of `was`, so it sorts where it did);
// `gone`, the ones of it that left and are drawn as dimmed rows in their
// place; `late`, the ones that came and wait at the list's end.
export function held<T extends { id: string }>(was: T[], now: T[], own: (id: string) => boolean, mine: (id: string) => boolean = own): { list: T[]; gone: Set<string>; late: T[] } {
  const live = new Map(now.map((s) => [s.id, s]));
  const had = new Set(was.map((s) => s.id));
  const list: T[] = [], gone = new Set<string>(), late: T[] = [];
  for (const s of was) {
    const cur = live.get(s.id);
    if (own(s.id)) { if (cur) list.push(cur); continue; }
    list.push(s);
    if (!cur) gone.add(s.id);
  }
  for (const s of now) if (!had.has(s.id)) (own(s.id) || mine(s.id) ? list : late).push(s);
  return { list, gone, late };
}

// What the line above the list counts, and whom each count names next. A
// session that needs the owner or failed is always one press away, wherever
// its row is: the longest wait first.
export type Tally = { need: string[]; fail: string[]; work: string[]; unread: string[] };
export function tally(sessions: { id: string; created: number }[], states: Record<string, { watch: Watch; since?: number; why?: string } | undefined>, unread: Record<string, number | undefined>): Tally {
  const since = (id: string) => states[id]?.since ?? Infinity;
  const first = (a: { id: string; created: number }, b: { id: string; created: number }) => since(a.id) - since(b.id) || a.created - b.created || a.id.localeCompare(b.id);
  const of = (ws: Watch[]) => sessions.filter((s) => ws.includes(states[s.id]?.watch ?? "idle")).sort(first).map((s) => s.id);
  return {
    need: of(["need"]),
    fail: of(["fail", "declined"]),
    // Working is a turn or an agent at work: a session that only keeps a command going in the background is not counted with them.
    work: of(["work"]).filter((id) => !inBackground(states[id])),
    // Unread that says something new: what needs them or failed is counted there already.
    unread: sessions.filter((s) => (unread[s.id] ?? 0) > 0 && !["need", "fail", "declined"].includes(states[s.id]?.watch ?? "idle")).sort(first).map((s) => s.id),
  };
}

// What settles, settles around the row the hand is on: `id` keeps the place it had among `prev`
// (the keys of the list as it was last drawn), and the others take theirs around it. So a row
// the pointer rests on does not leave it because its own session, or one beside it, moved in the order.
export function around<T>(next: T[], prev: string[], id: string | null | undefined, key: (x: T) => string): T[] {
  if (!id) return next;
  const was = prev.indexOf(id), now = next.findIndex((x) => key(x) === id);
  if (was < 0 || now < 0 || was === now) return next;
  const out = next.filter((_, i) => i !== now);
  out.splice(Math.min(was, out.length), 0, next[now]!);
  return out;
}

// The pinned group is in the order of its pins' marks (`pinned_ms`, the time a session was pinned).
// A row put between two others takes a mark between theirs; put first or last, one before or after.
export function pinMark(before: number | undefined, after: number | undefined, now: number): number {
  if (before !== undefined && after !== undefined) return (before + after) / 2;
  if (before !== undefined) return Math.max(now, before + 1000);
  if (after !== undefined) return after - 1000;
  return now;
}
// The pinned sessions in their order (two pinned in one millisecond: by id).
export const pinnedOrder = <T extends { id: string; settings: { pinned_ms?: number } }>(list: T[]): T[] =>
  list.filter((s) => s.settings.pinned_ms).sort((a, b) => a.settings.pinned_ms! - b.settings.pinned_ms! || a.id.localeCompare(b.id));
// The mark that moves `id` by `by` places (-1: up, 1: down) among the pinned, or to index `to`; null when it is there already.
export function pinMove<T extends { id: string; settings: { pinned_ms?: number } }>(pinned: T[], id: string, to: number, now: number): number | null {
  const from = pinned.findIndex((s) => s.id === id);
  const at = Math.max(0, Math.min(pinned.length - 1, to));
  if (from < 0 || at === from) return null;
  const rest = pinned.filter((s) => s.id !== id);
  return pinMark(rest[at - 1]?.settings.pinned_ms, rest[at]?.settings.pinned_ms, now);
}

// The one after `last` in `ids`, around the end; the first when `last` is not among them.
export const after = (ids: string[], last: string | null): string | undefined => ids[(ids.indexOf(last ?? "") + 1) % Math.max(1, ids.length)];
