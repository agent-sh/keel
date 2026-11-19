// Search across sessions: titles and folders first, then what was said
// (prompts and reply text) through an FTS5 index the database keeps current
// with triggers, so the turn loop does not have to know about it.
import type { RouteModule } from "../app.ts";

const TEXT_OF = `CASE NEW.kind
  WHEN 'user' THEN json_extract(NEW.data, '$.text')
  WHEN 'assistant' THEN (SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(NEW.data, '$.blocks') WHERE json_extract(value, '$.type') = 'text')
END`;

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(text, event_id UNINDEXED, session_id UNINDEXED, kind UNINDEXED, ts UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS search_fts_ins AFTER INSERT ON events WHEN NEW.kind IN ('user', 'assistant') BEGIN
  INSERT INTO search_fts (text, event_id, session_id, kind, ts) SELECT t, NEW.id, NEW.session_id, NEW.kind, NEW.ts FROM (SELECT ${TEXT_OF} AS t) WHERE t IS NOT NULL AND t != '';
END;
CREATE TRIGGER IF NOT EXISTS search_fts_del AFTER DELETE ON events WHEN OLD.kind IN ('user', 'assistant') BEGIN
  DELETE FROM search_fts WHERE event_id = OLD.id;
END;
`;

type Hit = { session_id: string; session_title: string; event_id?: string; kind: string; ts: number; snippet: string; cwd: string; archived: boolean };

// Every word must match, the last one as a prefix ("deb func" finds "debounce function").
export function ftsQuery(q: string): string | null {
  const words = q.split(/\s+/).map((w) => w.replace(/"/g, "")).filter(Boolean);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

export const searchRoutes: RouteModule = ({ store }) => {
  store.migrate(SCHEMA);
  // Index what was stored before the index existed (once).
  const count = store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_fts").get()!.n;
  if (count === 0) {
    store.db.run(`INSERT INTO search_fts (text, event_id, session_id, kind, ts)
      SELECT t, id, session_id, kind, ts FROM (SELECT e.id, e.session_id, e.kind, e.ts, ${TEXT_OF.replaceAll("NEW.", "e.")} AS t FROM events e WHERE e.kind IN ('user', 'assistant')) WHERE t IS NOT NULL AND t != ''`);
  }

  return {
    "/api/search": {
      GET: (req: Request) => {
        const u = new URL(req.url);
        const q = (u.searchParams.get("q") ?? "").trim();
        if (q.length > 500) return Response.json({ error: "query over 500 bytes" }, { status: 400 });
        const limit = Math.min(Number(u.searchParams.get("limit") ?? 20) || 20, 100);
        const match = ftsQuery(q);
        if (!match) return Response.json({ query: q, hits: [] });
        const words = q.toLowerCase().split(/\s+/).filter(Boolean);
        // Every word matches the title or folder; matched over all sessions, then ranked and cut.
        const like = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const titles = store.db
          .query<any, string[]>(`SELECT id, title, workspace, updated, archived FROM sessions WHERE ${like.map(() => "lower(coalesce(title, '') || ' ' || workspace) LIKE ? ESCAPE '\\'").join(" AND ")} ORDER BY archived, updated DESC LIMIT ${limit}`)
          .all(...like);
        let content: any[] = [];
        try {
          content = store.db
          .query<any, [string, number]>(
            `SELECT f.event_id, f.session_id, f.kind, f.ts, snippet(search_fts, 0, char(1), char(2), '…', 14) AS snippet,
               s.title, s.workspace, s.archived
             FROM search_fts f JOIN sessions s ON s.id = f.session_id
             WHERE search_fts MATCH ?1 ORDER BY s.archived, bm25(search_fts) LIMIT ?2`,
          )
          .all(match, limit);
        } catch {
          content = []; // a query FTS cannot parse matches nothing
        }
        const hits: Hit[] = [
          ...titles.map((t) => ({ session_id: t.id, session_title: t.title, kind: "title", ts: t.updated, snippet: t.title, cwd: t.workspace, archived: !!t.archived })),
          ...content.map((c) => ({ session_id: c.session_id, session_title: c.title, event_id: c.event_id, kind: c.kind, ts: c.ts, snippet: c.snippet, cwd: c.workspace, archived: !!c.archived })),
        ];
        return Response.json({ query: q, hits });
      },
    },
  };
};
