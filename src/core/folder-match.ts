// How a name typed in the folder picker matches a folder. One rule for the
// server's folder index (GET /api/fs/find) and the page's recent folders, so
// both lists rank the same way and Enter takes the same top match.

export type FolderHit = { name: string; path: string; is_git: boolean; linked_worktree?: boolean; used?: boolean };

// Whether the typed text is a path to open rather than a name to find.
export const typedPath = (q: string): boolean => /^[~/.]/.test(q.trim()) || q.includes("/");

// How well `q` names the folder: higher is better, -1 is no match. Every word
// of the query must match the folder's name or, failing that, its path. The
// name counts most: whole, then its start, then the start of one of its parts
// ("api" in "shop-api"), then anywhere in it; the path counts less; the letters
// in order and close together (three or more) least.
export function folderScore(q: string, name: string, path: string): number {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return -1;
  const n = name.toLowerCase(), p = path.toLowerCase();
  let total = 0;
  for (const w of words) {
    let s = -1;
    if (n === w) s = 100;
    else if (n.startsWith(w)) s = 80;
    else if (new RegExp(`[-_. ]${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(n)) s = 60;
    else if (n.includes(w)) s = 50;
    else if (p.includes(w)) s = 20;
    else if (w.length >= 3 && inOrder(w, n)) s = 10;
    if (s < 0) return -1;
    total += s;
  }
  return total / words.length;
}

// The letters of `w` in order within `s`, close together: in a span at most
// twice as long as `w`, from any start ("rsch" in "research", not "keel"
// spread across "ko-codex-desktop-linux").
const inOrder = (w: string, s: string) => {
  for (let start = s.indexOf(w[0]!); start >= 0; start = s.indexOf(w[0]!, start + 1)) {
    let j = 1, i = start + 1;
    for (; i < s.length && j < w.length && i - start < w.length * 2; i++) if (s[i] === w[j]) j++;
    if (j === w.length) return true;
  }
  return false;
};

// The matches best first: by score, a folder a session used and a repository
// a little ahead of others, then the shorter path, then by path. At most `limit`.
export function rankFolders(q: string, list: FolderHit[], limit = 20): FolderHit[] {
  const seen = new Set<string>();
  const scored: { h: FolderHit; s: number }[] = [];
  for (const h of list) {
    if (seen.has(h.path)) continue;
    const s = folderScore(q, h.name, h.path);
    if (s < 0) continue;
    seen.add(h.path);
    scored.push({ h, s: s + (h.used ? 8 : 0) + (h.is_git ? 5 : 0) });
  }
  scored.sort((a, b) => b.s - a.s || a.h.path.length - b.h.path.length || a.h.path.localeCompare(b.h.path));
  return scored.slice(0, limit).map((x) => x.h);
}
