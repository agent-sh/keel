// Projects: a named group of sessions across one or more folders, with its
// own instructions, files to read, and defaults for a new session. A session
// belongs to the project it was put in (settings.project), else to the
// project that holds its folder (a worktree's: the folder of its repository);
// "none" keeps it out. The instructions and the files are one block of each
// member's own part of the system prompt (after the cache split, so the prefix
// other sessions share never changes); a change has the members' prompts made
// again at their next turn, where the kept prompt names the changed block.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Session } from "../../core/types.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { asksLess, isMode } from "../../safety/policy.ts";
import { registerListFilter, registerSessionPatch, type RouteModule } from "../app.ts";
import { gate, presence } from "./permissions.ts";

export type ProjectDefaults = { model?: string; mode?: string };
export type Project = { id: string; name: string; instructions: string; folders: string[]; files: string[]; defaults: ProjectDefaults; pos: number; created: number; updated: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
  folders TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]', defaults TEXT NOT NULL DEFAULT '{}',
  pos REAL NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
`;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const refuse = (message: string, status = 400) => Object.assign(new Error(message), { status });
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// One line of text: a name.
function cleanName(v: unknown): string {
  const n = typeof v === "string" ? v.trim() : "";
  if (!n) throw refuse("a project has a name");
  if (n.length > 200 || /[\u0000-\u001f\u007f]/.test(n)) throw refuse("a project name is one line of at most 200 characters");
  return n;
}
// Absolute paths, without repeats, each an existing folder (or file).
function cleanPaths(v: unknown, what: "folders" | "files"): string[] {
  if (!Array.isArray(v) || v.some((p) => typeof p !== "string" || !p.trim())) throw refuse(`${what} is a list of paths`);
  const out: string[] = [];
  for (const raw of v as string[]) {
    const p = expand(raw.trim());
    if (what === "folders" ? !isDir(p) : !existsSync(p) || isDir(p)) throw refuse(`not ${what === "folders" ? "a folder" : "a file"}: ${p}`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

// The project of a path: the one whose folder holds it most closely.
export function projectByFolder(projects: Project[], paths: (string | undefined)[]): Project | undefined {
  let best: Project | undefined, len = -1;
  for (const path of paths) {
    if (!path) continue;
    for (const p of projects) for (const f of p.folders) if ((path === f || path.startsWith(f.endsWith("/") ? f : `${f}/`)) && f.length > len) { best = p; len = f.length; }
  }
  return best;
}

export let projectOfSession: ((s: Session) => Project | undefined) | undefined;

export const projectRoutes: RouteModule = ({ store, bus, engine, providers }) => {
  store.migrate(SCHEMA);
  const db = store.db;
  const row = (r: any): Project => ({ ...r, folders: JSON.parse(r.folders), files: JSON.parse(r.files), defaults: JSON.parse(r.defaults) });
  const all = (): Project[] => db.query("SELECT * FROM projects ORDER BY pos, created").all().map(row);
  const one = (id: string): Project | undefined => { const r = db.query("SELECT * FROM projects WHERE id = ?").get(id); return r ? row(r) : undefined; };
  const repoRoot = (id: string) => {
    try { return db.query<{ repo_root: string }, [string]>("SELECT repo_root FROM worktrees WHERE session_id = ?").get(id)?.repo_root; } catch { return undefined; }
  };

  // A subagent is in its parent's project; a session on another machine is
  // only in one it was put in (its folder is that machine's).
  const projectOf = (s: Session, list = all()): Project | undefined => {
    for (let hops = 0; s.parent_id && hops < 32; hops++) { const p = store.session(s.parent_id); if (!p) break; s = p; }
    const set = s.settings.project;
    if (set === "none") return undefined;
    if (set) { const p = list.find((x) => x.id === set); if (p) return p; }
    return s.machine ? undefined : projectByFolder(list, [s.workspace, repoRoot(s.id)]);
  };
  projectOfSession = (s) => projectOf(s);
  const members = (list = all()) => {
    const out: Record<string, string> = {};
    for (const s of [...store.sessions(), ...store.sessions({ archived: true })]) {
      if (s.parent_id) continue;
      const p = projectOf(s, list);
      if (p) out[s.id] = p.id;
    }
    return out;
  };

  // Who is in which project, as last told to the pages: a session that moves
  // in or out has its prompt made again and the pages are told.
  let known = members();
  const changed = () => bus.emit({ t: "feature", name: "projects", data: {} });
  const refresh = (forget: Iterable<string> = []) => {
    const now = members();
    const ids = new Set(forget);
    for (const id of new Set([...Object.keys(known), ...Object.keys(now)])) if (known[id] !== now[id]) ids.add(id);
    known = now;
    for (const id of ids) {
      engine.forgetSystem(id);
      for (const d of store.descendants(id)) engine.forgetSystem(d);
    }
    changed();
  };
  bus.on((f) => {
    if (f.t !== "session" || f.session.parent_id) return;
    const p = projectOf(f.session);
    if ((p?.id) !== known[f.session.id]) refresh();
  });

  // The block of each member's prompt. The files are named, not copied in: the
  // model reads the one a task needs, and an edit to a file does not make the
  // prompt again.
  registerHooks({
    sessionSystem: (s) => {
      const p = projectOf(s);
      if (!p || (!p.instructions.trim() && !p.files.length)) return "";
      const files = p.files.length ? `\n\nFiles of the project (read the ones the task touches):\n${p.files.map((f) => `- ${f}`).join("\n")}` : "";
      return `Project instructions (${p.name}): this session is part of the project ${p.name}.${p.instructions.trim() ? `\n\n${p.instructions.trim()}` : ""}${files}`;
    },
  });

  // A default mode that asks less than the daemon's default needs the owner
  // at this machine or his passkey, as loosening a session's mode does.
  const checkDefaults = async (req: Request, d: unknown): Promise<ProjectDefaults> => {
    if (!d || typeof d !== "object" || Array.isArray(d)) throw refuse("defaults is an object");
    const out: ProjectDefaults = {};
    const { model, mode } = d as Record<string, unknown>;
    if (model !== undefined && model !== null && model !== "") {
      if (typeof model !== "string") throw refuse("defaults.model is a model id");
      await providers.resolve(model).catch(() => { throw refuse(`no listed model ${model}`); });
      out.model = model;
    }
    if (mode !== undefined && mode !== null && mode !== "") {
      if (!isMode(mode)) throw refuse(`unknown mode: ${mode}`);
      if (gate && asksLess(mode, gate.defaultMode()) && presence && !presence.allows(req, "project-mode")) throw Object.assign(refuse("this needs your passkey from a remote device", 428), { presence: { action: "project-mode" } });
      out.mode = mode;
    }
    return out;
  };
  const guard = async (f: () => Promise<Response>) => {
    try { return await f(); } catch (e: any) {
      if (e?.status) return json({ error: e.message, ...(e.presence ? { presence: e.presence } : {}) }, e.status);
      throw e;
    }
  };
  const write = (p: Project) => {
    db.query("INSERT OR REPLACE INTO projects (id, name, instructions, folders, files, defaults, pos, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.name, p.instructions, JSON.stringify(p.folders), JSON.stringify(p.files), JSON.stringify(p.defaults), p.pos, p.created, p.updated);
  };
  const fields = async (req: Request, b: any, p: Project) => {
    if (b.name !== undefined) p.name = cleanName(b.name);
    if (b.instructions !== undefined) {
      if (typeof b.instructions !== "string") throw refuse("instructions is text");
      p.instructions = b.instructions;
    }
    if (b.folders !== undefined) p.folders = cleanPaths(b.folders, "folders");
    if (b.files !== undefined) p.files = cleanPaths(b.files, "files");
    if (b.defaults !== undefined) p.defaults = await checkDefaults(req, b.defaults);
    if (b.pos !== undefined) {
      if (!Number.isFinite(b.pos)) throw refuse("pos is a number");
      p.pos = b.pos;
    }
  };

  // A session is put in a project, taken out of every one ("none"), or
  // given back to the project of its folder (null). A session with no
  // history yet (one being made, or one not started) takes the project's
  // default mode; one that has worked keeps its own.
  registerSessionPatch({
    id: "project",
    fields: ["project"],
    check(_s, b) {
      if (b.project !== null && b.project !== "none" && (typeof b.project !== "string" || !one(b.project))) throw refuse("project is a project's id, \"none\" or null");
    },
    apply(s, b) {
      const p = b.project && b.project !== "none" ? one(b.project) : undefined;
      // A project the folder already gives is not kept: moving the session to
      // another folder then follows that folder.
      const byFolder = s.machine ? undefined : projectByFolder(all(), [s.workspace, repoRoot(s.id)]);
      store.mergeSettings(s.id, { project: b.project === null || (p && byFolder?.id === p.id) ? null : b.project });
      const fresh = !store.events(s.id).length;
      if (fresh && p?.defaults.mode && gate) gate.setPerm(s.id, { mode: p.defaults.mode as any });
    },
  });
  registerListFilter("project", (s, q) => {
    const want = q.get("project");
    return !want || (projectOf(s)?.id ?? "none") === want;
  });

  return {
    "/api/projects": {
      GET: () => json({ projects: all(), members: members() }),
      POST: (req: Request) => guard(async () => {
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        const now = Date.now();
        const last = db.query<{ n: number | null }, []>("SELECT MAX(pos) AS n FROM projects").get()?.n ?? 0;
        const p: Project = { id: crypto.randomUUID(), name: "", instructions: "", folders: [], files: [], defaults: {}, pos: last + 1, created: now, updated: now };
        await fields(req, { name: "", ...b }, p);
        write(p);
        refresh();
        return json({ project: p }, 201);
      }),
    },
    "/api/projects/:id": {
      GET: (req: any) => {
        const p = one(req.params.id);
        return p ? json({ project: p, sessions: Object.entries(members()).filter(([, pid]) => pid === p.id).map(([sid]) => sid) }) : bad("no such project", 404);
      },
      PATCH: (req: any) => guard(async () => {
        const p = one(req.params.id);
        if (!p) return bad("no such project", 404);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        await fields(req, b, p);
        p.updated = Date.now();
        write(p);
        // Its members' prompts are made again at their next turn (a block that did not change keeps the prompt as it was).
        refresh(Object.entries(known).filter(([, pid]) => pid === p.id).map(([sid]) => sid));
        return json({ project: p });
      }),
      DELETE: (req: any) => {
        const p = one(req.params.id);
        if (!p) return bad("no such project", 404);
        const was = Object.entries(known).filter(([, pid]) => pid === p.id).map(([sid]) => sid);
        db.query("DELETE FROM projects WHERE id = ?").run(p.id);
        for (const s of [...store.sessions(), ...store.sessions({ archived: true })]) {
          if (s.settings.project === p.id) bus.emit({ t: "session", session: store.mergeSettings(s.id, { project: null })! });
        }
        refresh(was);
        return json({ ok: true });
      },
    },
  };
};
