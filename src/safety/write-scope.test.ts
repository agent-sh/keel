import { expect, test } from "bun:test";
import type { OwnPlace } from "./own-places.ts";
import { bindable, isReviewer, judgeWrite, ownerOpens, parseWrites, refusedWrites, shellWrites, type Base } from "./write-scope.ts";

const home = "/home/u";
const base: Base = { root: "/home/u/p/repo", git: "/home/u/p/repo/.git", branches: ["main"] };
const places: OwnPlace[] = [
  { path: "/home/u/state/worktrees/repo-1", from: "worktree" },
  { path: "/home/u/state/artifacts/s1", from: "scratch" },
  { path: "/home/u/.cache/lane/T1", from: "writes" },
];
const v = (p: string, pl = places, b: Base | null = base) => {
  const r = judgeWrite(p, { places: pl, base: b ?? undefined });
  return "ok" in r ? `ok:${r.ok.from}` : "never" in r ? "never" : "free" in r ? "free" : "out";
};

test("a write is the scope's by its places, never in the owner's checkout or its git directory", () => {
  expect(v("/home/u/state/worktrees/repo-1/src/a.ts")).toBe("ok:worktree");
  expect(v("/home/u/.cache/lane/T1/log.txt")).toBe("ok:writes");
  expect(v("/home/u/.cache/lane/T2/log.txt")).toBe("out");
  expect(v("/home/u/p/repo/.git/refs/heads/main")).toBe("never");
  expect(v("/home/u/p/repo/src/a.ts")).toBe("never");
  expect(v("/tmp/x")).toBe("free");
  expect(v("/dev/null")).toBe("free");
  // A worktree Keel made inside the checkout is the agent's; a path its parent gave there is not.
  const deep: OwnPlace[] = [{ path: "/home/u/p/repo/.wt/a", from: "worktree" }, { path: "/home/u/p/repo/docs", from: "writes" }];
  expect(v("/home/u/p/repo/.wt/a/x", deep)).toBe("ok:worktree");
  expect(v("/home/u/p/repo/docs/x", deep)).toBe("never");
  // The owner's words open it; the session's folder that is the checkout itself does not.
  expect(v("/home/u/p/repo/.git/x", [{ path: "/home/u/p/repo/.git", from: "owner" }])).toBe("ok:owner");
  expect(v("/home/u/p/repo/a", [{ path: "/home/u/p/repo", from: "folder" }])).toBe("never");
  // Outside a repository there is no base.
  expect(v("/home/u/p/repo/a", [{ path: "/home/u/p/repo", from: "folder" }], null)).toBe("ok:folder");
});

test("a glob place holds what it matches and what is under it", () => {
  const g: OwnPlace[] = [{ path: "/home/u/out/*/logs", from: "writes", glob: true }];
  expect(v("/home/u/out/a/logs", g)).toBe("ok:writes");
  expect(v("/home/u/out/a/logs/x.txt", g)).toBe("ok:writes");
  expect(v("/home/u/out/a/data/x.txt", g)).toBe("out");
  expect(bindable(g, base)).toEqual(["/home/u/out"]);
  // Nothing of the base is bound, whoever gave it.
  expect(bindable([{ path: "/home/u/p/repo/docs", from: "writes" }, { path: "/home/u/p", from: "writes" }], base)).toEqual([]);
});

test("a spawn's writes are paths, never the whole disk or the home", () => {
  expect(parseWrites(["src", "~/.cache/x", "/abs/y/**/*.log"], "/w", home)).toEqual({ places: [{ path: "/w/src" }, { path: "/home/u/.cache/x" }, { path: "/abs/y/**/*.log", glob: true }] });
  expect("error" in parseWrites(["/"], "/w", home)).toBe(true);
  expect("error" in parseWrites(["~"], "/w", home)).toBe(true);
  expect("error" in parseWrites(["/home/*"], "/w", home)).toBe(true);
  expect("error" in parseWrites(["$HOME/x"], "/w", home)).toBe(true);
  expect("error" in parseWrites([3], "/w", home)).toBe(true);
  expect(parseWrites(undefined, "/w", home)).toEqual({ places: [] });
});

test("the writes a command's words show, and the branches it moves", () => {
  const w = (c: string, cwd = "/w") => shellWrites(c, cwd, home);
  expect(w("echo x > /a/b 2>&1").paths).toEqual(["/a/b"]);
  expect(w("cd /x && cp a ~/d/").paths).toEqual(["/home/u/d"]);
  expect(w("cd /x && touch f && mkdir -p g/h").paths).toEqual(["/x/f", "/x/g/h"]);
  expect(w("cd /x && tee out.txt < in").paths).toEqual(["/x/out.txt"]);
  expect(w("git -C /home/u/p/repo commit -m x").paths).toEqual(["/home/u/p/repo"]);
  expect(w("git status && git log").paths).toEqual([]);
  expect(w("git commit -am x").paths).toEqual(["/w"]);
  expect(w("cd $D && echo > f").paths).toEqual([]);
  expect(w("git branch -f main HEAD").refs).toEqual(["main"]);
  expect(w("git branch -D old main").refs).toEqual(["old", "main"]);
  expect(w("git branch topic").refs).toEqual([]);
  expect(w("git push . HEAD:main").refs).toEqual(["main"]);
  expect(w("git push origin HEAD:main").refs).toEqual([]);
  expect(w("git fetch origin main:main").refs).toEqual(["main"]);
  expect(w("git update-ref refs/heads/main abc123").refs).toEqual(["main"]);
  expect(w("git checkout -B main origin/main").refs).toEqual(["main"]);
});

test("the paths a sandbox refused to write, from what the command printed", () => {
  const out = [
    "touch: cannot touch '/home/u/.cache/other/x': Read-only file system",
    "bash: /home/u/notes.txt: Read-only file system",
    "sh: 1: cannot create /srv/a: Read-only file system",
    "OSError: [Errno 30] Read-only file system: '/data/y.json'",
    "bash: line 1: /home/u/.cache/lane/T2/z.txt: No such file or directory",
    "touch: cannot touch '/home/u/.cache/q/w': No such file or directory",
    "cat: /nope: No such file or directory",
    "ls: cannot access '/gone': No such file or directory",
  ].join("\n");
  expect(refusedWrites(out)).toEqual([
    { path: "/home/u/.cache/other/x", how: "rofs" }, { path: "/home/u/notes.txt", how: "rofs" }, { path: "/srv/a", how: "rofs" }, { path: "/data/y.json", how: "rofs" },
    { path: "/home/u/.cache/lane/T2/z.txt", how: "missing" }, { path: "/home/u/.cache/q/w", how: "missing" },
  ]);
});

test("a reviewer by its type or its title", () => {
  expect(isReviewer("gishra-reviewer", "x")).toBe(true);
  expect(isReviewer("general-purpose", "Verify lane T1")).toBe(true);
  expect(isReviewer("general-purpose", "Review FIND-M29")).toBe(true);
  expect(isReviewer("general-purpose", "Build the preview pane")).toBe(false);
  expect(isReviewer("general-purpose", "Fix reviews list")).toBe(true);
  expect(isReviewer(undefined, undefined)).toBe(false);
});

test("the owner's words open the checkout's files by its name, its git directory only by a name inside it", () => {
  expect(ownerOpens("Fix the docs in ~/p/repo please.", "/home/u/p/repo/docs/a.md", base, home)).toBe(true);
  expect(ownerOpens("Fix the docs in ~/p/repo please.", "/home/u/p/repo/.git/config", base, home)).toBe(false);
  expect(ownerOpens("Repair /home/u/p/repo/.git/refs/heads/main now.", "/home/u/p/repo/.git/refs/heads/main", base, home)).toBe(true);
  expect(ownerOpens("Never write ~/p/repo yourself.", "/home/u/p/repo/a", base, home)).toBe(false);
});
