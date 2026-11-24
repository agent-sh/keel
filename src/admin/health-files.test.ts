import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileFindings } from "./health-file-rules.ts";
import { scanFiles } from "./health-files.ts";

test("a skill, command or agent file: what is lost is said, what is fine says nothing", () => {
  // Skills and commands.
  expect(fileFindings("skill", "---\nname: ok\ndescription: Does a thing.\n---\nBody\n")).toEqual([]);
  expect(fileFindings("skill", "---\nname: x\ndescription: never closed\nBody\n")).toMatchObject([{ level: "broken", why: expect.stringContaining("never closes") }]);
  expect(fileFindings("skill", "---\nname: <b>\ndescription: d\n---\nx")).toMatchObject([{ level: "broken", why: expect.stringContaining("not listed") }]);
  expect(fileFindings("skill", "---\nname: n\n---\n\n")).toMatchObject([{ level: "warning" }]);
  expect(fileFindings("command", "Say hello.\n")).toEqual([]);
  expect(fileFindings("command", " \n")).toMatchObject([{ level: "warning", why: "the file is empty" }]);
  // Agents: front matter between --- lines, a description, a size.
  expect(fileFindings("agent", "---\nname: a\ndescription: d\n---\nPrompt")).toEqual([]);
  expect(fileFindings("agent", "Prompt only")).toMatchObject([{ level: "broken", why: expect.stringContaining("no front matter") }]);
  expect(fileFindings("agent", "---\nname: a\n---\nPrompt")).toMatchObject([{ level: "warning", why: expect.stringContaining("no description") }]);
  expect(fileFindings("agent", "---\nname: [a\ndescription: d\n---\nPrompt")[0]).toMatchObject({ level: "warning", why: expect.stringContaining("not valid YAML") });
  expect(fileFindings("agent", "---\nname: a\ndescription: d\n---\n", 40_000)).toMatchObject([{ level: "broken", why: expect.stringContaining("larger than 32 KB") }]);
  // Codex agents: TOML with three fields.
  expect(fileFindings("codex agent", 'name = "a"\ndescription = "d"\ndeveloper_instructions = "x"\n')).toEqual([]);
  expect(fileFindings("codex agent", 'name = "a"\n')[0]).toMatchObject({ level: "broken", why: "a Codex agent file needs description, developer_instructions" });
  expect(fileFindings("codex agent", "name = ")[0]).toMatchObject({ level: "broken", why: expect.stringContaining("not valid TOML") });
});

test("the walk: broken files by folder, a hidden name, a repository agent that takes a built-in's name, a plugin that lost a file, a bad config file", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-health-"));
  try {
    const put = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
    put("own/skills/good/SKILL.md", "---\nname: good\ndescription: fine\n---\nx");
    put("own/skills/torn/SKILL.md", "---\nname: torn\ndescription: no end\n");
    put("own/skills/twin/SKILL.md", "---\nname: good\ndescription: same name as the first\n---\nx");
    put("own/skills/.hidden/SKILL.md", "---\nname: hid\n---\nx");
    put("own/skills/synced/SKILL.md", "ignored");
    put("proj/skills/shadow/SKILL.md", "---\nname: good\ndescription: a repository's\n---\nx");
    put("own/commands/run.md", "Run it.\n");
    put("own/commands/good.md", "A command named like the skill.\n");
    put("own/agents/a.md", "---\nname: helper\ndescription: d\n---\nx");
    put("own/agents/bare.md", "no front matter");
    put("proj/agents/h.md", "---\nname: helper\ndescription: the repository's\n---\nx");
    put("proj/agents/b.md", "---\nname: Explore\ndescription: takes a built-in's name\n---\nx");
    put("cats/web/deep/SKILL.md", "---\nname: deep\ndescription: nested\n---\nx");
    put("cfg/skills.json", "{not json");
    put("cfg/plugins.json", '{"plugins": []}');
    put("plug/.claude-plugin/plugin.json", "{oops");
    // A linked folder holds the same skill twice: it counts once.
    symlinkSync(join(root, "own/skills"), join(root, "own/skills-link"));

    const r = scanFiles({
      folders: [
        { dir: join(root, "own/skills"), kind: "skill", layer: "personal" },
        { dir: join(root, "own/skills-link"), kind: "skill", layer: "personal" },
        { dir: join(root, "cats"), kind: "skill", layer: "personal", nested: true },
        { dir: join(root, "proj/skills"), kind: "skill", layer: "project" },
        { dir: join(root, "own/commands"), kind: "command", layer: "personal" },
        { dir: join(root, "own/agents"), kind: "agent", layer: "owner" },
        { dir: join(root, "proj/agents"), kind: "agent", layer: "project" },
      ],
      plugins: [
        { id: "p", dir: join(root, "plug"), files: [{ kind: "skill", file: join(root, "plug/skills/gone/SKILL.md"), name: "gone" }] },
        { id: "q", dir: join(root, "no-such-plugin"), files: [] },
      ],
      builtins: ["Explore", "general-purpose"],
      json: [join(root, "cfg/skills.json"), join(root, "cfg/plugins.json"), join(root, "cfg/mcp.json")],
    });
    const at = (f: { path: string }) => f.path.slice(root.length + 1);
    const seen = r.findings.map((f) => [f.group, f.level, f.kind, at(f)] as const).sort((a, b) => (a.join() < b.join() ? -1 : 1));
    expect(seen).toEqual([
      ["files", "broken", "agent", "own/agents/bare.md"],
      ["files", "broken", "config", "cfg/skills.json"],
      ["files", "broken", "plugin", "no-such-plugin"],
      ["files", "broken", "plugin", "plug"],
      ["files", "broken", "skill", "own/skills/torn/SKILL.md"],
      ["files", "broken", "skill", "plug/skills/gone/SKILL.md"],
      ["settings", "warning", "agent", "own/agents/a.md"],
      ["settings", "warning", "agent", "proj/agents/b.md"],
      ["settings", "warning", "command", "own/commands/good.md"],
      ["settings", "warning", "skill", "own/skills/twin/SKILL.md"],
      ["settings", "warning", "skill", "proj/skills/shadow/SKILL.md"],
    ]);
    // The layers say which file wins; a plugin that is gone says so; a good config file is counted.
    const why = (p: string) => r.findings.find((f) => at(f) === p)!.why;
    expect(why("proj/skills/shadow/SKILL.md")).toContain(join(root, "own/skills/good/SKILL.md"));
    expect(why("own/agents/a.md")).toContain(join(root, "proj/agents/h.md"));
    expect(why("proj/agents/b.md")).toContain("never takes the name of an agent Keel brings itself");
    expect(why("no-such-plugin")).toBe("its folder is gone");
    // Hidden and synced folders are not skills; the nested folder's skill is.
    expect(r.counts).toEqual({ skill: 5, command: 2, agent: 4, plugin: 2, config: 2 });
    expect(r.truncated).toBe(false);
    expect(scanFiles({ folders: [{ dir: join(root, "own/skills"), kind: "skill", layer: "personal" }], plugins: [], builtins: [], max: 1 }).truncated).toBe(true);
  } finally { rmSync(join(root), { recursive: true, force: true }); }
});
