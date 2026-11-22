// What a sandbox keeps per repository in Keel's state folder
// (`<state>/sandbox/<key>/`): the socket of its network proxy
// (src/safety/net-proxy.ts) and, with the read view, its home and caches.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gitViewsDir, locate } from "../core/git.ts";

export const sandboxRoot = () => join(dirname(gitViewsDir()), "sandbox");
// The repository a workspace is of (its main checkout, so every worktree of
// it shares one scope), else the folder itself.
export function sandboxScope(workspace: string): string {
  let common: string | undefined;
  try { common = locate(workspace)?.common; } catch {} // a folder git cannot read is its own scope
  if (common) return basename(common) === ".git" ? dirname(common) : common;
  try { return realpathSync(workspace); } catch { return resolve(workspace); }
}
// The file that names the scope a folder under the root is of: a folder whose scope is gone can be removed.
export const SCOPE_ORIGIN = "origin";
export function scopeDir(scope: string): string {
  const dir = join(sandboxRoot(), createHash("sha256").update(scope).digest("hex").slice(0, 24));
  let made = false;
  try { made = statSync(dir).isDirectory(); } catch {} // not made yet
  if (!made) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, SCOPE_ORIGIN), scope);
  }
  return dir;
}
