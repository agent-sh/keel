import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileFindings } from "./health-file-rules.ts";
import { READ_MAX, readHead, scanFiles } from "./health-files.ts";

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

test("a file is read up to READ_MAX bytes, never whole", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-health-head-"));
  try {
    const big = join(root, "big.md");
    writeFileSync(big, "a".repeat(READ_MAX + 5000));
    const h = readHead(big);
    expect(h.size).toBe(READ_MAX + 5000);
    expect(h.text.length).toBe(READ_MAX);
    expect(readHead(big, 10).text).toBe("aaaaaaaaaa");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the walk mirrors what the skill list leaves out: another harness's skill and a skill the trust pin holds back take no name", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-health-mirror-"));
  try {
    const put = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
    // A personal skill that drives another harness's product is not offered, so it holds no name...
    put("own/skills/cdx/SKILL.md", "---\nname: same\ndescription: Use the Codex CLI to do it.\n---\nx");
    // ...so a repository's skill of that name is the one offered.
    put("proj/skills/real/SKILL.md", "---\nname: same\ndescription: the repository's\n---\nx");
    // A folder the owner chose keeps every skill it holds.
    put("chosen/c1/SKILL.md", "---\nname: other\ndescription: Use the Codex CLI.\n---\nx");
    put("proj/skills/other/SKILL.md", "---\nname: other\ndescription: the repository's\n---\nx");
    // A repository's skill the trust pin holds back says so, and takes no name.
    put("proj/skills/held/SKILL.md", "---\nname: held\ndescription: waits\n---\nx");
    put("own/skills/held2/SKILL.md", "---\nname: held\ndescription: the owner's\n---\nx");
    const r = scanFiles({
      folders: [
        { dir: join(root, "own/skills"), kind: "skill", layer: "personal" },
        { dir: join(root, "chosen"), kind: "skill", layer: "personal", chosen: true },
        { dir: join(root, "proj/skills"), kind: "skill", layer: "project" },
      ],
      plugins: [], builtins: [],
      held: [{ path: join(root, "proj/skills/held"), why: "it is new in this repository, and waits for the owner to trust it." }],
    });
    const shadow = r.findings.filter((f) => f.group === "settings");
    // "same": no warning (the foreign one took nothing). "other": the chosen folder's skill is first, the repository's is hidden.
    expect(shadow.some((f) => f.name === "same")).toBe(false);
    expect(shadow.find((f) => f.name === "other")).toMatchObject({ why: expect.stringContaining("never offered") });
    // "held": the pinned skill says why it does not load; it does not hide behind or in front of the owner's.
    expect(shadow.find((f) => f.path.endsWith("held/SKILL.md"))).toMatchObject({ level: "warning", why: expect.stringContaining("it does not load: it is new in this repository") });
    expect(shadow.filter((f) => f.name === "held" && /never offered/.test(f.why))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two folders that hold one skill name: a different file is told with which one is used, a copy of the same file is not", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-health-names-"));
  try {
    const put = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
    const one = "---\nname: same\ndescription: one\n---\nx";
    put("a/same/SKILL.md", one);
    put("b/same/SKILL.md", one);
    put("a/diff/SKILL.md", "---\nname: diff\ndescription: first\n---\nx");
    put("b/diff/SKILL.md", "---\nname: diff\ndescription: second\n---\nx");
    const r = scanFiles({ folders: [{ dir: join(root, "a"), kind: "skill", layer: "personal" }, { dir: join(root, "b"), kind: "skill", layer: "personal" }], plugins: [], builtins: [], json: [] });
    expect(r.findings.map((f) => [f.name, f.path.slice(root.length + 1), f.why])).toEqual([
      ["diff", "b/diff/SKILL.md", `diff is never offered: ${join(root, "a/diff/SKILL.md")} holds a different file under the same name, is read first and is the one used`],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
