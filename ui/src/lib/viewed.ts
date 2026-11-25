// "Viewed" marks on the files of a diff, the way a pull request review has them: a file marked viewed folds and is
// counted, and it loses its mark only when its own diff changes (a later commit on another file leaves it).
// A mark is kept per session in this browser, like a review draft, and is the hash of the file's diff text: the
// head is not part of it, so a head that moved without touching the file keeps the mark.
import { useCallback, useEffect, useMemo, useState } from "react";
import { parsePatch, type FilePatch } from "../../../src/safety/patch.ts";

export type ViewedFile = { path: string; status: string; added: number; removed: number };

// cyrb53: 53 bits, enough that two different diffs do not meet by accident, and no crypto needed.
export function hashText(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// A file's diff as one key: its lines and its mode and binary facts. A file whose diff is not in the patch (cut to
// fit) is keyed by what the file list says of it.
export function diffKey(f: ViewedFile, p?: FilePatch): string {
  if (!p) return hashText(`${f.status}\0+${f.added}\0-${f.removed}`);
  return hashText(`${p.binary ? "binary" : ""}\0${p.oldMode ?? ""}\0${p.newMode ?? ""}\0${p.lines.map((l) => `${l.kind}${l.text}`).join("\n")}`);
}

export type Marks = Record<string, string>;

// The files whose mark still holds: marked, and their diff is the one that was marked.
export function viewedPaths(marks: Marks, keys: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [path, key] of keys) if (marks[path] === key) out.add(path);
  return out;
}

export const viewedKey = (session: string, scope: string) => `keel.viewed.${session}.${scope}`;
function read(key: string): Marks {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, k]) => typeof k === "string")) as Marks : {};
  } catch { return {}; }
}

export type Viewed = { is(path: string): boolean; toggle(path: string): void; count: number; total: number };

// The marks of one diff (`scope`: the panel that shows it), against the files and the patch as they are now.
export function useViewed(session: string, scope: string, files: readonly ViewedFile[], patch: string): Viewed {
  const key = viewedKey(session, scope);
  const [marks, setMarks] = useState<Marks>(() => read(key));
  useEffect(() => setMarks(read(key)), [key]);
  const keys = useMemo(() => {
    const parsed = new Map(parsePatch(patch).map((p) => [p.path, p]));
    return new Map(files.map((f) => [f.path, diffKey(f, parsed.get(f.path))]));
  }, [files, patch]);
  const held = useMemo(() => viewedPaths(marks, keys), [marks, keys]);
  // Marks of files that left the diff, or whose diff changed, are dropped when the next one is written.
  const toggle = useCallback((path: string) => {
    const now = read(key);
    const next: Marks = {};
    for (const [p, k] of keys) if (now[p] === k && p !== path) next[p] = k;
    if (now[path] !== keys.get(path) && keys.has(path)) next[path] = keys.get(path)!;
    if (Object.keys(next).length) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key);
    setMarks(next);
  }, [key, keys]);
  return useMemo(() => ({ is: (p: string) => held.has(p), toggle, count: held.size, total: files.length }), [held, toggle, files.length]);
}
