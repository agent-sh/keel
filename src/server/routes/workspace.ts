// Folders and files for the workbench: the folder picker of a new session
// (recent folders, browsing inside the home directory) and the file search
// behind @-mentions in the message box.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { RouteModule } from "../app.ts";
import { heldFile } from "../../core/store-files.ts";
import { git } from "../../core/git.ts";
import { contains, homeDir } from "../../core/paths.ts";
import { rankFolders } from "../../core/folder-match.ts";
import { findRoots, folderIndex } from "../folder-index.ts";
import { countLines, HTML_MAX, imageFacts, shapeOf, tarEntries, textRange, zipEntries } from "../file-preview.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const HOME = homeDir();
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

// The folders a session used, without the worktrees Keel makes for its agents (in its state folder):
// a start box or a folder search that offers one would start in an agent's branch.
export const notManaged = (paths: readonly string[], stateDir: string): string[] => {
  const made = join(stateDir, "worktrees");
  return paths.filter((p) => !contains(made, p));
};

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
  // A file named by `root` and `path` of a request: inside the folder, a file, not held back.
  const fileIn = (u: URL): { root: string; real: string; size: number } | Response => {
    const root = allowed(u.searchParams.get("root"));
    if (!root) return bad("outside the home directory", 403);
    let real: string;
    try { real = realpathSync(resolve(root, u.searchParams.get("path") ?? "")); } catch { return bad("no such file", 404); }
    if (!contains(root, real)) return bad("outside the folder", 403);
    const st = statSync(real);
    if (!st.isFile()) return bad("not a file", 400);
    const held = heldFile(real);
    if (held) return bad(held, 403);
    return { root, real, size: st.size };
  };
  // The folders sessions on this machine worked in, newest first, at most `n`: one grouped read of
  // the table (a picker asks at every pause in typing), not every session parsed. A session placed
  // on another machine (the fleet's column) names a folder there.
  const usedFolders = (n: number): string[] => {
    // (Not the folders of sessions another harness runs: src/core/outside.ts.)
    const here = store.columnExists("sessions", "machine") ? "AND machine IS NULL" : "";
    return store.db.query<{ workspace: string }, [number]>(`SELECT workspace FROM sessions WHERE outside IS NULL ${here} GROUP BY workspace ORDER BY MAX(updated) DESC LIMIT ?`).all(n).map((r) => r.workspace);
  };

  return {
    "/api/workspaces": {
      GET: () => {
        const seen = new Map<string, number>();
        // A session placed on another machine names a folder there, not here.
        for (const s of store.sessions({ archived: true })) if (!s.machine && (!seen.has(s.workspace) || seen.get(s.workspace)! < s.updated)) seen.set(s.workspace, s.updated);
        for (const s of store.sessions()) if (!s.machine && (!seen.has(s.workspace) || seen.get(s.workspace)! < s.updated)) seen.set(s.workspace, s.updated);
        // Not the worktrees Keel made for its agents: the box would start in an agent's branch.
        const kept = new Set(notManaged([...seen.keys()], store.stateDir));
        const recent = [...seen.entries()]
          .filter(([p]) => kept.has(p) && existsSync(p))
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
        const used = notManaged(usedFolders(400), store.stateDir).filter((p) => readable(p)).slice(0, 200);
        const repos = (process.env.KEEL_REPO_ROOTS ?? dirname(resolve(workspace))).split(":").filter(Boolean).map((r) => resolve(r.replace(/^~(?=$|\/)/, HOME)));
        const { folders, partial } = await folderIndex(findRoots(HOME, used, repos), used);
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

    // One file for the Files panel, by its kind (src/server/file-preview.ts): a text range of at most
    // 512 KB from `offset` (a larger file is read in ranges, never whole), a table's line count, the
    // names and sizes inside a ZIP or a tar, an image's size against the limits. A file that is none
    // of these is named with its size and kind.
    "/api/fs/file": {
      GET: async (req: Request) => {
        const u = new URL(req.url);
        const file = fileIn(u);
        if (file instanceof Response) return file;
        const { root, real: p, size } = file;
        const path = relative(root, p);
        const f = Bun.file(p);
        const head = new Uint8Array(await f.slice(0, 8000).arrayBuffer());
        const shape = shapeOf(p, head);
        const base = { path, size, kind: shape.kind, what: shape.what };
        if (shape.kind === "image") return json({ ...base, binary: true, image: { mime: shape.mime, ...imageFacts(head.length < 65_536 ? new Uint8Array(await f.slice(0, 65_536).arrayBuffer()) : head, size) } });
        if (shape.kind === "archive") {
          const l = shape.archive === "zip" ? await zipEntries(f, size) : await tarEntries(f, size, shape.archive === "tgz");
          return json({ ...base, binary: true, archive: l });
        }
        if (shape.kind === "binary") return json({ ...base, binary: true });
        const offset = Math.max(0, Math.floor(Number(u.searchParams.get("offset") ?? 0)) || 0);
        const r = await textRange(f, size, offset);
        const more = r.to < size;
        const rows = (shape.kind === "csv" || shape.kind === "tsv") && offset === 0 ? await countLines(f, size) : null;
        return json({ ...base, text: r.text, from: r.from, to: r.to, truncated: more || r.from > 0, ...(rows ? { rows: rows.lines, rows_exact: rows.exact } : {}), ...(shape.kind === "html" ? { framed: size <= HTML_MAX } : {}) });
      },
    },

    // The file itself, streamed: for the Files panel's raw view, an image and a page in a frame
    // with no script and no network. What is neither is a download.
    "/api/fs/raw": {
      GET: async (req: Request) => {
        const u = new URL(req.url);
        const file = fileIn(u);
        if (file instanceof Response) return file;
        const f = Bun.file(file.real);
        const shape = shapeOf(file.real, new Uint8Array(await f.slice(0, 8000).arrayBuffer()));
        const h: Record<string, string> = { "x-content-type-options": "nosniff", "cache-control": "no-cache", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; sandbox" };
        if (shape.kind === "image") h["content-type"] = shape.mime!;
        else if (shape.kind === "html" && file.size <= HTML_MAX && u.searchParams.get("as") !== "text") {
          h["content-type"] = "text/html; charset=utf-8";
          h["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; sandbox";
        } else if (shape.kind === "archive" || shape.kind === "binary") {
          h["content-type"] = "application/octet-stream";
          h["content-disposition"] = `attachment; filename="${basename(file.real).replace(/["\\\r\n]/g, "_")}"`;
        } else h["content-type"] = "text/plain; charset=utf-8";
        return new Response(f, { headers: h });
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
