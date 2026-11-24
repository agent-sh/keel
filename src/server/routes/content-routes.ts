// GET /api/content-routes?since_ms=&until_ms=  which provider saw which session's content, by purpose, from
// the ledger (one row per model request attempt: turns, summaries, readers, titles, side answers,
// the judge), held against the rule the owner set in Settings (`content_routes`;
// src/safety/content-routes.ts). The rows are summed and the sessions above them read on the read
// thread; the default window is the last 30 days. The rule itself is read and changed through
// /api/settings.
import { homedir } from "node:os";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { realFolder, routeRule } from "../../safety/content-routes.ts";
import { seenBy, type SeenRow, type SeenSession } from "../../safety/route-seen.ts";

const DAYS_30 = 30 * 86_400_000;

const ROWS = `SELECT session_id, COALESCE(purpose, 'turn') AS purpose, substr(model, 1, max(0, instr(model, ':') - 1)) AS provider,
  COUNT(*) AS calls, MAX(ts) AS last_ms FROM telemetry_calls WHERE ts >= ?1 AND ts < ?2 GROUP BY 1, 2, 3`;
// The sessions that made the calls and every session above them, with the worktree each works in
// (a worktree session's content is its repository's folder's).
const SESSIONS = (wt: boolean) => `WITH RECURSIVE up(id) AS (SELECT DISTINCT session_id FROM telemetry_calls WHERE ts >= ?1 AND ts < ?2
  UNION SELECT s.parent_id FROM sessions s JOIN up ON s.id = up.id WHERE s.parent_id IS NOT NULL)
  SELECT s.id, s.workspace, s.parent_id, s.title${wt ? ", w.repo_root AS wt_root, w.path AS wt_path" : ""} FROM sessions s JOIN up ON s.id = up.id${wt ? " LEFT JOIN worktrees w ON w.session_id = s.id" : ""}`;

export const contentRouteRoutes: RouteModule = ({ store }) => ({
  "/api/content-routes": {
    GET: async (req: Request) => {
      const q = new URL(req.url).searchParams;
      const since = q.has("since_ms") ? Number(q.get("since_ms")) : Date.now() - DAYS_30;
      const until = q.has("until_ms") ? Number(q.get("until_ms")) : Number.MAX_SAFE_INTEGER;
      if (!Number.isFinite(since) || !Number.isFinite(until)) return Response.json({ error: "a bound is not a number" }, { status: 400 });
      const has = store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_calls'").get();
      const wt = !!store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worktrees'").get();
      const rule = routeRule();
      if (!has) return Response.json({ since_ms: since, rule, calls: 0, crossing: 0, folders: [] });
      const reads = readsOf(store);
      const [rows, sessions] = await Promise.all([reads.sql<SeenRow>(ROWS, [since, until]), reads.sql<SeenSession>(SESSIONS(wt), [since, until])]);
      return Response.json({ since_ms: since, rule, ...seenBy(rows, sessions, rule, homedir(), realFolder) });
    },
  },
});
