// A session's draft: text and images put into its message box from outside the
// page (a capture tool, a script, another device), not sent. The page keeps
// its attachments here too, so an image survives a reload or a session switch
// until it is sent. Nothing here sends anything.
import type { RouteModule } from "../app.ts";
import type { Store } from "../../core/store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drafts (session_id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', origin TEXT, updated_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS draft_files (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, origin TEXT, added_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS draft_files_session ON draft_files(session_id, added_ms);
-- A deleted session takes its unsent draft with it, whichever path deleted it;
-- the sweep below clears what was left before this trigger existed.
CREATE TRIGGER IF NOT EXISTS drafts_session_gone AFTER DELETE ON sessions BEGIN
  DELETE FROM drafts WHERE session_id = OLD.id;
  DELETE FROM draft_files WHERE session_id = OLD.id;
END;
DELETE FROM drafts WHERE session_id NOT IN (SELECT id FROM sessions);
DELETE FROM draft_files WHERE session_id NOT IN (SELECT id FROM sessions);
`;

const IMAGE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 3_750_000; // what a provider takes as one base64 image
const MAX_FILES = 20;
const TARGET_MS = 60_000; // a capture without a session goes to the one used this recently

export type DraftFile = { id: string; name: string; mime: string; origin: string | null; added_ms: number; bytes: number };
export type Draft = { text?: string; origin?: string | null; text_ms?: number; attachments: DraftFile[]; updated_ms?: number };

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

// An unsent message the owner is writing in a page: the page says when its box
// holds one and repeats it while it does (DRAFT_BEAT_MS); a claim not repeated
// for three beats is from a page that went away. Only that it exists is kept,
// never what it says.
// Each page speaks for its own box (a second tab with an empty box does not
// cancel the first one's message).
const DRAFT_BEAT_MS = 30_000; // the page's beat (ui/src/lib/drafts.ts)
const typed = new Map<string, Map<string, number>>(); // session -> page -> last claim

// Whether the owner has a message not yet sent in this session: one in an open
// page's box, or text or images kept in the session's draft on the daemon.
export function draftPresent(store: Store, id: string): boolean {
  const pages = typed.get(id);
  for (const [p, t] of pages ?? []) {
    if (Date.now() - t <= 3 * DRAFT_BEAT_MS) return true;
    pages!.delete(p);
  }
  try {
    return !!store.db.query("SELECT 1 FROM drafts WHERE session_id = ? AND text != '' UNION ALL SELECT 1 FROM draft_files WHERE session_id = ? LIMIT 1").get(id, id);
  } catch {
    return false; // the drafts table is not there yet
  }
}

export const draftRoutes: RouteModule = ({ store, bus }) => {
  store.migrate(SCHEMA);
  const db = store.db;

  const draft = (id: string): Draft => {
    const row = db.query<{ text: string; origin: string | null; updated_ms: number }, [string]>("SELECT text, origin, updated_ms FROM drafts WHERE session_id = ?").get(id);
    const attachments = db
      .query<DraftFile, [string]>("SELECT id, name, mime, origin, added_ms, length(data) AS bytes FROM draft_files WHERE session_id = ? ORDER BY added_ms, id")
      .all(id);
    const updated = Math.max(row?.updated_ms ?? 0, ...attachments.map((a) => a.added_ms));
    // `text_ms`: which write the text is, for the page to say it took exactly that one.
    return { ...(row?.text ? { text: row.text, origin: row.origin, text_ms: row.updated_ms } : {}), attachments, ...(updated ? { updated_ms: updated } : {}) };
  };

  // When the owner last used each session: his message, a draft change, typing.
  const used = new Map<string, number>();
  const touch = (id: string) => used.set(id, Date.now());
  // The owner's own words count: every automatic sender tags what it sends
  // (a loop, a wait, an agent's report, a peer: `kind`; momentum, the queue:
  // `origin`), at the place it sends. Speech is the owner's too.
  bus.on((f) => {
    if (f.t !== "event" || f.event.kind !== "user") return;
    const d = f.event.data as { origin?: string; kind?: string };
    if (!d?.kind && (!d?.origin || d.origin === "voice")) touch(f.event.session_id);
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
          // Each write gets its own time, so two deliveries in one millisecond read apart.
          const prev = db.query<{ updated_ms: number }, [string]>("SELECT updated_ms FROM drafts WHERE session_id = ?").get(s.id)?.updated_ms ?? 0;
          // `taken`: the page moved the text of that write into its box; a newer write stays.
          if (typeof b.taken === "number") db.run("UPDATE drafts SET text = '', updated_ms = ? WHERE session_id = ? AND updated_ms = ?", [Math.max(now, prev + 1), s.id, b.taken]);
          else db.run("INSERT INTO drafts (session_id, text, origin, updated_ms) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, origin = excluded.origin, updated_ms = excluded.updated_ms", [s.id, b.text, origin, Math.max(now, prev + 1)]);
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
    // The owner is typing in this session (the page says so every few seconds);
    // { draft: boolean } says whether the page's box holds an unsent message.
    "/api/sessions/:id/presence": {
      POST: async (req: any) => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        const b = (await req.json().catch(() => null)) as { draft?: unknown; page?: unknown } | null;
        const page = typeof b?.page === "string" ? b.page.slice(0, 64) : "";
        if (b?.draft === true) {
          const pages = typed.get(req.params.id) ?? new Map<string, number>();
          pages.set(page, Date.now());
          typed.set(req.params.id, pages);
        } else if (b?.draft === false) typed.get(req.params.id)?.delete(page);
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
