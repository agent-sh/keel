// What a model reads when the path it asked for is not there. In real use
// most misses are a near name (another extension, a typo, a test file that is
// named differently), a folder that was removed or moved (a worktree), or a
// path written from the wrong root. Each of those is answered with the place
// to look instead, so the next call lands without a directory listing.
import { statSync } from "node:fs";
import { contains, namesIn, ownerHome } from "../core/paths.ts";
import { basename, dirname, extname, join, relative, isAbsolute, sep } from "node:path";
import { placeholdersIn } from "../safety/secrets.ts";

const exists = (p: string) => { try { statSync(p); return true; } catch { return false; } };
// (Read from the folder itself, never through a link that took its name: a hint names nothing of another folder.)
const list = (dir: string): string[] | null => namesIn(dir);

export function notFound(p: string, cwd: string, what: "File" | "Directory" = "File"): string {
  const out = [`${what} does not exist: ${p}`];
  // A path a model copied from text where a secret was replaced: the reason
  // it is not there is the placeholder, not a removed folder.
  const marks = placeholdersIn(p);
  if (marks.length) out.push(`${marks.join(", ")} in this path is a secret's placeholder. Only a shell command's script is given a secret's value, never a path, so nothing has this name. Use a path without it: one relative to the session's folder, or cd inside the command, where ~ and $HOME expand.`);
  const folder = dirname(p);
  let names = list(folder);
  let suggestions = [
    ...(what === "Directory" && !marks.length ? sameEnding(p) : []),
    ...reroot(p, cwd),
  ];
  if (names) {
    suggestions.push(...similar(names, basename(p)).map((n) => join(folder, n)));
  } else {
    // The folder itself is gone: name the first missing folder and the nearest one that exists.
    let child = folder;
    let parent = dirname(folder);
    while (parent !== child && !(names = list(parent))) { child = parent; parent = dirname(parent); }
    if (names) {
      out.push(`The folder ${child} does not exist. The nearest folder that does is ${parent}.`);
      suggestions.push(...similar(names, basename(child)).map((n) => join(parent, n)));
    }
  }
  suggestions = [...new Set(suggestions)].slice(0, 3);
  if (suggestions.length) out.push(`Did you mean one of these?\n${suggestions.join("\n")}`);
  return out.join("\n\n");
}

// A workdir under the wrong home root: try the exact tail under the other
// standard roots, longest first, without listing or walking the home.
function sameEnding(p: string): string[] {
  const home = ownerHome();
  if (!isAbsolute(p) || !contains(home, p)) return [];
  const roots = [".cache", ".local/share", ".local/state", ".config"].map((r) => join(home, r));
  const from = roots.find((r) => contains(r, p)) ?? home;
  const parts = relative(from, p).split(sep);
  for (let i = 0; i <= 3 && i + 1 < parts.length; i++) {
    const tail = parts.slice(i).join(sep);
    const found = [home, ...roots].map((root) => join(root, tail)).filter((dir) => {
      try { return statSync(dir).isDirectory(); } catch { return false; }
    });
    if (found.length) return found;
  }
  return [];
}

// /home/me/src/a.ts asked for in /home/me/repo usually means /home/me/repo/src/a.ts.
function reroot(p: string, cwd: string): string[] {
  const up = dirname(cwd);
  const inCwd = relative(cwd, p);
  if (!inCwd.startsWith("..") && !isAbsolute(inCwd)) return [];
  const inUp = relative(up, p);
  if (inUp.startsWith("..") || isAbsolute(inUp)) return [];
  const cand = join(cwd, inUp);
  return exists(cand) ? [cand] : [];
}

const stem = (n: string) => n.slice(0, n.length - extname(n).length) || n;

// A folder's entries ranked against a missing name: same name in another
// case, same stem with another extension, one name inside the other, then a
// typo in the stem.
export function similar(names: readonly string[], requested: string): string[] {
  const name = requested.toLowerCase();
  const wanted = stem(name);
  const typos = wanted.length < 3 ? 0 : wanted.length < 5 ? 1 : 2;
  const tier = (c: string): number | undefined => {
    if (c === name) return 1;
    const found = stem(c);
    if (found === wanted) return 2;
    const root = c.split(".")[0]!;
    if (root.length >= 3 && root === name.split(".")[0]) return 3;
    if (Math.min(found.length, wanted.length) >= 3 && (c.includes(name) || name.includes(c) || found.includes(wanted) || wanted.includes(found))) return 3;
    if (typos && Math.abs(found.length - wanted.length) <= typos && distance(found, wanted) <= typos) return 4;
  };
  return names
    .filter((n) => n !== requested)
    .flatMap((n) => {
      const rank = tier(n.toLowerCase());
      return rank === undefined ? [] : [{ n, rank, d: distance(n.toLowerCase(), name) }];
    })
    .sort((a, b) => a.rank - b.rank || a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, 3)
    .map((m) => m.n);
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
