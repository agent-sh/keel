import { expect, test } from "bun:test";
import { changed, sandboxSaid, type RefState } from "./refwatch.ts";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const state = (refs: Record<string, string>, branch = "refs/heads/mine"): RefState => ({ refs: new Map(Object.entries(refs)), branch });

test("what changed outside the session's own branch is named; its own work is not", () => {
  const before = state({ "refs/heads/mine": A, "refs/heads/main": A, "refs/heads/c": A, "refs/tags/v1": A, "refs/remotes/origin/main": A, "refs/stash": A });
  // Its own commits, a new branch and tag, a fetch: nothing to say.
  expect(changed(before, state({ ...Object.fromEntries(before.refs), "refs/heads/mine": B, "refs/heads/new": B, "refs/tags/v2": B, "refs/remotes/origin/main": B }))).toBeUndefined();
  // It switched to a branch and committed there: that is its branch now.
  expect(changed(before, state({ ...Object.fromEntries(before.refs), "refs/heads/c": B }, "refs/heads/c"))).toBeUndefined();
  // Another checkout's branch moved, a branch and a tag gone, the stash moved.
  const after = state({ "refs/heads/mine": B, "refs/heads/main": B, "refs/remotes/origin/main": A, "refs/stash": C });
  expect(changed(before, after)).toBe(
    "While this command ran, what this worktree shares with the repository's other checkouts changed: moved branch main (aaaaaaa to bbbbbbb), refs/stash (aaaaaaa to ccccccc); deleted branch c, tag v1.",
  );
  // A branch another checkout has out, at the commit that checkout's own log ends at, is its own commit.
  expect(changed(before, after, new Map([["refs/heads/main", B]]))).toContain("moved refs/stash (aaaaaaa to ccccccc); deleted");
  expect(changed(before, after, new Map([["refs/heads/main", C]]))).toContain("moved branch main");
});

test("a long list is cut, with the count", () => {
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`refs/heads/b${i}`, A]));
  expect(changed(state({ "refs/heads/mine": A, ...many }), state({ "refs/heads/mine": A }))).toEndWith("deleted branch b0, branch b1, branch b2, branch b3, branch b4, branch b5 and 3 more.");
});

test("a ref made where other checkouts read from, and a name pointed at another ref, are said; the session's own are not", () => {
  const before = state({ "refs/heads/mine": A, "refs/heads/main": A, "refs/heads/c": B });
  const all = (more: Record<string, string>) => state({ ...Object.fromEntries(before.refs), ...more });
  // A replacement of a commit and a note change what the main checkout reads.
  expect(changed(before, all({ "refs/replace/aaaa": B, "refs/notes/commits": C, "refs/other/x": C }))).toBe(
    "While this command ran, what this worktree shares with the repository's other checkouts changed: created refs/replace/aaaa, refs/notes/commits, refs/other/x.",
  );
  // A branch, a tag, a stash, what a bisect or a rebase keeps: ordinary work.
  expect(changed(before, all({ "refs/heads/new": B, "refs/tags/v1": B, "refs/stash": B, "refs/bisect/bad": B, "refs/rewritten/x": B }))).toBeUndefined();
  // One of Keel's own (a parked worktree's state is kept under refs/keel/): said.
  expect(changed(before, all({ "refs/keel/parked/s": B }))).toContain("created refs/keel/parked/s");
  // main made a name for c, at the same commit or not; a new branch that only names another.
  expect(changed(before, all({ "refs/heads/main": `${B} refs/heads/c` }))).toContain("changed what branch main (now a name for branch c) points at");
  expect(changed(state({ "refs/heads/mine": A, "refs/heads/main": `${B} refs/heads/c`, "refs/heads/c": B }), before)).toContain("changed what branch main (now a ref of its own) points at");
  expect(changed(before, all({ "refs/heads/alias": `${A} refs/heads/main` }))).toContain("created branch alias (a name for branch main)");
  // What the session's own commands made this turn: deleted or moved again without a word.
  const own = new Set(["refs/heads/topic"]);
  const with_topic = all({ "refs/heads/topic": B });
  expect(changed(with_topic, before, undefined, own)).toBeUndefined();
  expect(changed(with_topic, before)).toContain("deleted branch topic");
});

test("what a confined command ran into gets one sentence each, in the tool's own words for leaving the sandbox", () => {
  const escape = "ESCAPE.";
  const at = { linked: true, network: false, escape };
  for (const said of [
    "error: could not delete reference refs/heads/old: unable to create file /r/.git/keel-sandbox/packed-refs.5.new: File exists",
    "fatal: Unable to create '/r/.git/gc.pid.lock': Read-only file system",
    "fatal: Unable to create '/r/.git/shallow.lock': Read-only file system",
    "fatal: Unable to create '/r/.git/keel-sandbox/top/packed-refs.lock': Read-only file system",
    "fatal: could not create directory of '/r/.git/worktrees/x': Read-only file system",
    "fatal: could not create directory '/r/.git/rr-cache'",
    "error: unable to update /r/.git/info/refs: Read-only file system",
    "error: cannot lock ref 'main-worktree/HEAD': Unable to create '/r/.git/HEAD.lock': Read-only file system",
  ]) expect(sandboxSaid(`some output\n${said}\n`, at)).toEqual([expect.stringMatching(/^This worktree's sandbox keeps the top of the repository's git directory read-only.* ESCAPE\.$/)]);
  // The config, in a worktree and in a main checkout alike.
  for (const said of [
    "error: could not lock config file /r/.git/config: Read-only file system",
    "error: could not write config file /r/.git/config: Device or resource busy",
    "error: unable to write upstream branch configuration",
    "fatal: branch is renamed, but update of config-file failed",
  ]) expect(sandboxSaid(said, { ...at, linked: false })).toEqual([expect.stringMatching(/^The repository's config is read-only in a sandboxed session.*git branch -m renames the branch and then exits 128.* ESCAPE\.$/)]);
  // A branch that was deleted, with git's warning about its settings: nothing to add.
  expect(sandboxSaid("error: could not lock config file /r/.git/config: Read-only file system\nwarning: update of config-file failed\nDeleted branch topic (was 1234567).", at)).toEqual([]);
  // The network: off says so; on, a command that did not go through the proxy is told how the sandbox's network works.
  const lost = "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com";
  expect(sandboxSaid(lost, at)).toEqual([expect.stringMatching(/^This session's network is off.*The owner turns it on in the session's permissions \("Network in the sandbox"\)\. ESCAPE\.$/)]);
  expect(sandboxSaid(lost, { ...at, network: true })).toEqual([expect.stringMatching(/^This session's sandbox has a network of its own\..* ESCAPE\.$/)]);
  expect(sandboxSaid("Everything up-to-date", { ...at, network: true })).toEqual([]);
  expect(sandboxSaid("ssh: Could not resolve hostname github.com: Temporary failure in name resolution", at)).toHaveLength(1);
  // A session none of git's files is open to (its folder is inside a repository, or its worktree could not be opened): why, and nothing else about git.
  const shut = { ...at, shut: () => "this session's folder is inside the repository at /r, and so on" };
  expect(sandboxSaid("fatal: Unable to create '/r/.git/index.lock': Read-only file system", shut)).toEqual(["git could not write here: this session's folder is inside the repository at /r, and so on. ESCAPE."]);
  expect(sandboxSaid("error: could not lock config file /r/.git/config: Read-only file system", shut)).toHaveLength(1);
  expect(sandboxSaid("ls: cannot access 'x'", shut)).toEqual([]);
  // Not the sandbox's doing.
  expect(sandboxSaid("touch: cannot touch '/etc/x': Read-only file system", at)).toEqual([]);
  expect(sandboxSaid("fatal: Unable to create '/r/.git/worktrees/wt/index.lock': File exists.", at)).toEqual([]);
  expect(sandboxSaid("fatal: Unable to create '/r/.git/gc.pid.lock': Read-only file system", { ...at, linked: false })).toEqual([]);
});

// The checkouts a worktree shares its branches with, read from a real repository: the main checkout and another
// worktree, each with the branch it has out; the worktree's own is not one of them.
test("the checkouts a worktree shares its branches with are read from the repository's files", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { realOf } = await import("../core/paths.ts");
  const { checkoutsOf } = await import("./refwatch.ts");
  const { sharedRefusal } = await import("./shared-branches.ts");
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "shared-")));
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env: { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent"), other = join(dir, "other");
    git(dir, "init", "-q", main);
    writeFileSync(join(main, "a"), "a\n");
    git(main, "add", "a");
    git(main, "commit", "-qm", "a");
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    git(main, "worktree", "add", "-q", "-b", "keel/y", other);
    const s = checkoutsOf(agent, "keel/x", "main")!;
    expect([...s.out].sort()).toEqual([["keel/y", other], ["main", main]]);
    expect(s.folders.sort()).toEqual([main, other].sort());
    expect(s.root).toBe(agent);
    expect(sharedRefusal("git push . HEAD:main", agent, dir, s)).toBe("pushes into the branch main, which another checkout has out");
    expect(sharedRefusal(`git -C ${main} reset --hard`, agent, dir, s)).toBe(`runs git reset in ${main}, another checkout of this repository`);
    expect(sharedRefusal(`GIT_DIR=${join(main, ".git")} git reset --hard`, agent, dir, s)).toBe(`runs git reset in ${main}, another checkout of this repository`);
    expect(sharedRefusal("git commit -qm b", agent, dir, s)).toBeNull();
    // What a review ran from such a worktree: a symbolic ref over main, env -C, a plain write of the ref.
    expect(sharedRefusal("git symbolic-ref refs/heads/main refs/heads/keel/x", agent, dir, s)).toBe("makes the branch main, which another checkout has out a link to refs/heads/keel/x");
    expect(sharedRefusal(`env -C ${main} git reset --hard`, agent, dir, s)).toBe(`runs git reset in ${main}, another checkout of this repository`);
    expect(sharedRefusal(`echo x > ${main}/.git/refs/heads/main`, agent, dir, s)).toBe(`writes ${main}/.git/refs/heads/main, in the repository's git directory, which every checkout shares`);
    // A remote is read from the repository's config: one that is this repository is local, a server is not.
    git(main, "remote", "add", "loc", main);
    git(main, "remote", "add", "origin", "https://example.com/r.git");
    const r = checkoutsOf(agent, "keel/x", "main")!;
    expect([...r.remotes!]).toEqual([["loc", [main]], ["origin", ["https://example.com/r.git"]]]);
    expect(sharedRefusal("git push loc HEAD:main", agent, dir, r)).toBe("pushes into the branch main, which another checkout has out");
    expect(sharedRefusal("git push origin HEAD:main", agent, dir, r)).toBeNull();
    // Not a linked worktree: nothing to share.
    expect(checkoutsOf(main, "main", null)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The stash list is the repository's, shared by every worktree: a pop in one takes what another stashed.
test("git stash pop, apply, drop and clear in a worktree are held when an entry they take was made on another branch", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { realOf } = await import("../core/paths.ts");
  const { checkoutsOf } = await import("./refwatch.ts");
  const { sharedRefusal } = await import("./shared-branches.ts");
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "stash-")));
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env: { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent"), other = join(dir, "other");
    git(dir, "init", "-q", main);
    writeFileSync(join(main, "a"), "a\n");
    git(main, "add", "a");
    git(main, "commit", "-qm", "a");
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    git(main, "worktree", "add", "-q", "-b", "keel/y", other);
    const refused = (line: string) => sharedRefusal(line, agent, dir, checkoutsOf(agent, "keel/x", "main")!);
    // No stash yet: nothing to take.
    expect(refused("git stash pop")).toBeNull();
    // The agent's own entry: its subject names its branch.
    writeFileSync(join(agent, "a"), "mine\n");
    git(agent, "stash", "push", "-q");
    expect(refused("git stash pop")).toBeNull();
    expect(refused("git stash apply stash@{0}")).toBeNull();
    expect(refused("git stash drop")).toBeNull();
    expect(refused("git stash clear")).toBeNull();
    // Another lane stashes after it: the newest entry is the other branch's.
    writeFileSync(join(other, "a"), "theirs\n");
    git(other, "stash", "push", "-q", "-m", "their work");
    for (const line of ["git stash pop", "git stash apply", "git stash drop", "git stash pop --index -q", "git stash apply stash@{0}", "git stash pop 0", "git stash branch nb", "git stash clear", "cd " + agent + " && git stash pop"]) {
      const why = refused(line);
      expect([line, why?.includes("keel/y")]).toEqual([line, true]);
    }
    expect(refused("git stash pop")).toContain("stash@{0}");
    expect(refused("git stash pop")).toContain("keel/x");
    // The entry below is the agent's own: naming it passes, naming the other's is held, and so is one it cannot place.
    expect(refused("git stash pop stash@{1}")).toBeNull();
    expect(refused("git stash drop 1")).toBeNull();
    expect(refused("git stash branch nb stash@{1}")).toBeNull();
    expect(refused("git stash pop stash@{0}")).not.toBeNull();
    expect(refused("git stash pop 'stash@{2.days.ago}'")).not.toBeNull();
    // What stays allowed: making, listing and reading entries.
    for (const line of ["git stash", "git stash push -m mine", "git stash list", "git stash show stash@{0}", "git stash show -p", "git stash create", "git stash -u"]) expect([line, refused(line)]).toEqual([line, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A command that starts without the environment (env -i) drops the git settings Keel gives, the guard's among them.
// It is refused with words of its own unless it gives the whole settings back in the command itself: no script is
// trusted to do it (the agent writes the scripts of its worktree).
test("env -i is refused with its own words, and allowed only where the command gives back the whole settings", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { realOf } = await import("../core/paths.ts");
  const { SHELL_GIT_SETTINGS } = await import("../core/git.ts");
  const { checkoutsOf } = await import("./refwatch.ts");
  const { sessionSettings, sharedMessage, sharedRefusal } = await import("./shared-branches.ts");
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "envi-")));
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env: { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent");
    git(dir, "init", "-q", main);
    writeFileSync(join(main, "a"), "a\n");
    git(main, "add", "a");
    git(main, "commit", "-qm", "a");
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    const s = checkoutsOf(agent, "keel/x", "main")!;
    // Scripts of the worktree that name the settings file (in code or in a comment): none is trusted.
    mkdirSync(join(agent, "scripts"));
    writeFileSync(join(agent, "scripts/good.sh"), '#!/usr/bin/env bash\n. "$(dirname "${BASH_SOURCE[0]}")/git-env.sh"\nexec true\n');
    writeFileSync(join(agent, "scripts/comment.sh"), "# git-env.sh\ngit update-ref refs/heads/main keel/x\n");
    const why = (c: string) => sharedRefusal(c, agent, dir, s);
    const ENV_I = "starts it without the environment Keel gives the command (env -i)";
    for (const c of ["env -i git commit -m x", "env -i bash -c 'git status'", "env -i PATH=/usr/bin HOME=/x bash scripts/good.sh 48201", "env -i sh ./scripts/good.sh", "env -i PATH=/usr/bin bash scripts/comment.sh", "env -i bash scripts/missing.sh"]) expect([c, why(c)]).toEqual([c, ENV_I]);
    // The settings the daemon gives this agent: Keel's pairs and the guard's, as the guard makes them.
    const given = sessionSettings(s);
    expect(given.length).toBeGreaterThan(SHELL_GIT_SETTINGS.length - 1);
    expect(given.some((a) => a.includes(`includeIf.gitdir:${s.common}`))).toBe(true);
    const all = given.join(" ");
    expect(why(`env -i PATH=/usr/bin ${all} git commit -m x`)).toBeNull();
    expect(why(`env -i PATH=/usr/bin ${all} bash scripts/good.sh 48201`)).toBeNull();
    // Keel's own pairs alone leave the guard out: refused, as is any changed or missing pair.
    expect(why(`env -i PATH=/usr/bin ${SHELL_GIT_SETTINGS.join(" ")} git commit -m x`)).not.toBeNull();
    expect(why(`env -i PATH=/usr/bin ${all.replace("core.hooksPath", "core.pager")} git commit -m x`)).not.toBeNull();
    expect(why(`env -i PATH=/usr/bin ${given.slice(1).join(" ")} git commit -m x`)).not.toBeNull();
    expect(why(`env -i PATH=/usr/bin ${all} GIT_CONFIG_COUNT=1 git commit -m x`)).not.toBeNull();
    // The words: what is wrong, the way that keeps the environment, and the settings to give back; not the other paragraph.
    const said = sharedMessage(ENV_I, s);
    expect(said).toContain("drops the git settings");
    expect(said).toContain("env -u NAME");
    expect(said).toContain("scripts/dev.sh");
    expect(said).toContain(all);
    expect(said).not.toContain("git-env.sh");
    expect(said).not.toContain("keel__landing_queue");
    // Without env -i nothing changed: the recipe that keeps the environment is allowed, and a settings of its own is refused.
    expect(why("env -u DBUS_SESSION_BUS_ADDRESS KEEL_DEV_DIR=/y bash scripts/dev.sh 48201")).toBeNull();
    expect(why("GIT_CONFIG_COUNT=1 git status")).toContain("GIT_CONFIG_COUNT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same refusal where the words around env are not plain: a lone dash is env -i, a word the shell fills in before
// env's options or program cannot be read, and env -i with a program the rules cannot read (an interpreter) can run
// git with none of the settings. (Each case moved main before the fix.)
test("env -i is refused through a lone dash, through words the rules cannot read, and for a program they cannot read", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { realOf } = await import("../core/paths.ts");
  const { checkoutsOf } = await import("./refwatch.ts");
  const { sessionSettings, sharedMessage, sharedRefusal } = await import("./shared-branches.ts");
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "envu s-")));
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env: { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent");
    git(dir, "init", "-q", main);
    writeFileSync(join(main, "a"), "a\n");
    git(main, "add", "a");
    git(main, "commit", "-qm", "a");
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    const s = checkoutsOf(agent, "keel/x", "main")!;
    const why = (c: string) => sharedRefusal(c, agent, dir, s);
    const U = "git update-ref refs/heads/main keel/x";
    const P = "PATH=/usr/bin";
    const ENV_I = "starts it without the environment Keel gives the command (env -i)";
    // A lone dash is -i (env's own manual): in front of a shell, git or any program, with an option cluster or -S too.
    for (const c of [`env - ${P} bash -c '${U}'`, `env - ${P} ${U}`, `env - ${P} git status`, `env -vi ${P} bash -c '${U}'`, `env -0i ${P} sh -c 'env -u X git status'`, `env -i -- ${P} bash -c '${U}'`]) expect([c, why(c)]).toEqual([c, ENV_I]);
    // The program of env -i is any the rules cannot read.
    for (const c of [`env -i ${P} python3 -c 'import os;os.system("${U}")'`, `env - ${P} node -e 'require("child_process").execSync("${U}")'`, `env -i ${P} perl -e 'system("${U}")'`, `env -i ${P} ./run.sh`, `env -i ${P} /usr/bin/python3 -c 'pass'`]) expect([c, why(c)]).toEqual([c, ENV_I]);
    // Words the shell fills in before env's program or options, and a program word that is one: refused for an agent here.
    for (const c of [`S=${P}; env -i $S bash -c '${U}'`, `env -i $S bash -c '${U}'`, `env -i "$S" bash -c '${U}'`, `env -i $(echo ${P}) bash -c '${U}'`, 'env -i ${S} git status', `S=${P}; env $S -i bash -c '${U}'`, `X=-i; env $X bash -c '${U}'`, `X=-i; env $X ${U}`, `X=env; $X -i ${P} ${U}`, `env -i ${P} $CMD`, "env -`echo i` bash -c 'git status'", "env -${X} git status", `env -u $V ${U}`, `env -S'-i ${P}' bash -c '${U}'`, `$(command -v env) -i ${P} bash -c '${U}'`, "$CMD", "\"$PROG\" --version"]) expect([c, why(c)]).not.toBeNull();
    for (const c of [`env - ${P} bash -c '${U}'`, `env -i $S bash -c '${U}'`, `X=env; $X -i ${P} ${U}`]) expect(why(c)).not.toContain("which this worktree did not make");
    // What stays allowed: assignments with a name written out (their value may be expanded), a program with a
    // path through a variable, the recipe that keeps the environment, and the whole settings given back.
    const all = sessionSettings(s).map((a) => `'${a}'`).join(" ");
    for (const c of ["env KEEL_DEV_DIR=$HOME/x bash scripts/dev.sh 48201", "env -u DBUS_SESSION_BUS_ADDRESS FOO=\"$X\" ls", "$HOME/.bun/bin/bun test", "\"$HOME/bin/tool\" --help", "env -C . git status", `env -i ${P} ${all} python3 -c 'pass'`, `env - ${P} ${all} git status`]) expect([c, why(c)]).toEqual([c, null]);
    // The settings in the message survive a copy: a value with a space or a quote is one word of the shell.
    const said = sharedMessage(ENV_I, s);
    const tail = said.slice(said.lastIndexOf("each as one word: ") + "each as one word: ".length);
    const words = Bun.spawnSync(["bash", "-c", `printf '%s\\n' ${tail}`]).stdout.toString().trimEnd().split("\n");
    expect(words).toEqual(sessionSettings(s));
    expect(sessionSettings(s).some((a) => a.includes(" "))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
