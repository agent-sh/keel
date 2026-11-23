// Folders and files for the workbench: the folder picker of a new session
// (recent folders, browsing inside the home directory) and the file search
// behind @-mentions in the message box.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { RouteModule } from "../app.ts";
import { heldFile } from "../../core/store-files.ts";
import { git } from "../../core/git.ts";
import { contains } from "../../core/paths.ts";
import { rankFolders } from "../../core/folder-match.ts";
import { folderIndex, type Root } from "../folder-index.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const HOME = homedir();
const SKIP = new Set([".git", "node_modules", ".venv", "target", "dist", ".cache", "__pycache__", ".next", "build"]);
const MAX_FILES = 50_000;

const isGit = (p: string) => existsSync(join(p, ".git"));

// File lists are cached a few seconds per folder: typing an @-query asks per key.
const cache = new Map<string, { at: number; files: string[] }>();
async function listFiles(root: string): Promise<string[]> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < 10_000) return hit.files;
  let files: string[] = [];
  if (isGit(root)) {
    const r = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { read: true });
    if (r.code === 0) files = r.out.split("\0").filter(Boolean).slice(0, MAX_FILES);
  }
  if (!files.length) {
    const walk = (dir: string, depth: number) => {
      if (files.length >= MAX_FILES || depth > 12) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile()) files.push(relative(root, p));
      }
    };
    walk(root, 0);
  }
  // Lists past their few seconds are dropped, not kept for every folder ever asked.
  for (const [k, v] of cache) if (Date.now() - v.at >= 10_000) cache.delete(k);
  cache.set(root, { at: Date.now(), files });
  return files;
}

// Subsequence match over the path, favoring hits in the file name.
function score(q: string, path: string): number {
  const s = path.toLowerCase();
  const name = s.slice(s.lastIndexOf("/") + 1);
  if (name.startsWith(q)) return 3000 - s.length;
  const ni = name.indexOf(q);
  if (ni >= 0) return 2500 - ni - s.length;
  const pi = s.indexOf(q);
  if (pi >= 0) return 2000 - pi - s.length;
  let j = 0, sc = 0, run = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) { j++; run++; sc += 1 + run + (i === 0 || "/._-".includes(s[i - 1]!) ? 5 : 0); } else run = 0;
  }
  return j === q.length ? sc - s.length / 50 : -1;
}

export const workspaceRoutes: RouteModule = ({ store, workspace }) => {
  // A folder the page may read: inside the home directory or the daemon's workspace.
  const readable = (real: string) => contains(HOME, real) || contains(resolve(workspace), real);
  const allowed = (raw: string | null): string | null => {
    if (!raw) return null;
    const p = resolve(raw.replace(/^~(?=$|\/)/, HOME));
    let real: string;
    try { real = realpathSync(p); } catch { return null; }
    return readable(real) ? real : null;
  };
  // The folders sessions on this machine worked in, newest first.
  const usedFolders = (): string[] => {
    const seen = new Map<string, number>();
    for (const s of [...store.sessions({ archived: true }), ...store.sessions()]) if (!s.machine && (seen.get(s.workspace) ?? -1) < s.updated) seen.set(s.workspace, s.updated);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  };

  return {
    "/api/workspaces": {
      GET: () => {
        const seen = new Map<string, number>();
        // A session placed on another machine names a folder there, not here.
        for (const s of store.sessions({ archived: true })) if (!s.machine && (!seen.has(s.workspace) || seen.get(s.workspace)! < s.updated)) seen.set(s.workspace, s.updated);
        for (const s of store.sessions()) if (!s.machine && (!seen.has(s.workspace) || seen.get(s.workspace)! < s.updated)) seen.set(s.workspace, s.updated);
        const recent = [...seen.entries()]
          .filter(([p]) => existsSync(p))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([path, last]) => ({ path, name: basename(path), is_git: isGit(path), last }));
        return json({ default: resolve(workspace), home: HOME, recent });
      },
    },

    // Folders found by name for the picker (src/server/folder-index.ts), best first
    // (src/core/folder-match.ts): the home three levels down, two levels under the
    // parent of each folder a session used and under the repo roots, and those folders.
    "/api/fs/find": {
      GET: async (req: Request) => {
        const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
        const used = usedFolders().filter((p) => readable(p)).slice(0, 200);
        const roots: Root[] = [{ path: HOME, depth: 3 }];
        for (const p of used) if (dirname(p) !== p && contains(HOME, dirname(p)) && dirname(p) !== HOME) roots.push({ path: dirname(p), depth: 2 });
        for (const r of (process.env.KEEL_REPO_ROOTS ?? dirname(resolve(workspace))).split(":").filter(Boolean)) {
          const p = resolve(r.replace(/^~(?=$|\/)/, HOME));
          if (contains(HOME, p) && p !== HOME) roots.push({ path: p, depth: 2 });
        }
        const { folders, partial } = await folderIndex(roots, used);
        return json({ hits: q ? rankFolders(q, folders, 20) : [], partial, folders: folders.length });
      },
    },

    // A folder's folders. A path that cannot open says why: 404 when nothing is there or it
    // is a file, 403 when it is outside the folders the page may read or cannot be read.
    // A path that does not start at the root or the home is taken from the home.
    "/api/fs/dirs": {
      GET: (req: Request) => {
        const raw = new URL(req.url).searchParams.get("path") || HOME;
        const full = resolve(HOME, raw.replace(/^~(?=$|\/)/, HOME));
        const shown = full.startsWith(HOME) ? "~" + full.slice(HOME.length) : full;
        let real: string;
        try { real = realpathSync(full); } catch { return bad(`No folder at ${shown}.`, 404); }
        if (!readable(real)) return bad(`${shown} is outside your home folder. The picker opens folders inside ~ only.`, 403);
        const p = real;
        if (!statSync(p).isDirectory()) return bad(`${shown} is a file, not a folder.`, 404);
        let entries;
        try { entries = readdirSync(p, { withFileTypes: true }); } catch (e) { return bad(`Cannot read ${shown}: ${(e as NodeJS.ErrnoException).code === "EACCES" ? "permission denied" : (e as Error).message}.`, 403); }
        const dirs = entries
          .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".") && !SKIP.has(e.name))
          .map((e) => join(p, e.name))
          .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 500)
          .map((d) => ({ name: basename(d), path: d, is_git: isGit(d) }));
        return json({ path: p, parent: p === HOME ? null : dirname(p), dirs, is_git: isGit(p) });
      },
    },

    // One text file for the Files panel: inside the folder it was asked from, at most 512 KB.
    "/api/fs/file": {
      GET: async (req: Request) => {
        const u = new URL(req.url);
        const root = allowed(u.searchParams.get("root"));
        if (!root) return bad("outside the home directory", 403);
        let p: string;
        try { p = realpathSync(resolve(root, u.searchParams.get("path") ?? "")); } catch { return bad("no such file", 404); }
        if (!contains(root, p)) return bad("outside the folder", 403);
        const st = statSync(p);
        if (!st.isFile()) return bad("not a file", 400);
        { const held = heldFile(p); if (held) return bad(held, 403); }
        const f = Bun.file(p);
        const head = new Uint8Array(await f.slice(0, 8000).arrayBuffer());
        if (head.includes(0)) return json({ path: relative(root, p), size: st.size, binary: true });
        const LIMIT = 512 * 1024;
        return json({ path: relative(root, p), size: st.size, truncated: st.size > LIMIT, text: await f.slice(0, LIMIT).text() });
      },
    },

    "/api/fs/files": {
      GET: async (req: Request) => {
        const u = new URL(req.url);
        const root = allowed(u.searchParams.get("path"));
        if (!root) return bad("outside the home directory", 403);
        const q = (u.searchParams.get("q") ?? "").toLowerCase().replace(/^\.\//, "");
        const files = await listFiles(root);
        const dirs = new Set<string>();
        for (const f of files) {
          let i = f.indexOf("/");
          while (i > 0 && dirs.size < 20_000) { dirs.add(f.slice(0, i + 1)); i = f.indexOf("/", i + 1); }
        }
        const all = [...[...dirs].map((d) => ({ path: d, dir: true })), ...files.map((f) => ({ path: f, dir: false }))];
        const hits = q
          ? all.map((h) => ({ ...h, s: score(q, h.path) })).filter((h) => h.s >= 0).sort((a, b) => b.s - a.s)
          : all.filter((h) => !h.path.slice(0, -1).includes("/")).map((h) => ({ ...h, s: 0 }));
        return json({ root, total: files.length, hits: hits.slice(0, 30).map(({ path, dir }) => ({ path, dir })) });
      },
    },
  };
};
