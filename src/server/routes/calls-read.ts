// The newest call of one of some tools on a session's branch whose result was
// not an error (the plan in force, for a page that holds only the branch's
// end). The route used to walk the branch back from the place asked about,
// reading every reply and result on the way: a session where no such call was
// ever made was read whole, bodies and all, where the loop waits.
//
// Here the search index says which replies hold a call by one of the names
// (every call is indexed under its name: routes/search.ts), newest first, and
// only those replies and the results after them are read. The loop places
// what comes back on the branch it keeps (a search by seq) and parses no body
// of the session for it. A first, bounded part of each read is made on the
// loop's own connection, which answers the usual asks (a tool called seldom or
// never, a result stored right after its call) in a millisecond; what is left
// of a longer one goes to the read thread.
//
// The answer is the walk's: the newest reply on the branch first, its last
// call first, a call counting when a result for it that is not an error lies
// on the branch after it and before the place asked about. (A declined reply
// is not indexed; its calls were never run, so none of them counts.)
//
// The reads import nothing of the daemon: the read thread loads them
// (read-tasks.ts).
import type { Database } from "bun:sqlite";
import { KIND_OF, PART_BITS, SEARCH_TABLE, searchTable } from "./search-index.ts";

// `below`: where the read goes on from (a place in the index, or a seq when
// the index cannot be asked), null from the newest. `max`: how many index
// rows (or replies) one read looks at.
export type NamedAsk = { session: string; names: string[]; before: number | null; below: number | null; max: number };
// A reply that holds calls by those names, its last call first.
export type NamedReply = { seq: number; event: string; calls: { id: string; name: string; input: unknown }[] };
// The replies found, newest first. `below`: where to go on from for older ones, null when there are none.
export type NamedPage = { replies: NamedReply[]; below: number | null };

const END = Number.MAX_SAFE_INTEGER;
// A name the index can look up: it holds a letter or a digit (the index's words are made of those).
const worded = (name: string) => /[\p{L}\p{N}]/u.test(name);
// Whether every name can be asked of the index (else the replies themselves are looked through, on the read thread).
export const namedByIndex = (db: Database, names: string[]) => names.every(worded) && !!searchTable(db);

type ReplyRow = { seq: number; id: string; data: string };
function callsOf(rows: ReplyRow[], wanted: string[]): NamedReply[] {
  const names = new Set(wanted);
  const replies: NamedReply[] = [];
  for (const r of rows) {
    const blocks = (JSON.parse(r.data) as { blocks?: any[] }).blocks ?? [];
    const calls: NamedReply["calls"] = [];
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k];
      if (b?.type === "tool_use" && names.has(b.name)) calls.push({ id: b.id, name: b.name, input: b.input });
    }
    if (calls.length) replies.push({ seq: r.seq, event: r.id, calls });
  }
  return replies.sort((a, b) => b.seq - a.seq);
}

// The replies of the session, older than `before`, that hold a call by one of
// the names: the next part of them, going back.
export function callsNamed(db: Database, a: NamedAsk): NamedPage {
  const before = a.before ?? END;
  if (!namedByIndex(db, a.names)) {
    // A name the index holds no word of: the replies are looked through for it as it is stored.
    const rows = db.query<ReplyRow, (string | number)[]>(
      `SELECT seq, id, data FROM events WHERE session_id = ? AND seq < ? AND kind = 'assistant' AND EXISTS (SELECT 1 FROM json_each(?) n WHERE instr(data, n.value) > 0) ORDER BY seq DESC LIMIT ?`,
    ).all(a.session, Math.min(before, a.below ?? END), JSON.stringify(a.names.map((n) => `"name":${JSON.stringify(n)}`)), a.max);
    return { replies: callsOf(rows, a.names), below: rows.length === a.max ? rows.at(-1)!.seq : null };
  }
  // A call is indexed as its name and the words of its input: the name is the
  // row's first words. The index's rows are walked newest first, every
  // session's among them: its rows of one session are in the order of that
  // session's events (a row is written with its event, and an index made
  // again is filled in the events' order).
  const match = `text : (${a.names.map((n) => `^"${n.replaceAll('"', '""')}"`).join(" OR ")})`;
  // (The index of this layout says which event a row is of by its number; the one before, while it is read, by its columns.)
  const T = searchTable(db);
  const found = db.query<{ doc: number; id: string; session: string; kind: string }, [string, number, number]>(T === SEARCH_TABLE
    ? `SELECT w.rowid AS doc, e.id AS id, e.session_id AS session, ${KIND_OF("e", `(w.rowid & ${(1 << PART_BITS) - 1})`)} AS kind
       FROM ${SEARCH_TABLE} w JOIN events e ON e.rowid = (w.rowid >> ${PART_BITS}) WHERE ${SEARCH_TABLE} MATCH ? AND w.rowid < ? ORDER BY w.rowid DESC LIMIT ?`
    : "SELECT rowid AS doc, event_id AS id, session_id AS session, kind FROM search_idx WHERE search_idx MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT ?",
  ).all(match, a.below ?? END, a.max);
  const ids = [...new Set(found.filter((f) => f.session === a.session && f.kind === "tool_use").map((f) => f.id))];
  const reply = db.query<ReplyRow, [string, string, number]>("SELECT seq, id, data FROM events WHERE id = ? AND session_id = ? AND seq < ? AND kind = 'assistant'");
  const rows = ids.map((id) => reply.get(id, a.session, before)).filter((r): r is ReplyRow => !!r);
  return { replies: callsOf(rows, a.names), below: found.length === a.max ? found.at(-1)!.doc : null };
}

// `span`: how many seqs after `after` one read looks at (null: all of them).
export type AnsweredAsk = { session: string; id: string; after: number; before: number | null; span: number | null };
// The first result for the call `id` that is not an error, among the
// session's results after `after` and before `before`: `hit`, its event.
// `more`: none in the span looked at, and where to go on from. Neither: none.
export type Answered = { hit?: { seq: number; event: string }; more?: number };
export function callAnswered(db: Database, a: AnsweredAsk): Answered {
  const before = a.before ?? END;
  const end = a.span === null ? before : Math.min(before, a.after + a.span + 1);
  const next = db.query<ReplyRow, [string, number, number, string]>(
    "SELECT seq, id, data FROM events WHERE session_id = ? AND kind = 'tool_result' AND seq > ? AND seq < ? AND instr(data, ?) > 0 ORDER BY seq LIMIT 1");
  const needle = JSON.stringify(a.id);
  for (let from = a.after; ; ) {
    const r = next.get(a.session, from, end, needle);
    if (!r) break;
    const results = (JSON.parse(r.data) as { results?: any[] }).results ?? [];
    if (results.some((x) => x?.tool_use_id === a.id && !x.is_error)) return { hit: { seq: r.seq, event: r.id } };
    from = r.seq;
  }
  if (end >= before) return {};
  // (Past the session's newest event there is nothing to go on to.)
  const last = db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE session_id = ?").get(a.session)?.n ?? 0;
  return end > last ? {} : { more: end - 1 };
}

type Line = readonly { id: string; seq: number }[];
// Whether the event with that seq and id is on the branch (its events are in seq order).
function onLine(line: Line, seq: number, id: string): boolean {
  let lo = 0, hi = line.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (line[mid]!.seq >= seq) hi = mid;
    else lo = mid + 1;
  }
  return line[lo]?.id === id;
}

// What the loop reads by itself before the read thread is asked: this many
// rows of the index, and the results within this many events of a call.
export const HERE = { rows: 256, span: 256 };
// And what one read on the thread looks at (the index's rows; its results are read to the end).
const THERE_ROWS = 50_000;

// The answer, on the loop. `db`: the loop's own connection, for the first
// bounded part of each read; `named` and `answered` ask the read thread;
// `line` gives the session's branch as it is now (asked again after a wait).
export async function lastCall(
  d: { db: Database; named: (a: NamedAsk) => Promise<NamedPage>; answered: (a: AnsweredAsk) => Promise<Answered>; line: () => Line },
  session: string, names: string[], before: number | null, here = HERE,
): Promise<{ name: string; input: unknown; seq: number } | null> {
  if (!names.length) return null;
  const answered = async (id: string, after: number): Promise<{ seq: number; event: string } | undefined> => {
    const first = callAnswered(d.db, { session, id, after, before, span: here.span });
    if (first.hit || first.more === undefined) return first.hit;
    return (await d.answered({ session, id, after: first.more, before, span: null })).hit;
  };
  let page = namedByIndex(d.db, names) ? callsNamed(d.db, { session, names, before, below: null, max: here.rows }) : await d.named({ session, names, before, below: null, max: THERE_ROWS });
  for (;;) {
    for (const reply of page.replies) {
      if (!onLine(d.line(), reply.seq, reply.event)) continue;
      for (const c of reply.calls) {
        // A result on another branch does not count: the next one for the call is asked for.
        for (let after = reply.seq; ; ) {
          const r = await answered(c.id, after);
          if (!r) break;
          if (onLine(d.line(), r.seq, r.event)) return { name: c.name, input: c.input, seq: reply.seq };
          after = r.seq;
        }
      }
    }
    if (page.below === null) return null;
    page = await d.named({ session, names, before, below: page.below, max: THERE_ROWS });
  }
}
