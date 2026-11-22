import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changes, consentKey, entrySource, fill, nameProblem, parseMarketplace, readPlugin, resolveNames, runLine, runsOf } from "./manifest.ts";
import { parseSource } from "./fetch.ts";

const tree = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "keel-plugin-"));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
};

test("a Claude Code plugin is read as it is: its parts, and what Keel does not take", () => {
  const root = tree({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "kit", version: "1.2.0", description: "A kit", author: { name: "Ann" }, commands: ["./more/"], outputStyles: "./styles/", userConfig: { token: {} } }),
    "skills/greet/SKILL.md": "---\nname: hello\ndescription: say hello\n---\nHi",
    "skills/notes/README.md": "not a skill",
    "commands/ignored.md": "replaced by the manifest's commands",
    "more/stamp.md": "Stamp it",
    "agents/checker.md": "---\nname: checker\ndescription: checks\n---\nCheck.",
    "hooks/hooks.json": JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hook.sh" }] }] } }),
    ".mcp.json": JSON.stringify({ mcpServers: { db: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/db.js"] } } }),
    ".lsp.json": "{}",
    "styles/terse.md": "Be terse.",
    "bin/tool": "#!/bin/sh",
  });
  const p = readPlugin(root);
  expect(p.problems).toEqual([]);
  expect(p.name).toBe("kit");
  expect(p.version).toBe("1.2.0");
  expect(p.author).toBe("Ann");
  expect(p.skills.map((s) => s.name)).toEqual(["hello"]);
  expect(p.commands.map((c) => c.name)).toEqual(["stamp"]); // the manifest's paths replace commands/
  expect(p.agents.map((a) => a.name)).toEqual(["checker"]);
  expect(Object.keys(p.hooks)).toEqual(["UserPromptSubmit"]);
  expect(Object.keys(p.mcp)).toEqual(["db"]);
  expect(p.notTaken.map((n) => n.part).sort()).toEqual([".lsp.json", "bin/", "outputStyles", "userConfig"]);
});

test("no manifest: the folder's name and the standard layout; a path out of the folder is refused", () => {
  const bare = tree({ "commands/a.md": "A" });
  expect(readPlugin(bare).name).toBe(bare.split("/").pop()!);
  expect(readPlugin(bare).commands.map((c) => c.name)).toEqual(["a"]);
  const out = tree({ ".claude-plugin/plugin.json": JSON.stringify({ name: "x", agents: "./../elsewhere", skills: "skills" }) });
  const p = readPlugin(out);
  expect(p.problems.some((m) => m.includes("outside the plugin's folder"))).toBe(true);
  expect(p.problems.some((m) => m.includes("not a path starting with ./"))).toBe(true);
  expect(nameProblem("has space")).toContain("not a plugin name");
  expect(nameProblem("a:b")).toContain("not a plugin name");
  expect(nameProblem("ok-name")).toBeNull();
});

test("a marketplace entry is the manifest when there is no plugin.json, and adds to one when strict", () => {
  const root = tree({ "p/skills/s/SKILL.md": "---\nname: s\ndescription: d\n---\n", "p/extra/x.md": "X" });
  const { market } = parseMarketplace({ name: "m", owner: { name: "o" }, plugins: [{ name: "pp", source: "./p", version: "3", commands: "./extra/" }] });
  const p = readPlugin(join(root, "p"), market!.plugins[0]);
  expect(p.name).toBe("pp");
  expect(p.version).toBe("3");
  expect(p.commands.map((c) => c.name)).toEqual(["x"]);
  expect(entrySource(market!.plugins[0]!, root)).toEqual({ dir: join(root, "p") });
  expect(entrySource({ name: "g", source: { source: "github", repo: "o/r", ref: "v1" }, fields: {} }, root)).toEqual({ git: "https://github.com/o/r.git", ref: "v1" });
  expect(entrySource({ name: "s", source: { source: "git-subdir", url: "https://x/y.git", path: "plugins/a" }, fields: {} }, root)).toEqual({ git: "https://x/y.git", sub: "plugins/a" });
  expect("unsupported" in entrySource({ name: "n", source: { source: "npm", package: "x" }, fields: {} }, root)).toBe(true);
  expect("unsupported" in entrySource({ name: "up", source: "../out", fields: {} }, root)).toBe(true);
});

test("names: skills and commands are the plugin's, an MCP server takes a prefix only when its name is taken", () => {
  const r = resolveNames({ id: "kit", skills: ["review"], commands: ["review", "stamp"], agents: ["checker"], mcp: ["db", "web", "fresh"] }, { skills: new Set(["stamp"]), agents: new Set(["checker"]), mcp: new Set(["db", "web"]) });
  expect(r.mcp).toEqual({ db: "kit-db", web: "kit-web", fresh: "fresh" });
  expect(r.notes.join("\n")).toContain("The command stamp is also yours: yours keeps the name, this plugin's is kit:stamp.");
  expect(r.notes.join("\n")).toContain("kit:review is the skill");
  expect(r.notes.join("\n")).toContain("The agent checker is also yours");
  expect(r.notes.join("\n")).toContain("this plugin's is kit-db, and yours is left as it is");
});

test("what runs, its consent key, and what an update changes", () => {
  const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/check.sh", args: ["-q"] }] }] };
  const runs = runsOf(hooks, { db: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/db.js"] }, api: { url: "https://api.example/mcp" } });
  expect(runs.map(runLine)).toEqual([
    "hook on PreToolUse (Bash): ${CLAUDE_PLUGIN_ROOT}/check.sh -q",
    "MCP server db: node ${CLAUDE_PLUGIN_ROOT}/db.js",
    "MCP server api: connects to https://api.example/mcp",
  ]);
  expect(consentKey(["a"])).toBe(consentKey(["a"]));
  expect(consentKey(["a"])).not.toBe(consentKey(["b"]));
  expect(fill({ c: "${CLAUDE_PLUGIN_ROOT}/x", d: ["${CLAUDE_PLUGIN_DATA}"] }, { root: "/r", data: "/d" })).toEqual({ c: "/r/x", d: ["/d"] });
  const a = { version: "1", skills: ["s"], commands: [], agents: [], mcp: ["db"], runs: ["hook on Stop: a"], notTaken: [] };
  const c = changes(a, { ...a, version: "2", skills: ["s", "t"], runs: ["hook on Stop: b"] });
  expect(c.lines).toEqual(["version 1 to 2", "adds skills: t", "will run hook on Stop: b", "no longer runs hook on Stop: a"]);
  expect(c.runsChanged).toBe(true);
  expect(changes(a, a)).toEqual({ lines: [], runsChanged: false });
});

test("a source: a folder, a git URL with a ref, owner/repo", () => {
  const dir = tree({ "x.md": "x" });
  expect(parseSource(dir, "/")).toEqual({ path: dir });
  expect(parseSource("https://example.com/r.git#v2", "/")).toEqual({ git: "https://example.com/r.git", ref: "v2" });
  expect(parseSource("file:///srv/r.git", "/")).toEqual({ git: "file:///srv/r.git" });
  expect(parseSource("owner/repo", "/")).toEqual({ git: "https://github.com/owner/repo.git" });
  expect("error" in parseSource("./nowhere-at-all", dir)).toBe(true);
});
