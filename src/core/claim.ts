// The claim on a state folder: an exclusive lock on an empty SQLite file of
// its own (never keel.db), held by the kernel for the process. Two starts at
// once cannot both get it, and it ends with the process however it dies, so
// there is no stale claim to take over. Kept per process: a hot reload has it.
import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const CLAIM = "daemon.claim";
const claims: Map<string, Database> = ((globalThis as any).__keelClaims ??= new Map());

export const hasClaim = (stateDir: string) => claims.has(stateDir);

export function claimState(stateDir: string): { release: () => void } | null {
  if (claims.has(stateDir)) return { release: () => {} };
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, CLAIM), { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch (e) {
    db.close();
    if (/^SQLITE_(BUSY|LOCKED)/.test((e as { code?: string }).code ?? "")) return null;
    throw e;
  }
  claims.set(stateDir, db);
  return { release: () => { claims.delete(stateDir); db.close(); } };
}

// The lock is a POSIX record lock: it goes when this process closes any
// handle of the file, so a read of the claim file from inside the daemon
// would drop the claim without a word. The daemon's own file tools ask here
// first and leave the file alone. (Another process, a shell command included,
// can read it freely.)
export function isClaimFile(path: string): boolean {
  if (!claims.size) return false;
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const p = real(path);
  if (basename(p) !== CLAIM) return false;
  for (const dir of claims.keys()) if (real(dir) === dirname(p)) return true;
  return false;
}
export const claimNote = (path: string) => `${path} is the daemon's claim on its state folder. It is empty, and it is not opened from inside the daemon.`;
