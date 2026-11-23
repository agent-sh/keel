// The page's Find in one conversation, for the part of it the page does not
// hold: the rows of the search index in that session that hold the words, and
// how many times each holds the text as typed. Runs on the read thread
// (src/server/reads.ts): one word can match most of a long history.
//
// The index finds a row by its words (search-query.ts: an English word by its
// stem's prefix); the count is of the text itself, folded as the transcript's
// Find folds it (case and accents), so a row the stem matched that does not
// hold the text is not counted. A tool call's text is its input's words (the
// tool's name, which the index keeps first, is not what its card shows).
import type { Database } from "bun:sqlite";
import { PART_BITS, SEARCH_TABLE, searchTable } from "./search-index.ts";
import { fold } from "../search-query.ts";
import { unparsed } from "./search-content.ts";

// `held`: the seqs the page holds (`from` to `to`, an end open at ±Infinity), whose rows are not read.
export type FindAsk = { session: string; match: string; needle: string; limit: number; held?: { from: number; to: number } };
// `seq`: the event's; `kind`: user, assistant (a reply's text), tool_use or tool_result;
// `ref`: a call's id (of the call, or of the call a result answers).
export type FindRow = { event_id: string; seq: number; kind: string; ref: string | null; count: number };

type Raw = { event_id: string; seq: number; kind: string; ref: string | null; text: string | null };

export function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

// No seq of a session is this far out (an open end of the part the page holds).
const FAR = Number.MAX_SAFE_INTEGER;

export function findInSession(db: Database, a: FindAsk): { rows: FindRow[]; more: boolean } {
  const T = searchTable(db);
  if (!T || !a.needle) return { rows: [], more: false };
  const from = a.held ? Math.max(a.held.from, -FAR) : FAR, to = a.held ? Math.min(a.held.to, FAR) : -FAR;
  let raw: Raw[];
  try {
    if (T === SEARCH_TABLE) {
      // Only the index rows of the session's events are read: an event's rows
      // are numbered from its row number (search-index.ts), so the session's
      // are within one range of numbers, and the rows the page holds are left
      // out before the cap counts them. FTS5 walks only the numbers in a
      // rowid range, but a word's start (`the*`) still merges what every
      // word with that start holds across the store; so a range of no more
      // rows than the cap, which is all a find returns at most, is read
      // whole instead, at a few microseconds a row. Its rows are counted
      // below as the index's are, by the text as typed, so there the text is
      // found inside a word too, as the page finds it in what it holds.
      const span = db.query<{ lo: number | null; hi: number | null }, [string]>("SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM events WHERE session_id = ?1").get(a.session);
      if (span?.lo == null || span.hi == null) return { rows: [], more: false };
      const lo = span.lo * 2 ** PART_BITS, hi = (span.hi + 1) * 2 ** PART_BITS - 1;
      const inRange = db.query<{ n: number }, [number, number, number]>("SELECT count(*) AS n FROM (SELECT 1 FROM search_rows WHERE doc BETWEEN ?1 AND ?2 LIMIT ?3)").get(lo, hi, a.limit + 1)!.n;
      raw = inRange <= a.limit
        ? db.query<Raw, [string, number, number, number, number]>(
          `SELECT t.event_id, e.seq, t.kind, t.ref, t.text FROM search_text t JOIN events e ON e.rowid = (t.doc >> ${PART_BITS})
           WHERE t.doc BETWEEN ?2 AND ?3 AND e.session_id = ?1 AND NOT (e.seq BETWEEN ?4 AND ?5) ORDER BY e.seq, t.doc`,
        ).all(a.session, lo, hi, from, to)
        : db.query<Raw, [string, string, number, number, number, number, number]>(
          `WITH hit AS MATERIALIZED (
             SELECT w.rowid AS doc, e.seq AS seq FROM ${SEARCH_TABLE} w JOIN events e ON e.rowid = (w.rowid >> ${PART_BITS})
             WHERE ${SEARCH_TABLE} MATCH ?1 AND w.rowid BETWEEN ?4 AND ?5 AND e.session_id = ?2 AND NOT (e.seq BETWEEN ?6 AND ?7)
             ORDER BY e.seq, w.rowid LIMIT ?3)
           SELECT t.event_id, h.seq, t.kind, t.ref, t.text FROM hit h CROSS JOIN search_text t ON t.doc = h.doc ORDER BY h.seq, h.doc`,
        ).all(a.match, a.session, a.limit + 1, lo, hi, from, to);
    } else {
      raw = db.query<Raw, [string, string, number, number, number]>(
        `SELECT f.event_id, e.seq, f.kind, f.ref, f.text FROM search_idx f JOIN events e ON e.id = f.event_id
         WHERE search_idx MATCH ?1 AND f.session_id = ?2 AND NOT (e.seq BETWEEN ?4 AND ?5) ORDER BY e.seq, f.rowid LIMIT ?3`,
      ).all(a.match, a.session, a.limit + 1, from, to);
    }
  } catch (e) {
    if (unparsed(e)) return { rows: [], more: false };
    throw e;
  }
  const more = raw.length > a.limit;
  const rows: FindRow[] = [];
  for (const r of raw.slice(0, a.limit)) {
    let text = r.text ?? "";
    if (r.kind === "tool_use") text = text.slice(text.indexOf(" ") + 1);
    const n = count(fold(text), a.needle);
    if (n) rows.push({ event_id: r.event_id, seq: r.seq, kind: r.kind, ref: r.ref, count: n });
  }
  return { rows, more };
}
