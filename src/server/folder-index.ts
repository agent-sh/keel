// The folders the folder picker finds by name (GET /api/fs/find): the home
// directory three levels down (~/projects/group/name), two levels under the
// parent of each folder a session used and under the repo roots, and the used
// folders themselves. Read with the asynchronous directory calls, which run off
// the loop, a few at a time; a repository is listed and not entered; folders
// whose name starts with a dot, and build and package folders, are skipped.
// At most MAX_FOLDERS are kept, and the index is reused for INDEX_MS: a
// picker asks once per pause in typing.
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FolderHit } from "../core/folder-match.ts";

export const MAX_FOLDERS = 20_000;
const INDEX_MS = 60_000;
const AT_ONCE = 16;
const SKIP = new Set(["node_modules", ".venv", "target", "dist", "__pycache__", ".next", "build", "vendor"]);

export type Root = { path: string; depth: number };

// Each folder under the roots to its depth, with whether it is a repository
// (a `.git` folder; a `.git` file is a linked worktree's). `partial` when the
// cap cut the walk.
export async function indexFolders(roots: Root[], used: string[] = [], cap = MAX_FOLDERS): Promise<{ folders: FolderHit[]; partial: boolean }> {
  const out = new Map<string, FolderHit>();
  const usedSet = new Set(used);
  let partial = false;
  // A folder read once: whether it is a repository, and its folders.
  const read = async (dir: string): Promise<{ ok: boolean; git: "dir" | "file" | null; kids: string[] }> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const g = entries.find((e) => e.name === ".git");
      return {
        ok: true,
        git: g ? (g.isDirectory() ? "dir" : "file") : null,
        kids: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)).map((e) => join(dir, e.name)),
      };
    } catch {
      return { ok: false, git: null, kids: [] };
    }
  };
  // Breadth first, so a cap keeps the shallow folders.
  let level: { path: string; left: number; root: boolean }[] = [];
  const queued = new Set<string>();
  for (const r of roots) if (!queued.has(r.path)) { queued.add(r.path); level.push({ path: r.path, left: r.depth, root: true }); }
  while (level.length) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += AT_ONCE) {
      const batch = level.slice(i, i + AT_ONCE);
      const got = await Promise.all(batch.map((d) => read(d.path)));
      batch.forEach((d, k) => {
        const { ok, git, kids } = got[k]!;
        if (!ok) return;
        // A root is where the walk starts, not a match of its own unless a session used it.
        if (!d.root || usedSet.has(d.path)) {
          if (out.size >= cap) { partial = true; return; }
          out.set(d.path, { name: basename(d.path), path: d.path, is_git: !!git, ...(git === "file" ? { linked_worktree: true } : {}), ...(usedSet.has(d.path) ? { used: true } : {}) });
        }
        if (git || d.left <= 0) return;
        for (const c of kids) if (!queued.has(c)) { queued.add(c); next.push({ path: c, left: d.left - 1, root: false }); }
      });
    }
    level = next;
  }
  // The used folders the walk did not reach.
  const rest = used.filter((p) => !out.has(p));
  for (let i = 0; i < rest.length; i += AT_ONCE) {
    const batch = rest.slice(i, i + AT_ONCE);
    const got = await Promise.all(batch.map(read));
    batch.forEach((p, k) => { if (!got[k]!.ok) return; if (out.size < cap) out.set(p, { name: basename(p), path: p, is_git: !!got[k]!.git, ...(got[k]!.git === "file" ? { linked_worktree: true } : {}), used: true }); else partial = true; });
  }
  return { folders: [...out.values()], partial };
}

// What an index is of: its roots and the set of used folders, each sorted. The order of the used
// folders (newest first) moves whenever a session works somewhere else, and is not what is walked.
export const indexKey = (roots: Root[], used: string[]): string =>
  JSON.stringify([[...new Set(roots.map((r) => `${r.depth}\u0000${r.path}`))].sort(), [...new Set(used)].sort()]);

// One index at a time, reused while fresh, keyed by what it walks.
let last: { key: string; at: number; job: Promise<{ folders: FolderHit[]; partial: boolean }> } | null = null;
export function folderIndex(roots: Root[], used: string[]): Promise<{ folders: FolderHit[]; partial: boolean }> {
  const key = indexKey(roots, used);
  if (last && last.key === key && Date.now() - last.at < INDEX_MS) return last.job;
  const job = indexFolders(roots, used);
  last = { key, at: Date.now(), job };
  job.catch(() => { if (last?.job === job) last = null; });
  return job;
}
