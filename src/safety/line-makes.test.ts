// The folders a line's own git makes a repository in: what a command makes, and where a later command may find one.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { follow, makerOf, walked } from "./line-makes.ts";
import { dirsOf, unwrap } from "./risk-words.ts";
import { splitCommand } from "./shell.ts";

const mine = "https://github.com/me/app.git";
// A disk with no links: a path leads where its words say.
const flat = (p: string) => resolve(p);

test("a worktree, a clone and a new repository are read with the folder each makes", () => {
  const w = (line: string, dir: string | null = "/w/own") => makerOf(line.split(" "), dir, flat);
  expect(w("git worktree add -q ../wt -b fix")).toEqual({ by: "worktree", path: "/w/wt" });
  expect(w("git -C /w/two worktree add /x/wt origin/main")).toEqual({ by: "worktree", path: "/x/wt" });
  expect(w("git worktree add --detach ../topic")).toEqual({ by: "worktree", path: "/w/topic" });
  expect(w(`git clone ${mine}`)).toEqual({ by: "clone", path: "/w/own/app" });
  expect(w(`git clone -q --depth 1 -o up ${mine} there`)).toEqual({ by: "clone", path: "/w/own/there" });
  expect(w("git clone git@github.com:me/app.git .")).toEqual({ by: "clone", path: "/w/own" });
  expect(w("git clone $U x")).toEqual({ by: "clone", path: "/w/own/x" });
  expect(w("git init -q")).toEqual({ by: "init", path: "/w/own" });
  expect(w("git init new")).toEqual({ by: "init", path: "/w/own/new" });
  expect(w("gh repo clone me/app")).toEqual({ by: "clone", path: "/w/own/app" });
  expect(w("gh repo clone me/app there")).toEqual({ by: "clone", path: "/w/own/there" });
  // What the rules cannot read is a maker with no folder: an expansion, an option they do not know, a folder the
  // command itself is not known to run in.
  for (const line of ["git worktree add $D -b x", "git worktree add --frob ../wt", `git clone --bare ${mine}`, `git clone --mirror ${mine} x`, `git clone --reference /w/clone ${mine} x`,
    `git clone --recurse-submodules ${mine} x`, `git clone --bran main ${mine} x`, "git init --bare x", "git worktree add --orphan ../wt", `git clone --template=/t ${mine} x`, `git clone ${mine} ~/x`, "git clone $U",
    `git -c init.templateDir=/t clone ${mine} x`, "git init --separate-git-dir /w/clone/.git x", `git clone --separate-git-dir=/w/clone/.git ${mine} x`, "gh repo fork --clone", "gh repo clone me/app -- --depth 1"]) expect([line, w(line)?.path]).toEqual([line, null]);
  expect(w(`git clone ${mine} x`, null)?.path).toBeNull();
  for (const line of ["git status", "git worktree list", "git commit -m clone", "gh repo view", "npm init"]) expect([line, w(line)]).toEqual([line, null]);
});

// A line followed to its last command: whether a repository the line makes may be where that one runs.
const end = (line: string, cwd = "/w/own", before?: (dir: string) => boolean) => {
  const parts = splitCommand(line)!, runs = parts.map((p) => unwrap(p.words)), dirs = dirsOf(parts, runs, cwd, "/home/u");
  const f = follow(before, flat);
  parts.slice(0, -1).forEach((p, i) => f.step(p, runs[i]!, dirs[i] ?? null));
  const dir = dirs[parts.length - 1] ?? null;
  return { may: dir !== null && f.mayHold(dir), replaced: dir !== null && f.mayReplace(dir), over: dir === null ? null : f.over(dir) };
};

test("a repository may be in a folder the line makes, or under it, run or not", () => {
  expect(end(`git clone ${mine} .; git push`).may).toBe(true);
  expect(end(`false && git init; git push`).may).toBe(true);
  expect(end(`git clone ${mine} app; cd app/src; git push`).may).toBe(true);
  expect(end(`git clone ${mine} $D; git push`).may).toBe(true);
  expect(end(`gh repo fork --clone; git push`).may).toBe(true);
  expect(end(`gh repo clone me/app; cd app; git push`).may).toBe(true);
  expect(end(`git clone ${mine} app/.git; cd app; git push`).may).toBe(true);
  expect(end(`echo x | xargs git clone ${mine}; git push`).may).toBe(true);
  expect(end(`bash -c 'cd /tmp/x && git clone ${mine} .'; git push`).may).toBe(true);
  expect(end(`git clone ${mine} app; git push`).may).toBe(false);
  expect(end(`git status; npm test; git push`).may).toBe(false);
  // (In a script of a line that makes one where the folder is.)
  expect(end("git push", "/w/own", (d) => d === "/w/own").may).toBe(true);
});

// A new repository with no remote changes none where there is one: only a clone or a new checkout puts another there.
test("a clone or a new checkout of the line may stand where a folder is; a git init does not", () => {
  expect(end(`git clone ${mine} .; git push`).replaced).toBe(true);
  expect(end("git worktree add ../wt -b t; cd ../wt; git push").replaced).toBe(true);
  expect(end(`git clone --bare ${mine}; git push`).replaced).toBe(true);
  expect(end("git init -q; git push").replaced).toBe(false);
  expect(end(`git clone ${mine} app; git push`).replaced).toBe(false);
});

test("where the line makes a repository a folder is in: the places, and whether one is in a place the words do not say", () => {
  expect(end("git init -q new && cd new && git push").over).toEqual({ places: ["/w/own/new"], any: false });
  expect(end(`git init -q && git clone ${mine} app && cd app/src && git push`).over).toEqual({ places: ["/w/own", "/w/own/app"], any: false });
  expect(end(`git clone ${mine} app/.git && cd app && git push`).over).toEqual({ places: ["/w/own/app"], any: false });
  expect(end(`git clone --bare ${mine} && git push`).over).toEqual({ places: [], any: true });
  expect(end(`git clone ${mine} app; git push`).over).toEqual({ places: [], any: false });
  expect(end("git push", "/w/own", () => true).over).toEqual({ places: [], any: true });
});

// git walks the folder it is given on the disk, where a `..` after a link leaves the link's target.
test("a folder git is given with a .. in it is read through the disk, or not at all", () => {
  // /w/own/out is a link to /x/plain.
  const linked = (p: string) => (p === "/w/own/out/.." ? "/x" : p === "/w/own/gone/.." ? null : resolve(p));
  const w = (line: string, real?: (p: string) => string | null) => makerOf(line.split(" "), "/w/own", real)?.path;
  expect(w(`git clone ${mine} out/../inner`, linked)).toBe("/x/inner");
  expect(w(`git -C out/.. clone ${mine}`, linked)).toBe("/x/app");
  expect(w("git -C out/.. worktree add wt -b t", linked)).toBe("/x/wt");
  expect(w("gh repo clone me/app out/../there", linked)).toBe("/x/there");
  expect(w("git worktree add ../wt -b t", linked)).toBe("/w/wt");
  expect(w(`git clone ${mine} gone/../inner`, linked)).toBeNull();
  expect(w("git worktree add ../wt -b t")).toBeNull();
  expect(w(`git clone ${mine} out/inner`)).toBe("/w/own/out/inner");
  expect(walked(null, "../x", linked)).toBeNull();
  expect(walked(null, "/w/own/out/../x", linked)).toBe("/x/x");
});
