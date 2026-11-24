// MCP Apps in the transcript (src/mcp/apps.ts). A tool that names a ui://
// page has the page read from its server once, when its result comes, and
// kept with the session: a reload draws the same app, and a server that is
// gone by then does not take it away. The page is served under a policy that
// reaches only what its server declared, in a sandbox with no same origin.
//
// What the app asks of the host comes through the owner's page (its bridge is
// ui/src/components/McpApp.tsx) to the routes here, and each names the app,
// so nothing reaches past it:
//   - a call of a tool goes to the app's own server only, to a tool the
//     owner accepted that its server does not keep from apps, through the
//     owner's hooks and the permission gate as a model's call does. Each call
//     is kept, and shown under the app;
//   - a message to the model goes in as an outside input: shown to the
//     owner as the app's, never as the owner's words, and framed as data for
//     the model;
//   - a link is opened by the page on the owner's press, and never here.
import { createHash } from "node:crypto";
import type { ToolResultBlock } from "../../core/types.ts";
import { APP_MIME, APP_MIN_PX, appCsp, appliedCsp, isAppMime, MESSAGE_MAX, resourceMetaOf, type AppCallRow, type AppResourceMeta } from "../../mcp/apps.ts";
import { Bucket, frame } from "../../mcp/channel.ts";
import type { McpCallResult } from "../../mcp/client.ts";
import type { McpManager } from "../../mcp/manager.ts";
import { judgedOf } from "../../tools/catalog.ts";
import { nativeName } from "../../tools/defer.ts";
import type { Tool } from "../../tools/types.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

// A page, and a result kept for its app, at most: the cap Claude Code keeps
// for an MCP Apps tool's structured content (8,388,608 JSON characters). A
// page over it is not kept, and the app says why in its place.
export const APP_PAGE_MAX = 8_388_608;
// What the page keeps of one call's result text: the owner reads these rows, the model never does.
const CALL_TEXT = 4 * 1024;
// The pages one session keeps, at most, in bytes: room for the newest four at
// the largest a page may be. Past it the oldest of the session's pages are let
// go (their apps say so in their place); the newest, which the owner is using,
// stay drawn.
export const SESSION_PAGES_MAX = 4 * APP_PAGE_MAX;
// Calls an app's server gets from its apps in one session in a minute, at
// most (a bucket refilled evenly). Each is a press of the owner's in the app or
// the app's own refresh: a person presses about one control a second at most,
// and an app that refreshes once a second stays under it too. Past that it is
// a loop, and a read runs with no card to stop it.
export const CALLS_PER_MINUTE = 60;

export type AppRow = { id: string; session_id: string; call_id: string | null; server: string; source: string; label: string; tool: string; uri: string; page: string | null; meta: AppResourceMeta; input: unknown; result: McpCallResult | null; error: string | null; height: number | null; created: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_app_pages (hash TEXT PRIMARY KEY, html TEXT NOT NULL, bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_apps (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  call_id TEXT, server TEXT NOT NULL, source TEXT NOT NULL, label TEXT NOT NULL, tool TEXT NOT NULL, uri TEXT NOT NULL, page TEXT, meta TEXT NOT NULL,
  input TEXT, result TEXT, error TEXT, height INTEGER, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mcp_apps_session ON mcp_apps(session_id);
CREATE INDEX IF NOT EXISTS mcp_apps_page ON mcp_apps(page) WHERE page IS NOT NULL;
-- A page goes with the last app that points to it: its row deleted (its session's delete cascades here) or its page let go.
CREATE TRIGGER IF NOT EXISTS mcp_app_page_gone AFTER DELETE ON mcp_apps WHEN OLD.page IS NOT NULL BEGIN
  DELETE FROM mcp_app_pages WHERE hash = OLD.page AND NOT EXISTS (SELECT 1 FROM mcp_apps WHERE page = OLD.page);
END;
CREATE TRIGGER IF NOT EXISTS mcp_app_page_let_go AFTER UPDATE OF page ON mcp_apps WHEN OLD.page IS NOT NULL AND OLD.page IS NOT NEW.page BEGIN
  DELETE FROM mcp_app_pages WHERE hash = OLD.page AND NOT EXISTS (SELECT 1 FROM mcp_apps WHERE page = OLD.page);
END;
CREATE TABLE IF NOT EXISTS mcp_app_calls (id TEXT PRIMARY KEY, app TEXT NOT NULL REFERENCES mcp_apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS mcp_app_calls_app ON mcp_app_calls(app, seq);
`;

// The text of a page item: as text, or a blob in base64.
function pageText(item: { text?: string; blob?: string }): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.blob === "string") { try { return Buffer.from(item.blob, "base64").toString("utf8"); } catch { return undefined; } }
  return undefined;
}

// A result kept for its app: whole when it fits, else its content without the structured part, else nothing.
function keptResult(r: McpCallResult): string | null {
  const whole = JSON.stringify(r);
  if (whole.length <= APP_PAGE_MAX) return whole;
  const lean = JSON.stringify({ content: r.content, isError: r.isError, structuredContentOmitted: true });
  return lean.length <= APP_PAGE_MAX ? lean : null;
}

const textOf = (r: ToolResultBlock) => (typeof r.content === "string" ? r.content : r.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
const clip = (s: string) => (s.length > CALL_TEXT ? `${s.slice(0, CALL_TEXT)} [... ${s.length - CALL_TEXT} more characters]` : s);

export const mcpAppRoutes: RouteModule = ({ store, bus, engine, errors }) => {
  store.migrate(SCHEMA);
  const db = store.db;
  const mcp = () => (globalThis as { __keelMcp?: McpManager }).__keelMcp;
  const rowOf = (r: any): AppRow => ({ ...r, meta: JSON.parse(r.meta), input: r.input ? JSON.parse(r.input) : null, result: r.result ? JSON.parse(r.result) : null });
  const appOf = (session: string, id: string): AppRow | undefined => {
    const r = db.query("SELECT * FROM mcp_apps WHERE id = ? AND session_id = ?").get(id, session);
    return r ? rowOf(r) : undefined;
  };
  const callsOf = (app: string): AppCallRow[] => db.query<{ data: string }, [string]>("SELECT data FROM mcp_app_calls WHERE app = ? ORDER BY seq").all(app).map((r) => JSON.parse(r.data));
  const saveCall = (sessionId: string, c: AppCallRow) => {
    try {
      db.query("INSERT INTO mcp_app_calls (id, app, session_id, seq, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(c.id, c.app, sessionId, c.seq, JSON.stringify(c));
    } catch (e) {
      errors.capture("server", e, { at: "mcp_app_calls", session: sessionId });
    }
    bus.emit({ t: "feature", name: "mcp_app_call", session_id: sessionId, data: c });
  };

  // The keeper: the page is read when the result comes, and kept (one copy of the same page for every result).
  const keeper: NonNullable<McpManager["apps"]> = {
    async keep({ server, source, shown, tool, uri, input, result, ctx }) {
      const m = mcp();
      let html: string | undefined, meta: AppResourceMeta = {}, error: string | undefined;
      try {
        const items = m ? await m.readApp(server, uri, ctx.signal) : [];
        const item = items.find((i) => isAppMime(i.mimeType)) ?? items[0];
        if (!item) error = `${shown} returned nothing for ${uri}`;
        else if (!isAppMime(item.mimeType)) error = `${uri} is ${item.mimeType ? `of the type ${item.mimeType}` : "of no type"}, not an app page (${APP_MIME})`;
        else {
          html = pageText(item);
          meta = resourceMetaOf(item._meta);
          if (html === undefined) error = `${uri} holds no page`;
          else if (html.length > APP_PAGE_MAX) { error = `${uri} is ${html.length.toLocaleString("en-US")} characters, over the ${APP_PAGE_MAX.toLocaleString("en-US")} an app may be`; html = undefined; }
        }
      } catch (e) {
        error = `${shown} could not give ${uri}: ${(e as Error).message.split("\n")[0]}`;
      }
      const id = Bun.randomUUIDv7();
      const page = html === undefined ? null : createHash("sha256").update(html).digest("hex");
      const r = keptResult(result);
      db.transaction(() => {
        if (page !== null) db.query("INSERT OR IGNORE INTO mcp_app_pages (hash, html, bytes) VALUES (?, ?, ?)").run(page, html!, Buffer.byteLength(html!));
        db.query(`INSERT INTO mcp_apps (id, session_id, call_id, server, source, label, tool, uri, page, meta, input, result, error, height, created)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
          .run(id, ctx.sessionId, ctx.callId ?? null, server, source, shown, tool.name, uri, page, JSON.stringify(meta), JSON.stringify(input ?? {}), r, error ?? null, Date.now());
        if (page !== null) fit(ctx.sessionId, page);
      })();
      return { id, server: shown, tool: tool.name, uri, ...(error ? { error } : {}) };
    },
  };
  const m = mcp();
  if (m) m.apps = keeper;

  // The session's pages within SESSION_PAGES_MAX: the oldest let go first, never `kept` (the page just kept).
  const LET_GO = `the page was let go: a session keeps at most ${SESSION_PAGES_MAX / 1024 / 1024} MB of app pages, the newest`;
  function fit(session: string, kept: string) {
    const pages = db.query<{ page: string; bytes: number }, [string]>(
      `SELECT a.page AS page, p.bytes AS bytes FROM mcp_apps a JOIN mcp_app_pages p ON p.hash = a.page WHERE a.session_id = ?
       GROUP BY a.page ORDER BY MAX(a.created) ASC`).all(session);
    let total = pages.reduce((n, p) => n + p.bytes, 0);
    for (const p of pages) {
      if (total <= SESSION_PAGES_MAX) break;
      if (p.page === kept) continue;
      db.query("UPDATE mcp_apps SET page = NULL, error = ? WHERE session_id = ? AND page = ?").run(LET_GO, session, p.page);
      total -= p.bytes;
    }
  }

  // Messages an app sends to the model in a minute, at most: an outside source's rate (src/mcp/channel.ts PER_MINUTE).
  const buckets = new Map<string, Bucket>();
  // Calls of a server's apps in one session (CALLS_PER_MINUTE).
  const callBuckets = new Map<string, Bucket>();
  const bucketOf = (map: Map<string, Bucket>, key: string, perMinute?: number) => map.get(key) ?? map.set(key, new Bucket(perMinute)).get(key)!;

  const view = (a: AppRow) => ({
    id: a.id, server: a.label, tool: a.tool, uri: a.uri, error: a.error, prefers_border: a.meta.prefersBorder ?? null, csp: appliedCsp(a.meta.csp),
    height: a.height, input: a.input, result: a.result, page: !!a.page, created: a.created,
  });

  return {
    "/api/sessions/:id/mcp-apps/:app": {
      GET: (req: any) => {
        const a = appOf(req.params.id, req.params.app);
        if (!a) return bad("no such app in this session", 404);
        return json({ app: view(a), calls: callsOf(a.id) });
      },
    },
    // The page itself, under its server's declared origins and nothing more.
    "/api/sessions/:id/mcp-apps/:app/page": {
      GET: (req: any) => {
        const a = appOf(req.params.id, req.params.app);
        if (!a?.page) return bad(a ? a.error ?? "the app has no page" : "no such app in this session", 404);
        const row = db.query<{ html: string }, [string]>("SELECT html FROM mcp_app_pages WHERE hash = ?").get(a.page);
        if (!row) return bad("the app's page is gone", 404);
        return new Response(row.html, { headers: {
          "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": appCsp(a.meta.csp),
          "referrer-policy": "no-referrer", "cache-control": "no-cache",
        } });
      },
    },
    // The height the app last asked for: a reload draws it at that height before the app has said.
    "/api/sessions/:id/mcp-apps/:app/height": {
      PUT: async (req: any) => {
        const a = appOf(req.params.id, req.params.app);
        if (!a) return bad("no such app in this session", 404);
        const b = ((await req.json().catch(() => null)) ?? {}) as { height?: unknown };
        if (typeof b.height !== "number" || !Number.isFinite(b.height)) return bad("height must be a number");
        // (Kept as asked, within what any window draws: the page bounds it by its own window.)
        db.query("UPDATE mcp_apps SET height = ? WHERE id = ?").run(Math.round(Math.min(Math.max(b.height, APP_MIN_PX), 100_000)), a.id);
        return json({ ok: true });
      },
    },
    // A call of a tool of the app's own server, judged as a model's call is.
    "/api/sessions/:id/mcp-apps/:app/call": {
      POST: async (req: any) => {
        const sid = req.params.id as string;
        const a = appOf(sid, req.params.app);
        if (!a) return bad("no such app in this session", 404);
        const s = store.session(sid);
        if (!s || s.archived) return bad("the session is archived", 409);
        const b = ((await req.json().catch(() => null)) ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof b.name !== "string" || !b.name) return bad("name is required");
        const args = b.arguments === undefined ? {} : b.arguments;
        if (!args || typeof args !== "object" || Array.isArray(args)) return bad("arguments must be an object");
        if (!bucketOf(callBuckets, `${sid}\u0000${a.server}`, CALLS_PER_MINUTE).take()) return bad(`the app called its server more than ${CALLS_PER_MINUTE} times in a minute`, 429);
        const seq = (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM mcp_app_calls WHERE app = ?").get(a.id)?.n ?? 0) + 1;
        const call: AppCallRow = { id: `mcpapp_${Bun.randomUUIDv7().replace(/-/g, "")}`, app: a.id, seq, tool: b.name, input: args, state: "running", text: "", started: Date.now() };
        const end = (state: AppCallRow["state"], text: string) => { Object.assign(call, { state, text: clip(text), ended: Date.now() }); saveCall(sid, call); };
        const manager = mcp();
        const found = manager ? await manager.appTool(a.server, a.source, b.name, sid) : { refused: "MCP servers are not running" };
        if ("refused" in found) {
          end("refused", found.refused);
          return json({ refused: found.refused, call });
        }
        saveCall(sid, call);
        const t = found.tool;
        let raw: McpCallResult | undefined;
        // Judged and granted as the tool it is, under the name the model would call it by.
        const tool: Tool = {
          name: nativeName(t), description: t.description, input_schema: t.input_schema, readOnly: !!t.readOnly,
          async target(input) {
            return { name: t.qualified, readOnly: !!t.readOnly, input, source: t.source, shape: judgedOf(t).shape, cls: t.judge ? await t.judge(input) : undefined };
          },
          run: (input, ctx) => manager!.call(a.server, found.def.name, input, ctx, { raw: (r) => { raw = r; } }),
        };
        // A page that goes away (closed, reloaded) takes its call with it: a call waiting on a card does not wait on.
        const r = await engine.runForApp(sid, tool, args, call.id, req.signal ?? new AbortController().signal, `The ${a.label} app`);
        const how = r.is_error ? engine.verdictOf(r) : undefined;
        if (how === "denied" || (r.is_error && !raw)) {
          end(how === "denied" ? "denied" : "error", textOf(r));
          return json(how === "denied" ? { refused: textOf(r), call } : { result: { content: [{ type: "text", text: textOf(r) }], isError: true }, call });
        }
        end(raw?.isError || r.is_error ? "error" : "ok", textOf(r));
        return json({ result: raw ?? { content: [{ type: "text", text: textOf(r) }] }, call });
      },
    },
    // A message the app sends to the model: an outside input, as a connected server's event is.
    "/api/sessions/:id/mcp-apps/:app/message": {
      POST: async (req: any) => {
        const sid = req.params.id as string;
        const a = appOf(sid, req.params.app);
        if (!a) return bad("no such app in this session", 404);
        const s = store.session(sid);
        if (!s || s.archived) return bad("the session is archived", 409);
        const b = ((await req.json().catch(() => null)) ?? {}) as { text?: unknown };
        if (typeof b.text !== "string" || !b.text.trim()) return bad("text is required");
        if (b.text.length > MESSAGE_MAX) return bad(`a message holds at most ${MESSAGE_MAX} characters`);
        const key = `${sid}\u0000${a.server}`;
        if (!bucketOf(buckets, key).take()) return bad("the app sent too many messages in a minute", 429);
        const source = `${a.label} app`;
        const sent = engine.message(sid, frame(source, { content: b.text.trim(), attrs: {} }), { kind: "channel", source, source_key: `mcp_app:${a.server}`, via: "mcp_app" });
        return json({ ok: true, state: sent.held ? "held" : sent.event ? "started" : "waiting" });
      },
    },
  };
};
