// The owner's folders of sessions: manual groups in the session list, apart
// from the folder a session works in. A folder holds sessions and at most one
// level of folders; each has a name, a place in the order and whether it is
// folded. A session is in one folder or none (settings.folder_id). Deleting a
// folder leaves its sessions unfiled and moves its folders up a level.
import type { RouteModule } from "../app.ts";
import { registerListFilter, registerSessionPatch } from "../app.ts";

export type SessionFolder = { id: string; name: string; parent_id: string | null; pos: number; collapsed: boolean; created: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, pos REAL NOT NULL DEFAULT 0, collapsed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
`;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const refuse = (message: string, status = 400) => Object.assign(new Error(message), { status });

function cleanName(v: unknown): string {
  const n = typeof v === "string" ? v.trim() : "";
  if (!n) throw refuse("a folder has a name");
  if (n.length > 200 || /[\u0000-\u001f\u007f]/.test(n)) throw refuse("a folder name is one line of at most 200 characters");
  return n;
}

export const sessionFolderRoutes: RouteModule = ({ store, bus }) => {
  store.migrate(SCHEMA);
  const db = store.db;
  const row = (r: any): SessionFolder => ({ ...r, collapsed: !!r.collapsed });
  const all = (): SessionFolder[] => db.query("SELECT * FROM session_folders ORDER BY pos, created").all().map(row);
  const one = (id: string): SessionFolder | undefined => { const r = db.query("SELECT * FROM session_folders WHERE id = ?").get(id); return r ? row(r) : undefined; };
  const changed = () => bus.emit({ t: "feature", name: "folders", data: {} });
  const nextPos = (parent: string | null) => (db.query<{ n: number | null }, [string | null]>("SELECT MAX(pos) AS n FROM session_folders WHERE parent_id IS ?").get(parent)?.n ?? 0) + 1;
  // One level of nesting: the parent is a top folder, and a folder with folders of its own stays on top.
  const checkParent = (id: string | null, parent: unknown) => {
    if (parent === null || parent === undefined) return null;
    if (typeof parent !== "string") throw refuse("parent_id is a folder's id or null");
    const p = one(parent);
    if (!p) throw refuse("no such parent folder");
    if (p.parent_id) throw refuse("folders nest one level: the parent is a top folder");
    if (id && (parent === id || db.query("SELECT 1 FROM session_folders WHERE parent_id = ? LIMIT 1").get(id))) throw refuse("a folder that holds folders stays on top");
    return parent;
  };

  registerSessionPatch({
    id: "session-folder",
    fields: ["folder_id"],
    check(_s, b) {
      if (b.folder_id !== null && (typeof b.folder_id !== "string" || !one(b.folder_id))) throw refuse("folder_id is a folder's id or null");
    },
    apply(s, b) {
      store.mergeSettings(s.id, { folder_id: b.folder_id });
    },
  });
  registerListFilter("session-folder", (s, q) => {
    const f = q.get("folder_id");
    return !f || (s.settings.folder_id ?? "none") === f;
  });

  return {
    "/api/session-folders": {
      GET: () => json({ folders: all() }),
      POST: async (req: Request) => {
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        try {
          const parent = checkParent(null, b.parent_id);
          const f: SessionFolder = { id: crypto.randomUUID(), name: cleanName(b.name), parent_id: parent, pos: nextPos(parent), collapsed: false, created: Date.now() };
          db.query("INSERT INTO session_folders (id, name, parent_id, pos, collapsed, created) VALUES (?, ?, ?, ?, 0, ?)").run(f.id, f.name, f.parent_id, f.pos, f.created);
          changed();
          return json({ folder: f }, 201);
        } catch (e: any) {
          if (e?.status) return bad(e.message, e.status);
          throw e;
        }
      },
    },
    "/api/session-folders/:id": {
      PATCH: async (req: any) => {
        const f = one(req.params.id);
        if (!f) return bad("no such folder", 404);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        try {
          if (b.name !== undefined) f.name = cleanName(b.name);
          if (b.parent_id !== undefined) {
            const parent = checkParent(f.id, b.parent_id);
            if (parent !== f.parent_id && b.pos === undefined) f.pos = nextPos(parent);
            f.parent_id = parent;
          }
          if (b.pos !== undefined) {
            if (!Number.isFinite(b.pos)) throw refuse("pos is a number");
            f.pos = b.pos;
          }
          if (b.collapsed !== undefined) f.collapsed = !!b.collapsed;
        } catch (e: any) {
          return bad(e.message, e.status ?? 400);
        }
        db.query("UPDATE session_folders SET name = ?, parent_id = ?, pos = ?, collapsed = ? WHERE id = ?").run(f.name, f.parent_id, f.pos, f.collapsed ? 1 : 0, f.id);
        changed();
        return json({ folder: f });
      },
      DELETE: (req: any) => {
        const f = one(req.params.id);
        if (!f) return bad("no such folder", 404);
        db.transaction(() => {
          db.query("UPDATE session_folders SET parent_id = NULL WHERE parent_id = ?").run(f.id);
          db.query("DELETE FROM session_folders WHERE id = ?").run(f.id);
        })();
        for (const s of [...store.sessions(), ...store.sessions({ archived: true })]) {
          if (s.settings.folder_id === f.id) bus.emit({ t: "session", session: store.mergeSettings(s.id, { folder_id: null })! });
        }
        changed();
        return json({ ok: true });
      },
    },
  };
};
