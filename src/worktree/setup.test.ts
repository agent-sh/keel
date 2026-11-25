import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store } from "../core/store.ts";
import { bindLedger, repoOf, treeOf, unbindLedger } from "../checks/ledger.ts";
import { jobScope, sessionVars, toolEnv } from "../tools/jobs.ts";
import { patchSettings, settings } from "../admin/settings.ts";
import { tempTree } from "../../test/env.ts";
import { Worktrees } from "./manager.ts";
import { allowedName, headHeld, parseEnvFile, parseSetup, refusedName, setupHook } from "./setup.ts";

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
  const r = parseEnvFile(["# c", "", "A=1", 'B="two words"', "export C='x'", "A=3", "KEEL_SESSION=other", "not a line", "1X=2", "D="].join("\n"), ["*"]);
  expect(r.env).toEqual({ A: "3", B: "two words", C: "x", D: "" });
  expect(r.left).toEqual(["KEEL_SESSION", "a line that is not NAME=value", "a line that is not NAME=value"]); // names only: a value may be a secret
});

test("names that change what a program loads or runs are never taken from a setup", () => {
  const bad = ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "SHELLOPTS", "PS4", "NODE_OPTIONS", "BUN_CONFIG_REGISTRY", "PYTHONPATH", "PYTHONSTARTUP", "HOME", "TMPDIR", "https_proxy", "HTTPS_PROXY", "ALL_PROXY", "SSH_ASKPASS", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "KEEL_X", "XDG_DATA_DIRS", "EDITOR"];
  for (const n of bad) expect([n, refusedName(n)]).toEqual([n, true]);
  for (const n of ["NODE_ENV", "CI", "FROM_SETUP", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "DATABASE_URL"]) expect([n, refusedName(n)]).toEqual([n, false]);
  const r = parseEnvFile(["PATH=/x:$PATH", "LD_PRELOAD=/x.so", "SETUP_FLAG=test", "GIT_SSH_COMMAND=x"].join("\n"), ["*"]); // even a pattern that names everything
  expect(r.env).toEqual({ SETUP_FLAG: "test" });
  expect(r.left).toEqual(["PATH", "LD_PRELOAD", "GIT_SSH_COMMAND"]);
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

  patchSettings({ worktree_setup: { env: ["FROM_SETUP"] } });
  const a = await wts.create("s2", repo, "two"), b = await wts.create("s3", repo, "three");
  patchSettings({ worktree_setup: { env: null } });
  for (const w of [a, b]) {
    expect(w.wt.setup?.state).toBe("ok");
    expect(w.wt.setup?.steps).toBe(3);
    expect(readFileSync(join(w.wt.path, "marker"), "utf8")).toBe("ran\n"); // once
    expect(readFileSync(join(w.wt.path, "included"), "utf8")).toBe("TOKEN=1\n"); // after the copy
    expect(readFileSync(w.wt.setup!.log!, "utf8")).toContain("$ echo ran >> marker");
  }
  expect(confined).toBe(2);

  // Its variables are the environment of the session's own commands (a job that asks for them), never of toolEnv, which the
  // daemon's own spawns (xdg-open, git init, the landing queue) read: those run outside the sandbox.
  wts.adopt("s2", a.wt);
  setupHook.envOf = (id) => wts.get(id)?.setup?.env;
  patchSettings({ worktree_setup: { env: ["FROM_SETUP"] } });
  expect(sessionVars("s2").FROM_SETUP).toBe(a.wt.path);
  patchSettings({ worktree_setup: { env: null } });
  expect(sessionVars("s3").FROM_SETUP).toBeUndefined();
  expect(toolEnv("s2").FROM_SETUP).toBeUndefined();
  // A job asks for them (StartOpts.vars) in a program of its own: a job started here would stay in this process's job list.
  const code = `
    import { registerVars, startJob, waitJob } from ${JSON.stringify(join(import.meta.dir, "../tools/jobs.ts"))};
    import { readFileSync } from "node:fs";
    registerVars(() => ({ FROM_SETUP: "yes" }));
    for (const vars of [true, false]) {
      const job = startJob({ sessionId: "vars", command: "echo got=$FROM_SETUP", cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(join(root, "jobs"))}, vars });
      await waitJob(job, 10000);
      console.log(readFileSync(job.log, "utf8").trim());
    }`;
  const p = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "inherit" });
  expect((await new Response(p.stdout).text()).trim().split("\n")).toEqual(["got=yes", "got="]);
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


test("a setup variable is taken only when a pattern the owner set matches its name, and the floor holds even then", () => {
  const text = ["LESSOPEN=|x", "npm_config_script_shell=/x", "RUSTC_WRAPPER=/x", "GOFLAGS=-x", "CC=/x", "GH_TOKEN=t", "NODE_ENV=test", "APP_MODE=a", "APP_X=1", "PATH=/x"].join("\n");
  expect(parseEnvFile(text).env).toEqual({}); // nothing is taken until the owner names it
  expect(parseEnvFile(text).unlisted).toEqual(["LESSOPEN", "npm_config_script_shell", "RUSTC_WRAPPER", "GOFLAGS", "CC", "GH_TOKEN", "NODE_ENV", "APP_MODE", "APP_X"]);
  expect(parseEnvFile(text).left).toEqual(["PATH"]);
  const r = parseEnvFile(text, ["NODE_ENV", "APP_*", "PATH"]);
  expect(r.env).toEqual({ NODE_ENV: "test", APP_MODE: "a", APP_X: "1" });
  expect(r.left).toEqual(["PATH"]); // allowed by name, still refused
  expect(allowedName("APP_X", ["APP_*"])).toBe(true);
  expect(allowedName("MYAPP_X", ["APP_*"])).toBe(false);
  expect(allowedName("NODE_ENV", [])).toBe(false);
  // the setting: names and * only
  for (const bad of [["a b"], [""], ["A=1"], "A", [1]]) expect([bad, patchSettings({ worktree_setup: { env: bad } }).ok]).toEqual([bad, false]);
  expect(patchSettings({ worktree_setup: { env: ["NODE_ENV"] } }).ok).toBe(true);
  expect(settings().worktree_setup.env).toEqual(["NODE_ENV"]);
  patchSettings({ worktree_setup: { env: null } });
  expect(settings().worktree_setup.env).toEqual([]);
});

test("a planted PATH does not reach the session's commands or the daemon's spawns", async () => {
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ['echo "PATH=$PWD/bin:$PATH" >> "$KEEL_ENV_FILE"', 'echo "SETUP_FLAG=test" >> "$KEEL_ENV_FILE"'] }));
  git(repo, "commit", "-qam", "path");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  patchSettings({ worktree_setup: { env: ["SETUP_*", "PATH"] } });
  const w = await wts.create("s11", repo, "eleven");
  wts.adopt("s11", w.wt);
  setupHook.envOf = (id) => wts.get(id)?.setup?.env;
  expect(w.wt.setup?.note).toContain("sets SETUP_FLAG");
  expect(w.wt.setup?.note).toContain("left out of $KEEL_ENV_FILE: PATH");
  expect(sessionVars("s11")).toEqual({ SETUP_FLAG: "test" });
  expect(toolEnv("s11").PATH).toBe(process.env.PATH);
  expect(toolEnv("s11").SETUP_FLAG).toBeUndefined();
  patchSettings({ worktree_setup: { env: null } });
  // the owner took the pattern away: the variable is gone from the session's next command
  expect(sessionVars("s11")).toEqual({});
});

test("with no pattern set, a setup's variables are left out by name and the note says how to allow them", async () => {
  const w = await wts.create("s16", repo, "sixteen");
  expect(w.wt.setup?.state).toBe("ok");
  wts.adopt("s16", w.wt);
  expect(sessionVars("s16")).toEqual({});
  expect(w.wt.setup?.env).toBeUndefined();
  expect(w.wt.setup?.note).toContain("not taken from $KEEL_ENV_FILE: SETUP_FLAG");
  expect(w.wt.setup?.note).toContain("worktree_setup.env");
  expect(w.wt.setup?.note).not.toContain("test");
});

test("what a step leaves running is stopped at its end, and the variables are read after that", async () => {
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["sleep 60 & echo $! > pidfile", '(sleep 0.4; echo "LATE=1" >> "$KEEL_ENV_FILE") &', 'echo "EARLY=1" >> "$KEEL_ENV_FILE"'] }));
  git(repo, "commit", "-qam", "background");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  patchSettings({ worktree_setup: { env: ["EARLY", "LATE"] } });
  const w = await wts.create("s12", repo, "twelve");
  expect(w.wt.setup?.state).toBe("ok");
  const pid = Number(readFileSync(join(w.wt.path, "pidfile"), "utf8"));
  expect(pid).toBeGreaterThan(1);
  await Bun.sleep(100);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
  await Bun.sleep(700); // past the late write
  wts.adopt("s12", w.wt);
  expect(sessionVars("s12")).toEqual({ EARLY: "1" });
  patchSettings({ worktree_setup: { env: null } });
});

test("a time limit stops what the step started too", async () => {
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["sleep 60 & echo $! > pidfile; sleep 60"], timeout: 0.4 }));
  git(repo, "commit", "-qam", "limit group");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  const w = await wts.create("s13", repo, "thirteen");
  expect(w.wt.setup?.state).toBe("failed");
  const pid = Number(readFileSync(join(w.wt.path, "pidfile"), "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
});

test("a step's process that started a session of its own is stopped with the step's scope", async () => {
  if (!jobScope().slice) return console.log("skipped: needs a systemd user manager with cgroups for scopes");
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["setsid sleep 60 > /dev/null 2>&1 & echo $! > pidfile; sleep 0.2"] }));
  git(repo, "commit", "-qam", "setsid");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  const w = await wts.create("s17", repo, "seventeen");
  expect(w.wt.setup?.state).toBe("ok");
  const pid = Number(readFileSync(join(w.wt.path, "pidfile"), "utf8"));
  await Bun.sleep(100);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["setsid sleep 60 > /dev/null 2>&1 & echo $! > pidfile; sleep 60"], timeout: 0.6 }));
  git(repo, "commit", "-qam", "setsid limit");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  const x = await wts.create("s18", repo, "eighteen");
  expect(x.wt.setup?.state).toBe("failed");
  const pid2 = Number(readFileSync(join(x.wt.path, "pidfile"), "utf8"));
  await Bun.sleep(100);
  let alive2 = true;
  try { process.kill(pid2, 0); } catch { alive2 = false; }
  expect(alive2).toBe(false);
});

test("two calls for the head of a pull request run its setup once", async () => {
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["echo ran >> marker; sleep 0.3"] }));
  git(repo, "commit", "-qam", "twice");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  const w = await wts.create("s19", repo, "nineteen", undefined, "s19", { setup: false });
  wts.adopt("s19", w.wt);
  await Promise.all([wts.settleSetup("s19"), wts.settleSetup("s19")]);
  expect(readFileSync(join(w.wt.path, "marker"), "utf8")).toBe("ran\n");
  expect(wts.get("s19")?.setup).toMatchObject({ state: "ok" });
});

test("the head of a pull request from a fork runs its setup only after its trust is decided", async () => {
  writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: ["echo ran >> marker"] }));
  git(repo, "commit", "-qam", "head");
  expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toBeNull();
  try {
    headHeld.of = () => ({ why: "fork" });
    expect(wts.setupPins.show(repo).state).toBe("refused");
    expect(wts.setupPins.pin(repo, wts.setupPins.show(repo).sha256!)).toContain("trusts the head");
    const w = await wts.create("s14", repo, "fourteen", undefined, "s14", { setup: false });
    expect(w.wt.setup).toMatchObject({ state: "held", pending: true });
    wts.adopt("s14", w.wt);
    await wts.settleSetup("s14");
    expect(wts.get("s14")?.setup).toMatchObject({ state: "held", pending: true });
    expect(wts.get("s14")?.setup?.note).toContain("trusts the head");
    expect(existsSync(join(w.wt.path, "marker"))).toBe(false);
    headHeld.of = undefined; // the owner trusted the head
    await wts.settleSetup("s14");
    expect(wts.get("s14")?.setup).toMatchObject({ state: "ok" });
    expect(wts.get("s14")?.setup?.pending).toBeUndefined();
    expect(readFileSync(join(w.wt.path, "marker"), "utf8")).toBe("ran\n");
    await wts.settleSetup("s14"); // once
  } finally { headHeld.of = undefined; }
});

test("the setup's folder goes with the worktree", async () => {
  const w = await wts.create("s15", repo, "fifteen");
  expect(w.wt.setup?.state).toBe("ok");
  const dir = dirname(w.wt.setup!.log!);
  expect(existsSync(dir)).toBe(true);
  wts.adopt("s15", w.wt);
  const r = await wts.remove(wts.get("s15")!, true);
  expect([r.removed, r.reason]).toEqual([true, undefined]);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(`${dir}.env`)).toBe(false);
});

test("a .keel/ or a worktree.json that links out of the repository is refused", () => {
  const other = join(root, "linked");
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  writeFileSync(join(root, "elsewhere", "worktree.json"), JSON.stringify({ setup: ["echo x"] }));
  mkdirSync(join(other, ".keel"), { recursive: true });
  symlinkSync(join(root, "elsewhere", "worktree.json"), join(other, ".keel", "worktree.json"));
  const a = wts.setupPins.show(other);
  expect(a.state).toBe("refused");
  expect(a.problems.join(" ")).toContain(".keel/worktree.json is a link out of the repository");
  expect(wts.setupPins.pin(other, a.sha256!)).toContain("link");
  rmSync(join(other, ".keel"), { recursive: true });
  symlinkSync(join(root, "elsewhere"), join(other, ".keel"));
  const b = wts.setupPins.show(other);
  expect(b.state).toBe("refused");
  expect(b.problems.join(" ")).toContain(".keel is a link");
});
