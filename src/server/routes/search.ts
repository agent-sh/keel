// Search across sessions: titles and folders first, then what was said and
// done: prompts (with the names of their attached files), reply text, tool
// calls with a bounded excerpt of their input and output, and summaries. An
// FTS5 index the database keeps current with triggers, so the turn loop does
// not have to know about it.
import type { Database } from "bun:sqlite";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";

// How much of one tool call's input or output is indexed (the rest is not
// searched; a hit on a cut one says so).
export const TOOL_EXCERPT = 4000;
const L = TOOL_EXCERPT;

// A declined reply is discarded (the transcript hides its partial text), so it is not found either.
const KEPT = "coalesce(json_extract(e.data, '$.stop'), '') != 'refusal'";

// One INSERT per kind of row, over `SRC` (the events table, or NEW in a trigger).
// Columns: text, event_id, session_id, kind, ts, ref (a tool call id), cut.
const ROWS = (SRC: string) => [
  // A prompt: its words (not the placeholder of an attachment-only prompt) and its files' names.
  `SELECT x.t, x.id, x.session_id, 'user', x.ts, NULL, 0 FROM (SELECT e.id, e.session_id, e.ts, trim(
     CASE WHEN json_extract(e.data, '$.text') IN ('(image)', '(attached file)') THEN '' ELSE coalesce(json_extract(e.data, '$.text'), '') END
     || ' ' || coalesce((SELECT group_concat(json_extract(value, '$.name'), ' ') FROM json_each(e.data, '$.images') WHERE json_extract(value, '$.type') = 'attachment'), '')) AS t
   FROM ${SRC} WHERE e.kind = 'user') x WHERE x.t != ''`,
  `SELECT x.t, x.id, x.session_id, 'assistant', x.ts, NULL, 0 FROM (SELECT e.id, e.session_id, e.ts,
     (SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(e.data, '$.blocks') WHERE json_extract(value, '$.type') = 'text') AS t
   FROM ${SRC} WHERE e.kind = 'assistant' AND ${KEPT}) x WHERE x.t IS NOT NULL AND x.t != ''`,
  // A tool call: its name and input (a command, a path, a pattern).
  // The words of the input, not its JSON: `Bash echo done`, not `{"command":"echo done"}`.
  `SELECT substr(x.t, 1, ${L}), x.id, x.session_id, 'tool_use', x.ts, x.ref, length(x.t) > ${L} FROM (SELECT e.id, e.session_id, e.ts, json_extract(j.value, '$.id') AS ref,
     json_extract(j.value, '$.name') || ' ' || coalesce((SELECT group_concat(v.value, ' ') FROM json_tree(j.value, '$.input') v WHERE v.type = 'text'), '') AS t
   FROM ${SRC}, json_each(e.data, '$.blocks') j WHERE e.kind = 'assistant' AND ${KEPT} AND json_extract(j.value, '$.type') = 'tool_use') x`,
  // What a tool gave back (text only; images are not words).
  `SELECT substr(x.t, 1, ${L}), x.id, x.session_id, 'tool_result', x.ts, x.ref, length(x.t) > ${L} FROM (SELECT e.id, e.session_id, e.ts, json_extract(j.value, '$.tool_use_id') AS ref,
     CASE json_type(j.value, '$.content') WHEN 'text' THEN json_extract(j.value, '$.content')
       ELSE (SELECT group_concat(json_extract(c.value, '$.text'), char(10)) FROM json_each(j.value, '$.content') c WHERE json_extract(c.value, '$.type') = 'text') END AS t
   FROM ${SRC}, json_each(e.data, '$.results') j WHERE e.kind = 'tool_result') x WHERE x.t IS NOT NULL AND x.t != ''`,
  // A summary (a compaction checkpoint, or one written from a prompt on).
  `SELECT json_extract(e.data, '$.summary'), e.id, e.session_id, 'summary', e.ts, NULL, 0 FROM ${SRC}
   WHERE e.kind IN ('compaction', 'note') AND json_extract(e.data, '$.summary') IS NOT NULL AND json_extract(e.data, '$.summary') != ''`,
];
// Rows go in through `search_in`, a view whose trigger writes the FTS row and
// maps it to its event in `search_docs` (an event has several rows: one per
// tool call and result). The index cannot look a row up by its event (the
// column is not indexed); the map can, so removing an event's rows costs a
// lookup of that event and a delete by rowid each, whatever else is indexed.
const COLS = "INSERT INTO search_in (text, event_id, session_id, kind, ts, ref, cut)";
const NEW_SRC = "(SELECT NEW.id AS id, NEW.session_id AS session_id, NEW.kind AS kind, NEW.ts AS ts, NEW.data AS data) e";
const KINDS = "('user', 'assistant', 'tool_result', 'compaction', 'note')";

// Bumped when what is indexed changes: the index is made again from the events once.
// The next bump that changes what is indexed must drop the kept-rows path below (UNMAPPED_VERSION).
const INDEX_VERSION = 4;
// The same rows without the map: they are kept and mapped, not made again.
const UNMAPPED_VERSION = 3;

const DROP_LAYOUT = `
DROP TRIGGER IF EXISTS search_fts_ins;
DROP TRIGGER IF EXISTS search_fts_del;
DROP TABLE IF EXISTS search_fts;
DROP TRIGGER IF EXISTS search_idx_ins;
DROP TRIGGER IF EXISTS search_idx_del;
DROP VIEW IF EXISTS search_in;
DROP TABLE IF EXISTS search_docs;
DROP TABLE IF EXISTS search_meta;
`;
const SCHEMA = `
CREATE TABLE search_meta (version INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5(text, event_id UNINDEXED, session_id UNINDEXED, kind UNINDEXED, ts UNINDEXED, ref UNINDEXED, cut UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE search_docs (event_id TEXT NOT NULL, doc INTEGER NOT NULL, PRIMARY KEY (event_id, doc)) WITHOUT ROWID;
CREATE VIEW search_in AS SELECT NULL AS text, NULL AS event_id, NULL AS session_id, NULL AS kind, NULL AS ts, NULL AS ref, NULL AS cut;
CREATE TRIGGER search_in_ins INSTEAD OF INSERT ON search_in BEGIN
  INSERT INTO search_idx (text, event_id, session_id, kind, ts, ref, cut) VALUES (NEW.text, NEW.event_id, NEW.session_id, NEW.kind, NEW.ts, NEW.ref, NEW.cut);
  INSERT INTO search_docs (event_id, doc) VALUES (NEW.event_id, last_insert_rowid());
END;
CREATE TRIGGER search_docs_del AFTER DELETE ON search_docs BEGIN
  DELETE FROM search_idx WHERE rowid = OLD.doc;
END;
CREATE TRIGGER search_idx_ins AFTER INSERT ON events WHEN NEW.kind IN ${KINDS} BEGIN
  ${ROWS(NEW_SRC).map((r) => `${COLS} ${r};`).join("\n  ")}
END;
CREATE TRIGGER search_idx_del AFTER DELETE ON events WHEN OLD.kind IN ${KINDS} BEGIN
  DELETE FROM search_docs WHERE event_id = OLD.id;
END;
`;

// The index and what keeps it current, made or brought to this version in one
// transaction with the version it records. The recorded version is the whole
// answer of a later start: the index is there and filled, and nothing in it
// is read or counted. A start that failed part way left the version it found,
// and the next start does the work again.
export function initSearchIndex(db: Database) {
  const had = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'search_meta'").get()
    ? db.query<{ version: number }, []>("SELECT version FROM search_meta").get()?.version
    : undefined;
  // The recorded version is trusted only with its objects in place (an older
  // binary cut while it rebuilt its own layout leaves the version without them).
  const OBJECTS = ["search_idx", "search_docs", "search_in", "search_in_ins", "search_docs_del", "search_idx_ins", "search_idx_del"];
  const present = new Set(db.query<{ name: string }, string[]>(`SELECT name FROM sqlite_master WHERE name IN (${OBJECTS.map(() => "?").join(", ")})`).all(...OBJECTS).map((r) => r.name));
  if (had === INDEX_VERSION && present.size === OBJECTS.length) return;
  const whole = had === UNMAPPED_VERSION && present.has(OBJECTS[0]!);
  db.transaction(() => {
    const keep = whole;
    db.exec(`${DROP_LAYOUT}${keep ? "" : "DROP TABLE IF EXISTS search_idx;"}`);
    db.exec(SCHEMA);
    // One read of the rows already indexed (no words are indexed again).
    if (keep) db.run("INSERT INTO search_docs (event_id, doc) SELECT event_id, rowid FROM search_idx ORDER BY 1, 2");
    // Index what was stored before the index existed. A kept index with no
    // rows was never filled: that version recorded itself before its fill.
    if (!keep || !db.query("SELECT 1 FROM search_docs LIMIT 1").get()) for (const r of ROWS(`events e`)) db.run(`${COLS} ${r}`);
    db.run("INSERT INTO search_meta (version) VALUES (?)", [INDEX_VERSION]);
  }).immediate(); // the write lock from the start: another process cannot commit in between
}

type Hit = {
  session_id: string; session_title: string; event_id?: string; kind: string; ts: number; snippet: string; cwd: string; archived: boolean;
  parent_id?: string | null; ref?: string; partial?: boolean;
};

// Case and accents fold the way the transcript index folds them (é = e = É),
// and the canonically equal spellings (a composed é and e + combining accent) are one.
export const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

// Every word must match, the last one as a prefix ("deb func" finds "debounce function").
export function ftsQuery(q: string): string | null {
  const words = q.normalize("NFKC").split(/\s+/).map((w) => w.replace(/"/g, "")).filter(Boolean);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

export const searchRoutes: RouteModule = ({ store }) => {
  initSearchIndex(store.db);

  return {
    "/api/search": {
      // ?q=words&limit=n (per group: titles and conversation hits are cut apart)
      // [&roots=1: no subagent sessions] [&archived=0|1: one partition]
      // [&cwd=folder] [&sessions=1: one hit per session, the best]
      GET: async (req: Request) => {
        const u = new URL(req.url);
        const q = (u.searchParams.get("q") ?? "").trim();
        if (q.length > 500) return Response.json({ error: "query over 500 bytes" }, { status: 400 });
        const limit = Math.min(Number(u.searchParams.get("limit") ?? 20) || 20, 100);
        const match = ftsQuery(q);
        if (!match) return Response.json({ query: q, hits: [] });
        const roots = u.searchParams.get("roots") === "1";
        // Subagent sessions name their parent (the agents module adds the column).
        const pid = store.columnExists("sessions", "parent_id") ? "s.parent_id" : "NULL";
        const arch = u.searchParams.get("archived");
        const cwd = u.searchParams.get("cwd");
        const perSession = u.searchParams.get("sessions") === "1";
        const scope: string[] = [];
        const args: (string | number)[] = [];
        if (roots) scope.push(`${pid} IS NULL`);
        if (arch === "0" || arch === "1") { scope.push("s.archived = ?"); args.push(Number(arch)); }
        if (cwd) { scope.push("s.workspace = ?"); args.push(cwd); }
        const where = scope.length ? `AND ${scope.join(" AND ")}` : "";
        // Every word matches the title or folder; matched over all eligible sessions, then ranked and cut.
        const words = fold(q).split(/\s+/).filter(Boolean);
        const titles = store.db
          .query<any, (string | number)[]>(`SELECT s.id, s.title, s.workspace, s.updated, s.archived, ${pid} AS parent_id FROM sessions s WHERE 1 ${where} ORDER BY s.archived, s.updated DESC`)
          .all(...args)
          .filter((t) => { const hay = fold(`${t.title ?? ""} ${t.workspace}`); return words.every((w) => hay.includes(w)); })
          .slice(0, limit);
        // The index is read off the loop: one word can match most of a long history.
        const content = await readsOf(store).run("search.content", { match, where, args, limit, perSession, pid });
        const hits: Hit[] = [
          ...titles.map((t) => ({ session_id: t.id, session_title: t.title, kind: "title", ts: t.updated, snippet: t.title, cwd: t.workspace, archived: !!t.archived, parent_id: t.parent_id ?? null })),
          ...content.map((c) => {
            const tool = c.kind === "tool_use" || c.kind === "tool_result";
            return {
              session_id: c.session_id, session_title: c.title, event_id: c.event_id,
              kind: c.kind, ts: c.ts, snippet: c.snippet, cwd: c.workspace, archived: !!c.archived, parent_id: c.parent_id ?? null,
              ...(tool && c.ref ? { ref: c.ref } : {}), ...(c.cut ? { partial: true } : {}),
            };
          }),
        ];
        return Response.json({ query: q, hits });
      },
    },
  };
};
