// Where a plugin comes from, and its files fetched into a folder of Keel's
// own: a folder on this machine is copied, a git repository is cloned (at a
// branch, tag or commit), and a GitHub owner/repo is that repository's
// address. Nothing the files hold runs here: a clone runs no hook of the
// repository and fetches no submodule.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { cp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { git } from "../core/git.ts";
import { contains } from "../core/paths.ts";

export type Source = { path: string } | { git: string; ref?: string };

const GIT_URL = /^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/;
const SHA = /^[0-9a-f]{40}$/;

// What the owner typed: a path (absolute, ~/, ./ or ../, or one that
// exists), a git URL (with #ref for a branch, tag or commit), or owner/repo.
// A path that is a bare repository is cloned as one.
export function parseSource(input: string, cwd: string): Source | { error: string } {
  const t = input.trim();
  if (!t) return { error: "give a folder, a git URL or owner/repo" };
  const [base, ref] = t.includes("#") && !t.startsWith("/") && !t.startsWith("~") && !t.startsWith(".") ? [t.slice(0, t.lastIndexOf("#")), t.slice(t.lastIndexOf("#") + 1)] : [t, undefined];
  if (GIT_URL.test(base!)) return { git: base!, ...(ref ? { ref } : {}) };
  const p = t.startsWith("~/") ? join(homedir(), t.slice(2)) : isAbsolute(t) ? t : resolve(cwd, t);
  if (existsSync(p)) {
    let dir = false;
    try { dir = statSync(p).isDirectory(); } catch {}
    if (!dir) return { error: `${t} is not a folder` };
    // A bare repository: a HEAD and objects, no work tree.
    if (existsSync(join(p, "HEAD")) && existsSync(join(p, "objects")) && !existsSync(join(p, ".git"))) return { git: p };
    return { path: p };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(base!) && !t.startsWith(".")) return { git: `https://github.com/${base}.git`, ...(ref ? { ref } : {}) };
  return { error: `${t} is not a folder here, a git URL or owner/repo` };
}

// A copy of `from` in `to` (which does not exist yet). A link that leads out
// of the folder is not copied: what it points at is not the plugin's.
export async function copyFolder(from: string, to: string): Promise<string[]> {
  const root = realpathSync(from);
  const left: string[] = [];
  await cp(root, to, {
    recursive: true, verbatimSymlinks: true, errorOnExist: true,
    filter: (src) => {
      const rel = relative(root, src);
      if (rel === ".git" || rel.startsWith(`.git/`)) return false;
      try {
        if (lstatSync(src).isSymbolicLink()) {
          let real: string | null = null;
          try { real = realpathSync(src); } catch {}
          if (!real || !contains(root, real)) { left.push(rel); return false; }
        }
      } catch { return false; }
      return true;
    },
  });
  return [...left, ...(await dropLinksOut(to))];
}

// Every link in `root` whose real place is outside it, or nowhere, taken out
// (a clone keeps a repository's links as they are, and a copied link written
// with an absolute path still points at the folder it was copied from): the
// names of what was taken out.
export async function dropLinksOut(root: string): Promise<string[]> {
  const top = realpathSync(root);
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        let real: string | null = null;
        try { real = realpathSync(p); } catch {}
        if (!real || !contains(top, real)) { out.push(relative(root, p)); await rm(p, { force: true }); }
      } else if (e.isDirectory()) await walk(p);
    }
  };
  await walk(root);
  return out;
}

// The bytes of a folder, counted up to `most`: a folder larger is not read on.
export async function folderSize(dir: string, most: number): Promise<number> {
  let n = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (n > most) return;
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== ".git" || d !== dir) await walk(p); }
      else if (e.isFile()) n += (await stat(p)).size;
    }
  };
  await walk(dir);
  return n;
}

// git through src/core/git.ts: no hook, no prompt for a password, no submodule.
async function run(dir: string, args: string[], o: { mode: "plain" | "own"; gitDir?: string; workTree?: string; signal?: AbortSignal }) {
  const r = await git(dir, args, { ...o, timeout: CLONE_MS });
  if (o.signal?.aborted) throw Object.assign(new Error("stopped: the request that asked for it went away"), { status: 499 });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.err.trim() || r.out.trim() || `exit ${r.code}`).split("\n").slice(-3).join(" ")}`);
  return r.out.trim();
}
// A clone that has not ended in this long is stopped: the request that asked for it waits on it.
const CLONE_MS = 10 * 60_000;

// The repository at `url` (at `ref`) in `to`, without its .git and without
// a link that leads out of it: the commit it is at and the links taken out.
// `signal` ends the clone (the request that asked for it went away).
export async function cloneInto(url: string, ref: string | undefined, to: string, signal?: AbortSignal): Promise<{ commit: string; left: string[] }> {
  const parent = dirname(to);
  const own = { mode: "own" as const, gitDir: join(to, ".git"), workTree: to, signal };
  if (ref && SHA.test(ref)) {
    await run(parent, ["clone", "--quiet", "--no-checkout", "--", url, to], { mode: "plain", signal });
    await run(to, ["checkout", "--quiet", "--detach", ref], own);
  } else await run(parent, ["clone", "--quiet", "--depth", "1", "--no-tags", "--single-branch", ...(ref ? ["--branch", ref] : []), "--", url, to], { mode: "plain", signal });
  const commit = await run(to, ["rev-parse", "HEAD"], own);
  await rm(join(to, ".git"), { recursive: true, force: true });
  return { commit, left: await dropLinksOut(to) };
}

// A folder's content as one digest: the version of a plugin from a folder that names none.
export async function folderDigest(dir: string): Promise<string> {
  const h = createHash("sha256");
  const walk = async (d: string) => {
    const names = (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of names) {
      const p = join(d, e.name);
      h.update(relative(dir, p)).update("\0");
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) h.update(await readFile(p)).update("\0");
    }
  };
  await walk(dir);
  return h.digest("hex").slice(0, 12);
}
