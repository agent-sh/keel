// The look at the files under a folder that hold credentials (credential-reads.ts namedUnder), made off the loop.
// The folder is read with the async file calls, a few at a time, so a busy loop only slows the look and never makes it
// late by itself; the answer is kept per folder with the modification time of every folder it read, and a repeat
// search is answered after one stat of each of those (a changed folder is read again). A look that does not finish
// in its time says how long it took and how much it had read, so the search can be narrowed.
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homeOf } from "./credentials.ts";
import type { Classifier, Found } from "./credential-reads.ts";

// The folders a look does not enter: a repository's own store and the installed packages.
const NOT_ENTERED = new Set([".git", "node_modules"]);
// What one folder's look reads at most, and may take. The entries are the folder's, all levels together; a folder
// of 20,000 entries is read in about a third of the time (see WALK_MS's measurement in the commit), so the time is
// room for a slow disk and a loaded machine, not what a look usually takes.
export const WALK_ENTRIES = 20_000;
export const WALK_MS = 5_000;
export const WALK_NAMES = 20;
// How long an answer stands whatever the folders' times say (a hard link made elsewhere does not touch them).
const STANDS_MS = 60_000;
const DIRS_AT_ONCE = 16, FILES_AT_ONCE = 32;

type Kept = { at: number; found: Found[]; stamps: Map<string, number> };
const kept = new Map<string, Kept>();
const running = new Map<string, Promise<Found[]>>();

/** Test seam: forget what was kept. */
export function forgetLooks() { kept.clear(); running.clear(); }

async function pool<T>(items: T[], width: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) await run(items[next++]!); }));
}

// Whether every folder the answer was made from has the time it had then.
async function unchanged(k: Kept): Promise<boolean> {
  if (performance.now() - k.at > STANDS_MS) return false;
  let same = true;
  await pool([...k.stamps], FILES_AT_ONCE, async ([dir, at]) => {
    if (!same) return;
    try { if ((await lstat(dir)).mtimeMs !== at) same = false; } catch { same = false; }
  });
  return same;
}

// The files under `folder` that hold credentials, as namedUnder finds them, off the loop. `scope`: what the classifier
// depends on besides the home (the places it lists), so a look made for other places is not reused.
export function lookUnder(folder: string, is: Classifier, o: { scope?: string; ms?: number; entries?: number } = {}): Promise<Found[]> {
  const key = `${homeOf()}\0${o.scope ?? ""}\0${folder}`;
  const running1 = running.get(key);
  if (running1) return running1;
  const run = (async () => {
    const had = kept.get(key);
    if (had && await unchanged(had)) return had.found;
    const made = await walk(folder, is, o.ms ?? WALK_MS, o.entries ?? WALK_ENTRIES);
    // (A look that ran out of time is not kept: the next search tries again.)
    if (!made.late) {
      kept.set(key, { at: performance.now(), found: made.found, stamps: made.stamps });
      if (kept.size > 64) for (const k of kept.keys()) { kept.delete(k); if (kept.size <= 32) break; }
    } else kept.delete(key);
    return made.found;
  })().finally(() => { running.delete(key); });
  running.set(key, run);
  return run;
}

async function walk(folder: string, is: Classifier, ms: number, limit: number): Promise<{ found: Found[]; stamps: Map<string, number>; late: boolean }> {
  const began = performance.now();
  const end = began + ms;
  const names = new Map<string, Found>();
  const stamps = new Map<string, number>();
  let seen = 0, late = false;
  for (let level = [folder]; level.length && seen < limit && names.size < WALK_NAMES && !late; ) {
    const next: string[] = [];
    await pool(level, DIRS_AT_ONCE, async (d) => {
      if (late || seen >= limit) return;
      if (performance.now() > end) { late = true; return; }
      let entries;
      try {
        // (The time first: a folder that changes while it is read is read again at the next search.)
        const st = await lstat(d);
        entries = await readdir(d, { withFileTypes: true });
        stamps.set(d, st.mtimeMs);
      } catch { return; }
      const files: string[] = [];
      for (const e of entries) {
        if (seen++ >= limit) break;
        const p = join(d, e.name);
        if (e.isDirectory()) { if (!NOT_ENTERED.has(e.name)) next.push(p); continue; }
        if (e.isSymbolicLink()) { if (is.link(p)) names.set(p, { path: p, foreign: true }); else if (is.by(p)) names.set(p, { path: p }); continue; }
        if (e.isFile()) files.push(p);
      }
      // A file with more than one name may be another name for a listed one: the count of names is read for each.
      await pool(files, FILES_AT_ONCE, async (p) => {
        if (performance.now() > end) { late = true; return; }
        let foreign = false;
        try { foreign = (await lstat(p)).nlink > 1 && !!is.link(p); } catch { /* gone */ }
        if (foreign) names.set(p, { path: p, foreign: true });
        else if (is.by(p)) names.set(p, { path: p });
      });
    });
    level = next;
  }
  const took = Math.round(performance.now() - began);
  const found = [...names.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  if (late) found.push({ path: folder, unread: true, why: `the look took ${took} ms of its ${ms} ms and had read ${Math.min(seen, limit)} entries` });
  return { found, stamps, late };
}
