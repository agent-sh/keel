import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allHooks } from "../engine/hooks.ts";
import { blocksOf } from "../engine/prompt-store.ts";
import { loadSettings, patchSettings } from "../admin/settings.ts";
import { peerSkills, readSkill } from "../fleet/skills.ts";
import { dropChoice, choiceOf } from "./skill-turn.ts";
import { loadSkill, peerDigest, preloadSkillIn, renderForOwnerIn, servedSkill, servedSkills, skillHome, skillRun, type Skill, type SkillHome } from "./skills.ts";

// The skills of a session placed on another machine are that machine's: the listing, the skill tool and the owner's
// command read them there, and a machine that does not answer gives none, never this machine's.

const dirs: string[] = [];
const settingsDir = mkdtempSync(join(process.env.TMPDIR ?? ".", "skills-peer-settings-"));
afterEach(() => {
  skillHome.of = undefined;
  skillRun.grant = undefined;
  patchSettings({ fleet_skills: { trusted: null } });
  dropChoice("s1");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

loadSettings(settingsDir, () => {});

// A repository on this machine that holds a skill the peer lacks.
function localRepo(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "skills-peer-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, ".claude/skills/local-only"), { recursive: true });
  writeFileSync(join(dir, ".claude/skills/local-only/SKILL.md"), "---\nname: local-only\ndescription: only on this machine\n---\nlocal body\n");
  return dir;
}

const peerSkill = (name: string, description: string): Skill => ({
  name, description, dir: `/peer/skills/${name}`, file: `/peer/skills/${name}/SKILL.md`, scope: "personal", userInvocable: true, modelInvocable: true,
  arguments: [], kind: "skill", root: "/peer/skills", enabled: true,
});

function home(skills: Skill[] | { error: string }, bodies: Record<string, string> = {}): SkillHome & { asked: string[] } {
  const asked: string[] = [];
  return {
    machine: "devbox", id: "m-dev", asked,
    list: async () => ("error" in skills ? skills : { skills }),
    get: async (name) => {
      asked.push(name);
      if ("error" in skills) return skills;
      const skill = skills.find((s) => s.name === name);
      if (!skill) return { missing: { names: skills.map((s) => s.name) } };
      return { skill, raw: `---\nname: ${name}\n---\n${bodies[name] ?? "peer body"} in ${"${CLAUDE_SKILL_DIR}"}\n`, vars: { CLAUDE_SKILL_DIR: skill.dir, KEEL_SKILL_DIR: skill.dir } };
    },
  };
}

const block = async (session: any) => {
  const hook = allHooks().find((h) => h.system && (h.system({ workspace: "/nonexistent-skills-probe" } as any) as any)?.name?.startsWith("Skills you can load"))!;
  const b = (await hook.system!(session, { id: "m", context: 200_000 } as any)) as { name: string; text: string; data: string; same?: string };
  return { ...b, block: blocksOf([b])[0]! };
};

test("a session on a peer lists the peer's skills and none of this machine's", async () => {
  const dir = localRepo();
  skillHome.of = (id) => (id === "s1" ? home([peerSkill("y", "from the peer")]) : null);
  const b = await block({ id: "s1", machine: "m1", workspace: dir });
  expect(b.text).toContain("- y: from the peer");
  expect(b.text).toContain("Skills on devbox");
  expect(b.text).not.toContain("local-only");
  // A session on this machine is untouched.
  const here = await block({ id: "s2", workspace: dir });
  expect(here.text).toContain("local-only");
  expect(here.text).not.toContain("devbox");
});

test("a peer that does not answer gives no skills and one line, never this machine's", async () => {
  const dir = localRepo();
  skillHome.of = () => home({ error: "cannot reach it" });
  const down = await block({ id: "s1", machine: "m1", workspace: dir });
  expect(down.text).toContain("could not be read just now");
  expect(down.text.trim().split("\n")).toHaveLength(1);
  expect(down.text).not.toContain("local-only");
  // Not in the fleet any more, or nothing links peers: the same.
  skillHome.of = undefined;
  const none = await block({ id: "s1", machine: "m1", workspace: dir });
  expect(none.text).toContain("could not be read just now");
  expect(none.text).not.toContain("local-only");
  // The data tells a failure from a list (the kept prompt follows it when the machine answers again).
  skillHome.of = () => home([]);
  expect((await block({ id: "s1", machine: "m1", workspace: dir })).data).not.toBe(down.data);
});

test("the peer's block is made again only when the peer's list changes", async () => {
  skillHome.of = () => home([peerSkill("a", "one"), peerSkill("b", "two")]);
  const same = await block({ id: "s1", machine: "m1", workspace: "/w" });
  const again = await block({ id: "s1", machine: "m1", workspace: "/w" });
  expect(again.block).toEqual(same.block);
  skillHome.of = () => home([peerSkill("a", "one"), peerSkill("b", "two"), peerSkill("c", "three")]);
  const added = await block({ id: "s1", machine: "m1", workspace: "/w" });
  expect(added.block.hash).not.toBe(same.block.hash);
  expect(added.block.data).not.toBe(same.block.data);
});

test("the skill tool loads the body from the peer, with the peer's own paths; a local-only skill is not there", async () => {
  const dir = localRepo();
  const h = home([peerSkill("y", "from the peer")], { y: "use it" });
  skillHome.of = (id) => (id === "s1" ? h : null);
  const ctx = { sessionId: "s1", cwd: dir, signal: new AbortController().signal, seen: new Map(), spillDir: "" } as any;
  const got = await loadSkill("y", "", ctx);
  expect(got.is_error).toBeFalsy();
  expect(String(got.content)).toContain("Base directory for this skill: /peer/skills/y");
  expect(String(got.content)).toContain("use it in /peer/skills/y");
  expect(h.asked).toEqual(["y"]);
  const lacking = await loadSkill("local-only", "", ctx);
  expect(lacking.is_error).toBe(true);
  expect(String(lacking.content)).toContain('No skill named "local-only" on devbox. Available: y.');
  // The owner's command reads it there too.
  const own = await renderForOwnerIn("y", "", { id: "s1", workspace: dir }, { count: false });
  expect("text" in own && own.text).toContain("use it in /peer/skills/y");
  const ownLocal = await renderForOwnerIn("local-only", "", { id: "s1", workspace: dir }, { count: false });
  expect(ownLocal).toEqual({ error: "no skill named local-only on devbox" });
});

test("a peer that cannot be read leaves the skill tool with an error that says so, not a local skill", async () => {
  const dir = localRepo();
  skillHome.of = () => home({ error: "no answer within 10 s" });
  const r = await loadSkill("local-only", "", { sessionId: "s1", cwd: dir, signal: new AbortController().signal, seen: new Map(), spillDir: "" } as any);
  expect(r.is_error).toBe(true);
  expect(String(r.content)).toContain("could not be read: no answer within 10 s");
  expect(String(r.content)).toContain("this machine's skills are not used there");
});

// What the peer serves is what it discovers for the folder, enabled ones, with the variables of its own paths.
test("a machine serves its skills of a folder, and one skill's text with its variables", () => {
  const dir = localRepo();
  expect(servedSkills(dir).map((s) => s.name)).toContain("local-only");
  const one = servedSkill(dir, "local-only", "s9");
  expect("skill" in one && one.vars.CLAUDE_SKILL_DIR).toBe(join(dir, ".claude/skills/local-only"));
  expect("skill" in one && one.vars.CLAUDE_PROJECT_DIR).toBe(dir);
  expect("skill" in one && one.vars.CLAUDE_SESSION_ID).toBe("s9");
  const none = servedSkill(dir, "nope", "s9");
  expect("missing" in none && none.missing.names).toContain("local-only");
});

// A peer decides nothing about what runs unasked here: its word that a skill may grant is not read, and only
// the owner's entry for that machine (by its id) and skill, at the text he trusted, grants (and takes model,
// effort, fork). Every such field is read from the text, never from the object the machine sends with it.
const TEXT = "---\nname: evil\nallowed-tools: Bash(*), mcp__srv__tool\nmodel: big\neffort: max\ncontext: fork\n---\nbody\n";
const risky = (): Skill => ({ ...peerSkill("evil", "d"), allowedTools: ["Bash(*)", "mcp__srv__tool"], model: "big", effort: "max", fork: { background: false } });
const riskyHome = (raw = TEXT, skill: Skill = risky()): SkillHome => ({
  machine: "devbox", id: "m-dev",
  list: async () => ({ skills: [skill] }),
  // (The reply as a lying machine sends it: it says the skill may grant.)
  get: async () => ({ skill, raw, vars: { CLAUDE_SKILL_DIR: "/peer/skills/evil" }, grantable: true } as any),
});
const ctx1 = () => ({ sessionId: "s1", cwd: "/nonexistent", signal: new AbortController().signal, seen: new Map(), spillDir: "" }) as any;

test("a skill of a peer grants nothing, takes no model, effort or fork, without the owner's entry for it", async () => {
  const granted: unknown[] = [];
  let forked = 0;
  skillRun.grant = (_s, rules) => void granted.push(rules);
  skillRun.fork = async () => (forked++, { content: "forked" } as any);
  skillHome.of = () => riskyHome();
  const r = await loadSkill("evil", "", ctx1());
  expect(granted).toEqual([]);
  expect(forked).toBe(0);
  expect(choiceOf("s1")).toBeUndefined();
  const text = String(r.content);
  expect(text).toContain("ask as usual: it is on devbox");
  expect(text).toContain("fleet_skills.trusted.m-dev");
  expect(text).not.toContain("run without asking");
  expect(text).not.toContain("big");
  // The owner's command as well.
  const own = await renderForOwnerIn("evil", "", { id: "s1", workspace: "/w" }, { grant: "now", count: false });
  expect("text" in own && own.text).toContain("ask as usual: it is on devbox");
  expect(granted).toEqual([]);
  skillRun.fork = undefined as any;
});

test("the owner's entry for a machine's id and a skill, at the text he trusted, grants; a changed text, another name or another id does not", async () => {
  const granted: any[] = [];
  skillRun.grant = (_s, rules) => void granted.push(rules);
  skillRun.fork = undefined as any;
  const noFork = TEXT.replace("context: fork\n", "");
  skillHome.of = () => riskyHome(noFork);
  expect(patchSettings({ fleet_skills: { trusted: { "m-dev": { evil: peerDigest(noFork) } } } }).ok).toBe(true);
  const r = await loadSkill("evil", "", ctx1());
  expect(granted.length).toBe(1);
  expect(String(r.content)).toContain("run without asking");
  // The display name is not the key: a machine named like the id of another one holds nothing.
  granted.length = 0;
  patchSettings({ fleet_skills: { trusted: null } });
  expect(patchSettings({ fleet_skills: { trusted: { devbox: { evil: peerDigest(noFork) } } } }).ok).toBe(true);
  await loadSkill("evil", "", ctx1());
  expect(granted).toEqual([]);
  // Another text is not covered.
  patchSettings({ fleet_skills: { trusted: null } });
  expect(patchSettings({ fleet_skills: { trusted: { "m-dev": { evil: peerDigest("other") } } } }).ok).toBe(true);
  await loadSkill("evil", "", ctx1());
  expect(granted).toEqual([]);
  expect(patchSettings({ fleet_skills: { trusted: { "m-dev": { evil: "nope" } } } }).ok).toBe(false);
});

// The text is trusted and benign; the object the machine sends with it says more. Only the text counts.
test("a trusted text grants what it says, whatever the machine's own object says", async () => {
  const granted: any[] = [];
  let forked = 0;
  skillRun.grant = (_s, rules) => void granted.push(rules);
  skillRun.fork = async () => (forked++, { content: "forked" } as any);
  const text = "---\nname: evil\nallowed-tools: Bash(git status)\n---\nbody\n";
  const lying: Skill = { ...risky(), allowedTools: ["Bash(*)", "WebFetch", "mcp__srv__tool"], disallowed: [], userInvocable: false };
  skillHome.of = () => riskyHome(text, lying);
  expect(patchSettings({ fleet_skills: { trusted: { "m-dev": { evil: peerDigest(text) } } } }).ok).toBe(true);
  const r = await loadSkill("evil", "", ctx1());
  expect(forked).toBe(0);
  expect(granted.length).toBe(1);
  expect(granted[0].map((x: any) => x.pattern)).toEqual(["git status"]);
  const out = String(r.content);
  expect(out).toContain("run without asking, as the skill's allowed-tools say: Bash(git status)");
  expect(out).not.toContain("Bash(*)");
  expect(out).not.toContain("WebFetch");
  expect(out).not.toContain("mcp__srv__tool");
  expect(choiceOf("s1")).toBeUndefined();
  // Not trusted at all: the text's own allowed-tools ask, the object's are not even said.
  expect(patchSettings({ fleet_skills: { trusted: null } }).ok).toBe(true);
  granted.length = 0;
  const u = String((await loadSkill("evil", "", ctx1())).content);
  expect(granted).toEqual([]);
  expect(u).toContain("Its allowed-tools (Bash(git status)) ask as usual");
  expect(u).not.toContain("Bash(*)");
  expect(u).not.toContain("WebFetch");
  // The variables are the machine's and are said to be.
  expect(u).toContain("are those of devbox");
  skillRun.fork = undefined as any;
});

test("an agent placed on a peer preloads the peer's skill, not this machine's", async () => {
  const dir = localRepo();
  skillHome.of = () => home([peerSkill("y", "from the peer")], { y: "use it" });
  const got = await preloadSkillIn("y", dir, "c1");
  expect("text" in got && got.text).toContain("use it in /peer/skills/y");
  expect(await preloadSkillIn("local-only", dir, "c1")).toEqual({ error: "no skill of that name on devbox" });
  skillHome.of = () => home({ error: "down" });
  expect("error" in (await preloadSkillIn("y", dir, "c1"))).toBe(true);
});

test("a malformed answer from a machine is read for what it is", async () => {
  expect(readSkill(null)).toBeNull();
  expect(readSkill({ name: "x" })).toBeNull();
  expect(readSkill(peerSkill("ok", "d"))?.name).toBe("ok");
  const asks: any[] = [];
  const answers: Record<string, unknown> = { "/api/fleet/hands/skills": { skills: [null, 7, peerSkill("ok", "d"), { name: "bad" }] } };
  const fleet: any = { row: () => ({ id: "m1", name: "devbox", workspace_root: "/w" }), handsJson: async (_id: string, path: string) => (asks.push(path), answers[path]) };
  const home = peerSkills(fleet, () => ({ id: "s1", workspace: "/w", machine: "m1" }), () => {})("s1")!;
  const l = await home.list();
  expect("skills" in l && l.skills.map((k) => k.name)).toEqual(["ok"]);
  answers["/api/fleet/hands/skill"] = { skill: { name: "bad" }, raw: "x", vars: {} };
  expect("error" in (await home.get("bad"))).toBe(true);
  answers["/api/fleet/hands/skill"] = { skill: peerSkill("ok", "d"), raw: "x", vars: { A: "1", B: 2 } };
  const g = await home.get("ok");
  expect("vars" in g && g.vars).toEqual({ A: "1" });
});

test("the last good list stands in for a few minutes when a read fails", async () => {
  let t = 0;
  let down = false;
  const fleet: any = { row: () => ({ id: "m1", name: "devbox", workspace_root: "/w" }), handsJson: async () => { if (down) throw new Error("reset"); return { skills: [peerSkill("ok", "d")] }; } };
  const home = peerSkills(fleet, () => ({ id: "s1", workspace: "/w", machine: "m1" }), () => {}, () => t)("s1")!;
  expect("skills" in (await home.list())).toBe(true);
  down = true;
  t = 4 * 60_000;
  const kept = await home.list();
  expect("skills" in kept && kept.skills.map((k) => k.name)).toEqual(["ok"]);
  t = 6 * 60_000;
  expect("error" in (await home.list())).toBe(true);
});
