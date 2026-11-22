// The part of a search that reads the index: the rows that match, ranked,
// with the event each hit opens at. On a long history one word can match
// hundreds of thousands of rows, and ranking them is one SQLite call, so this
// runs on the read thread (src/server/reads.ts).
import type { Database } from "bun:sqlite";

export type ContentQuery = {
  match: string;
  // The session filter of the request: its SQL (starting with AND, or empty) and its values.
  where: string;
  args: (string | number)[];
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
};

export function searchContent(db: Database, q: ContentQuery): ContentHit[] {
  let content: ContentHit[] = [];
  try {
    // One hit per session: the best of its rows (so many matches in one session do not crowd out another).
    const inner = `SELECT f.event_id, f.session_id, f.kind, f.ts, f.ref, f.cut, snippet(search_idx, 0, char(1), char(2), '…', 14) AS snippet, bm25(search_idx) AS rank,
         s.title, s.workspace, s.archived, ${q.pid} AS parent_id
       FROM search_idx f JOIN sessions s ON s.id = f.session_id
       WHERE search_idx MATCH ? ${q.where}`;
    const order = q.newest ? "CAST(ts AS INTEGER) DESC" : "rank";
    // Made for this search and freed after it: its text carries the search's limits.
    content = q.perSession
      ? db.prepare<ContentHit, (string | number)[]>(`SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY session_id ORDER BY ${order}) AS n FROM (${inner})) WHERE n = 1 ORDER BY archived, ${order} LIMIT ?`).all(q.match, ...q.args, q.limit)
      : db.prepare<ContentHit, (string | number)[]>(`${inner} ORDER BY s.archived, ${q.newest ? "CAST(f.ts AS INTEGER) DESC" : "rank"} LIMIT ?`).all(q.match, ...q.args, q.limit);
  } catch {
    return []; // a query FTS cannot parse matches nothing
  }
  // The reply that holds a tool call (its card is where a hit on the call's output opens).
  const callEvent = db.query<{ id: string }, [string, string]>(
    "SELECT e.id FROM events e, json_each(e.data, '$.blocks') j WHERE e.session_id = ? AND e.kind = 'assistant' AND json_extract(j.value, '$.id') = ? LIMIT 1");
  return content.map((c) => (c.kind === "tool_result" && c.ref ? { ...c, event_id: callEvent.get(c.session_id, c.ref)?.id ?? c.event_id } : c));
}
