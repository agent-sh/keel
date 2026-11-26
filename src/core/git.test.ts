// The daemon's own git calls against a repository whose files name programs:
// none of them may run. Each program writes a marker file when it does.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAll, git, gitEach, GIT_SHELL_ENV, GIT_SHELL_FETCH, gitEnv, gitSync, innerWork, locate, realDir, realDirLater, remotesAsRun, setGitReach, setGitViews } from "./git.ts";
import { remotesIn, rewritesOwn } from "../safety/looked.ts";
import { handsRoutes } from "../fleet/hands-routes.ts";
import { Shadow } from "../safety/shadow.ts";
import { Store } from "./store.ts";
import { lookRepo } from "../safety/repofacts.ts";
import { confine, sandboxStatus } from "../safety/sandbox.ts";
import { Worktrees } from "../worktree/manager.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-git-")));
const marks = join(root, "marks");
const mark = (name: string) => `touch ${marks}/${name}`;
const ran = () => readdirSync(marks).sort();
// The owner's global config: an identity, and a filter of their own (as git-lfs installs one).
const GLOBAL = join(root, "gitconfig");
writeFileSync(GLOBAL, `[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n[filter "own"]\n\tclean = ${mark("owner-filter")}; cat\n\tsmudge = cat\n`);
const env = { ...process.env, GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: "1" } as Record<string, string>;
// The helper reads the daemon's environment: these two are put back when the file ends.
const was = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = "1";
setGitViews(join(root, "state"));
// git as a session's own command runs it: straight, the repository's config in force.
const raw = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
const must = (cwd: string, ...args: string[]) => { const r = raw(cwd, ...args); if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`); return r.out.trim(); };
beforeEach(() => { rmSync(marks, { recursive: true, force: true }); mkdirSync(marks, { recursive: true }); });
afterAll(() => {
  for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  // (A sandbox's cache layers keep a folder of the kernel's that nothing may read.)
  Bun.spawnSync(["chmod", "-R", "u+rwX", root], { stdout: "ignore", stderr: "ignore" });
  rmSync(root, { recursive: true, force: true });
});

// What a session can plant in a repository it can write: every way git's
// config names a program, with the attributes that turn the drivers on.
// `worktree`: also a core.worktree that names another folder (then git as a
// session runs it does not work in this one at all).
function plant(gitDir: string, common = gitDir, worktree = true) {
  const hooks = join(root, `hooks-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(hooks);
  for (const h of ["post-index-change", "reference-transaction", "post-checkout", "pre-commit", "post-commit", "pre-push", "post-merge", "pre-auto-gc"]) {
    writeFileSync(join(hooks, h), `#!/bin/sh\n${mark(`hook-${h}`)}\n`, { mode: 0o755 });
  }
  mkdirSync(join(common, "hooks"), { recursive: true });
  writeFileSync(join(common, "hooks/post-checkout"), `#!/bin/sh\n${mark("hook-in-git-dir")}\n`, { mode: 0o755 });
  writeFileSync(join(root, "included"), `[core]\n\tfsmonitor = ${mark("included-fsmonitor")}; echo\n`);
  const text = `
[core]
	fsmonitor = ${mark("fsmonitor")}; echo
	hooksPath = ${hooks}
	pager = ${mark("pager")}; cat
	editor = ${mark("editor")}
	sshCommand = ${mark("ssh")}
	gitProxy = ${mark("proxy")}
${worktree ? `	worktree = ${join(root, "elsewhere")}\n` : ""}	alternateRefsCommand = ${mark("alternate-refs")}
[include]
	path = ${join(root, "included")}
[filter "evil"]
	clean = ${mark("filter-clean")}; cat
	smudge = ${mark("filter-smudge")}; cat
[diff]
	external = ${mark("diff-external")}; true
[diff "evil"]
	textconv = ${mark("textconv")}; cat
	command = ${mark("diff-command")}; true
[merge "evil"]
	driver = ${mark("merge-driver")}; true
[credential]
	helper = "!${mark("credential")}"
[protocol "ext"]
	allow = always
[remote "origin"]
	url = ext::sh -c '${mark("ext-transport")}'
	uploadpack = ${mark("upload-pack")}
	receivepack = ${mark("receive-pack")}
[gpg]
	program = ${mark("gpg")}
[log]
	showSignature = true
[alias]
	status = !${mark("alias")}
[submodule]
	recurse = true
`;
  writeFileSync(join(common, "config"), readFileSync(join(common, "config"), "utf8") + text);
  mkdirSync(join(common, "info"), { recursive: true });
  writeFileSync(join(common, "info/attributes"), "* filter=evil diff=evil merge=evil\n");
  void gitDir;
}
// A repository with one commit, a changed file, and attributes that name the planted drivers.
function repo(name: string, how: (dir: string) => void = (dir) => must(dir, "init", "-q")): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  how(dir);
  writeFileSync(join(dir, "f"), "one\n");
  writeFileSync(join(dir, ".gitattributes"), "f filter=evil diff=evil merge=evil\nowned filter=own\n");
  writeFileSync(join(dir, "owned"), "the owner's filter reads this\n");
  must(dir, "add", "-A");
  must(dir, "commit", "-qm", "one");
  return dir;
}
const change = (dir: string) => writeFileSync(join(dir, "f"), "one\ntwo\n");

// Every call the daemon makes by itself in a session's folder, with the
// arguments it uses. `wts`: the worktree manager, for the calls that go through it.
async function daemonCalls(dir: string) {
  change(dir);
  writeFileSync(join(dir, "new"), "untracked\n");
  // Repository facts for the gate.
  const facts = lookRepo(dir)!;
  expect(facts).not.toBeNull();
  expect([facts.dirty(), facts.untracked()]).toEqual([1, 1]);
  expect(Object.keys(facts.remotes)).toEqual(expect.arrayContaining([]));
  // The file picker and the readers tool.
  const listed = await git(dir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { read: true });
  expect(listed.out.split("\0").filter(Boolean).sort()).toEqual([".gitattributes", "f", "new", "owned"]);
  // The worktree manager's reads and writes.
  expect((await git(dir, ["status", "--porcelain", "-z"])).out.split("\0").filter(Boolean).sort()).toEqual([" M f", "?? new"]);
  expect((await git(dir, ["diff", "HEAD", "--", "f"])).out).toContain("+two");
  expect((await git(dir, ["log", "-1", "--format=%s"])).out.trim()).toBe("one");
  const index = join(root, `index-${Math.random().toString(36).slice(2, 8)}`);
  for (const args of [["read-tree", "HEAD"], ["add", "-A"], ["write-tree"]]) expect((await git(dir, args, { index })).code).toBe(0);
  expect((await git(dir, ["diff", "--cached", "--name-only", "-z", "HEAD"], { index })).out.split("\0").filter(Boolean).sort()).toEqual(["f", "new"]);
  for (const args of [["update-ref", "refs/keel/test", "HEAD"], ["update-ref", "-d", "refs/keel/test"], ["branch", "side"], ["branch", "-D", "side"], ["checkout", "HEAD", "--", "."], ["reset", "-q"]]) {
    const r = await git(dir, args);
    expect([args.join(" "), r.code, r.err]).toEqual([args.join(" "), 0, ""]);
  }
  expect(readFileSync(join(dir, "f"), "utf8")).toBe("one\n"); // the checkout wrote this folder, not the one core.worktree names
}

test("where a folder's repository is, read from the files", async () => {
  const main = repo("where");
  must(main, "worktree", "add", "-q", "-b", "w", join(root, "where-wt"));
  mkdirSync(join(main, "sub/deep"), { recursive: true });
  expect(locate(join(main, "sub/deep"))).toEqual({ top: main, gitDir: join(main, ".git"), common: join(main, ".git") });
  expect(locate(join(root, "where-wt"))).toEqual({ top: join(root, "where-wt"), gitDir: join(main, ".git/worktrees/where-wt"), common: join(main, ".git") });
  must(root, "init", "-q", "--bare", "where-bare.git");
  expect(locate(join(root, "where-bare.git"))).toEqual({ gitDir: join(root, "where-bare.git"), common: join(root, "where-bare.git") });
  expect(locate(root)).toBeNull();
  expect(locate(join(root, "no-such-folder"))).toBeNull();
  // A call outside a repository answers as git does, without starting it.
  expect(await git(root, ["status"])).toEqual({ code: 128, out: "", err: `fatal: not a git repository: ${root}` });
});

test("the planted programs do run for git as a session runs it", () => {
  const dir = repo("live");
  plant(join(dir, ".git"), join(dir, ".git"), false);
  change(dir);
  raw(dir, "status", "--porcelain");
  raw(dir, "diff");
  raw(dir, "checkout", "-q", "-b", "x");
  // The fixture is live: these are what the daemon's calls must not start.
  expect(ran()).toEqual(expect.arrayContaining(["included-fsmonitor", "filter-clean", "hook-post-checkout", "hook-reference-transaction", "hook-post-index-change", "diff-command"]));
  // And a planted core.worktree moves git's work to the folder it names.
  mkdirSync(join(root, "elsewhere-live"));
  must(dir, "config", "core.worktree", join(root, "elsewhere-live"));
  expect(raw(join(root, "elsewhere-live"), `--git-dir=${join(dir, ".git")}`, "rev-parse", "--show-toplevel").out.trim()).toBe(join(root, "elsewhere-live"));
});

test("the daemon's git calls run none of them: a repository the session made", async () => {
  const dir = repo("made");
  plant(join(dir, ".git"));
  await daemonCalls(dir);
  // Only the owner's own filter ran (their global config still applies).
  expect(ran()).toEqual(["owner-filter"]);
  expect(existsSync(join(root, "elsewhere"))).toBe(false);
});

test("the same in a nested repository, a linked worktree and a folder whose .git is a file", async () => {
  // A nested repository in an outer one the session cannot change: the outer
  // repository's status does not run git inside it, and a call in it reads its view.
  const outer = repo("outer");
  const nested = repo("outer/nest");
  plant(join(nested, ".git"));
  must(outer, "add", "nest");
  must(outer, "commit", "-qm", "with a nested repository");
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  change(nested);
  expect((await git(outer, ["status", "--porcelain"])).code).toBe(0);
  expect((await git(outer, ["diff"])).code).toBe(0);
  // (The nested repository holds a change: one changed entry, asked of it through its own view.)
  expect(lookRepo(outer)!.dirty()).toBe(1);
  await daemonCalls(nested);
  expect(ran()).toEqual(["owner-filter"]);

  // A linked worktree: the shared config and this worktree's own are both planted.
  const main = repo("shared");
  const wt = join(root, "shared-wt");
  must(main, "worktree", "add", "-q", "-b", "w", wt);
  must(main, "config", "extensions.worktreeConfig", "true");
  plant(join(main, ".git/worktrees/shared-wt"), join(main, ".git"));
  writeFileSync(join(main, ".git/worktrees/shared-wt/config.worktree"), `[core]\n\tfsmonitor = ${mark("worktree-fsmonitor")}; echo\n\tsparseCheckout = false\n`);
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  await daemonCalls(wt);
  await daemonCalls(main);
  expect(ran()).toEqual(["owner-filter"]);

  // A folder whose .git is a file that names a git directory elsewhere.
  const apart = repo("apart", (dir) => must(dir, "init", "-q", "--separate-git-dir", join(root, "apart.git")));
  plant(join(root, "apart.git"));
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  await daemonCalls(apart);
  expect(ran()).toEqual(["owner-filter"]);
});

test("a worktree made, parked, restored and removed in a planted repository runs nothing", async () => {
  const dir = repo("managed");
  plant(join(dir, ".git"));
  const wts = new Worktrees(new Store(join(root, "managed-state")), join(root, "managed-wts"));
  const { wt } = await wts.create("s1", dir, "work");
  wts.adopt("s1", wt);
  expect(readFileSync(join(wt.path, "f"), "utf8")).toBe("one\n"); // checked out, through the view
  expect(must(dir, "worktree", "list").split("\n")).toHaveLength(2);
  writeFileSync(join(wt.path, "f"), "one\nthree\n");
  writeFileSync(join(wt.path, "added"), "new\n");
  const session = { id: "s1", workspace: wt.path } as any;
  expect((await wts.status(wts.get("s1")!)).dirty).toBe(2);
  expect((await wts.branchDiff(session)).files.map((f) => f.path).sort()).toEqual(["added", "f"]);
  expect((await wts.changeDiff(session, "uncommitted")).files.map((f) => f.path).sort()).toEqual(["added", "f"]);
  const parked = await wts.park(wts.get("s1")!);
  expect(existsSync(wt.path)).toBe(false);
  const back = await wts.restore(parked);
  expect(readFileSync(join(back.path, "f"), "utf8")).toBe("one\nthree\n");
  expect(readFileSync(join(back.path, "added"), "utf8")).toBe("new\n");
  expect((await wts.remove(wts.get("s1")!, true)).removed).toBe(true);
  expect(ran()).toEqual(["owner-filter"]);
  expect(existsSync(join(root, "elsewhere"))).toBe(false);
});

test("the view keeps the repository's plain settings and none that names a program", () => {
  const dir = repo("kept");
  must(dir, "config", "core.autocrlf", "input");
  must(dir, "config", "user.name", "Local Name");
  must(dir, "config", "branch.main.remote", "origin");
  // What `gh` keeps there (the repository a fork's pull requests go to), and a file of patterns.
  must(dir, "config", "branch.main.gh-merge-base", "main");
  must(dir, "config", "core.excludesFile", join(root, "kept-excludes"));
  writeFileSync(join(root, "kept-excludes"), "*.mine\n");
  writeFileSync(join(dir, "note.mine"), "left out by the owner's patterns\n");
  plant(join(dir, ".git"));
  must(dir, "config", "remote.origin.gh-resolved", "base");
  // A section named like a property every object has is a section like any other.
  must(dir, "config", "constructor.name", "x");
  const view = gitEnv(dir).GIT_COMMON_DIR!;
  const read = (key: string) => raw(root, "config", "--file", join(view, "config"), "--get", key).out.trim();
  expect([read("core.autocrlf"), read("user.name"), read("branch.main.remote"), read("core.repositoryformatversion")]).toEqual(["input", "Local Name", "origin", "0"]);
  const keys = raw(root, "config", "--file", join(view, "config"), "--list", "--name-only").out.trim().split("\n").sort();
  expect(keys).toEqual(["branch.main.gh-merge-base", "branch.main.remote", "core.autocrlf", "core.excludesfile", "core.filemode", "core.logallrefupdates", "core.repositoryformatversion", "remote.origin.gh-resolved", "remote.origin.url", "user.name"]);
  // The file the owner's patterns leave out is not listed as new.
  expect(gitSync(dir, ["ls-files", "--others", "--exclude-standard"], { read: true }).out).toBe("");
  expect(readdirSync(view).sort()).not.toEqual(expect.arrayContaining(["hooks"]));
  expect(existsSync(join(view, "info/attributes"))).toBe(false);
  // The remote's address is kept, and the transport it names is refused.
  expect(gitSync(dir, ["remote", "-v"], { read: true }).out).toContain("ext::sh");
  const pushed = gitSync(dir, ["push", "origin", "HEAD:refs/heads/x"]);
  expect(pushed.code).not.toBe(0);
  expect(pushed.err).toContain("transport 'ext' not allowed");
  // A change of the repository's config is seen at the next call.
  must(dir, "config", "core.autocrlf", "false");
  expect(raw(root, "config", "--file", join(gitEnv(dir).GIT_COMMON_DIR!, "config"), "--get", "core.autocrlf").out.trim()).toBe("false");
  expect(ran()).toEqual(["owner-filter"]); // from the commit that made the repository

  // The one filter carried from a repository's own config: Git LFS as `git lfs
  // install --local` writes it, whole. One changed line and none of it is.
  const lfs = repo("kept-lfs");
  const stock = [["clean", "git-lfs clean -- %f"], ["smudge", "git-lfs smudge -- %f"], ["process", "git-lfs filter-process"], ["required", "true"]] as const;
  for (const [k, v] of stock) must(lfs, "config", `filter.lfs.${k}`, v);
  const carried = () => raw(root, "config", "--file", join(gitEnv(lfs).GIT_COMMON_DIR!, "config"), "--get-regexp", "^filter\\.").out.trim().split("\n").filter(Boolean).sort();
  // The program is the one the daemon's PATH finds now, written by its whole path.
  const bin = join(root, "lfs-bin"), path = process.env.PATH;
  mkdirSync(bin);
  writeFileSync(join(bin, "git-lfs"), "#!/bin/sh\ncat\n", { mode: 0o755 });
  process.env.PATH = `${bin}:${path}`;
  try {
    expect(carried()).toEqual(stock.map(([k, v]) => `filter.lfs.${k} ${v.replace("git-lfs", `'${bin}/git-lfs'`)}`).sort());
    // One inside the work tree, first on the PATH (by a relative entry too): the session wrote it, and it is not run.
    mkdirSync(join(lfs, "tools"));
    writeFileSync(join(lfs, "tools/git-lfs"), `#!/bin/sh\n${mark("lfs-in-tree")}\ncat\n`, { mode: 0o755 });
    process.env.PATH = `${join(lfs, "tools")}:${path}`;
    must(lfs, "config", "core.autocrlf", "false"); // (the config changed: the view is written again)
    expect(carried()).toEqual([]);
    writeFileSync(join(lfs, ".gitattributes"), "f filter=lfs\n");
    writeFileSync(join(lfs, "f"), "one\nlfs\n");
    expect(gitSync(lfs, ["add", "-A"], { index: join(root, "lfs-index") }).code).toBe(0);
    expect(ran()).not.toContain("lfs-in-tree");
  } finally {
    process.env.PATH = `${bin}:${path}`;
  }
  must(lfs, "config", "core.autocrlf", "input");
  expect(carried()).toHaveLength(4);
  expect(existsSync(join(lfs, ".git/lfs"))).toBe(true); // where git-lfs keeps its objects, linked into the view
  must(lfs, "config", "filter.lfs.smudge", `${mark("lfs-smudge")}; git-lfs smudge -- %f`);
  expect(carried()).toEqual([]);
  must(lfs, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
  must(lfs, "config", "filter.lfs.extra", "x");
  expect(carried()).toEqual([]);
  process.env.PATH = path;
});

test("a repository of another user is not opened, unless the owner listed it as safe", async () => {
  const dir = repo("theirs");
  const uid = process.getuid!;
  // As if the daemon ran as someone else: the folder is then another user's.
  process.getuid = () => uid() + 1;
  try {
    setGitViews(join(root, "state")); // (the owner's config is read again)
    expect(locate(dir)).toBeNull();
    expect(lookRepo(join(dir, "."))).toBeNull();
    expect(await git(dir, ["status", "--porcelain"])).toEqual({ code: 128, out: "", err: `fatal: detected dubious ownership in repository at '${dir}': it is another user's, and not listed in safe.directory` });
    const global = readFileSync(GLOBAL, "utf8");
    symlinkSync(dir, join(root, "theirs-link"));
    // The folder as the owner may write it: itself, with a slash at its end, through a link, by its parent.
    for (const entry of [dir, `${dir}/`, join(root, "theirs-link"), `${root}/*`, "*"]) {
      writeFileSync(GLOBAL, `${global}[safe]\n\tdirectory = ${entry}\n`);
      setGitViews(join(root, "state"));
      expect([entry, locate(dir)?.top]).toEqual([entry, dir]);
    }
    expect((await git(dir, ["status", "--porcelain"])).code).toBe(0);
    for (const entry of [join(root, "kept"), `${dir}-other`, `${dir}/sub/*`]) {
      writeFileSync(GLOBAL, `${global}[safe]\n\tdirectory = ${entry}\n`);
      setGitViews(join(root, "state"));
      expect([entry, locate(dir)]).toEqual([entry, null]);
    }
    writeFileSync(GLOBAL, global);
  } finally {
    process.getuid = uid;
    setGitViews(join(root, "state"));
  }
});

test("a partial clone's diff is its list of files when the contents are not here, and nothing is fetched", async () => {
  const src = repo("partial-src");
  must(src, "config", "uploadpack.allowFilter", "true");
  writeFileSync(join(src, "f"), "one\ntwo\n");
  must(src, "commit", "-qam", "two");
  must(root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${src}`, "partial");
  const dir = join(root, "partial");
  const wts = new Worktrees(new Store(join(root, "partial-state")), join(root, "partial-wts"));
  const d = await wts.changeDiff({ id: "p1", workspace: dir } as any, "commit", "HEAD");
  expect([d.files.map((f) => `${f.status} ${f.path}`), d.diff, d.truncated]).toEqual([["M f"], "", true]);
  expect(raw(dir, "rev-list", "--objects", "--missing=print", "HEAD").out).toMatch(/^\?[0-9a-f]{40}/m); // still not here
});

test("a view that was written over is made again, and the view of a git directory that is gone is removed", async () => {
  const dir = repo("tampered");
  change(dir);
  const view = gitEnv(dir).GIT_COMMON_DIR!;
  const good = readFileSync(join(view, "config"), "utf8");
  // What a command could do if it reached the folder: a config that names a program, and attributes.
  writeFileSync(join(view, "config"), `${good}[core]\n\tfsmonitor = ${mark("view-fsmonitor")}; echo\n`);
  writeFileSync(join(view, "info/attributes"), "* filter=evil\n");
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  expect((await git(dir, ["status", "--porcelain"])).out).toBe(" M f\n");
  expect(ran().filter((m) => m !== "owner-filter")).toEqual([]);
  expect(readFileSync(join(view, "config"), "utf8")).toBe(good);
  expect(existsSync(join(view, "info/attributes"))).toBe(false);
  // A start removes the views of repositories that are gone, and keeps the others.
  const gone = repo("gone");
  const stale = gitEnv(gone).GIT_COMMON_DIR!;
  rmSync(gone, { recursive: true });
  setGitViews(join(root, "state"));
  expect([existsSync(stale), existsSync(view)]).toEqual([false, true]);
});

test.skipIf(!sandboxStatus().available)("a confined command cannot write a view, also when its folder holds the state folder", () => {
  const dir = repo("held");
  const view = gitEnv(dir).GIT_COMMON_DIR!;
  const r = Bun.spawnSync(confine(["bash", "-c", `echo x >> ${view}/config; mkdir ${view}/hooks; echo x > ${join(root, "state")}/other && echo wrote-beside`], { sandbox: "workspace-write", network: false }, root), { cwd: root, stdout: "pipe", stderr: "pipe" });
  const said = r.stdout.toString() + r.stderr.toString();
  // Keel's state is in no sandbox, also for a session whose folder holds it (src/safety/sandbox-view.ts): the view
  // is not there to write, and what the command wrote "beside" it landed in the sandbox's own empty folder.
  expect(said.match(/No such file or directory|Read-only file system/g)).toHaveLength(2);
  expect(existsSync(join(view, "hooks"))).toBe(false);
  expect(readFileSync(join(view, "config"), "utf8")).not.toContain("\nx\n");
  expect(existsSync(join(root, "state/other"))).toBe(false);
});

// git asks a repository inside a work tree about itself by running git in it,
// which reads that repository's own config and attributes: `add` does, for a
// submodule, a gitlink and a nested repository it does not track.
test("an add over a work tree that holds other repositories runs nothing they name, and records them as git does", async () => {
  const lib = repo("lib-src");
  const outer = repo("holds");
  must(outer, "submodule", "add", "-q", lib, "vendor/lib");
  const linked = repo("holds/linked"), loose = repo("holds/loose");
  must(outer, "add", "linked");
  must(outer, "commit", "-qm", "a submodule and a gitlink");
  // Each inner repository names a filter in its own config, turned on by its own attributes, and holds a change.
  for (const [dir, gitDir] of [[join(outer, "vendor/lib"), join(outer, ".git/modules/vendor/lib")], [linked, join(linked, ".git")], [loose, join(loose, ".git")]] as const) {
    plant(gitDir, gitDir, false);
    change(dir);
  }
  const heads = [join(outer, "vendor/lib"), linked, loose].map((d) => must(d, "rev-parse", "HEAD"));
  const reset = () => { rmSync(marks, { recursive: true, force: true }); mkdirSync(marks); };
  const tree = async (run: (args: string[], input?: string) => Promise<string>) => (await run(["ls-files", "-s"])).split("\n").filter((l) => l.startsWith("160000")).map((l) => l.replace(/ 0\t/, " ")).sort();
  // (Sorted as text, as `tree` sorts what it reads: the ids differ from run to run.)
  const want = [`160000 ${heads[1]} linked`, `160000 ${heads[2]} loose`, `160000 ${heads[0]} vendor/lib`].sort();

  // The fixture is live: git's own add runs the inner filters.
  reset();
  raw(outer, "add", "-A", "-n");
  raw(outer, "-c", "core.hooksPath=/dev/null", "add", "-A");
  expect(ran()).toContain("filter-clean");
  must(outer, "reset", "-q");

  // The daemon's add, over an index of its own (a park, a move, the Changes panel's tree).
  reset();
  const index = join(root, "holds-index");
  const run = async (args: string[], input?: string) => { const r = await git(outer, args, { index, input }); if (r.code !== 0) throw new Error(r.err); return r.out; };
  await run(["read-tree", "HEAD"]);
  expect((await addAll(outer, run)).map((i) => `${i.path}:${i.tracked}`).sort()).toEqual(["linked:true", "loose:false", "vendor/lib:true"]);
  expect(await tree(run)).toEqual(want);
  expect(ran().filter((m) => m !== "owner-filter")).toEqual([]);

  // A checkpoint's snapshot of the folder, twice (the second finds the gitlinks in its own index), and the Changes panel's tree.
  const shadow = new Shadow(join(root, "holds-shadow"), outer);
  const first = await shadow.snapshot();
  writeFileSync(join(outer, "f"), "one\nthree\n");
  const second = await shadow.snapshot();
  expect(second).not.toBe(first);
  expect((await shadow.git(["ls-tree", "-r", second])).split("\n").filter((l) => l.startsWith("160000")).map((l) => l.replace(" commit", "").replace("\t", " ")).sort()).toEqual(want);
  const wts = new Worktrees(new Store(join(root, "holds-state")), join(root, "holds-wts"));
  expect((await wts.changeDiff({ id: "h1", workspace: outer } as any, "uncommitted")).files.map((f) => f.path)).toContain("f");
  expect(ran().filter((m) => m !== "owner-filter")).toEqual([]);
});

// A worktree is removed when it holds no work. Work inside a repository it
// holds is work: git's own status says so, and the daemon's does not look
// inside one, so each is asked.
test("work inside a submodule or a nested repository keeps a worktree, and one that cannot be read is unknown", async () => {
  const lib = repo("lib2-src");
  const sup = repo("super");
  must(sup, "submodule", "add", "-q", lib, "vendor/lib");
  must(sup, "commit", "-qm", "a submodule");
  const wts = new Worktrees(new Store(join(root, "super-state")), join(root, "super-wts"));
  const make = async (key: string) => { const { wt } = await wts.create(key, sup, key); wts.adopt(key, wt); must(wt.path, "submodule", "update", "-q", "--init"); return wts.get(key)!; };
  const facts = (dir: string) => { const f = lookRepo(dir)!; return f.dirty(); };

  // The reviewer's case: a file of the submodule edited, and a new one beside it.
  const w = await make("edit");
  expect([(await wts.status(w)).dirty, facts(w.path)]).toEqual([0, 0]);
  writeFileSync(join(w.path, "vendor/lib/f"), "one\nedited\n");
  writeFileSync(join(w.path, "vendor/lib/new.txt"), "new\n");
  const st = await wts.status(w);
  expect([st.dirty, st.inner, st.unknown]).toEqual([1, ["vendor/lib"], undefined]);
  expect(await innerWork(w.path)).toEqual({ dirty: ["vendor/lib"], unpushed: [], unknown: [] });
  await Bun.sleep(5_100); // (the facts of a folder are kept a few seconds)
  expect(facts(w.path)).toBe(1);
  expect(await wts.remove(w, false)).toEqual({ removed: false, reason: "it holds work: 1 changed files, 0 commits", branch_deleted: false });
  // A snapshot of the worktree would not hold it either: nothing is removed.
  expect((await wts.remove(w, true)).reason).toContain("a repository inside it holds work that a snapshot does not keep (vendor/lib)");
  expect(wts.park(w)).rejects.toThrow("a snapshot does not keep");
  expect(wts.toMain(w, { id: "edit", workspace: w.path } as any)).rejects.toThrow("a snapshot does not keep");
  expect(readFileSync(join(w.path, "vendor/lib/f"), "utf8")).toBe("one\nedited\n");

  // Only a new file inside the submodule.
  const u = await make("untracked");
  writeFileSync(join(u.path, "vendor/lib/new.txt"), "new\n");
  expect([(await wts.status(u)).dirty, (await wts.remove(u, false)).removed]).toEqual([1, false]);
  // The submodule at another commit: git's own status lists it, once.
  const c = await make("commit");
  writeFileSync(join(c.path, "vendor/lib/f"), "one\ncommitted\n");
  must(join(c.path, "vendor/lib"), "commit", "-qam", "inside");
  expect([(await wts.status(c)).dirty, (await wts.remove(c, false)).removed]).toEqual([1, false]);
  // That commit is in the worktree's own git directory and nowhere else: also
  // when the outer repository records it, the worktree does not go with a snapshot.
  must(c.path, "commit", "-qam", "the submodule moved");
  const cs = await wts.status(c);
  expect([cs.dirty, cs.commits_ahead, cs.inner]).toEqual([0, 1, ["vendor/lib"]]);
  expect((await wts.remove(c, true)).reason).toBe("a repository inside it holds commits of its own that none of its remotes has, which a snapshot does not keep (vendor/lib): push them, or move it out, first");
  expect(wts.park(c)).rejects.toThrow("a snapshot does not keep");
  expect(must(join(c.path, "vendor/lib"), "log", "-1", "--format=%s")).toBe("inside");
  // The main checkout's copy of the submodule holds that commit (fetched by
  // name, as a pull request's head is): it is not lost with the worktree's
  // copy, so nothing is held back.
  must(join(sup, "vendor/lib"), "fetch", "-q", join(c.path, "vendor/lib"), "HEAD");
  expect([(await wts.status(c)).inner, (await innerWork(c.path)).unpushed]).toEqual([undefined, []]);
  expect((await wts.remove(c, true)).removed).toBe(true);
  // A repository in the worktree that is no submodule: it is in no tree at all.
  const n = await make("nested");
  mkdirSync(join(n.path, "nest"));
  must(join(n.path, "nest"), "init", "-q");
  must(join(n.path, "nest"), "commit", "-q", "--allow-empty", "-m", "first");
  const ns = await wts.status(n);
  expect([ns.dirty, ns.inner]).toEqual([1, ["nest"]]);
  expect((await wts.remove(n, true)).removed).toBe(false);
  // The same below a folder the outer repository does not track.
  const d = await make("deep");
  mkdirSync(join(d.path, "newdir/nest"), { recursive: true });
  must(join(d.path, "newdir/nest"), "init", "-q");
  must(join(d.path, "newdir/nest"), "commit", "-q", "--allow-empty", "-m", "first");
  expect((await wts.status(d)).inner).toEqual(["newdir/nest"]);
  expect((await wts.remove(d, true)).removed).toBe(false);
  // A submodule whose `.git` is a folder that is no git directory: the
  // repository found from it is the outer one, which is not asked in its place.
  const b = await make("damaged");
  rmSync(join(b.path, "vendor/lib/.git"));
  mkdirSync(join(b.path, "vendor/lib/.git"));
  expect(await innerWork(b.path)).toEqual({ dirty: [], unpushed: [], unknown: ["vendor/lib"] });
  expect((await wts.status(b)).unknown).toContain("could not be read (vendor/lib)");
  const bi = join(root, "damaged-index");
  const brun = async (args: string[], input?: string) => { const r = await git(b.path, args, { index: bi, input }); if (r.code !== 0) throw new Error(r.err); return r.out; };
  await brun(["read-tree", "HEAD"]);
  expect((await addAll(b.path, brun)).map((i) => [i.path, i.head])).toEqual([["vendor/lib", undefined]]);
  // A submodule whose git directory cannot be read: unknown, and nothing is removed on that.
  const x = await make("broken");
  rmSync(join(sup, ".git/worktrees", x.path.split("/").pop()!, "modules/vendor/lib/HEAD"));
  const xs = await wts.status(x);
  expect(xs.unknown).toContain("a repository inside it could not be read (vendor/lib)");
  expect((await wts.remove(x, false)).reason).toContain("git cannot read the worktree's state");
  expect((await wts.remove(x, true)).removed).toBe(false);
  expect(facts(x.path)).toBeNull();
  // A clean one goes.
  const clean = await make("clean");
  expect((await wts.remove(clean, false)).removed).toBe(true);
}, 30_000);

// A partial clone has not every file's contents. The fill of a new worktree
// and the checkout of a restore may fetch them: through the view, which holds
// the remote's address and nothing else of the repository's own config.
test("a worktree is made in a partial clone by fetching what is missing, and no program the repository names runs for it", async () => {
  const src = repo("blobless-src");
  must(src, "config", "uploadpack.allowFilter", "true");
  writeFileSync(join(src, "big"), "contents that are not in the clone\n");
  must(src, "add", "big");
  must(src, "commit", "-qm", "big");
  must(root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${src}`, "blobless");
  const dir = join(root, "blobless");
  const missing = () => raw(dir, "rev-list", "--objects", "--missing=print", "HEAD").out.split("\n").filter((l) => l.startsWith("?")).length;
  expect(missing()).toBeGreaterThan(0);
  // What a session could plant to be run by a fetch: each is a way git starts a program for a remote.
  must(dir, "config", "remote.origin.uploadpack", `${mark("uploadpack")}; git-upload-pack`);
  must(dir, "config", "core.sshCommand", mark("ssh"));
  must(dir, "config", "credential.helper", `!${mark("credential")}`);
  must(dir, "config", `url.ext::sh -c '${mark("rewrite")}'.insteadOf`, `file://${src}`);
  must(dir, "config", "core.gitProxy", mark("proxy"));
  const wts = new Worktrees(new Store(join(root, "blobless-state")), join(root, "blobless-wts"));
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  // A read fetches nothing.
  expect((await wts.changeDiff({ id: "b0", workspace: dir } as any, "commit", "HEAD")).diff).toBe("");
  expect(missing()).toBeGreaterThan(0);
  const { wt } = await wts.create("b1", dir, "work");
  wts.adopt("b1", wt);
  expect(readFileSync(join(wt.path, "big"), "utf8")).toBe("contents that are not in the clone\n");
  expect(missing()).toBe(0);
  expect(ran().filter((m) => m !== "owner-filter")).toEqual([]);

  // The remote is gone: the worktree cannot be filled. Nothing of it stays
  // (its folder, its entry, its branch), the answer says what to do, and the
  // same call works once the remote is back.
  must(root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${src}`, "blobless2");
  const dir2 = join(root, "blobless2");
  renameSync(src, `${src}-away`);
  const failed = await wts.create("b2", dir2, "work").then(() => "made", (e) => (e as Error).message);
  expect(failed).toContain("partial clone and a file of that commit could not be fetched");
  expect(failed).toContain(`git -C ${dir2} archive`);
  expect(must(dir2, "worktree", "list").split("\n")).toHaveLength(1);
  expect(must(dir2, "branch", "--list", "keel/*")).toBe("");
  expect(existsSync(join(root, "blobless-wts"))).toBe(true);
  renameSync(`${src}-away`, src);
  const again = await wts.create("b2", dir2, "work");
  expect(readFileSync(join(again.wt.path, "big"), "utf8")).toBe("contents that are not in the clone\n");
});

// The address a fill fetches from is the repository's to name, and a session
// can write it: the fetch reaches no further than the session the worktree
// is for reaches with its own commands.
test("a fill fetches only as far as its session reaches, and starts no other transport program", async () => {
  const src = repo("reach-src");
  must(src, "config", "uploadpack.allowFilter", "true");
  writeFileSync(join(src, "big"), "contents that are not in the clone\n");
  must(src, "add", "big");
  must(src, "commit", "-qm", "big");
  const clone = (name: string) => { must(root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${src}`, name); return join(root, name); };
  const wts = new Worktrees(new Store(join(root, "reach-state")), join(root, "reach-wts"));
  const tried = (key: string, dir: string) => wts.create(key, dir, "work").then(() => "made", (e) => (e as Error).message);
  const left = (dir: string) => [must(dir, "worktree", "list").split("\n").length, must(dir, "branch", "--list", "keel/*")];
  // Any address a session wrote into the config: a listener here counts what reaches it.
  const got: string[] = [];
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { got.push(new URL(req.url).pathname); return new Response("no", { status: 404 }); } });
  const reach = { of: "public" as "any" | "public" | undefined };
  setGitReach(() => reach.of);
  try {
    // A session whose network is off: nothing is fetched, also from the remote the clone was made from.
    reach.of = undefined;
    const off = clone("reach-off");
    const said = await tried("r1", off);
    expect(said).toContain("could not be fetched: Keel fetches nothing for a session whose own commands cannot reach the network. Fetch its files first");
    expect(left(off)).toEqual([1, ""]);

    // A confined session with its network on: not from an address on this machine.
    reach.of = "public";
    const local = clone("reach-local");
    must(local, "config", "remote.origin.url", `http://127.0.0.1:${listener.port}/the-session-text/repo.git`);
    expect(await tried("r2", local)).toContain(`could not be fetched: the remote origin is at an address on this machine or a private network (127.0.0.1), which Keel fetches from only for a session whose sandbox is off`);
    // A second promisor remote the session added, at a private address, with the first one fine.
    const second = clone("reach-second");
    must(second, "config", "remote.other.url", `http://10.0.0.7:${listener.port}/x.git`);
    must(second, "config", "remote.other.promisor", "true");
    expect(await tried("r3", second)).toContain("the remote other is at an address on this machine or a private network (10.0.0.7)");
    // The short ssh form, and a name with no dot.
    const short = clone("reach-short");
    must(short, "config", "remote.origin.url", "git@buildbox:team/repo.git");
    expect(await tried("r4", short)).toContain("(buildbox)");
    expect(got).toEqual([]);
    expect([left(local), left(second), left(short)]).toEqual([[1, ""], [1, ""], [1, ""]]);

    // A transport of a program on PATH (git-remote-<name>): never started, however far the session reaches.
    reach.of = "any";
    const bin = join(root, "reach-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git-remote-foo"), `#!/bin/sh\n${mark("remote-foo")}\n`, { mode: 0o755 });
    const helper = clone("reach-helper");
    must(helper, "config", "remote.origin.url", "foo::anything");
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try { expect(await tried("r5", helper)).toContain("could not be fetched: the remote origin uses the transport foo, and Keel's git speaks https, http, ssh and git only"); } finally { process.env.PATH = path; }
    // (And git itself is told the same, should a remote be named another way.)
    expect(gitEnv(local, "any")[`GIT_CONFIG_VALUE_${Object.entries(gitEnv(local, "any")).find(([, v]) => v === "protocol.allow")![0].split("_").at(-1)}`]).toBe("never");
    expect(ran().filter((m) => m !== "owner-filter")).toEqual([]);

    // A session that is not confined reaches that address with its own commands: so does its fill.
    expect(await tried("r6", local)).toContain("could not be fetched");
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((p) => p.startsWith("/the-session-text/repo.git/"))).toBe(true);

    // On another machine: the script's fill fetches only when the route that runs it allowed it.
    expect(GIT_SHELL_FETCH).toStartWith('if [ -n "${KEEL_GIT_FETCH:-}" ]; then unset GIT_NO_LAZY_FETCH; export GIT_CONFIG_COUNT=');
    expect(GIT_SHELL_FETCH).toContain("=protocol.allow GIT_CONFIG_VALUE_");
    const there = clone("reach-there");
    expect([gitEnv(there).KEEL_GIT_FETCH, gitEnv(there, "public").KEEL_GIT_FETCH, gitEnv(there, "public").GIT_NO_LAZY_FETCH, gitEnv(local, "public").KEEL_GIT_FETCH, gitEnv(local, "public").GIT_NO_LAZY_FETCH, gitEnv(local, "any").KEEL_GIT_FETCH]).toEqual([undefined, "1", undefined, undefined, "1", "1"]);
  } finally {
    setGitReach(() => "public");
    listener.stop(true);
  }
});

test("a repository of another hash format inside the folder is left out of a snapshot, as git leaves it", async () => {
  const outer = repo("mixed");
  mkdirSync(join(outer, "other"));
  must(join(outer, "other"), "init", "-q", "--object-format=sha256");
  writeFileSync(join(outer, "other/x"), "x\n");
  must(join(outer, "other"), "add", "x");
  must(join(outer, "other"), "commit", "-qm", "x");
  writeFileSync(join(outer, "f"), "one\nmixed\n");
  const shadow = new Shadow(join(root, "mixed-shadow"), outer);
  const tree = await shadow.snapshot();
  expect(shadow.mode).toBe("tree");
  expect((await shadow.git(["ls-tree", "-r", "--name-only", tree])).trim().split("\n").sort()).toEqual([".gitattributes", "f", "owned"]);
  const wts = new Worktrees(new Store(join(root, "mixed-state")), join(root, "mixed-wts"));
  expect((await wts.changeDiff({ id: "m1", workspace: outer } as any, "uncommitted")).files.map((f) => f.path)).toEqual(["f"]);
});

test("a move to a worktree leaves a submodule's own changes in the main checkout, and stops for a repository it cannot move", async () => {
  const lib = repo("lib3-src");
  const sup = repo("moves");
  must(sup, "submodule", "add", "-q", lib, "vendor/lib");
  must(sup, "commit", "-qm", "a submodule");
  writeFileSync(join(sup, "f"), "one\nouter\n");
  writeFileSync(join(sup, "vendor/lib/f"), "one\ninner\n");
  const wts = new Worktrees(new Store(join(root, "moves-state")), join(root, "moves-wts"));
  const moved = await wts.toWorktree({ id: "mv1", workspace: sup, title: "move" } as any);
  expect([moved.moved, moved.stayed]).toEqual([2, ["vendor/lib"]]);
  expect(readFileSync(join(moved.wt.path, "f"), "utf8")).toBe("one\nouter\n");
  expect(readFileSync(join(sup, "f"), "utf8")).toBe("one\n");
  expect(readFileSync(join(sup, "vendor/lib/f"), "utf8")).toBe("one\ninner\n"); // still there
  // A repository the outer one does not track: main failed half way on it; nothing is touched.
  mkdirSync(join(sup, "nest"));
  must(join(sup, "nest"), "init", "-q");
  writeFileSync(join(sup, "f"), "one\nagain\n");
  expect(wts.toWorktree({ id: "mv2", workspace: sup, title: "move" } as any)).rejects.toThrow("a repository inside it holds work that a snapshot does not keep (nest)");
  expect(readFileSync(join(sup, "f"), "utf8")).toBe("one\nagain\n");
});

test("a push to a remote the repository names by a folder runs no hook there, and the file transport is off for everything else", async () => {
  must(root, "init", "-q", "--bare", "origin.git");
  const origin = join(root, "origin.git");
  mkdirSync(join(origin, "hooks"), { recursive: true });
  for (const h of ["pre-receive", "update", "post-receive", "post-update"]) writeFileSync(join(origin, "hooks", h), `#!/bin/sh\n${mark(`origin-${h}`)}\n`, { mode: 0o755 });
  const dir = repo("pushes");
  must(dir, "remote", "add", "origin", origin);
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  const pushed = await git(dir, ["push", "origin", "HEAD:refs/heads/pushed"]);
  expect([pushed.code, pushed.err.includes("not allowed")]).toEqual([0, false]);
  expect(must(origin, "rev-parse", "refs/heads/pushed")).toBe(must(dir, "rev-parse", "HEAD"));
  expect(ran()).toEqual([]);
  expect((await git(dir, ["fetch", "origin"])).code).toBe(0);
  // An address given on the command line, or any other command: the transport stays off.
  expect((await git(dir, ["ls-remote", origin])).err).toContain("transport 'file' not allowed");
  expect((await git(dir, ["fetch", origin])).err).toContain("transport 'file' not allowed");

  // The repository pushed into is one a session may have written. Its config
  // names a program for the refs of its alternates: not run.
  must(root, "clone", "-q", "--bare", dir, "alt.git");
  must(root, "clone", "-q", "--bare", dir, "target.git");
  const target = join(root, "target.git");
  writeFileSync(join(target, "objects/info/alternates"), `${join(root, "alt.git/objects")}\n`);
  must(target, "config", "core.alternateRefsCommand", `${mark("alternate-refs")}; true`);
  must(target, "config", "core.fsmonitor", `${mark("target-fsmonitor")}; echo`);
  must(dir, "remote", "add", "target", target);
  must(dir, "commit", "-q", "--allow-empty", "-m", "more");
  // (As a session's own git pushes there, the program runs.)
  must(dir, "push", "-q", "target", "HEAD:refs/heads/by-hand");
  expect(ran()).toContain("alternate-refs");
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  expect((await git(dir, ["push", "target", "HEAD:refs/heads/pushed"])).code).toBe(0);
  expect((await git(dir, ["fetch", "target"])).code).toBe(0);
  expect(ran()).toEqual([]);
  // A remote whose push address is that folder and whose fetch address is elsewhere: the push address decides.
  must(dir, "remote", "add", "split", "https://example.invalid/x.git");
  must(dir, "config", "remote.split.pushurl", target);
  expect((await git(dir, ["push", "split", "HEAD:refs/heads/split"])).code).toBe(0);
  expect(ran()).toEqual([]);
  // And the other way round: nothing of Keel's is named for a program on another machine.
  must(dir, "remote", "add", "away", target);
  must(dir, "config", "remote.away.pushurl", "ssh://example.invalid/x.git");
  const view = readFileSync(join(gitEnv(dir).GIT_COMMON_DIR!, "config"), "utf8").split("\n");
  const keysOf = (remote: string) => { let on = false; return view.filter((l) => (l.startsWith("[") ? ((on = l === `[remote "${remote}"]`), false) : on)).map((l) => l.trim().split(" = ")[0]).filter(Boolean).sort(); };
  expect([keysOf("away"), keysOf("split")]).toEqual([["fetch", "pushurl", "uploadpack", "url"], ["fetch", "pushurl", "receivepack", "url"]]);

  // A push into a branch that is checked out there would update its files,
  // through that repository's file-system monitor and filters: refused, and
  // the answer says why.
  must(root, "clone", "-q", dir, "checked-out");
  const live = join(root, "checked-out");
  must(live, "checkout", "-q", "-b", "work");
  must(live, "config", "receive.denyCurrentBranch", "updateInstead");
  must(live, "config", "core.fsmonitor", `${mark("live-fsmonitor")}; echo`);
  must(live, "config", "filter.x.smudge", `${mark("live-smudge")}; cat`);
  must(live, "config", "filter.x.clean", `${mark("live-clean")}; cat`);
  writeFileSync(join(live, ".git/info/attributes"), "* filter=x\n");
  must(dir, "remote", "add", "live", live);
  writeFileSync(join(dir, "pushed.txt"), "pushed\n");
  must(dir, "add", "pushed.txt");
  must(dir, "commit", "-qm", "a file");
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  const into = await git(dir, ["push", "live", "HEAD:refs/heads/work"]);
  expect(into.code).not.toBe(0);
  expect(into.err).toContain("Keel does not push into a branch that is checked out in the repository it pushes to");
  expect([ran(), existsSync(join(live, "pushed.txt"))]).toEqual([[], false]);
  // Another branch of it takes the push.
  expect((await git(dir, ["push", "live", "HEAD:refs/heads/other"])).code).toBe(0);
  expect(ran()).toEqual([]);
});

test("the work in a folder on another machine is asked through that machine's helper, and a script never fetches", async () => {
  expect(GIT_SHELL_ENV).toContain("export GIT_NO_LAZY_FETCH=1 ");
  const lib = repo("lib4-src");
  const sup = repo("far");
  must(sup, "submodule", "add", "-q", lib, "vendor/lib");
  must(sup, "commit", "-qm", "a submodule");
  // The submodule names a filter in its own config and holds a change: a status run inside it would start the program.
  plant(join(sup, ".git/modules/vendor/lib"), join(sup, ".git/modules/vendor/lib"), false);
  writeFileSync(join(sup, "vendor/lib/f"), "two\n"); // (the same size: git must read the file)
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
  const routes = handsRoutes({ spillRoot: join(root, "far-spill"), capture: (e) => ({ message: String(e) }), instructions: () => "" }) as any;
  const ask = async (b: object) => JSON.parse((await (await routes["/api/fleet/hands/work"].POST(new Request("http://x/api/fleet/hands/work", { method: "POST", body: JSON.stringify(b) }))).text()).trim());
  expect(await ask({ dir: sup, root, base: "HEAD" })).toEqual({ dirty: 1, unpushed: [], unknown: [], ahead: 0 });
  expect(ran().filter((m) => m !== "owner-filter")).toEqual([]);
  expect((await ask({ dir: sup, root: join(root, "kept") })).error).toContain("not a directory inside the granted one");
});

// A listing read as it comes stops git where its reader stops, and when the reader fails:
// otherwise git waits on a full pipe for its whole timeout.
test("gitEach stops git when told to and when its reader throws", async () => {
  const dir = join(root, "each");
  mkdirSync(dir);
  must(dir, "init", "-q");
  writeFileSync(join(dir, "big"), "x\0".repeat(4_000_000));
  must(dir, "add", "big");
  must(dir, "commit", "-q", "-m", "big");
  // The git processes of this test still running (a zombie is gone).
  const alive = () => {
    const kids: string[] = [];
    for (const t of readdirSync(`/proc/${process.pid}/task`)) {
      try { kids.push(...readFileSync(`/proc/${process.pid}/task/${t}/children`, "utf8").split(" ").filter(Boolean)); } catch {}
    }
    return kids.filter((pid) => {
      try { return readlinkSync(`/proc/${pid}/cwd`) === dir && !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
    }).length;
  };
  const gone = async () => { for (let i = 0; i < 60 && alive(); i++) await Bun.sleep(50); return alive() === 0; };
  // Read whole: every entry, in order.
  let n = 0;
  const whole = await gitEach(dir, ["cat-file", "blob", "HEAD:big"], { timeout: 30_000 }, (e) => { n += e.filter((x) => x === "x").length; return true; });
  expect(whole).toEqual({ code: 0, err: "" });
  expect(n).toBe(4_000_000);
  // Stopped at the first chunk: one call, git killed long before it printed everything.
  let calls = 0;
  const stopped = await gitEach(dir, ["cat-file", "blob", "HEAD:big"], { timeout: 30_000 }, () => { calls++; return false; });
  expect(stopped.stopped).toBe(true);
  expect(calls).toBe(1);
  expect(await gone()).toBe(true);
  // The reader throws: the failure is passed on, and git does not wait on the pipe.
  await expect(gitEach(dir, ["cat-file", "blob", "HEAD:big"], { timeout: 30_000 }, () => { throw new Error("reader failed"); })).rejects.toThrow("reader failed");
  expect(await gone()).toBe(true);
});

test("a session with no managed worktree is diffed against the local base, not a remote ref that lags it", async () => {
  const dir = repo("lagging");
  const origin = join(root, "lagging-origin.git");
  must(root, "init", "-q", "--bare", "-b", "main", origin);
  must(dir, "remote", "add", "origin", origin);
  must(dir, "push", "-q", "origin", "main");
  must(dir, "remote", "set-head", "origin", "main");
  // A landing committed on main and not pushed, then a branch cut from it with one change of its own.
  writeFileSync(join(dir, "landed"), "landed\n");
  must(dir, "add", "-A");
  must(dir, "commit", "-qm", "landed, not pushed");
  must(dir, "checkout", "-q", "-b", "work");
  writeFileSync(join(dir, "mine"), "mine\n");
  must(dir, "add", "-A");
  must(dir, "commit", "-qm", "mine");
  const wts = new Worktrees(new Store(join(root, "lagging-state")), join(root, "lagging-wts"));
  const d = await wts.branchDiff({ id: "l1", workspace: dir } as any);
  expect(d.base).toBe("main");
  expect(d.commits).toBe(1);
  expect(d.files.map((f) => f.path)).toEqual(["mine"]);
  expect((await wts.changeDiff({ id: "l1", workspace: dir } as any, "branch")).files.map((f) => f.path)).toEqual(["mine"]);
});

test("the remotes are listed as the owner's own git lists them: the repository's url rewrites applied, in no other call", async () => {
  const mk = (name: string, ...config: [string, string][]) => {
    const dir = repo(name);
    must(dir, "remote", "add", "origin", "https://forge.example/me/app.git");
    for (const [k, v] of config) must(dir, "config", k, v);
    return dir;
  };
  const listed = async (dir: string) => (await remotesAsRun(dir, 10_000)).out.trim();
  const own = (dir: string) => must(dir, "remote", "-v");
  const instead = mk("rw-instead", ["url.https://forge.example/them/.insteadOf", "https://forge.example/me/"]);
  const push = mk("rw-push", ["url.https://forge.example/them/.pushInsteadOf", "https://forge.example/me/"]);
  const both = mk("rw-both", ["remote.origin.pushurl", "https://forge.example/me/other.git"], ["url.ssh://git@forge.example/them/.insteadOf", "https://forge.example/me/"], ["url.https://nowhere.example/.pushInsteadOf", "https://forge.example/"]);
  const plain = mk("rw-plain");
  for (const dir of [instead, push, both, plain]) expect(await listed(dir)).toBe(own(dir));
  expect(await listed(instead)).toContain("forge.example/them/app.git (push)");
  expect(await listed(push)).toContain("forge.example/me/app.git (fetch)");
  expect(await listed(push)).toContain("forge.example/them/app.git (push)");
  // With a rewrite of the owner's own: git picks the longest match among both, as in his shell.
  const global = readFileSync(GLOBAL, "utf8");
  try {
    writeFileSync(GLOBAL, `${global}[url "https://mirror.example/"]\n\tinsteadOf = https://forge.example/\n`);
    for (const dir of [instead, push, both, plain]) expect(await listed(dir)).toBe(own(dir));
    expect(await listed(plain)).toContain("mirror.example/me/app.git");
    expect(await listed(instead)).toContain("forge.example/them/app.git");
    // (What a clone the line makes would get its remote through: asked outside any repository.)
    expect(await rewritesOwn()).toBe(true);
  } finally {
    writeFileSync(GLOBAL, global);
  }
  expect(await rewritesOwn()).toBe(false);
  // The same for what else gives a repository the line makes another remote than the line says: a file included by
  // condition (not shown outside a repository), a template for new repositories, a remote's settings of his own.
  for (const more of [`[includeIf "gitdir:/w/"]\n\tpath = /w/other.config\n`, "[init]\n\ttemplateDir = /w/tpl\n", "[remote]\n\tpushDefault = fork\n", `[remote "origin"]\n\tpushurl = https://forge.example/them/app.git\n`]) {
    try { writeFileSync(GLOBAL, global + more); expect([more, await rewritesOwn()]).toEqual([more, true]); } finally { writeFileSync(GLOBAL, global); }
  }
  // Keel's own git still rewrites nothing: a fetch or a push of its own goes to the address the remote names.
  expect((await git(instead, ["remote", "-v"], { read: true })).out).not.toContain("them");
  expect((await git(push, ["remote", "get-url", "--push", "origin"], { read: true })).out.trim()).toBe("https://forge.example/me/app.git");
  // The repository's own remote.pushDefault comes with the listing: the view keeps a remote's keys only under its name.
  const def = mk("rw-default", ["remote.pushDefault", "elsewhere"]);
  expect((await remotesAsRun(def, 10_000)).pushDefault).toBe("elsewhere");
  expect(((await remotesIn(def)) as { pushDefault?: string }).pushDefault).toBe("elsewhere");
  expect((await remotesAsRun(instead, 10_000)).pushDefault).toBeUndefined();
  // What any branch's remote or pushRemote says that is no remote's name (an address, as `git push -u URL` leaves it)
  // comes with the remotes: a checkout of that branch pushes there with no remote named.
  for (const [k, v] of [["branch.rel.remote", "https://forge.example/them/lib.git"], ["branch.t9.pushRemote", "git@forge.example:them/two.git"], ["branch.side.remote", "."], ["branch.main.remote", "origin"]] as const) must(def, "config", k, v);
  expect(((await remotesIn(def)) as { picks?: string[] }).picks).toEqual(["https://forge.example/them/lib.git", "git@forge.example:them/two.git"]);
  expect(((await remotesIn(instead)) as { picks?: string[] }).picks).toBeUndefined();
  expect(((await remotesIn(def)) as { picksCut?: true }).picksCut).toBeUndefined();
  // More of them than are kept: said, so a push with no remote named in a new checkout is not placed by a partial list.
  const many = mk("rw-many");
  writeFileSync(join(many, ".git", "config"), readFileSync(join(many, ".git", "config"), "utf8") + Array.from({ length: 70 }, (_, n) => `[branch "b${n}"]\n\tremote = https://forge.example/x/r${n}.git\n`).join(""));
  expect(((await remotesIn(many)) as { picks?: string[]; picksCut?: true })).toMatchObject({ picksCut: true });
  expect(((await remotesIn(many)) as { picks: string[] }).picks.length).toBe(64);
  expect((await git(def, ["config", "--get", "remote.pushDefault"], { read: true })).out.trim()).toBe("");
  // A config that includes another file: the listing says so, since that file is not read.
  writeFileSync(join(root, "rw-included"), `[remote "origin"]\n\tpushurl = https://forge.example/them/app.git\n`);
  must(plain, "config", "include.path", join(root, "rw-included"));
  expect((await remotesAsRun(plain, 10_000)).includes).toBe(true);
  expect((await remotesAsRun(instead, 10_000)).includes).toBeUndefined();
  expect(((await remotesIn(plain)) as { includes?: true }).includes).toBe(true);
  expect(((await remotesIn(instead)) as { includes?: true }).includes).toBeUndefined();
  expect(((await remotesIn(push)) as { push: Record<string, string[]> }).push.origin).toEqual(["https://forge.example/them/app.git"]);
});

test("a folder with a .. after a link is the one the disk walks to, not the one its text spells", async () => {
  const mine = repo("real-mine"), theirs = repo("real-theirs");
  must(mine, "remote", "add", "origin", "https://forge.example/me/app.git");
  must(theirs, "remote", "add", "origin", "https://forge.example/them/lib.git");
  mkdirSync(join(theirs, "sub"));
  symlinkSync(join(theirs, "sub"), join(mine, "link"));
  // (As git run with that folder as its own finds it.)
  const top = (dir: string) => must(dir, "rev-parse", "--show-toplevel");
  expect(top(`${mine}/link/..`)).toBe(theirs);
  expect(realDir(`${mine}/link/..`)).toBe(theirs);
  expect(realDir(`${mine}/link/../../real-mine/./link`)).toBe(join(theirs, "sub"));
  expect(realDir(`${mine}/link`)).toBe(join(theirs, "sub"));
  expect(realDir(mine)).toBe(mine);
  // The same asked off the loop.
  expect(await realDirLater(`${mine}/link/..`)).toBe(theirs);
  expect(await realDirLater(`${mine}/link/../../real-mine/./link`)).toBe(join(theirs, "sub"));
  expect(await realDirLater(mine)).toBe(mine);
  expect(await realDirLater(`${mine}/gone/..`).catch(() => null)).toBeNull();
  expect(() => realDir(`${mine}/nothere/..`)).toThrow();
  expect(locate(`${mine}/link/..`)?.top).toBe(theirs);
  expect(locate(`${mine}/link`)?.top).toBe(theirs);
  expect(locate(`${mine}/../real-mine`)?.top).toBe(mine);
  expect((await remotesAsRun(`${mine}/link/..`, 10_000)).out).toContain("them/lib.git");
  expect((await git(`${mine}/link/..`, ["remote", "get-url", "origin"], { read: true })).out.trim()).toBe("https://forge.example/them/lib.git");
});
