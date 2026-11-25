import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { bindLedger, repoOf, treeOf, unbindLedger } from "../checks/ledger.ts";
import { toolEnv } from "../tools/jobs.ts";
import { tempTree } from "../../test/env.ts";
import { Worktrees } from "./manager.ts";
import { parseEnvFile, parseSetup, setupHook } from "./setup.ts";

setDefaultTimeout(30_000);

test("the file's words: a list of commands and a time limit, anything else named", () => {
  expect(parseSetup('{"setup": [" bun install ", "echo hi"], "timeout": 60}')).toEqual({ commands: ["bun install", "echo hi"], seconds: 60, problems: [] });
  expect(parseSetup('{"setup": ["a"], "extra": 1}').commands).toEqual(["a"]); // named, still runs: nothing it says is guessed
  expect(parseSetup('{"setup": ["a"], "extra": 1}').problems).toEqual(['"extra" is not read']);
  for (const bad of ["nope", "[]", '{"setup": "bun install"}', '{"setup": ["a", 3]}', '{"setup": [""]}', '{"setup": ["a"], "timeout": -1}']) {
    const r = parseSetup(bad);
    expect([bad, r.commands, r.problems.length > 0]).toEqual([bad, [], true]);
  }
});

test("the variables a setup writes: NAME=value lines, quotes taken off, Keel's own names and other lines left out", () => {
  const r = parseEnvFile(["# c", "", "A=1", 'B="two words"', "export C='x'", "A=3", "KEEL_SESSION=other", "not a line", "1X=2", "D="].join("\n"));
  expect(r.env).toEqual({ A: "3", B: "two words", C: "x", D: "" });
  expect(r.left).toEqual(["KEEL_SESSION=other", "not a line", "1X=2"]);
});

// The setup of a repository runs in a new worktree under the owner's pin, in the order git made it, and nowhere else.
const root = tempTree("keel-setup-");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
const repo = join(root, "repo");
let wts: Worktrees;
let confined = 0;
beforeAll(() => {
  mkdirSync(join(repo, ".keel"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a"), "a\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
  writeFileSync(join(repo, ".env"), "TOKEN=1\n");
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ['cat .env > included', "echo ran >> marker", 'echo "FROM_SETUP=$KEEL_WORKTREE" >> "$KEEL_ENV_FILE"'] }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  wts = new Worktrees(new Store(join(root, "state")), join(root, "state", "worktrees"));
  setupHook.confine = () => (confined++, {});
});
afterAll(() => { setupHook.confine = undefined; setupHook.envOf = undefined; });

test("a setup that is not pinned is held, and one that is pinned runs once, after the files .worktreeinclude names", async () => {
  const first = await wts.create("s1", repo, "one");
  expect(first.wt.setup?.state).toBe("held");
  expect(first.wt.setup?.note).toContain("not pinned");
  expect(existsSync(join(first.wt.path, "marker"))).toBe(false);
  expect(confined).toBe(0);

  const shown = wts.setupPins.show(repo);
  expect(shown.state).toBe("new");
  expect(wts.setupPins.pin(repo, "0".repeat(64))).toContain("no longer the one that was shown");
  expect(wts.setupPins.pin(repo, shown.sha256!)).toBeNull();
  expect(wts.setupPins.show(repo).state).toBe("pinned");

  const a = await wts.create("s2", repo, "two"), b = await wts.create("s3", repo, "three");
  for (const w of [a, b]) {
    expect(w.wt.setup?.state).toBe("ok");
    expect(w.wt.setup?.steps).toBe(3);
    expect(readFileSync(join(w.wt.path, "marker"), "utf8")).toBe("ran\n"); // once
    expect(readFileSync(join(w.wt.path, "included"), "utf8")).toBe("TOKEN=1\n"); // after the copy
    expect(readFileSync(w.wt.setup!.log!, "utf8")).toContain("$ echo ran >> marker");
  }
  expect(confined).toBe(2);

  // Its variables are the environment of the session's later commands.
  wts.adopt("s2", a.wt);
  setupHook.envOf = (id) => wts.get(id)?.setup?.env;
  expect(toolEnv("s2").FROM_SETUP).toBe(a.wt.path);
  expect(toolEnv("s3").FROM_SETUP).toBeUndefined();
  expect(wts.get("s2")?.setup?.state).toBe("ok"); // kept with the worktree
});

test("a changed file is held until it is pinned again, and a script of .keel/ it runs is part of the pin", async () => {
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["echo changed >> marker"] }));
  git(repo, "commit", "-qam", "change the setup");
  const held = await wts.create("s4", repo, "four");
  expect(held.wt.setup?.state).toBe("held");
  expect(held.wt.setup?.note).toContain("changed since you pinned");
  expect(existsSync(join(held.wt.path, "marker"))).toBe(false);

  writeFileSync(join(repo, ".keel", "install.sh"), "echo one >> marker\n");
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["bash .keel/install.sh"] }));
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "a script");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  expect((await wts.create("s5", repo, "five")).wt.setup?.state).toBe("ok");
  writeFileSync(join(repo, ".keel", "install.sh"), "echo two >> marker\n");
  git(repo, "commit", "-qam", "script changed");
  expect((await wts.create("s6", repo, "six")).wt.setup?.state).toBe("held");
});

test("a failing step stops the setup and is named with its last output; a session whose sandbox cannot write skips it", async () => {
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["echo before", "echo nope >&2; exit 3", "echo never >> marker"] }));
  git(repo, "commit", "-qam", "failing");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  const f = await wts.create("s7", repo, "seven");
  expect(f.wt.setup).toMatchObject({ state: "failed", steps: 1 });
  expect(f.wt.setup?.note).toContain("step 2 (echo nope >&2; exit 3) exited 3");
  expect(f.wt.setup?.note).toContain("nope");
  expect(existsSync(join(f.wt.path, "marker"))).toBe(false);

  setupHook.confine = () => ({ skip: "the session's sandbox is read-only" });
  const s = await wts.create("s8", repo, "eight");
  expect(s.wt.setup).toMatchObject({ state: "skipped", ms: 0 });
  setupHook.confine = () => ({});
});

test("a time limit stops a setup that runs past it", async () => {
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["sleep 30"], timeout: 0.3 }));
  git(repo, "commit", "-qam", "slow");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  const r = await wts.create("s9", repo, "nine");
  expect(r.wt.setup?.state).toBe("failed");
  expect(r.wt.setup?.note).toContain("stopped at the 0.3 s");
  expect(r.wt.setup!.ms).toBeLessThan(5_000);
});

// What a setup installs (node_modules and the like) is ignored by the repository, so the check ledger's look of the
// worktree does not hash it: a look over more than NEW_MAX bytes of new files is not taken at all.
test("what the setup installs is not hashed by the check ledger's look", async () => {
  const store = new Store(join(root, "state-ledger"));
  bindLedger(store);
  try {
    writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules\n");
    writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["mkdir node_modules", "head -c 40000000 /dev/zero > node_modules/big", "echo x > other.txt"] }));
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "install");
    expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
    const w = await wts.create("s10", repo, "ten");
    expect(w.wt.setup?.state).toBe("ok");
    expect(existsSync(join(w.wt.path, "node_modules", "big"))).toBe(true);
    const look = await treeOf(repoOf(w.wt.path)!);
    expect(look && "why" in look ? look.why : "").toBe(""); // read, with the 40 MB left out
    expect(look?.tree).toBeTruthy();
  } finally { unbindLedger(); }
});
