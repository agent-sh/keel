// A session started at a pull request's head reads the head's instruction files, skills, hook file and check
// names as the repository's own only when the head's author can write to the repository. A fork by anyone else,
// and a head whose author cannot be read, loads the base branch's instruction files and nothing else of the
// head, until the owner trusts the head. The host is a stand-in tool (KEEL_GH_BIN) and the origin a bare
// repository on this machine.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";
import { Bus } from "../../core/bus.ts";
import { ErrorTracker } from "../../core/errors.ts";
import { Store } from "../../core/store.ts";
import { allHooks } from "../../engine/hooks.ts";
import { instructionFiles, instructionFilter } from "../../engine/turn.ts";
import { Hooks, pinKey, projectRoot } from "../../integrations/hooks.ts";
import { namedFor, repoOf } from "../../checks/ledger.ts";
import { headHold } from "../../safety/head-trust.ts";
import { headHeld, SetupPins, setupHook } from "../../worktree/setup.ts";
import { skillFilter } from "../../tools/skills.ts";
import { trustRoutes } from "./trust.ts";
import { worktreeRoutes } from "./worktrees.ts";

setDefaultTimeout(30_000);

const hooksBefore = new Set(allHooks());
const root = tempTree("keel-head-");
afterAll(() => {
  // (The routes register turn hooks, process-wide: taken off with the filters they set.)
  for (const h of [...allHooks()]) if (!hooksBefore.has(h)) allHooks().splice(allHooks().indexOf(h), 1);
  instructionFilter.file = undefined; headHold.of = undefined; headHeld.of = undefined; setupHook.headTrusted = undefined; setupHook.confine = undefined; for (const k of Object.keys(skillFilter)) delete (skillFilter as any)[k];
});

const run = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().trim();
};

// The code host's stand-in: what it answers is the files of its folder, one per question.
const fake = join(root, "gh");
const answers = join(root, "answers");
mkdirSync(answers, { recursive: true });
writeFileSync(fake, `#!/bin/bash
f=""
case "$1 $2" in
  "pr view") f=pr ;;
  "api user") f=user ;;
  "api repos/"*) f=perm ;;
esac
[ -n "$f" ] && [ -f "${answers}/$f.json" ] && cat "${answers}/$f.json" && exit 0
exit 1
`);
chmodSync(fake, 0o755);
ownEnv({ KEEL_GH_BIN: fake });
const say = (answer: { pr?: object; perm?: object; user?: object }) => {
  for (const f of ["pr", "perm", "user"]) rmSync(join(answers, `${f}.json`), { force: true });
  for (const [f, v] of Object.entries(answer)) writeFileSync(join(answers, `${f}.json`), JSON.stringify(v));
};
const pr = (author: string, cross: boolean) => ({ author: { login: author }, isCrossRepository: cross, headRepositoryOwner: { login: author }, baseRefName: "main", url: "https://github.com/o/r/pull/7" });

// One repository with its origin: the base says BASE-RULE; the request's head says HEAD-RULE, adds a skill, a
// hook file and a named check.
let n = 0;
function scenario(baseExtra: Record<string, string> = {}, headExtra: Record<string, string> = {}) {
  const dir = join(root, `s${++n}`);
  mkdirSync(dir, { recursive: true });
  const origin = join(dir, "origin.git");
  run(dir, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(dir, "repo");
  run(dir, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "AGENTS.md"), "The base says BASE-RULE.\n");
  for (const [f, text] of Object.entries(baseExtra)) writeFileSync(join(repo, f), text);
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "base");
  run(repo, "push", "-q", "origin", "HEAD:main");
  run(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "AGENTS.md"), "The head says HEAD-RULE.\n");
  mkdirSync(join(repo, ".keel"), { recursive: true });
  writeFileSync(join(repo, ".keel/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo head-hook" }] }] } }));
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { headcheck: { run: "bun test", args: true } } }));
  mkdirSync(join(repo, ".claude/skills/evil"), { recursive: true });
  writeFileSync(join(repo, ".claude/skills/evil/SKILL.md"), "---\nname: evil\ndescription: from the head\n---\nDo it.\n");
  for (const [f, text] of Object.entries(headExtra)) writeFileSync(join(repo, f), text);
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "head");
  run(repo, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  run(repo, "checkout", "-q", "main");
  run(repo, "branch", "-q", "-D", "feature");

  const store = new Store(join(dir, "state"));
  store.db.run("CREATE TABLE IF NOT EXISTS perm_settings (key TEXT PRIMARY KEY, value TEXT)");
  const bus = new Bus();
  const providers = { defaultModel: async () => "m", resolve: async () => ({ provider: { id: "p" }, info: { id: "p:m" } }) };
  const deps = { store, bus, errors: new ErrorTracker(store, bus), providers, workspace: repo, engine: { isRunning: () => false, send() {} } } as any;
  const trust = trustRoutes(deps) as any;
  const wt = worktreeRoutes(deps) as any;
  const call = (routes: any, path: string, method: string, body?: unknown, params: Record<string, string> = {}, query = "") =>
    routes[path][method](Object.assign(new Request(`http://x${path}${query}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), { params }));
  return {
    repo, store,
    async start() {
      const r = await call(wt, "/api/worktrees", "POST", { workspace: repo, pr: "7" });
      expect(r.status).toBe(201);
      return (await r.json()).session as { id: string; workspace: string };
    },
    head: async (id: string) => (await (await call(trust, "/api/sessions/:id/head", "GET", undefined, { id })).json()).head,
    trust: (id: string) => call(trust, "/api/sessions/:id/head/trust", "POST", {}, { id }),
    // The Trust panel's route, for one file.
    async trustFile(cwd: string, rel: string) {
      const view = await (await call(trust, "/api/trust", "GET", undefined, {}, `?cwd=${encodeURIComponent(cwd)}`)).json();
      const f = view.files.find((x: any) => x.rel === rel);
      return call(trust, "/api/trust", "POST", { cwd, files: [{ path: f.path, sha256: f.sha256 }] });
    },
  };
}

// What the session reads as the repository's own, as it is now.
function loaded(cwd: string, store: Store) {
  const hooks = new Hooks(store);
  const project = hooks.sources(cwd).find((s) => s.scope === "project");
  // The owner pinned the file as it stands (what a clone's owner does after reading it).
  if (project) store.db.query("INSERT INTO hook_pins (root, sha256, created) VALUES (?, ?, 1) ON CONFLICT(root) DO UPDATE SET sha256 = excluded.sha256").run(pinKey(projectRoot(cwd)), project.sha256);
  return {
    prompt: instructionFiles(cwd),
    hookEvents: [...hooks.events(cwd)],
    checks: namedFor(repoOf(cwd)!)?.checks.map((c) => c.name) ?? [],
    skill: skillFilter.held?.(join(cwd, ".claude/skills/evil")) ?? null,
  };
}

test("a fork by someone without write access: the base's instructions load, nothing else of the head", async () => {
  say({ pr: pr("stranger", true), perm: { role_name: "read", permission: "read" }, user: { login: "owner" } });
  const t = scenario();
  const s = await t.start();
  const before = await t.head(s.id);
  expect(before).toMatchObject({ held: true, author: "stranger", fork: true, base_ref: "origin/main" });
  expect(before.why).toContain("does not have write access");

  const held = loaded(s.workspace, t.store);
  expect(held.prompt).toContain("BASE-RULE");
  expect(held.prompt).not.toContain("HEAD-RULE");
  expect(held.hookEvents).toEqual([]);
  expect(held.checks).toEqual([]);
  expect(held.skill).toContain("pull request from a fork");
  // One file of it is not trusted on its own while the head is held.
  expect((await t.trustFile(s.workspace, "AGENTS.md")).status).toBe(409);

  // The owner trusts the head: it loads as any repository's tree.
  expect((await t.trust(s.id)).status).toBe(200);
  expect((await t.head(s.id)).held).toBe(false);
  const open = loaded(s.workspace, t.store);
  expect(open.prompt).toContain("HEAD-RULE");
  expect(open.prompt).not.toContain("BASE-RULE");
  expect(open.hookEvents).toEqual(["SessionStart"]);
  expect(open.checks).toEqual(["headcheck"]);
  expect(open.skill).toBeNull();
});

test("a fork by an author with write access loads as a repository's own tree", async () => {
  say({ pr: pr("friend", true), perm: { role_name: "write", permission: "write" }, user: { login: "owner" } });
  const t = scenario();
  const s = await t.start();
  expect(await t.head(s.id)).toMatchObject({ held: false, state: "trusted", author: "friend" });
  const l = loaded(s.workspace, t.store);
  expect(l.prompt).toContain("HEAD-RULE");
  expect(l.hookEvents).toEqual(["SessionStart"]);
  expect(l.checks).toEqual(["headcheck"]);
});

test("the owner's own pull request from a fork, and a branch of the repository itself, are trusted", async () => {
  say({ pr: pr("me", true), perm: { role_name: "read" }, user: { login: "Me" } });
  let t = scenario();
  expect((await t.head((await t.start()).id)).held).toBe(false);
  say({ pr: pr("anyone", false) });
  t = scenario();
  expect(await t.head((await t.start()).id)).toMatchObject({ held: false, fork: false });
});

test("a head whose author cannot be read is held: the tool fails, or there is none for the host", async () => {
  say({});
  let t = scenario();
  let s = await t.start();
  expect((await t.head(s.id)).held).toBe(true);
  expect(loaded(s.workspace, t.store).prompt).not.toContain("HEAD-RULE");
  // No tool of the test's: a folder on this machine is no code host to ask.
  delete process.env.KEEL_GH_BIN;
  try {
    t = scenario();
    s = await t.start();
    const h = await t.head(s.id);
    expect(h.held).toBe(true);
    expect(h.why).toContain("not on a code host");
    expect(loaded(s.workspace, t.store).prompt).toContain("BASE-RULE");
  } finally {
    process.env.KEEL_GH_BIN = fake;
  }
});

test("a fork's head is held with every instruction file of the base's tree, CLAUDE.local.md and AGENTS.override.md too", async () => {
  say({ pr: pr("stranger", true), perm: { role_name: "read", permission: "read" }, user: { login: "owner" } });
  const t = scenario({ "CLAUDE.local.md": "Local says BASE-LOCAL.\n", "AGENTS.override.md": "Override says BASE-OVERRIDE.\n", "notes.md": "not an instruction file\n" });
  const s = await t.start();
  expect((await t.head(s.id)).held).toBe(true);
  const kept = JSON.parse((t.store.db.query("SELECT base_files FROM head_trust WHERE session_id = ?").get(s.id) as { base_files: string }).base_files);
  expect(Object.keys(kept).sort()).toEqual(["AGENTS.md", "AGENTS.override.md", "CLAUDE.local.md"]);
  expect(kept["CLAUDE.local.md"]).toContain("BASE-LOCAL");
});

test("a fork's head runs no worktree setup while it is held, and runs it once when the owner trusts the head", async () => {
  say({ pr: pr("stranger", true), perm: { role_name: "read", permission: "read" }, user: { login: "owner" } });
  const t = scenario({}, { ".keel/worktree.json": JSON.stringify({ setup: ["echo ran >> setup-ran.txt"] }) });
  const s = await t.start();
  const marker = join(s.workspace, "setup-ran.txt");
  expect((await t.head(s.id)).held).toBe(true);
  // The owner pinned the file (a held head cannot be pinned through the panel, so the pin is written as the panel would).
  const shown = new SetupPins(t.store).show(s.workspace);
  expect(shown.state).toBe("refused");
  t.store.db.query("INSERT INTO worktree_setup_pins (root, sha256, created) VALUES (?, ?, 1)").run(pinKey(projectRoot(s.workspace)), shown.sha256!);
  await Bun.sleep(300);
  expect(existsSync(marker)).toBe(false);
  setupHook.confine = () => ({}); // the permission routes are not loaded here: the session's commands run unconfined
  expect((await t.trust(s.id)).status).toBe(200);
  const until = Date.now() + 15_000;
  while (!existsSync(marker) && Date.now() < until) await Bun.sleep(50);
  expect(readFileSync(marker, "utf8")).toBe("ran\n");
  await t.trust(s.id); // trusted already: nothing again
  await Bun.sleep(500);
  expect(readFileSync(marker, "utf8")).toBe("ran\n");
});
