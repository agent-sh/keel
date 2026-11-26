// INT-S59: Keel read no Codex plugin. Port lists the ones turned on in Codex's config.toml and carries a picked one's
// skills by reference (<plugin>:<skill>, from Codex's plugin cache), as it does a Claude Code plugin's.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { configDir } from "../providers/config.ts";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../test/env.ts";

const home = tempTree("keel-port-codex-");
ownEnv({ KEEL_IMPORT_HOME: home, CODEX_HOME: join(home, ".codex") });

// The config folder is the run's: its skills.json is put back as it was when the file ends.
const skillsFile = join(configDir(), "skills.json");
const kept = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
const before = [skillsFile, `${skillsFile}.prev`].map((f) => [f, kept(f)] as const);
afterAll(() => { for (const [f, text] of before) { if (text === null) rmSync(f, { force: true }); else writeFileSync(f, text); } });

const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const cache = join(home, ".codex", "plugins", "cache");
put(join(cache, "m", "docs", "1.0.0", "skills", "write", "SKILL.md"), "---\nname: write\ndescription: Write DOCX files.\n---\nWrite.");
put(join(cache, "m", "biz", "2.0.0", "skills", "sell", "SKILL.md"), "---\nname: sell\ndescription: Sell.\n---\nSell.");
put(join(cache, "m", "conn", "0.1.0", ".app.json"), "{}");
put(join(cache, "m", "both", "0.1.0", "skills", "x", "SKILL.md"), "---\nname: x\ndescription: x\n---\nx");
// A plugin's skill that names allowed-tools, beside commands and agents Codex does not read from a plugin.
put(join(cache, "m", "docs", "1.0.0", "skills", "run", "SKILL.md"), "---\nname: run\ndescription: Run node.\nallowed-tools: Bash(node:*)\n---\nRun.");
put(join(cache, "m", "docs", "1.0.0", "commands", "go.md"), "---\ndescription: Go.\n---\nGo.");
put(join(cache, "m", "docs", "1.0.0", "agents", "helper.md"), "---\nname: helper\ndescription: Help.\n---\nHelp.");
// "dup" is a Claude Code plugin port carries, so its Codex twin gives way; "both" is turned on in Claude Code but not installed there.
put(join(cache, "m", "dup", "0.1.0", "skills", "y", "SKILL.md"), "---\nname: y\ndescription: y\n---\ny");
const claudeDup = join(home, ".claude", "plugins", "cache", "other", "dup", "1");
put(join(claudeDup, "skills", "y", "SKILL.md"), "---\nname: y\ndescription: y\n---\ny");
put(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "dup@other": [{ scope: "user", installPath: claudeDup }] } }));
put(join(home, ".codex", "config.toml"), [
  '[plugins."docs@m"]', "enabled = true", '[plugins."biz@m"]', "enabled = true", '[plugins."conn@m"]', "enabled = true",
  '[plugins."both@m"]', "enabled = true", '[plugins."dup@m"]', "enabled = true", '[plugins."off@m"]', "enabled = false", '[plugins."gone@m"]', "enabled = true",
].join("\n"));
put(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "biz@synced": false, "both@other": true, "dup@other": true } }));

test("port lists the Codex plugins turned on and carries a picked one's skills", async () => {
  const port = await import("./port.ts");
  const { discoverSkills } = await import("../tools/skills.ts");
  const deps = { workspace: home } as any;
  const items = await port.planParts(deps, { only: ["plugins"] });
  const of = (id: string) => items.find((i) => i.id === `plugins:codex:${id}`);
  expect(of("docs@m")).toMatchObject({ state: "new", pick: true, detail: "2 skills" });
  expect(of("biz@m")).toMatchObject({ state: "new", pick: false, reason: "turned off in Claude Code under the same name" });
  expect(of("conn@m")).toMatchObject({ state: "skip", reason: "nothing Keel can run: its app connectors are Codex's own" });
  expect(of("dup@m")).toMatchObject({ state: "skip", reason: "Claude Code has it turned on too: Keel carries that one" });
  expect(of("both@m")).toMatchObject({ state: "new", pick: true });
  expect(of("gone@m")).toMatchObject({ state: "skip", reason: "turned on but not in Codex's plugin cache" });
  expect(of("off@m")).toBeUndefined();
  expect(discoverSkills(home).some((s) => s.name === "docs:write")).toBe(false);
  const done = await port.apply(deps, { ids: ["plugins:codex:docs@m"] });
  expect(done.items.find((i) => i.id === "plugins:codex:docs@m")).toMatchObject({ ok: true });
  expect(discoverSkills(home).find((s) => s.name === "docs:write")?.file).toBe(join(cache, "m", "docs", "1.0.0", "skills", "write", "SKILL.md"));
  // Only its skills: their allowed-tools ask (Codex pre-approves nothing from that field), no command or agent comes with it.
  const { mayGrant } = await import("../tools/skills.ts");
  const run = discoverSkills(home).find((s) => s.name === "docs:run")!;
  expect(run.allowedTools).toEqual(["Bash(node:*)"]);
  expect(mayGrant(run)).toBe(false);
  expect(discoverSkills(home).some((s) => s.name === "docs:go")).toBe(false);
  const { definitions } = await import("../automation/agents.ts");
  expect(definitions(home).some((d) => d.name === "docs:helper")).toBe(false);
  expect((await port.planParts(deps, { only: ["plugins"] })).find((i) => i.id === "plugins:codex:docs@m")).toMatchObject({ state: "done", pick: false });
});

test("a Codex plugin id that could leave the cache names no folder", async () => {
  const { codexPluginDir } = await import("./codex-plugins.ts");
  put(join(home, ".codex", "plugins", "x", "1", "skills", "z", "SKILL.md"), "---\nname: z\n---\nz");
  expect(codexPluginDir(join(home, ".codex"), "docs@m")).toBe(join(cache, "m", "docs", "1.0.0"));
  for (const id of ["../../x@..", "x@..", "../x@m", "a/b@m", "a\\b@m", "docs@m/..", "@m", "docs@"]) expect(codexPluginDir(join(home, ".codex"), id)).toBeNull();
});

test("an agent file's apps._default is no app, and an app with an entry is on unless it says enabled = false", async () => {
  const { codexIntegrations } = await import("../automation/codex-agent.ts");
  const codex = join(home, ".codex");
  expect(codexIntegrations({ apps: { _default: { enabled: false } } }, codex).unavailable).toBeUndefined();
  expect(codexIntegrations({ apps: { _default: { enabled: true } } }, codex).unavailable).toBeUndefined();
  expect(codexIntegrations({ apps: { _default: { enabled: false }, gmail: {} } }, codex).unavailable).toContain("ChatGPT app connector");
  expect(codexIntegrations({ apps: { _default: { enabled: false }, gmail: { enabled: true } } }, codex).unavailable).toContain("ChatGPT app connector");
  expect(codexIntegrations({ apps: { gmail: {} } }, codex).unavailable).toContain("ChatGPT app connector");
  expect(codexIntegrations({ apps: { gmail: { enabled: false } } }, codex).unavailable).toBeUndefined();
});

test("a carried Codex skill registers no hooks, and its allowed-tools ask for Codex's reason", async () => {
  const { loadSkill, skillRun } = await import("../tools/skills.ts");
  put(join(cache, "m", "docs", "1.0.0", "skills", "hook", "SKILL.md"),
    "---\nname: hook\ndescription: Hooked.\nallowed-tools: Bash(node:*)\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: echo hi\n---\nHook.");
  const was = skillRun.hooks;
  let registered = 0;
  skillRun.hooks = () => { registered++; return { events: ["PreToolUse"], problems: [], notes: [] } as any; };
  try {
    const r = await loadSkill("docs:hook", "", { sessionId: "s1", cwd: home, signal: new AbortController().signal, seen: new Map(), spillDir: "" } as any);
    const text = JSON.stringify(r);
    expect(registered).toBe(0);
    expect(text).toContain("a Codex plugin's skill carries no hooks");
    expect(text).toContain("Codex pre-approves nothing from allowed-tools");
    expect(text).not.toContain("Trust panel");
  } finally { skillRun.hooks = was; }
});
