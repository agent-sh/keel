// The folders a line's own git makes: what a command makes, and how long a made folder stands as made.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { PLAIN_GIT, follow, makerOf, quiet, walked } from "./line-makes.ts";
import { dirsOf, unwrap } from "./risk-words.ts";
import { splitCommand } from "./shell.ts";

const mine = "https://github.com/me/app.git";
// A disk with no links: a path leads where its words say.
const flat = (p: string) => resolve(p);

test("a worktree, a clone and a new repository are read with the folder each makes", () => {
  const w = (line: string, dir: string | null = "/w/own") => makerOf(line.split(" "), dir, flat);
  expect(w("git worktree add -q ../wt -b fix")).toEqual({ by: "worktree", path: "/w/wt", from: "/w/own", branch: "fix", start: "HEAD" });
  expect(w("git -C /w/two worktree add /x/wt origin/main")).toEqual({ by: "worktree", path: "/x/wt", from: "/w/two", branch: "origin/main", start: "origin/main" });
  // (With no branch to make and no commit named, git picks where the checkout starts: a branch of that name, one a remote has.)
  expect(w("git worktree add ../topic")).toEqual({ by: "worktree", path: "/w/topic", from: "/w/own", branch: "topic" });
  expect(w("git worktree add --detach ../topic")).toMatchObject({ path: "/w/topic", start: "HEAD" });
  expect(w("git worktree add ../topic -")).toEqual({ by: "worktree", path: "/w/topic", from: "/w/own", branch: "-" });
  expect(w(`git clone ${mine}`)).toEqual({ by: "clone", path: "/w/own/app", url: mine, remote: "origin" });
  expect(w(`git clone -q --depth 1 -o up ${mine} there`)).toEqual({ by: "clone", path: "/w/own/there", url: mine, remote: "up" });
  expect(w("git clone git@github.com:me/app.git .")).toMatchObject({ path: "/w/own", url: "git@github.com:me/app.git" });
  expect(w("git init -q")).toEqual({ by: "init", path: "/w/own" });
  expect(w("git init new")).toEqual({ by: "init", path: "/w/own/new" });
  // What the rules cannot read is a maker with no folder: an expansion, an option they do not know, one that can give
  // the clone another remote, a folder the command itself is not known to run in.
  for (const line of ["git worktree add $D -b x", "git worktree add --frob ../wt", `git clone --bare ${mine}`, `git clone --mirror ${mine} x`, `git clone --reference /w/clone ${mine} x`, `git clone --reference-if-able /w/clone ${mine} x`,
    `git clone --recurse-submodules ${mine} x`, `git clone --bran main ${mine} x`, "git init --bare x", "git worktree add --orphan ../wt", `git clone --template=/t ${mine} x`, `git clone -c remote.origin.pushurl=x ${mine} x`, `git clone ${mine} ~/x`,
    `git -c init.templateDir=/t clone ${mine} x`, "git init --template /t x", "git init --separate-git-dir /w/clone/.git x", `git clone --separate-git-dir=/w/clone/.git ${mine} x`, "gh repo fork --clone", "gh repo clone me/app -- --depth 1"]) expect([line, w(line)?.path]).toEqual([line, null]);
  expect(w(`git clone ${mine} x`, null)?.path).toBeNull();
  // gh's clone: the folder is read, the address is gh's to say.
  expect(w("gh repo clone me/app")).toEqual({ by: "clone", path: "/w/own/app", url: null, remote: "origin" });
  expect(w("gh repo clone me/app there")).toMatchObject({ path: "/w/own/there", url: null });
  expect(w(`git clone $U x`)).toMatchObject({ path: "/w/own/x", url: null });
  for (const line of ["git status", "git worktree list", "git commit -m clone", "gh repo view", "npm init"]) expect([line, w(line)]).toEqual([line, null]);
});

// A line followed to its last command: what made the folder that one runs in, and whether a repository may be there.
const end = (line: string, cwd = "/w/own", safe?: Set<string>) => {
  const parts = splitCommand(line)!, runs = parts.map((p) => unwrap(p.words)), dirs = dirsOf(parts, runs, cwd, "/home/u");
  const f = follow(safe, undefined, false, flat, parts);
  parts.slice(0, -1).forEach((p, i) => f.step(p, runs[i]!, dirs[i] ?? null));
  const dir = dirs[parts.length - 1] ?? null;
  return { by: dir === null ? null : f.at(dir)?.by ?? null, may: dir !== null && f.mayHold(dir) };
};

test("a made folder stands while the line is joined by && and nothing between can put another in its place", () => {
  for (const line of [
    "git worktree add -q ../wt -b fix && cd ../wt && git commit -q --allow-empty -m x && git push -u origin fix",
    `git clone ${mine} app && cd app && git push`,
    `git clone ${mine} app && cd app && git status && git add -A && git commit -m "$(cat ../msg)" && git push`,
    `mkdir -p new && cd new && git init -q && git remote add origin ${mine} && git push -u origin main`,
    `git clone ${mine} app && (cd app && git push)`,
    "git worktree add ../wt -b f && cd ../wt && git commit -m \"$(cat <<'EOF'\nfix it\n\nbody\nEOF\n)\" && git push -u origin f",
    `git clone ${mine} app && cd app && git commit -m "$(date; echo \`id\`)" && git push`,
  ]) expect([line, end(line).by]).not.toEqual([line, null]);
  for (const line of [
    // Not joined by &&: the push runs whether or not the folder was made.
    `git clone ${mine} app; cd app && git push`,
    `git clone ${mine} app && cd app; git push`,
    // After a subshell: the operator after its close is not known, so what follows may run though the maker failed.
    `git clone ${mine} app && (cd app && git status); cd app && git push`,
    `git clone ${mine} app && (date); git -C app commit --allow-empty -m "$(date)" && git -C app push`,
    `git clone ${mine} app && (cd app; git push)`,
    // The maker may not run, or runs where the rules do not follow.
    `./git clone ${mine} app && cd app && git push`,
    `sudo git clone ${mine} app && cd app && git push`,
    `test -d app || git clone ${mine} app && cd app && git push`,
    `! git clone ${mine} app && cd app && git push`,
    `(git clone ${mine} app) && cd app && git push`,
    `if true; then git clone ${mine} app; fi && cd app && git push`,
    // Something between can put another folder there, or change what the made one holds.
    `git clone ${mine} app && rm -rf app && mv /w/clone app && cd app && git push`,
    `git clone ${mine} app && cp /w/clone/.git/config app/.git/config && cd app && git push`,
    `git clone ${mine} app && printf x >> app/.git/config && cd app && git push`,
    `git clone ${mine} app && ./setup.sh && cd app && git push`,
    `git clone ${mine} app && cd app && git rebase --exec 'git remote set-url origin x' HEAD~1 && git push`,
    `git clone ${mine} app && cd app && GIT_EDITOR=./e git commit && git push`,
    `git clone ${mine} app && cd app && git -c core.fsmonitor=./e status && git push`,
    `git clone ${mine} app && cd app && git log --output=.git/config && git push`,
    `git clone ${mine} app && cd app && git submodule add https://github.com/them/lib.git && git push`,
    `git clone ${mine} app && cd app && git config $K https://github.com/them/lib.git && git push`,
    `git clone ${mine} app && cd app && git remote set-url origin $U && git push`,
    `git clone ${mine} app && cd app && export GIT_DIR=/w/clone/.git && git push`,
    // A script whose words name a maker: where it makes what is not followed.
    `git clone ${mine} app && bash -c 'rm -rf app; git clone https://github.com/them/lib.git app' && cd app && git push`,
    `git clone ${mine} app && git worktree add $X && cd app && git push`,
    // Another folder than the one made, and one reached with a .. the disk may walk elsewhere.
    `git clone ${mine} app && cd app/src && git push`,
    `git clone ${mine} app && git -C app/link/.. push`,
  ]) expect([line, end(line).by]).toEqual([line, null]);
  for (const line of [
    // Another maker of the line where the folder is, above it or under it, run or not: what stands there is not known.
    `git init -q app && git clone ${mine} app && cd app && git push`,
    `git clone https://github.com/them/lib.git app; git clone ${mine} app && cd app && git push`,
    `git clone https://github.com/them/lib.git app/.git; git clone ${mine} app && cd app && git push`,
    // After a command that can fill a folder, or with something set for it.
    `rm -rf app && git clone ${mine} app && cd app && git push`,
    `GIT_TEMPLATE_DIR=/t git clone ${mine} app && cd app && git push`,
    // A checkout added to a repository the line makes, or after a command that can put another where its repository is.
    `git clone ${mine} inner && cd inner && git worktree add -q ../wtx -b t && cd ../wtx && git push origin t`,
    `git clone ${mine} inner && git -C inner worktree add -q ../wtx -b t && git -C wtx push -u origin t`,
    "mv /w/own /w/own.bak && mv /w/clone /w/own && git worktree add -q ../wtx -b t && cd ../wtx && git push origin t",
  ]) expect([line, end(line).by]).toEqual([line, null]);
  // After the plain commands only (the public-send check): a merge or a checkout brings commits the folder did not hold.
  expect(end(`git clone ${mine} app && cd app && git commit --allow-empty -m x && git push`, "/w/own", PLAIN_GIT).by).toBe("clone");
  expect(end(`git clone ${mine} app && cd app && git cherry-pick abc && git push`, "/w/own", PLAIN_GIT).by).toBeNull();
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
  // The folder a later command runs in is read the same way.
  const parts = splitCommand(`git clone ${mine} out/../inner && git -C out/../inner push`)!, runs = parts.map((p) => unwrap(p.words));
  const f = follow(undefined, undefined, false, linked);
  f.step(parts[0]!, runs[0]!, "/w/own");
  expect(f.at("/w/own/out/../inner")?.by).toBe("clone");
  expect(f.at("/w/own/inner")).toBeUndefined();
});

// `git init` in a folder that holds a repository changes none of its remotes: it makes its folder only when nothing
// before it on the line can have put one there.
test("a git init makes its folder only while no command before it can have filled it", () => {
  for (const line of [
    `mkdir -p new && cd new && git init -q && git remote add origin ${mine} && git push`,
    `git init -q new && cd new && git remote add origin ${mine} && git push`,
    `git status && echo hi && git init -q new && cd new && git push`,
    `git clone ${mine} app && git init -q new && cd new && git push`,
  ]) expect([line, end(line).by]).toEqual([line, "init"]);
  for (const line of [
    "cp -r /w/clone new && cd new && git init -q && git push",
    "ln -s /w/clone new && git init -q new && cd new && git push",
    "tar -xf r.tar && git init -q new && cd new && git push",
    "./setup.sh && git init -q new && cd new && git push",
    "echo x > new/.git/config && git init -q new && cd new && git push",
    "mkdir -p new/.git && git config -f new/.git/config remote.origin.url x && git init -q new && cd new && git push",
    `git clone ${mine} new && cd new && git init -q && git push`,
    // A repository another command of the line makes in the folder, above it or under it (`new/.git` is the repository of `new`).
    `git clone ${mine} new/.git && cd new && git init -q && git push`,
    `git clone ${mine} new/.git && git init -q new && cd new && git push`,
    `git clone ${mine} new/.git && git -C new init -q && git -C new push`,
    "git init -q new/sub && git init -q new && cd new && git push",
    "git init -q new && git -C new init -q && cd new && git push",
    "GIT_TEMPLATE_DIR=/t git init -q new && cd new && git push",
    `git clone ${mine} $D && git init -q new && cd new && git push`,
    "git init -q --separate-git-dir /w/clone/.git new && cd new && git push",
  ]) expect([line, end(line).by]).toEqual([line, null]);
  // In a script of a line that already ran such a command.
  const parts = splitCommand("git init -q new && cd new && git push")!, runs = parts.map((p) => unwrap(p.words)), dirs = dirsOf(parts, runs, "/w/own", "/home/u");
  const f = follow(undefined, undefined, true);
  parts.slice(0, -1).forEach((p, i) => f.step(p, runs[i]!, dirs[i] ?? null));
  expect(f.at("/w/own/new")).toBeUndefined();
  // (A repository the line made counts as such a command to a script of it.)
  const g = follow();
  expect(g.loud()).toBe(false);
  g.step(parts[0]!, runs[0]!, "/w/own");
  expect(g.loud()).toBe(true);
});

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
});

test("a command that leaves a made folder as made", () => {
  const q = (line: string) => { const p = splitCommand(line)!.at(-1)!; return quiet(p, unwrap(p.words)); };
  for (const line of ["cd x", "git add -A", "git commit -m x", "git -C x status", "git push -u origin main", "mkdir -p a/b", "cat f", "echo hi", "X=1", "git remote add origin u", "git checkout -b t"]) expect([line, q(line)]).toEqual([line, true]);
  // After which a push sends only what the folder held and the line commits: `git remote` in the forms that fetch nothing.
  const plain = (line: string) => { const p = splitCommand(line)!.at(-1)!; return quiet(p, unwrap(p.words), PLAIN_GIT); };
  for (const line of ["git remote add origin u", "git remote set-url --push origin u", "git remote -v", "git remote rename a b"]) expect([line, plain(line)]).toEqual([line, true]);
  for (const line of ["git remote add -f priv /p", "git remote add --fetch priv /p", "git remote add --fet priv /p", "git remote update", "git remote update priv", "git remote set-branches origin x", "git fetch priv"]) expect([line, plain(line), q(line)]).toEqual([line, false, true]);
  for (const line of ["rm -rf x", "mv a b", "cp -r a b", "echo x > f", "bash s.sh", "git worktree remove x", "git mv a b", "git clean -fdx", "git rebase main", "git -c a.b=c commit", "X=1 git commit", "git fetch --upload-pack=./p", "npm install", "ln -s a b"]) expect([line, q(line)]).toEqual([line, false]);
});
