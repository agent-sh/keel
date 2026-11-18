// Folders and files for the workbench: the folder picker of a new session
// (recent folders, browsing inside the home directory) and the file search
// behind @-mentions in the message box.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const HOME = homedir();
const SKIP = new Set([".git", "node_modules", ".venv", "target", "dist", ".cache", "__pycache__", ".next", "build"]);
const MAX_FILES = 50_000;

const isGit = (p: string) => existsSync(join(p, ".git"));
const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// File lists are cached a few seconds per folder: typing an @-query asks per key.
const cache = new Map<string, { at: number; files: string[] }>();
async function listFiles(root: string): Promise<string[]> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < 10_000) return hit.files;
  let files: string[] = [];
  if (isGit(root)) {
    const p = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) === 0) files = out.split("\0").filter(Boolean).slice(0, MAX_FILES);
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
  const allowed = (raw: string | null): string | null => {
    if (!raw) return null;
    const p = resolve(raw.replace(/^~(?=$|\/)/, HOME));
    let real: string;
    try { real = realpathSync(p); } catch { return null; }
    return inside(HOME, real) || inside(resolve(workspace), real) ? real : null;
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

    "/api/fs/dirs": {
      GET: (req: Request) => {
        const raw = new URL(req.url).searchParams.get("path") || HOME;
        const p = allowed(raw);
        if (!p) return bad("outside the home directory", 403);
        if (!statSync(p).isDirectory()) return bad("not a directory", 404);
        const dirs = readdirSync(p, { withFileTypes: true })
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
        if (!inside(root, p)) return bad("outside the folder", 403);
        const st = statSync(p);
        if (!st.isFile()) return bad("not a file", 400);
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
