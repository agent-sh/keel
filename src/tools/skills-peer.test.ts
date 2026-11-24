import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allHooks } from "../engine/hooks.ts";
import { blocksOf } from "../engine/prompt-store.ts";
import { loadSkill, renderForOwnerIn, servedSkill, servedSkills, skillHome, type Skill, type SkillHome } from "./skills.ts";

// The skills of a session placed on another machine are that machine's: the listing, the skill tool and the owner's
// command read them there, and a machine that does not answer gives none, never this machine's.

const dirs: string[] = [];
afterEach(() => {
  skillHome.of = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
    machine: "devbox", asked,
    list: async () => ("error" in skills ? skills : { skills }),
    get: async (name) => {
      asked.push(name);
      if ("error" in skills) return skills;
      const skill = skills.find((s) => s.name === name);
      if (!skill) return { missing: { names: skills.map((s) => s.name) } };
      return { skill, raw: `---\nname: ${name}\n---\n${bodies[name] ?? "peer body"} in ${"${CLAUDE_SKILL_DIR}"}\n`, vars: { CLAUDE_SKILL_DIR: skill.dir, KEEL_SKILL_DIR: skill.dir }, grantable: false };
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
