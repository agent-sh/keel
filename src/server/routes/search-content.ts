// The part of a search that reads the index: the rows that match, ranked,
// with the event each hit opens at. On a long history one word can match
// hundreds of thousands of rows, and ranking them is one SQLite call, so this
// runs on the read thread (src/server/reads.ts).
import type { Database } from "bun:sqlite";
import { KIND_OF, PART_BITS, SEARCH_TABLE, searchTable } from "./search-index.ts";
import { SHELL_TOOLS } from "../search-query.ts";

export type ContentQuery = {
  // The words to match (FTS5), or null for a search of limits alone: every row they allow, newest first.
  match: string | null;
  // The words of `match` one by one (FTS5 terms): when the rows that hold every word are fewer
  // than the limit, the ones that hold fewer of them follow, the most words first.
  terms?: string[];
  // The session filter of the request: its SQL (starting with AND, or empty, over `s`, the sessions table) and its values.
  where: string;
  args: (string | number)[];
  // What limits the rows themselves: their kinds, a shell tool's calls only, their time.
  rows?: { kinds?: string[]; commands?: boolean; since?: number; until?: number };
  limit: number;
  perSession: boolean;
  // The sessions column that names a subagent's parent, or NULL when there is none.
  pid: string;
  // The newest hits first (a question about when), not the best match first.
  newest?: boolean;
};
export type ContentHit = {
  event_id: string; session_id: string; kind: string; ts: number; ref: string | null; cut: number; snippet: string;
  title: string; workspace: string; archived: number; parent_id: string | null;
  missing?: number[]; // the terms (by place) a hit of fewer than every word does not hold
};

// The groups of k of n words a tier of the ranking matches are written out in its query (FTS5 has
// no "at least k of"). A tier with more groups than this is not searched: with eight words, those
// that hold at least six (28 groups) are, the ones that hold four are not (70).
const MOST_GROUPS = 40;
function groups(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick = (from: number, got: number[]) => {
    if (out.length > MOST_GROUPS) return;
    if (got.length === k) { out.push(got); return; }
    for (let i = from; i <= n - (k - got.length); i++) pick(i + 1, [...got, i]);
  };
  pick(0, []);
  return out;
}

// The limits of the rows as SQL over `f` (a row: kind, ts, and `call`, what a call's text starts with).
function rowsWhere(q: ContentQuery, call: string): { sql: string; args: (string | number)[] } {
  const r = q.rows ?? {};
  const sql: string[] = [];
  const args: (string | number)[] = [];
  if (r.kinds) { sql.push("f.kind IN (SELECT value FROM json_each(?))"); args.push(JSON.stringify(r.kinds)); }
  if (r.commands) { sql.push(`(${SHELL_TOOLS.map(() => `${call} LIKE ?`).join(" OR ")})`); args.push(...SHELL_TOOLS.map((t) => `${t} %`)); }
  if (r.since !== undefined) { sql.push("CAST(f.ts AS INTEGER) >= ?"); args.push(r.since); }
  if (r.until !== undefined) { sql.push("CAST(f.ts AS INTEGER) < ?"); args.push(r.until); }
  return { sql: sql.map((s) => ` AND ${s}`).join(""), args };
}

// FTS5's own words for a query it cannot parse.
export const unparsed = (e: unknown) => /^(fts5: syntax error|unterminated string)/.test(String((e as Error)?.message ?? ""));

export function searchContent(db: Database, q: ContentQuery): ContentHit[] {
  const T = searchTable(db);
  if (!T) return [];
  let content: ContentHit[];
  try {
    content = q.match === null ? (T === SEARCH_TABLE ? listed(db, q) : listedOld(db, q)) : tiered(db, T, q as ContentQuery & { match: string });
  } catch (e) {
    // A query FTS cannot parse matches nothing (a word of control characters); anything else is a
    // failure of the search, said as one (the page offers Retry) and kept in Errors.
    if (unparsed(e)) return [];
    throw e;
  }
  // The reply that holds a tool call (its card is where a hit on the call's output opens).
  const callEvent = db.query<{ id: string }, [string, string]>(
    "SELECT e.id FROM events e, json_each(e.data, '$.blocks') j WHERE e.session_id = ? AND e.kind = 'assistant' AND json_extract(j.value, '$.id') = ? LIMIT 1");
  return content.map(({ doc: _d, n: _n, ...c }: ContentHit & { doc?: number; n?: number }) => (c.kind === "tool_result" && c.ref ? { ...c, event_id: callEvent.get(c.session_id, c.ref)?.id ?? c.event_id } : c));
}

// The rows that hold every word, ranked; when they are fewer than the limit, the rows that hold
// all words but one, then two, each tier ranked in itself, and each hit of a lower tier names the
// words it lacks. One word is one tier. (A row of a lower tier holds the words of some group of
// it, so the tiers are read from the most words down and a row already listed is not listed again.)
function tiered(db: Database, T: string, q: ContentQuery & { match: string }): (ContentHit & { doc?: number })[] {
  const run = (match: string, limit: number) => (T === SEARCH_TABLE ? ranked(db, { ...q, match, limit }) : rankedOld(db, { ...q, match, limit }));
  const out = run(q.match, q.limit);
  const terms = q.terms ?? [];
  const n = terms.length;
  if (n < 2) return out;
  const key = (h: ContentHit) => (q.perSession ? h.session_id : `${h.event_id}|${h.kind}|${h.ref ?? ""}`);
  const seen = new Set(out.map(key));
  const lower: (ContentHit & { doc: number })[] = [];
  for (let k = n - 1; k >= 1 && out.length + lower.length < q.limit; k--) {
    const g = groups(n, k);
    if (g.length > MOST_GROUPS) break;
    const match = g.map((ix) => `(${ix.map((i) => terms[i]).join(" AND ")})`).join(" OR ");
    // The rows of the tiers above are among these too: asked for with room for them.
    for (const h of run(match, q.limit + seen.size) as (ContentHit & { doc: number })[]) {
      if (out.length + lower.length >= q.limit) break;
      if (seen.has(key(h))) continue;
      seen.add(key(h));
      lower.push(h);
    }
  }
  if (!lower.length) return out;
  // Which words each row holds: each word matched once over the rows kept (a look-up of each by its number).
  const docs = JSON.stringify(lower.map((h) => h.doc));
  const has = terms.map((t) => new Set(db.query<{ doc: number }, [string, string]>(
    `WITH top AS MATERIALIZED (SELECT value AS doc FROM json_each(?2)) SELECT w.rowid AS doc FROM ${T} w CROSS JOIN top ON top.doc = w.rowid WHERE ${T} MATCH ?1`,
  ).all(t, docs).map((r) => r.doc)));
  return [...out, ...lower.map((h) => ({ ...h, missing: terms.map((_, i) => i).filter((i) => !has[i]!.has(h.doc)) }))];
}

// The rows are ranked and cut from what the index and the events' own columns
// say (each match is one look-up of its event by row number), and only the
// hits kept read their text, for the snippet and what a hit says of its call:
// a row's text is read from its event's body.
function ranked(db: Database, q: ContentQuery & { match: string }): (ContentHit & { doc: number })[] {
  const P = `(w.rowid & ${(1 << PART_BITS) - 1})`;
  // A row of the index as the filters and the ranking see it.
  const f = `SELECT w.rowid AS doc, e.id AS event_id, e.session_id AS session_id, ${KIND_OF("e", P)} AS kind, e.ts AS ts, bm25(${SEARCH_TABLE}) AS rank,
      CASE WHEN e.kind = 'assistant' AND ${P} > 0 THEN json_extract(e.data, '$.blocks[' || (${P} - 1) || '].name') || ' ' END AS call
    FROM ${SEARCH_TABLE} w JOIN events e ON e.rowid = (w.rowid >> ${PART_BITS}) WHERE ${SEARCH_TABLE} MATCH ?1`;
  const rows = rowsWhere(q, "f.call");
  const inner = `SELECT f.doc, f.event_id, f.session_id, f.kind, f.ts, f.rank, s.title, s.workspace, s.archived, ${q.pid} AS parent_id
    FROM (${f}) f JOIN sessions s ON s.id = f.session_id WHERE 1 ${q.where}${rows.sql}`;
  const order = q.newest ? "CAST(ts AS INTEGER) DESC" : "rank";
  // One hit per session: the best of its rows (so many matches in one session do not crowd out another).
  const top = q.perSession
    ? `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY session_id ORDER BY ${order}) AS n FROM (${inner})) WHERE n = 1 ORDER BY archived, ${order} LIMIT ?`
    : `${inner} ORDER BY archived, ${order} LIMIT ?`;
  // Made for this search and freed after it: its text carries the search's limits.
  const hits = db.prepare<Omit<ContentHit, "ref" | "cut" | "snippet"> & { doc: number }, (string | number)[]>(top).all(q.match, ...q.args, ...rows.args, q.limit);
  if (!hits.length) return [];
  // The index is read once more for the hits kept (one pass over the matches, not a search per hit),
  // and their snippets and what they say of a call are made from their text.
  const told = new Map(db.query<{ doc: number; ref: string | null; cut: number; snippet: string }, [string, string]>(
    `WITH top AS MATERIALIZED (SELECT value AS doc FROM json_each(?2))
     SELECT w.rowid AS doc, w.ref, w.cut, snippet(${SEARCH_TABLE}, 0, char(1), char(2), '…', 14) AS snippet
     FROM ${SEARCH_TABLE} w CROSS JOIN top ON top.doc = w.rowid WHERE ${SEARCH_TABLE} MATCH ?1`,
  ).all(q.match, JSON.stringify(hits.map((h) => h.doc))).map((t) => [t.doc, t] as const));
  return hits.map((h) => ({ ...h, ref: told.get(h.doc)?.ref ?? null, cut: told.get(h.doc)?.cut ?? 0, snippet: told.get(h.doc)?.snippet ?? "" }));
}

// The index of the layout before (search_idx), read while the new one is filled: its rows hold their own text.
function rankedOld(db: Database, q: ContentQuery & { match: string }): (ContentHit & { doc: number })[] {
  const rows = rowsWhere(q, "f.text");
  const inner = `SELECT f.rowid AS doc, f.event_id, f.session_id, f.kind, f.ts, f.ref, f.cut, snippet(search_idx, 0, char(1), char(2), '…', 14) AS snippet, bm25(search_idx) AS rank,
       s.title, s.workspace, s.archived, ${q.pid} AS parent_id
     FROM search_idx f JOIN sessions s ON s.id = f.session_id
     WHERE search_idx MATCH ? ${q.where}${rows.sql}`;
  const order = q.newest ? "CAST(ts AS INTEGER) DESC" : "rank";
  return q.perSession
    ? db.prepare<ContentHit & { doc: number }, (string | number)[]>(`SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY session_id ORDER BY ${order}) AS n FROM (${inner})) WHERE n = 1 ORDER BY archived, ${order} LIMIT ?`).all(q.match, ...q.args, ...rows.args, q.limit)
    : db.prepare<ContentHit & { doc: number }, (string | number)[]>(`${inner} ORDER BY s.archived, ${q.newest ? "CAST(f.ts AS INTEGER) DESC" : "rank"} LIMIT ?`).all(q.match, ...q.args, ...rows.args, q.limit);
}

// How much of a row's text a hit of limits alone shows: there is no match to cut a snippet around.
const START = 160;

// A search of limits alone (in:commands, on:today, a state with a kind): the rows of the index the
// limits allow, newest first. No word, so no MATCH and no rank: the rows are read from the index's
// row list and their events' own columns, then the hits kept read the start of their text, their
// call and whether they were cut from the content view.
function listed(db: Database, q: ContentQuery): ContentHit[] {
  const P = `(d.doc & ${(1 << PART_BITS) - 1})`;
  const f = `SELECT d.doc AS doc, e.id AS event_id, e.session_id AS session_id, ${KIND_OF("e", P)} AS kind, e.ts AS ts,
      CASE WHEN e.kind = 'assistant' AND ${P} > 0 THEN json_extract(e.data, '$.blocks[' || (${P} - 1) || '].name') || ' ' END AS call
    FROM search_rows d JOIN events e ON e.rowid = (d.doc >> ${PART_BITS})`;
  const rows = rowsWhere(q, "f.call");
  const inner = `SELECT f.doc, f.event_id, f.session_id, f.kind, f.ts, s.title, s.workspace, s.archived, ${q.pid} AS parent_id
    FROM (${f}) f JOIN sessions s ON s.id = f.session_id WHERE 1 ${q.where}${rows.sql}`;
  // (Rows of one time in the order they were stored, the later first.)
  const order = "CAST(ts AS INTEGER) DESC, doc DESC";
  const top = q.perSession
    ? `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY session_id ORDER BY ${order}) AS n FROM (${inner})) WHERE n = 1 ORDER BY archived, ${order} LIMIT ?`
    : `${inner} ORDER BY archived, ${order} LIMIT ?`;
  const hits = db.prepare<Omit<ContentHit, "ref" | "cut" | "snippet"> & { doc: number }, (string | number)[]>(top).all(...q.args, ...rows.args, q.limit);
  if (!hits.length) return [];
  const told = new Map(db.query<{ doc: number; ref: string | null; cut: number; snippet: string }, [string]>(
    `WITH top AS MATERIALIZED (SELECT value AS doc FROM json_each(?1))
     SELECT t.doc, t.ref, t.cut, substr(t.text, 1, ${START}) AS snippet FROM top CROSS JOIN search_text t ON t.doc = top.doc`,
  ).all(JSON.stringify(hits.map((h) => h.doc))).map((t) => [t.doc, t] as const));
  return hits.map(({ doc, ...h }) => ({ ...h, ref: told.get(doc)?.ref ?? null, cut: told.get(doc)?.cut ?? 0, snippet: told.get(doc)?.snippet ?? "" }));
}

// The same over the layout before, while the new one is filled: its rows hold their own text.
function listedOld(db: Database, q: ContentQuery): ContentHit[] {
  const rows = rowsWhere(q, "f.text");
  const inner = `SELECT f.rowid AS doc, f.event_id, f.session_id, f.kind, f.ts, f.ref, f.cut, substr(f.text, 1, ${START}) AS snippet,
       s.title, s.workspace, s.archived, ${q.pid} AS parent_id
     FROM search_idx f JOIN sessions s ON s.id = f.session_id WHERE 1 ${q.where}${rows.sql}`;
  const order = "CAST(ts AS INTEGER) DESC, doc DESC";
  const out = q.perSession
    ? db.prepare<ContentHit & { doc?: number; n?: number }, (string | number)[]>(`SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY session_id ORDER BY ${order}) AS n FROM (${inner})) WHERE n = 1 ORDER BY archived, ${order} LIMIT ?`).all(...q.args, ...rows.args, q.limit)
    : db.prepare<ContentHit & { doc?: number }, (string | number)[]>(`SELECT * FROM (${inner}) ORDER BY archived, ${order} LIMIT ?`).all(...q.args, ...rows.args, q.limit);
  return out.map(({ doc: _d, n: _n, ...h }: ContentHit & { doc?: number; n?: number }) => h);
}
