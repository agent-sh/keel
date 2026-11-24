// The look at the files under a folder that hold credentials (credential-reads.ts namedUnder), made off the loop.
// The folder is read with the async file calls, a few at a time, so a busy loop only slows the look and never makes it
// late by itself; the answer is kept per folder with the modification time of every folder it read, and a repeat
// search is answered after one stat of each of those (a changed folder is read again). A look that does not finish
// in its time says how long it took and how much it had read, so the search can be narrowed.
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
// The entries of one folder handled between two looks at the clock.
const CHUNK = 512;

type Kept = { at: number; found: Found[]; stamps: Map<string, string> };
// A look that stopped before it was done: the folders still to read, what the parts so far found and the stamp of
// every folder they read. The next search of the folder goes on from there (after the stamps are checked).
type Partial = {
  at: number; folder: string; pending: string[]; queued: Set<string>; names: Map<string, Found>; stamps: Map<string, string>;
  // The entries of a folder already handled, for a folder that did not fit in a part by itself.
  offsets: Map<string, number>; seen: number; parts: number;
};
const kept = new Map<string, Kept>();
const partials = new Map<string, Partial>();
const running = new Map<string, Promise<Found[]>>();
// How long the progress of an unfinished look is kept (then the folder is looked through from its start).
const PARTIAL_MS = 10 * 60_000;

/** Test seam: forget what was kept. */
export function forgetLooks() { kept.clear(); partials.clear(); running.clear(); }

async function pool<T>(items: T[], width: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) await run(items[next++]!); }));
}

// What a folder is known by: its modification time and its change time (a file or a link made in it moves both; a
// restored modification time, which any owner of the folder can set, leaves the change time moved), or why it could
// not be looked at (a folder that is missing or closed when the look is made is known by that, and any change of it
// is a change).
async function stampOf(dir: string): Promise<string> {
  try { const st = await lstat(dir); return `${st.mtimeMs}:${st.ctimeMs}`; } catch (e) { return `none:${(e as NodeJS.ErrnoException).code ?? "?"}`; }
}

// Whether every folder the answer was made from is as it was then.
async function unchanged(k: Kept): Promise<boolean> {
  if (performance.now() - k.at > STANDS_MS) return false;
  let same = true;
  await pool([...k.stamps], FILES_AT_ONCE, async ([dir, at]) => {
    if (!same) return;
    if ((await stampOf(dir)) !== at) same = false;
  });
  return same;
}

// The files under `folder` that hold credentials, as namedUnder finds them, off the loop. `scope`: what the classifier
// depends on besides the home (the places it lists), so a look made for other places is not reused. A folder too big
// for one look (`entries`, `ms`) is looked through in parts, one for each search: the folders still to read are kept,
// and the search stays held, saying how far the look got, until the last part is done.
export function lookUnder(folder: string, is: Classifier, o: { scope?: string; ms?: number; entries?: number } = {}): Promise<Found[]> {
  const key = `${homeOf()}\0${o.scope ?? ""}\0${folder}`;
  const running1 = running.get(key);
  if (running1) return running1;
  const run = (async () => {
    const had = kept.get(key);
    if (had && await unchanged(had)) return had.found;
    kept.delete(key);
    let part = partials.get(key);
    if (part && performance.now() - part.at > PARTIAL_MS) part = undefined;
    // (What the parts read before is checked first: a folder that changed since is read again, and what it held is dropped.)
    if (part) await refresh(part);
    const made = await walk(folder, is, o.ms ?? WALK_MS, o.entries ?? WALK_ENTRIES, part);
    if (made.more) partials.set(key, made.more); else partials.delete(key);
    if (made.done) {
      kept.set(key, { at: made.done.at, found: made.found, stamps: made.stamps });
      if (kept.size > 64) for (const k of kept.keys()) { kept.delete(k); if (kept.size <= 32) break; }
    }
    if (partials.size > 64) for (const k of partials.keys()) { partials.delete(k); if (partials.size <= 32) break; }
    return made.found;
  })().finally(() => { running.delete(key); });
  running.set(key, run);
  return run;
}

// A look in parts takes up where it stopped, with every folder it read stamped as it was then.
async function refresh(part: Partial): Promise<void> {
  const changed: string[] = [];
  await pool([...part.stamps], FILES_AT_ONCE, async ([dir, at]) => { if ((await stampOf(dir)) !== at) changed.push(dir); });
  for (const dir of changed) {
    part.stamps.delete(dir);
    part.offsets.delete(dir);
    for (const p of [...part.names.keys()]) if (dirname(p) === dir) part.names.delete(p);
    if (!part.pending.includes(dir)) part.pending.unshift(dir);
  }
}

// One part of a look: from the folders still to read (or the folder itself), until its `limit` of entries or its `ms`.
async function walk(folder: string, is: Classifier, ms: number, limit: number, from?: Partial): Promise<{ found: Found[]; stamps: Map<string, string>; more?: Partial; done?: { at: number } }> {
  const began = performance.now();
  const end = began + ms;
  const st: Partial = from ?? { at: began, folder, pending: [folder], queued: new Set([folder]), names: new Map(), stamps: new Map(), offsets: new Map(), seen: 0, parts: 0 };
  const { names, stamps, offsets, pending, queued } = st;
  let part = 0, late = false, active = 0;
  const stop = () => late || part >= limit || names.size >= WALK_NAMES;
  const readDir = async (d: string) => {
    // (The stamp first: a folder that changes while it is read is read again at the next search. A folder that
    // cannot be read keeps its stamp, so it is read again when it changes, a mode change included.)
    if (!stamps.has(d)) stamps.set(d, await stampOf(d));
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { offsets.delete(d); return; }
    const first = offsets.get(d) ?? 0;
    for (let i = first; i < entries.length; i += CHUNK) {
      if (stop()) { offsets.set(d, i); pending.unshift(d); return; }
      const slice = entries.slice(i, i + CHUNK);
      part += slice.length;
      st.seen += slice.length;
      const files: string[] = [];
      for (const e of slice) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (!NOT_ENTERED.has(e.name) && !queued.has(p)) { queued.add(p); pending.push(p); } continue; }
        if (e.isSymbolicLink()) { if (is.link(p)) names.set(p, { path: p, foreign: true }); else if (is.by(p)) names.set(p, { path: p }); continue; }
        if (e.isFile()) files.push(p);
      }
      // A file with more than one name may be another name for a listed one: the count of names is read for each.
      await pool(files, FILES_AT_ONCE, async (p) => {
        let foreign = false;
        try { foreign = (await lstat(p)).nlink > 1 && !!is.link(p); } catch { /* gone */ }
        if (foreign) names.set(p, { path: p, foreign: true });
        else if (is.by(p)) names.set(p, { path: p });
      });
      if (performance.now() > end) late = true;
    }
    offsets.delete(d);
  };
  // Folders are taken from the front, a few at a time, shallow ones first.
  const worker = async () => {
    while (!stop()) {
      const d = pending.shift();
      if (d === undefined) { if (!active) return; await new Promise((r) => setTimeout(r, 1)); continue; }
      active++;
      try { await readDir(d); } finally { active--; }
    }
  };
  await Promise.all(Array.from({ length: DIRS_AT_ONCE }, worker));
  st.parts++;
  const took = Math.round(performance.now() - began);
  const found = [...names.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  // Done: nothing left to read, or enough found to hold the search already (what is left would only add to it).
  if (!pending.length || names.size >= WALK_NAMES) return { found, stamps, done: { at: st.at } };
  // Not done: what is known is kept, and the search is held with how far the look got.
  const why = `the look of this folder is made in parts: ${st.seen} entries read so far in ${st.parts} ${st.parts === 1 ? "part" : "parts"}, ${pending.length} folders still to read; this part took ${took} ms of its ${ms} ms${late ? " and ran out of time" : ""}. Search again: the look goes on from there, and the search is answered when it has read the whole folder`;
  found.push({ path: folder, unread: true, why, resumes: true });
  return { found, stamps, more: st };
}
