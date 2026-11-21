// What a machine offers of its transcripts to the daemon that asks: the list
// (never one under a credentials folder or name, titles and prompts through
// the export redactor) and a preview's last messages. The same rules whether a
// paired daemon answers (src/server/routes/imports.ts) or the helper of an ssh
// machine (src/fleet/hands-sessions.ts).
import { redact } from "../redact.ts";
import type { Found, Harness } from "./types.ts";

// `cursor`: the `next_cursor` of the page before, as it was given; none (or "0") starts the list.
export type ListQuery = { harness?: Harness; q?: string; cwd?: string; show?: string; sort?: "updated" | "size" | "title"; limit?: number; cursor?: string };

// The index keeps the answer of `offered` with each file's row (import_index.offered):
// a change of this pattern needs a new READER_V there, so every row is read again.
const CREDENTIAL = /(^|\/)(\.ssh|\.gnupg|\.aws|\.docker|\.kube|\.password-store|[^/]*(credential|secret|token|passw|\.pem$|\.key$)[^/]*)(\/|$)/i;

export const offered = (f: Found) => !CREDENTIAL.test(f.path) && !CREDENTIAL.test(f.cwd ?? "");
export const scrub = <T extends Found>(f: T): T => ({ ...f, title: redact(f.title), first_prompt: f.first_prompt && redact(f.first_prompt), last_prompt: f.last_prompt && redact(f.last_prompt) });

// ---- the order of a listing. It is total: rows that tie on what the list is
// sorted by are ordered by their path, then harness and id, so the place of a
// row never depends on the order the rows were read in.

// Strings by code point, which is how SQLite orders text (its BINARY
// collation compares UTF-8 bytes): the index and this file sort alike.
export function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    // In UTF-16 a surrogate sorts before U+E000..U+FFFF; by code point it sorts after.
    if (x >= 0xd800 && y >= 0xd800) { x += x >= 0xe000 ? -0x800 : 0x2000; y += y >= 0xe000 ? -0x800 : 0x2000; }
    return x - y;
  }
  return a.length - b.length;
}

type Key = Pick<Found, "updated_ms" | "size_bytes" | "title" | "path" | "harness" | "id">;
export const order = (sort: ListQuery["sort"] = "updated") => (a: Key, b: Key): number =>
  (sort === "size" ? b.size_bytes - a.size_bytes : sort === "title" ? a.title.localeCompare(b.title) : b.updated_ms - a.updated_ms) ||
  byCodePoint(a.path, b.path) || byCodePoint(a.harness, b.harness) || byCodePoint(a.id, b.id);

// What the search reads of a row, lower case.
export const haystack = (f: Found) => `${f.title} ${f.cwd ?? ""} ${f.first_prompt ?? ""} ${f.last_prompt ?? ""} ${f.id}`.toLowerCase();
export const wordsOf = (q?: string) => (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
// The kinds a listing shows: interactive sessions unless more are asked for; undefined is every kind.
export function kindsOf(show?: string): Found["kind"][] | undefined {
  const s = new Set((show ?? "").split(",").filter(Boolean));
  if (s.has("all")) return undefined;
  return ["interactive", ...(s.has("subagents") ? ["subagent" as const] : []), ...(s.has("headless") ? ["headless" as const] : [])];
}

// The rows a listing shows, in its order: interactive sessions unless more
// are asked for, every word of the search in the title, folder, prompts or id.
export function select(rows: Found[], q: ListQuery): Found[] {
  const words = wordsOf(q.q);
  const kinds = kindsOf(q.show);
  const out = rows.filter((f) => {
    if (q.harness && f.harness !== q.harness) return false;
    if (kinds && !kinds.includes(f.kind)) return false;
    if (q.cwd && f.cwd !== q.cwd) return false;
    if (words.length) {
      const hay = haystack(f);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  return out.sort(order(q.sort));
}

// ---- pages. A cursor names the last row a page gave, not a count of rows:
// the next page is what sorts after that row in the list as it is then, so a
// row that arrives or leaves meanwhile never moves another row past a page
// boundary. It also carries what the pages so far gave (how many rows, and
// the sum of their keys' hashes): when the rows up to the cursor are no longer
// those (one arrived, left, or moved across it), the page says `changed`, and
// a reader that needs every row starts again from the top.

// A string as a number (FNV-1a over its UTF-16 units), and a row's key as one.
function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
export const keyHash = (f: Pick<Found, "path" | "harness" | "id">): number => hashOf(`${f.path}\u0000${f.harness}\u0000${f.id}`);

export type Cursor = { sort: NonNullable<ListQuery["sort"]>; row: Key; seen: number; sum: number };
export class CursorError extends Error { status = 400; }

// Which listing a cursor belongs to: the filters and the order, not the page size.
const listingOf = (q: ListQuery, scope: string) => hashOf(JSON.stringify([q.harness ?? "", wordsOf(q.q), q.cwd ?? "", kindsOf(q.show) ?? "all", q.sort ?? "updated", scope]));

export const cursorGiven = (c?: string | null): string | undefined => (c && c !== "0" ? c : undefined);

// `scope`: what else narrows the list besides the query (the rows a machine offers).
export function readCursor(q: ListQuery, scope = ""): Cursor | undefined {
  const given = cursorGiven(q.cursor);
  if (!given) return undefined;
  let c: any;
  try { c = JSON.parse(Buffer.from(given, "base64url").toString()); } catch {}
  if (!Array.isArray(c) || c[0] !== 1 || typeof c[3] !== "string") throw new CursorError("the cursor is not one this list gave: start again without it");
  const sort = q.sort ?? "updated";
  if (c[1] !== listingOf(q, scope)) throw new CursorError("the cursor is of another listing (another search, filter or order): start again without it");
  const v = c[2];
  return { sort, row: { updated_ms: sort === "updated" ? v : 0, size_bytes: sort === "size" ? v : 0, title: sort === "title" ? v : "", path: c[3], harness: c[4], id: c[5] }, seen: c[6], sum: c[7] };
}

export function writeCursor(q: ListQuery, last: Key, seen: number, sum: number, scope = ""): string {
  const sort = q.sort ?? "updated";
  return Buffer.from(JSON.stringify([1, listingOf(q, scope), sort === "size" ? last.size_bytes : sort === "title" ? last.title : last.updated_ms, last.path, last.harness, last.id, seen, sum])).toString("base64url");
}

export const pageLimit = (q: ListQuery, max = 500) => Math.min(Math.max(Math.floor(q.limit ?? 50) || 50, 1), max);

export type Page<T extends Found = Found> = { sessions: T[]; total: number; next_cursor?: string; changed?: true };

// One page of the rows a listing shows.
export function page(rows: Found[], q: ListQuery, o: { max?: number; scope?: string } = {}): Page {
  const sorted = select(rows, q);
  const limit = pageLimit(q, o.max);
  const c = readCursor(q, o.scope);
  const cmp = order(q.sort);
  let at = 0;
  if (c) {
    // The first row after the cursor's.
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cmp(sorted[mid]!, c.row) > 0) hi = mid; else lo = mid + 1; }
    at = lo;
  }
  let sum = 0;
  for (let i = 0; i < at; i++) sum += keyHash(sorted[i]!);
  const changed = !!c && (at !== c.seen || sum !== c.sum);
  const sessions = sorted.slice(at, at + limit);
  for (const f of sessions) sum += keyHash(f);
  const more = at + sessions.length < sorted.length;
  return { sessions, total: sorted.length, ...(more ? { next_cursor: writeCursor(q, sessions.at(-1)!, at + sessions.length, sum, o.scope) } : {}), ...(changed ? { changed: true as const } : {}) };
}

// The newest messages of a read, for a preview.
export function tail(events: { kind: string; data: any }[], n = 6) {
  const out: { role: string; text: string }[] = [];
  for (const e of events) {
    if (e.kind === "user") out.push({ role: "user", text: e.data.text });
    else if (e.kind === "assistant") {
      const t = (e.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      if (t) out.push({ role: "assistant", text: t });
    }
  }
  return out.slice(-n).map((m) => ({ ...m, text: m.text.length > 1200 ? m.text.slice(0, 1199) + "…" : m.text }));
}
