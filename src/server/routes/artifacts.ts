// Artifacts: what a session made, in one place. An index, never a copy: the
// files its edit tools wrote (created or changed), the files its commands
// changed in its folder (from the turn's checkpoint diff), and the files in its
// artifacts folder (a folder of its own the prompt names for reports, charts and
// pages). A preview reads the file when asked. The pages are told at once
// ("artifacts" frames), so the list grows while the session works.
import { heldFile } from "../../core/store-files.ts";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { artifactsDir, contains, realOf } from "../../core/paths.ts";
import type { Session } from "../../core/types.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { classifyCall } from "../../safety/gate.ts";
import { toolEnv } from "../../tools/jobs.ts";
import type { RouteModule } from "../app.ts";
import { checkpoints } from "./checkpoints.ts";
import { openPlan } from "./places.ts";
import { projectOfSession } from "./projects.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, path TEXT NOT NULL,
  created INTEGER NOT NULL, source TEXT NOT NULL, tool TEXT, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, writes INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, path));
CREATE INDEX IF NOT EXISTS artifacts_recent ON artifacts(session_id, last_ts);
`;

export type ArtifactKind = "image" | "html" | "markdown" | "code";
// `place`: in the session's folder (`rel` is from there), in its artifacts folder, or elsewhere.
export type Artifact = { session_id: string; path: string; rel: string; place: "folder" | "artifacts" | "elsewhere"; name: string; kind: ArtifactKind; created: boolean; source: "edit" | "shell" | "folder"; tool: string | null; first_ts: number; last_ts: number; writes: number; exists: boolean; bytes: number | null };

const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
export const kindOf = (p: string): ArtifactKind => {
  const e = extname(p).toLowerCase();
  return e in IMAGE ? "image" : e === ".html" || e === ".htm" ? "html" : e === ".md" || e === ".markdown" ? "markdown" : "code";
};
// A page or an image is shown with scripts at most, in an opaque origin, and
// reaches nothing: no network, no other page of the daemon.
const SANDBOX = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:";
const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const artifactRoutes: RouteModule = ({ store, bus, errors }) => {
  store.migrate(SCHEMA);
  const db = store.db;
  const rootOf = (s: Session) => {
    for (let n = 0; s.parent_id && !s.machine && n < 32; n++) s = store.session(s.parent_id) ?? s;
    return s;
  };
  const dirOf = (s: Session) => artifactsDir(store.stateDir, rootOf(s).id);
  const told = (id: string) => bus.emit({ t: "feature", name: "artifacts", session_id: rootOf(store.session(id) ?? ({ id } as Session)).id, data: {} });
  const upsert = (sid: string, path: string, created: boolean, source: Artifact["source"], tool: string | null) => {
    const now = Date.now();
    db.query(`INSERT INTO artifacts (session_id, path, created, source, tool, first_ts, last_ts, writes) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
              ON CONFLICT(session_id, path) DO UPDATE SET last_ts = excluded.last_ts, writes = writes + 1, tool = COALESCE(excluded.tool, tool)`)
      .run(sid, path, created ? 1 : 0, source, tool, now, now);
  };

  // The artifacts folder: what is there and newer than its row.
  const scanDir = (s: Session) => {
    const dir = dirOf(s);
    if (!existsSync(dir)) return false;
    const owner = rootOf(s).id;
    const rows = new Map(db.query<{ path: string; last_ts: number }, [string]>("SELECT path, last_ts FROM artifacts WHERE session_id = ?").all(owner).map((r) => [r.path, r.last_ts]));
    let any = false;
    for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const p = join(e.parentPath, e.name);
      const m = statSync(p).mtimeMs;
      const at = rows.get(p);
      if (at !== undefined && at >= m) continue;
      upsert(owner, p, at === undefined, "folder", null);
      any = true;
    }
    return any;
  };

  // Calls in flight: which files an edit is about to write, and whether each was there.
  const pending = new Map<string, { paths: string[]; existed: Set<string> }>();
  const commanded = new Set<string>(); // sessions whose turn ran a command
  registerHooks({
    // The folder is the owner's side of the block (hooks.ts SystemBlock): a changed path is taken at the next daemon start.
    sessionSystem: (s) => {
      if (s.machine) return { name: "Artifacts", text: "", data: "" };
      const dir = dirOf(s);
      try { mkdirSync(dir, { recursive: true }); } catch (e) { errors.capture("server", e, { at: "artifacts folder", session: s.id }); }
      return { name: "Artifacts", data: dir, text: `Artifacts: files you make for the owner to look at (a report, a chart, an HTML page, a summary in markdown) go in ${dir}/, unless they name a place. They see them, with what you created or changed in their folders, in the session's Artifacts.` };
    },
    beforeTool: (s, call) => {
      if (s.machine) return;
      const c = classifyCall(call);
      if (c.kind === "edit") pending.set(call.id, { paths: c.paths, existed: new Set(c.paths.filter((p) => existsSync(p))) });
    },
    afterTool: (s, call, result) => {
      if (s.machine) return;
      const p = pending.get(call.id);
      pending.delete(call.id);
      try {
        if (p && !result.is_error) {
          for (const path of p.paths) if (existsSync(path)) upsert(s.id, path, !p.existed.has(path), "edit", call.tool.name);
          told(s.id);
        } else if (!p && classifyCall(call).kind !== "read") {
          commanded.add(s.id);
          if (scanDir(s)) told(s.id);
        }
      } catch (e) {
        errors.capture("server", e, { at: "artifacts index", session: s.id });
      }
    },
    // What the turn's commands changed in the folder: the checkpoint of the
    // turn names the files (the files another writer changed meanwhile are
    // left out); a session whose checkpoint keeps only written files has none.
    turnEnd: async (s) => {
      if (s.machine || !commanded.delete(s.id)) return;
      try {
        const turn = db.query<{ n: number | null }, [string]>("SELECT MAX(turn) AS n FROM checkpoints WHERE session_id = ? AND at = 'end'").get(s.id)?.n;
        if (turn !== null && turn !== undefined && checkpoints) {
          const d = await checkpoints.diff(s, { turn });
          for (const f of d.files) {
            if (f.outside || f.status.startsWith("D")) continue;
            const path = join(s.workspace, f.path);
            if (!db.query("SELECT 1 FROM artifacts WHERE session_id = ? AND path = ?").get(s.id, path)) upsert(s.id, path, f.status.startsWith("A") || f.status === "?", "shell", null);
          }
        }
        scanDir(s);
      } catch (e) {
        if (!/no checkpoint|expired/.test(String((e as Error)?.message))) errors.capture("server", e, { at: "artifacts turn", session: s.id });
      }
      told(s.id);
    },
  });

  const view = (r: any, s: Session): Artifact => {
    let bytes: number | null = null;
    try { bytes = statSync(r.path).size; } catch {}
    const dir = dirOf(s);
    const place = contains(dir, r.path) ? "artifacts" : contains(s.workspace, r.path) ? "folder" : "elsewhere";
    const rel = place === "artifacts" ? relative(dir, r.path) : place === "folder" ? relative(s.workspace, r.path) : r.path;
    return { ...r, created: !!r.created, rel, place, name: basename(r.path), kind: kindOf(r.path), exists: bytes !== null, bytes };
  };
  const listOf = (s: Session) => {
    scanDir(s);
    const ids = [s.id, ...store.descendants(s.id)];
    return db.query(`SELECT * FROM artifacts WHERE session_id IN (${ids.map(() => "?").join(",")}) ORDER BY last_ts DESC`).all(...ids).map((r) => view(r, s));
  };
  // A file the page may read: one of the session's artifacts, or in its artifacts folder.
  const allowed = (s: Session, path: string | null) => {
    if (!path) return null;
    const ids = [s.id, ...store.descendants(s.id)];
    if (db.query(`SELECT 1 FROM artifacts WHERE path = ? AND session_id IN (${ids.map(() => "?").join(",")})`).get(path, ...ids)) return path;
    const real = realOf(path);
    return contains(realOf(dirOf(s)), real) ? real : null;
  };

  return {
    "/api/sessions/:id/artifacts": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.machine) return json({ dir: null, artifacts: [], elsewhere: true });
        return json({ dir: dirOf(s), artifacts: listOf(s) });
      },
    },
    // The file itself: an image or a page under a sandbox that reaches nothing,
    // anything else as plain text; download=1 saves it.
    "/api/sessions/:id/artifacts/raw": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const u = new URL(req.url);
        const path = allowed(s, u.searchParams.get("path"));
        if (!path) return bad("not an artifact of this session", 404);
        { const held = heldFile(path); if (held) return bad(held, 403); }
        const f = Bun.file(path);
        if (!existsSync(path) || statSync(path).isDirectory()) return bad("the file is gone", 404);
        const e = extname(path).toLowerCase();
        const type = IMAGE[e] ?? (kindOf(path) === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
        const headers: Record<string, string> = { "content-type": type, "x-content-type-options": "nosniff", "content-security-policy": SANDBOX, "cache-control": "no-cache", "referrer-policy": "no-referrer" };
        if (u.searchParams.get("download") === "1") headers["content-disposition"] = `attachment; filename="${basename(path).replace(/["\\\r\n]/g, "_")}"`;
        return new Response(f, { headers });
      },
    },
    // Opens an artifact in the owner's editor, from a page on this machine only.
    "/api/sessions/:id/artifacts/open": {
      POST: async (req: Request, srv: Bun.Server<unknown>) => {
        const ip = srv.requestIP(req)?.address ?? "";
        if (!LOOPBACK.has(ip) || FORWARDED.some((h) => req.headers.has(h))) return bad("files can only be opened from a browser on the daemon's own machine", 403);
        const s = store.session((req as any).params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        const path = allowed(s, typeof b.path === "string" ? b.path : null);
        if (!path || !existsSync(path)) return bad("not an artifact of this session", 404);
        const { argv, opened } = openPlan(process.env, path);
        try {
          Bun.spawn(argv, { cwd: s.workspace, env: toolEnv(s.id), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
        } catch (e) {
          return bad(`could not start ${argv[0]}: ${(e as Error).message}`, 409);
        }
        return json({ ok: true, opened });
      },
    },
    // Every artifact of a project's sessions, newest first, each with its session.
    "/api/projects/:id/artifacts": {
      GET: (req: any) => {
        const out: (Artifact & { session_title: string })[] = [];
        for (const s of [...store.sessions(), ...store.sessions({ archived: true })]) {
          if (s.parent_id || s.machine || projectOfSession?.(s)?.id !== req.params.id) continue;
          for (const a of listOf(s)) out.push({ ...a, session_id: s.id, session_title: s.title });
        }
        out.sort((a, b) => b.last_ts - a.last_ts);
        return json({ artifacts: out });
      },
    },
  };
};
