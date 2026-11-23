// The search index: what was said and done, in FTS5, without a second copy
// of it. The index holds the words and their places; the text a snippet or a
// column is read from is the events' own, through a view (an external
// content table, sqlite.org/fts5.html section 4.4.3). Events are never
// changed once stored, so what the view gives for a row is what was indexed.
//
// A row of the index is numbered from its event's row number in the events
// table and its part: `doc = rowid << PART_BITS | part`. Part 0 is a prompt,
// a reply's text or a summary; the reply's block k, when it is a tool call,
// is part k + 1; a tool result's entry k is part k. `search_rows` holds the
// numbers that are indexed (and whether the row's text was cut), so the view
// finds a row's event by its row number, and an event's rows are one range of
// numbers. (Row numbers of the events table are kept by VACUUM and VACUUM
// INTO, which is what a backup's copy is made with.)
//
// The rows of an event are written beside it, not in its commit: they wait
// with the other side rows (src/core/side.ts) and are written before
// anything reads the index. `upto` in search_meta is the last event whose
// rows are written, so a start after a kill writes the ones that waited.
// Removing an event's rows is a trigger of the database, run before the
// event is gone (its text is what the index is told to remove).
//
// An index of an earlier layout (one that kept a copy of every row's text)
// is replaced once, on a thread (search-fill-worker.ts), once the start's own
// work is over: the new index is filled from the events, newest first, while
// searches still read the old one, which is kept current meanwhile; then the
// old one is removed in steps and its tables dropped. A store with no index
// of its own is filled the same way, and searches read the part that is filled.
import type { Database } from "bun:sqlite";
import type { Store } from "../../core/store.ts";

// How much of one tool call's input or output is indexed (the rest is not
// searched; a hit on a cut one says so).
export const TOOL_EXCERPT = 4000;
const L = TOOL_EXCERPT;
// Parts of one event: a reply with more blocks, or a result with more entries, has the rest unindexed.
export const PART_BITS = 8;
const PARTS = 1 << PART_BITS;

// Bumped when what is indexed changes: the index is made again from the events once. The same
// bump is the repair of an index that is wrong: FTS5's 'rebuild' and its integrity-check against
// the content read the view through statements of their own, which cannot take its json_each and
// json_tree, so both fail on this index; never run 'rebuild' on it. (search.test.ts checks the
// index word by word against a plain FTS5 table made from the view's text.)
export const INDEX_VERSION = 5;

// A declined reply is discarded (the transcript hides its partial text), so it is not found either.
const KEPT = "coalesce(json_extract(e.data, '$.stop'), '') != 'refusal'";

// The words of each kind of row, from its event `e` and its part `p` (an SQL
// expression). The fill and the view use the same text, so a row's words are
// always the ones it was indexed with.
// A prompt: its words (not the placeholder of an attachment-only prompt) and its files' names.
const PROMPT = `trim(CASE WHEN json_extract(e.data, '$.text') IN ('(image)', '(attached file)') THEN '' ELSE coalesce(json_extract(e.data, '$.text'), '') END
  || ' ' || coalesce((SELECT group_concat(json_extract(value, '$.name'), ' ') FROM json_each(e.data, '$.images') WHERE json_extract(value, '$.type') = 'attachment'), ''))`;
const REPLY = `(SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(e.data, '$.blocks') WHERE json_extract(value, '$.type') = 'text')`;
// A tool call: its name and the words of its input (`Bash echo done`, not `{"command":"echo done"}`).
const callAt = (p: string) => `'$.blocks[' || (${p} - 1) || ']'`;
const CALL = (p: string) => `(json_extract(e.data, ${callAt(p)} || '.name') || ' ' || coalesce((SELECT group_concat(v.value, ' ') FROM json_tree(e.data, ${callAt(p)} || '.input') v WHERE v.type = 'text'), ''))`;
// What a tool gave back (text only; images are not words).
const resultAt = (p: string) => `'$.results[' || ${p} || ']'`;
const RESULT = (p: string) => `(CASE json_type(e.data, ${resultAt(p)} || '.content') WHEN 'text' THEN json_extract(e.data, ${resultAt(p)} || '.content')
  ELSE (SELECT group_concat(json_extract(c.value, '$.text'), char(10)) FROM json_each(e.data, ${resultAt(p)} || '.content') c WHERE json_extract(c.value, '$.type') = 'text') END)`;
// A summary (a compaction checkpoint, or one written from a prompt on).
const SUMMARY = "json_extract(e.data, '$.summary')";

// What a hit says it is, from its event `e` and its part `p`.
export const KIND_OF = (e: string, p: string) =>
  `CASE ${e}.kind WHEN 'assistant' THEN CASE WHEN ${p} = 0 THEN 'assistant' ELSE 'tool_use' END WHEN 'user' THEN 'user' WHEN 'tool_result' THEN 'tool_result' ELSE 'summary' END`;
const DOC = (p: string) => `((e.rowid << ${PART_BITS}) + ${p})`;
// A row not written yet (an event's rows are written once, whichever writes them first).
const NEW = (p: string) => `NOT EXISTS (SELECT 1 FROM search_rows r WHERE r.doc = ${DOC(p)})`;
// One SELECT per kind of row over `SRC` (events `e`, filtered by its WHERE): doc, text, cut.
const ROWS = (SRC: string, AND: string) => [
  `SELECT ${DOC("0")}, ${PROMPT}, 0 FROM ${SRC} WHERE e.kind = 'user' ${AND} AND ${NEW("0")} AND ${PROMPT} != ''`,
  `SELECT ${DOC("0")}, ${REPLY}, 0 FROM ${SRC} WHERE e.kind = 'assistant' AND ${KEPT} ${AND} AND ${NEW("0")} AND coalesce(${REPLY}, '') != ''`,
  `SELECT ${DOC("j.key + 1")}, substr(${CALL("(j.key + 1)")}, 1, ${L}), length(${CALL("(j.key + 1)")}) > ${L} FROM ${SRC}, json_each(e.data, '$.blocks') j
     WHERE e.kind = 'assistant' AND ${KEPT} ${AND} AND json_extract(j.value, '$.type') = 'tool_use' AND j.key < ${PARTS - 1} AND ${NEW("j.key + 1")}`,
  `SELECT ${DOC("j.key")}, substr(${RESULT("j.key")}, 1, ${L}), length(${RESULT("j.key")}) > ${L} FROM ${SRC}, json_each(e.data, '$.results') j
     WHERE e.kind = 'tool_result' ${AND} AND j.key < ${PARTS} AND ${NEW("j.key")} AND coalesce(${RESULT("j.key")}, '') != ''`,
  `SELECT ${DOC("0")}, ${SUMMARY}, 0 FROM ${SRC} WHERE e.kind IN ('compaction', 'note') ${AND} AND ${NEW("0")} AND coalesce(${SUMMARY}, '') != ''`,
];
const KINDS = "('user', 'assistant', 'tool_result', 'compaction', 'note')";
// Which of ROWS an event of each kind can have.
const ROWS_OF: Record<string, number[]> = { user: [0], assistant: [1, 2], tool_result: [3], compaction: [4], note: [4] };
const ADD = "INSERT INTO search_add (doc, text, cut)";
// The rows of one event, by its row number.
const ONE = ROWS("events e", "AND e.rowid = ?1").map((r) => `${ADD} ${r}`);
// The rows of the events in a range of row numbers that have none yet (the fill).
const RANGE = ROWS("events e", "AND e.rowid BETWEEN ?1 AND ?2").map((r) => `${ADD} ${r}`);
// (For the test of their plans: each reads the events it names by row number.)
export const WRITES = { ONE, RANGE };

// The view a row's columns are read from: the text as it was indexed, and what a hit says of it.
const P = `(d.doc & ${PARTS - 1})`;
const VIEW = `
CREATE VIEW search_text AS SELECT d.doc AS doc,
  CASE e.kind WHEN 'user' THEN ${PROMPT}
    WHEN 'assistant' THEN CASE WHEN ${P} = 0 THEN ${REPLY} ELSE substr(${CALL(P)}, 1, ${L}) END
    WHEN 'tool_result' THEN substr(${RESULT(P)}, 1, ${L})
    ELSE ${SUMMARY} END AS text,
  e.id AS event_id, e.session_id AS session_id,
  ${KIND_OF("e", P)} AS kind,
  e.ts AS ts,
  CASE e.kind WHEN 'assistant' THEN CASE WHEN ${P} = 0 THEN NULL ELSE json_extract(e.data, ${callAt(P)} || '.id') END
    WHEN 'tool_result' THEN json_extract(e.data, ${resultAt(P)} || '.tool_use_id') END AS ref,
  d.cut AS cut
FROM search_rows d JOIN events e ON e.rowid = (d.doc >> ${PART_BITS});`;

// The greatest row number of the events table (the newest event's, but for one stored after the newest was deleted).
const LAST_EVENT = "(SELECT COALESCE(MAX(rowid), 0) FROM events)";
const RANGE_OF = (r: string) => `BETWEEN ${r} << ${PART_BITS} AND (${r} << ${PART_BITS}) + ${PARTS - 1}`;
const SCHEMA = `
CREATE TABLE search_rows (doc INTEGER PRIMARY KEY, cut INTEGER NOT NULL DEFAULT 0);
${VIEW}
CREATE VIRTUAL TABLE search_words USING fts5(text, event_id UNINDEXED, session_id UNINDEXED, kind UNINDEXED, ts UNINDEXED, ref UNINDEXED, cut UNINDEXED,
  content = 'search_text', content_rowid = 'doc', tokenize = 'unicode61 remove_diacritics 2');
CREATE VIEW search_add AS SELECT NULL AS doc, NULL AS text, NULL AS cut;
CREATE TRIGGER search_add_ins INSTEAD OF INSERT ON search_add BEGIN
  INSERT INTO search_rows (doc, cut) VALUES (NEW.doc, NEW.cut);
  INSERT INTO search_words (rowid, text) VALUES (NEW.doc, NEW.text);
END;
CREATE TRIGGER search_rows_del BEFORE DELETE ON events WHEN OLD.kind IN ${KINDS} BEGIN
  INSERT INTO search_words (search_words, rowid, text) SELECT 'delete', doc, text FROM search_text WHERE doc ${RANGE_OF("OLD.rowid")};
  DELETE FROM search_rows WHERE doc ${RANGE_OF("OLD.rowid")};
END;
`;
const OBJECTS = ["search_rows", "search_text", "search_words", "search_add", "search_add_ins", "search_rows_del"];

// The layout before this one (version 4): a copy of each row's text in the
// index, mapped to its event by `search_docs`. Kept current while the new
// index is filled, and read until it is whole.
const OLD_VERSION = 4;
const OLD_OBJECTS = ["search_idx", "search_docs", "search_in", "search_in_ins", "search_docs_del", "search_idx_del"];
// Whatever any earlier layout made, but the old index's tables (dropped by the fill thread once the new one is whole).
const OLD_LAYOUT = `
DROP TRIGGER IF EXISTS search_fts_ins;
DROP TRIGGER IF EXISTS search_fts_del;
DROP TABLE IF EXISTS search_fts;
DROP TRIGGER IF EXISTS search_idx_ins;
DROP TRIGGER IF EXISTS search_idx_del;
DROP TRIGGER IF EXISTS search_in_ins;
DROP TRIGGER IF EXISTS search_docs_del;
DROP VIEW IF EXISTS search_in;
`;
const OLD_COLS = "INSERT INTO search_in (text, event_id, session_id, kind, ts, ref, cut)";
const OLD_KEPT = KEPT;
const OLD_ROWS = [
  `SELECT x.t, x.id, x.session_id, 'user', x.ts, NULL, 0 FROM (SELECT e.id, e.session_id, e.ts, ${PROMPT} AS t FROM events e WHERE e.rowid = ?1 AND e.kind = 'user') x WHERE x.t != ''`,
  `SELECT x.t, x.id, x.session_id, 'assistant', x.ts, NULL, 0 FROM (SELECT e.id, e.session_id, e.ts, ${REPLY} AS t FROM events e WHERE e.rowid = ?1 AND e.kind = 'assistant' AND ${OLD_KEPT}) x WHERE x.t IS NOT NULL AND x.t != ''`,
  `SELECT substr(x.t, 1, ${L}), x.id, x.session_id, 'tool_use', x.ts, x.ref, length(x.t) > ${L} FROM (SELECT e.id, e.session_id, e.ts, json_extract(j.value, '$.id') AS ref,
     json_extract(j.value, '$.name') || ' ' || coalesce((SELECT group_concat(v.value, ' ') FROM json_tree(j.value, '$.input') v WHERE v.type = 'text'), '') AS t
   FROM events e, json_each(e.data, '$.blocks') j WHERE e.rowid = ?1 AND e.kind = 'assistant' AND ${OLD_KEPT} AND json_extract(j.value, '$.type') = 'tool_use') x`,
  `SELECT substr(x.t, 1, ${L}), x.id, x.session_id, 'tool_result', x.ts, x.ref, length(x.t) > ${L} FROM (SELECT e.id, e.session_id, e.ts, json_extract(j.value, '$.tool_use_id') AS ref,
     CASE json_type(j.value, '$.content') WHEN 'text' THEN json_extract(j.value, '$.content')
       ELSE (SELECT group_concat(json_extract(c.value, '$.text'), char(10)) FROM json_each(j.value, '$.content') c WHERE json_extract(c.value, '$.type') = 'text') END AS t
   FROM events e, json_each(e.data, '$.results') j WHERE e.rowid = ?1 AND e.kind = 'tool_result') x WHERE x.t IS NOT NULL AND x.t != ''`,
  `SELECT json_extract(e.data, '$.summary'), e.id, e.session_id, 'summary', e.ts, NULL, 0 FROM events e
   WHERE e.rowid = ?1 AND e.kind IN ('compaction', 'note') AND json_extract(e.data, '$.summary') IS NOT NULL AND json_extract(e.data, '$.summary') != ''`,
].map((r) => `${OLD_COLS} ${r}`);

// The rows of one event in the old index, unless it has them.
export function writeOld(db: Database, rowid: number, kind: string) {
  if (db.query("SELECT 1 FROM search_docs d JOIN events e ON e.id = d.event_id WHERE e.rowid = ?").get(rowid)) return;
  for (const i of ROWS_OF[kind] ?? []) db.query(OLD_ROWS[i]!).run(rowid);
}

const has = (db: Database, names: string[]) =>
  new Set(db.query<{ name: string }, string[]>(`SELECT name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(", ")})`).all(...names).map((r) => r.name));
type Meta = { version: number; upto: number | null; fill_below: number | null; reads_old: number };
export function searchMeta(db: Database): Meta | undefined {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'search_meta'").get()) return undefined;
  const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(search_meta)").all().map((c) => c.name));
  if (!cols.has("fill_below")) return undefined;
  return db.query<Meta, []>("SELECT version, upto, fill_below, reads_old FROM search_meta").get() ?? undefined;
}

// The table a search reads: the old index while the new one is filled, if it is kept; else this one.
export const SEARCH_TABLE = "search_words";
export function searchTable(db: Database): string | null {
  const m = searchMeta(db);
  if (!m) return db.query("SELECT 1 FROM sqlite_master WHERE name = 'search_idx'").get() ? "search_idx" : null;
  return m.reads_old ? "search_idx" : SEARCH_TABLE;
}

// What a start finds and leaves to the fill thread.
export type IndexState = { fill: boolean; drain: boolean };

// The index and what keeps it current, made or brought to this version in one
// short transaction with what it records. The recorded version is the whole
// answer of a later start: the index is there, and nothing in it is read or
// counted. What is left to fill is the fill thread's (search-fill.ts).
export function initSearchIndex(db: Database): IndexState {
  const meta = searchMeta(db);
  const found = has(db, [...OBJECTS, ...OLD_OBJECTS]);
  const mine = OBJECTS.every((o) => found.has(o));
  if (meta?.version === INDEX_VERSION && mine) {
    return { fill: meta.fill_below !== null, drain: meta.fill_below === null && found.has("search_idx") };
  }
  // The old index is read on while the new one fills when it is whole: its version's, with every object.
  const oldVersion = db.query("SELECT 1 FROM sqlite_master WHERE name = 'search_meta'").get()
    ? db.query<{ version: number }, []>("SELECT version FROM search_meta").get()?.version
    : undefined;
  const oldWhole = oldVersion === OLD_VERSION && OLD_OBJECTS.every((o) => found.has(o));
  const oldUpto = oldWhole && db.query<{ name: string }, []>("PRAGMA table_info(search_meta)").all().some((c) => c.name === "upto")
    ? db.query<{ upto: number | null }, []>("SELECT upto FROM search_meta").get()?.upto ?? null
    : null;
  db.transaction(() => {
    if (!oldWhole) db.exec(OLD_LAYOUT);
    // (A trigger of an older build that wrote an event's rows in its commit.)
    else db.exec("DROP TRIGGER IF EXISTS search_idx_ins");
    for (const o of ["search_rows_del", "search_add_ins"]) db.exec(`DROP TRIGGER IF EXISTS ${o}`);
    db.exec("DROP VIEW IF EXISTS search_add; DROP TABLE IF EXISTS search_words; DROP VIEW IF EXISTS search_text; DROP TABLE IF EXISTS search_rows; DROP TABLE IF EXISTS search_meta;");
    db.exec(SCHEMA);
    // Every event stored so far is the fill's (below `fill_below`); the old index, when kept, has its rows up to `upto`.
    const last = db.query<{ n: number }, []>(`SELECT ${LAST_EVENT} AS n`).get()!.n;
    db.exec("CREATE TABLE search_meta (version INTEGER NOT NULL, upto INTEGER, fill_below INTEGER, reads_old INTEGER NOT NULL DEFAULT 0)");
    db.query("INSERT INTO search_meta (version, upto, fill_below, reads_old) VALUES (?, ?, ?, ?)")
      .run(INDEX_VERSION, oldWhole ? (oldUpto ?? last) : last, last > 0 ? last + 1 : null, oldWhole && last > 0 ? 1 : 0);
  }).immediate(); // the write lock from the start: another process cannot commit in between
  const m = searchMeta(db)!;
  const left = has(db, ["search_idx"]).has("search_idx");
  return { fill: m.fill_below !== null, drain: m.fill_below === null && left };
}

// The rows of the events stored from here on. Each event's wait with the other
// side rows and are written, in the order the events were stored, with the
// number of the last event written (`upto`): a kill loses the rows that
// waited, and the next start writes them from the events. An event stored
// with many others (an import) has its rows written in that transaction,
// after the ones that waited.
export function keepIndexed(store: Pick<Store, "db" | "side"> & { stored?: Store["stored"] }) {
  const db = store.db;
  // While the old index is read, it is kept current too (until the fill thread drops it).
  let old = !!searchMeta(db)?.reads_old;
  const write = (rowid: number, kind: string) => {
    const of = ROWS_OF[kind] ?? [];
    for (const i of of) db.query(ONE[i]!).run(rowid);
    if (old && of.length) {
      try {
        if (db.query<{ reads_old: number }, []>("SELECT reads_old FROM search_meta").get()?.reads_old) writeOld(db, rowid, kind);
        else old = false;
      } catch (e) {
        // The fill thread dropped the old index's objects between two of these: it is not read any more.
        if (/no such (table|view)/.test(String((e as Error)?.message))) old = false;
        else throw e;
      }
    }
    db.query("UPDATE search_meta SET upto = MAX(COALESCE(upto, 0), ?)").run(rowid);
  };
  // Events stored by a daemon that was killed before their rows were written: at most what waited then.
  const upto = db.query<{ upto: number | null }, []>("SELECT upto FROM search_meta").get()?.upto ?? 0;
  const late = db.query<{ kind: string; rowid: number }, [number]>(
    `SELECT e.kind, e.rowid AS rowid FROM events e WHERE e.rowid > ? AND e.kind IN ${KINDS}
       AND NOT EXISTS (SELECT 1 FROM search_rows r WHERE r.doc ${RANGE_OF("e.rowid")}) ORDER BY e.rowid`).all(upto);
  if (late.length) db.transaction(() => { for (const e of late) write(e.rowid, e.kind); })();
  // The greatest row number handed over: an event numbered at or under it took the number of a
  // deleted one, and `upto` may be past it already, so its rows do not wait.
  let seen = Math.max(upto, db.query<{ n: number }, []>(`SELECT ${LAST_EVENT} AS n`).get()?.n ?? 0);
  store.stored = (e, bulk) => {
    const again = e.rowid <= seen;
    seen = Math.max(seen, e.rowid);
    // (An event of a kind that is not searched has no rows: `upto` passes it with the next one that has.)
    if (!ROWS_OF[e.kind]) return;
    if (!bulk && !again) return store.side.later("an event's search rows", () => write(e.rowid, e.kind));
    store.side.flush();
    write(e.rowid, e.kind);
  };
  // The fill thread has dropped the old index: told by it (search-fill.ts).
  return { oldGone: () => { old = false; } };
}

// One step of the fill: the events below `fill_below`, newest first, whose
// bodies come to about `bytes` (at least one event, at most `most`), get their
// rows, and `fill_below` moves down. What a step costs is the reading of those
// bodies and the indexing of their words, so a step is sized by their bytes,
// not by how many events it takes (a tool's output is up to TOOL_EXCERPT
// characters of words, a short note a few). Returns how many events it took
// (0: the fill is done, and recorded so) and whether any are left.
// `held_ms`: how long the step worked with the write lock held (not the wait for it).
export function fillStep(db: Database, bytes: number, most = 5_000): { events: number; left: number; held_ms: number } {
  let t = 0;
  const r = db.transaction(() => {
    t = performance.now();
    const m = db.query<{ fill_below: number | null }, []>("SELECT fill_below FROM search_meta").get();
    if (!m || m.fill_below === null) return { events: 0, left: 0 };
    const below = m.fill_below;
    // (The bytes of the events up to each one, newest first: the step ends before the first that would pass `bytes`.)
    const range = db.query<{ lo: number | null; n: number }, [number, number, number]>(
      `SELECT MIN(rowid) AS lo, count(*) AS n FROM (
         SELECT rowid, row_number() OVER w AS k, sum(octet_length(data)) OVER w AS upto
         FROM (SELECT rowid, data FROM events WHERE rowid < ?1 ORDER BY rowid DESC LIMIT ?2)
         WINDOW w AS (ORDER BY rowid DESC ROWS UNBOUNDED PRECEDING))
       WHERE k = 1 OR upto <= ?3`).get(below, most, bytes)!;
    if (range.lo === null) {
      finishFill(db);
      return { events: 0, left: 0 };
    }
    for (const r of RANGE) db.query(r).run(range.lo, below - 1);
    db.query("UPDATE search_meta SET fill_below = ?").run(range.lo);
    const left = db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM (SELECT 1 FROM events WHERE rowid < ? LIMIT 1)").get(range.lo)!.n;
    if (!left) finishFill(db);
    return { events: range.n, left };
  }).immediate();
  return { ...r, held_ms: performance.now() - t };
}

// The same for one event alone: the step it was in could not be made (its data
// is not JSON). Returns whether its rows were written.
export function fillOne(db: Database, rowid: number): boolean {
  try {
    db.transaction(() => { for (const r of RANGE) db.query(r).run(rowid, rowid); }).immediate();
    return true;
  } catch (e) {
    // (A lock not had is no fault of the event's: the caller tries again.)
    if ((e as { code?: string })?.code?.startsWith?.("SQLITE_BUSY")) throw e;
    return false;
  }
}

// The events below `fill_below` in the next step, to be filled one at a time.
export function nextRows(db: Database, batch: number): number[] {
  const m = db.query<{ fill_below: number | null }, []>("SELECT fill_below FROM search_meta").get();
  if (!m || m.fill_below === null) return [];
  return db.query<{ rowid: number }, [number, number]>("SELECT rowid FROM events WHERE rowid < ? ORDER BY rowid DESC LIMIT ?").all(m.fill_below, batch).map((r) => r.rowid);
}
export function passBelow(db: Database, rowid: number) {
  db.transaction(() => {
    db.query("UPDATE search_meta SET fill_below = ?").run(rowid);
    if (!db.query("SELECT 1 FROM events WHERE rowid < ? LIMIT 1").get(rowid)) finishFill(db);
  }).immediate();
}

// The new index is whole: searches read it, and the old one is not kept
// current any more (its triggers and the view it was written through go now;
// its rows are removed next, dropStep).
function finishFill(db: Database) {
  db.exec(OLD_LAYOUT);
  db.query("UPDATE search_meta SET fill_below = NULL, reads_old = 0").run();
}

// One step of removing the old index: its `rows` oldest rows are deleted
// (their pages go to the store's free list and are used again by what is
// written next), and once none is left its tables are dropped, now nearly
// empty. Dropping the whole index at once held the write lock for as long as
// SQLite takes to free every page, near a second on a store of a gigabyte;
// a delete of a few hundred rows takes a few milliseconds. (FTS5 reads each
// row's text to remove its words: the old index holds its own copy.) Returns
// how many rows it removed and whether anything is left.
export function dropStep(db: Database, rows: number): { rows: number; left: boolean; held_ms: number } {
  let t = 0;
  const r = db.transaction(() => {
    t = performance.now();
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'search_idx'").get()) {
      db.exec("DROP TABLE IF EXISTS search_docs");
      return { rows: 0, left: false };
    }
    // (Counted by the rows taken: FTS5's own writes to its tables are counted in a statement's changes.)
    const ids = db.query<{ rowid: number }, [number]>("SELECT rowid FROM search_idx ORDER BY rowid LIMIT ?").all(rows).map((r) => r.rowid);
    if (ids.length) {
      db.query("DELETE FROM search_idx WHERE rowid BETWEEN ? AND ?").run(ids[0]!, ids.at(-1)!);
      return { rows: ids.length, left: true };
    }
    // (The map of its rows to their events: rows of a few dozen bytes, removed many at a time.)
    const docs = db.query("SELECT 1 FROM sqlite_master WHERE name = 'search_docs'").get()
      ? db.query("DELETE FROM search_docs WHERE (event_id, doc) IN (SELECT event_id, doc FROM search_docs LIMIT ?)").run(rows * 16).changes : 0;
    if (docs) return { rows: docs, left: true };
    db.exec("DROP TABLE IF EXISTS search_idx; DROP TABLE IF EXISTS search_docs;");
    return { rows: 0, left: false };
  }).immediate();
  return { ...r, held_ms: performance.now() - t };
}
