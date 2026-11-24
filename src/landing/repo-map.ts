// What git says of a repository's tree at one commit, for the pair checks (src/landing/together.ts)
// and the plans of lanes (src/automation/lane-plans.ts): its files, its import lines, and how often
// its recent first-parent commits touched each file (pairs.ts hubsOf). Each is a process of its own
// with a time limit; nothing runs on the loop.
import { git } from "../core/git.ts";
import { graphOf, HUB_COMMITS, hubsOf, IMPORT_LINES, IMPORT_PATHS, type Graph } from "./pairs.ts";

export type TreeRead = { known: Set<string>; lines: { path: string; line: string }[]; touched: Map<string, number>; commits: number };

// The import lines of `paths` at `rev` (git grep -E IMPORT_LINES).
export async function importLines(repo: string, rev: string, paths: string[]): Promise<{ path: string; line: string }[]> {
  const r = await git(repo, ["-c", "core.quotePath=false", "grep", "-z", "-I", "--no-color", "-E", IMPORT_LINES, rev, "--", ...paths], { read: true, timeout: 60_000 });
  if (r.code !== 0) return [];
  const out: { path: string; line: string }[] = [];
  const pre = `${rev}:`;
  for (const l of r.out.split("\n")) {
    const z = l.indexOf("\0");
    if (z < 0 || !l.startsWith(pre)) continue;
    out.push({ path: l.slice(pre.length, z), line: l.slice(z + 1) });
  }
  return out;
}

// The tree's files and import lines at `rev`, and the work of its last HUB_COMMITS first-parent commits.
export async function readTree(repo: string, rev: string): Promise<TreeRead> {
  const ls = await git(repo, ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--name-only", rev], { read: true, timeout: 60_000 });
  const known = new Set(ls.code === 0 ? ls.out.split("\0").filter(Boolean) : []);
  const log = await git(repo, ["-c", "core.quotePath=false", "log", "--first-parent", "-n", String(HUB_COMMITS), "--format=format:%x00", "--name-only", "--no-renames", rev], { read: true, timeout: 60_000 });
  const touched = new Map<string, number>();
  let commits = 0;
  if (log.code === 0) for (const c of log.out.split("\0")) { if (!c) continue; commits++; for (const f of new Set(c.split("\n").filter(Boolean))) touched.set(f, (touched.get(f) ?? 0) + 1); }
  return { known, lines: await importLines(repo, rev, IMPORT_PATHS), touched, commits };
}

// The map a plan reads: the tree's files, its import graph and its hub files, kept for the newest
// commit of each repository it was asked for.
const maps = new Map<string, { rev: string; map: Promise<{ known: Set<string>; g: Graph; hubs: Set<string> }> }>();
export function repoMap(repo: string, rev: string): Promise<{ known: Set<string>; g: Graph; hubs: Set<string> }> {
  const had = maps.get(repo);
  if (had?.rev === rev) return had.map;
  const map = readTree(repo, rev).then((t) => { const g = graphOf(t.lines, t.known); return { known: t.known, g, hubs: hubsOf({ touched: t.touched, commits: t.commits, g }) }; });
  map.catch(() => { if (maps.get(repo)?.map === map) maps.delete(repo); });
  maps.set(repo, { rev, map });
  if (maps.size > 32) maps.delete(maps.keys().next().value!);
  return map;
}
