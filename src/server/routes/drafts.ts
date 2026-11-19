// A session's draft: text and images put into its message box from outside the
// page (a capture tool, a script, another device), not sent. The page keeps
// its attachments here too, so an image survives a reload or a session switch
// until it is sent. Nothing here sends anything.
import type { RouteModule } from "../app.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drafts (session_id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', origin TEXT, updated_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS draft_files (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, origin TEXT, added_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS draft_files_session ON draft_files(session_id, added_ms);
`;

const IMAGE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 3_750_000; // what a provider takes as one base64 image
const MAX_FILES = 20;
const TARGET_MS = 60_000; // a capture without a session goes to the one used this recently

export type DraftFile = { id: string; name: string; mime: string; origin: string | null; added_ms: number; bytes: number };
export type Draft = { text?: string; origin?: string | null; attachments: DraftFile[]; updated_ms?: number };

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

export const draftRoutes: RouteModule = ({ store, bus }) => {
  store.migrate(SCHEMA);
  const db = store.db;

  const draft = (id: string): Draft => {
    const row = db.query<{ text: string; origin: string | null; updated_ms: number }, [string]>("SELECT text, origin, updated_ms FROM drafts WHERE session_id = ?").get(id);
    const attachments = db
      .query<DraftFile, [string]>("SELECT id, name, mime, origin, added_ms, length(data) AS bytes FROM draft_files WHERE session_id = ? ORDER BY added_ms, id")
      .all(id);
    const updated = Math.max(row?.updated_ms ?? 0, ...attachments.map((a) => a.added_ms));
    return { ...(row?.text ? { text: row.text, origin: row.origin } : {}), attachments, ...(updated ? { updated_ms: updated } : {}) };
  };

  // When the owner last used each session: his message, a draft change, typing.
  const used = new Map<string, number>();
  const touch = (id: string) => used.set(id, Date.now());
  bus.on((f) => {
    if (f.t === "event" && f.event.kind === "user" && !(f.event.data as { origin?: string })?.origin) touch(f.event.session_id);
  });

  const changed = (id: string) => {
    const d = draft(id);
    bus.emit({ t: "feature", name: "draft", session_id: id, data: d });
    return d;
  };

  const session = (req: any) => {
    const s = store.session(req.params.id);
    return s && !s.archived ? s : null;
  };

  return {
    "/api/sessions/:id/draft": {
      // An archived session's page still reads its draft; writing needs a live session.
      GET: (req: any) => (store.session(req.params.id) ? json(draft(req.params.id)) : bad("no such session", 404)),
      // { text?, images?: [{ id?, name?, mime, data (base64) }], attachments?: ids to keep, origin? }
      // Text replaces the draft's text ("" empties it). Images are added.
      // `attachments` drops every file of the draft not listed.
      POST: async (req: any) => {
        const s = session(req);
        if (!s) return bad("no such session", 404);
        const b = (await req.json().catch(() => null)) as any;
        if (!b || (b.text === undefined && !b.images && !b.attachments)) return bad("give text, images or attachments");
        if (b.text !== undefined && typeof b.text !== "string") return bad("text is a string");
        const origin = typeof b.origin === "string" ? b.origin.slice(0, 64) : null;
        const now = Date.now();
        const images = Array.isArray(b.images) ? b.images : [];
        const have = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM draft_files WHERE session_id = ?").get(s.id)!.n;
        if (have + images.length > MAX_FILES) return bad(`a draft holds at most ${MAX_FILES} images`);
        const decoded: { id: string; name: string; mime: string; data: Uint8Array }[] = [];
        for (const im of images) {
          if (!IMAGE.has(im?.mime)) return bad(`not an image type a model reads: ${im?.mime}`);
          const data = Buffer.from(String(im.data ?? ""), "base64");
          if (!data.length) return bad("an image is empty");
          if (data.length > MAX_BYTES) return bad(`an image is over ${Math.round(MAX_BYTES / 1e6)} MB`);
          const id = typeof im.id === "string" && /^[\w-]{8,64}$/.test(im.id) ? im.id : Bun.randomUUIDv7();
          if (db.query("SELECT 1 FROM draft_files WHERE id = ?").get(id)) continue; // sent twice: once is enough
          decoded.push({ id, name: String(im.name || "image").slice(0, 200), mime: im.mime, data });
        }
        if (Array.isArray(b.attachments)) {
          const keep = new Set(b.attachments.map(String));
          for (const f of draft(s.id).attachments) if (!keep.has(f.id)) db.run("DELETE FROM draft_files WHERE id = ?", [f.id]);
        }
        decoded.forEach((im, i) => {
          db.run("INSERT INTO draft_files (id, session_id, name, mime, data, origin, added_ms) VALUES (?, ?, ?, ?, ?, ?, ?)", [im.id, s.id, im.name, im.mime, im.data, origin, now + i]);
        });
        if (b.text !== undefined) {
          db.run("INSERT INTO drafts (session_id, text, origin, updated_ms) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, origin = excluded.origin, updated_ms = excluded.updated_ms", [s.id, b.text, origin, now]);
        }
        if (origin === "page") touch(s.id);
        return json(changed(s.id));
      },
      // Empties the draft: the page calls it once the message was sent.
      DELETE: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        db.run("DELETE FROM drafts WHERE session_id = ?", [s.id]);
        db.run("DELETE FROM draft_files WHERE session_id = ?", [s.id]);
        changed(s.id);
        return json({ ok: true });
      },
    },
    "/api/sessions/:id/draft/files/:fid": {
      GET: (req: any) => {
        const f = db.query<{ mime: string; data: Uint8Array }, [string, string]>("SELECT mime, data FROM draft_files WHERE id = ? AND session_id = ?").get(req.params.fid, req.params.id);
        return f ? new Response(new Uint8Array(f.data) as unknown as BodyInit, { headers: { "content-type": f.mime, "cache-control": "private, max-age=86400, immutable" } }) : bad("no such file", 404);
      },
      DELETE: (req: any) => {
        const r = db.run("DELETE FROM draft_files WHERE id = ? AND session_id = ?", [req.params.fid, req.params.id]);
        if (!r.changes) return bad("no such file", 404);
        changed(req.params.id);
        return json({ ok: true });
      },
    },
    // The owner is typing in this session (the page says so every few seconds).
    "/api/sessions/:id/presence": {
      POST: (req: any) => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        touch(req.params.id);
        return json({ ok: true });
      },
    },
    // Where a capture sent without a session goes: the session the owner used
    // in the last minute, the most recent first. Events of a model, a loop or
    // an agent do not count.
    "/api/draft/target": {
      GET: () => {
        const now = Date.now();
        const best = [...used].filter(([id, t]) => now - t <= TARGET_MS && session({ params: { id } })).sort((a, b) => b[1] - a[1])[0];
        return json(best ? { session_id: best[0] } : {});
      },
    },
  };
};
