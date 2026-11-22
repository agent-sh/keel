import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changes, consentKey, entrySource, fill, nameProblem, parseMarketplace, readPlugin, resolveNames, runLine, runsOf, versionProblem } from "./manifest.ts";
import { dropLinksOut, parseSource } from "./fetch.ts";
import { existsSync, symlinkSync } from "node:fs";

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

test("every part of a server or a hook that decides what runs or what it gets is its own consent line", () => {
  const server = { url: "https://api.example/mcp", headers: { "X-Key": "${API_KEY}" }, headers_helper: "sh ./h.sh", headers_env: { Authorization: "TOK" }, bearer_env: "BEARER" };
  const local = { command: "node", args: ["s.js"], cwd: "/srv", env: { NODE_OPTIONS: "--require x" }, env_vars: ["SECRET"] };
  const hooks = { Stop: [{ hooks: [{ type: "http", url: "https://sink.example/h", headers: { A: "$TOKEN" }, allowedEnvVars: ["TOKEN"] }] }] };
  const lines = runsOf(hooks, { remote: server, local }).map(runLine);
  expect(lines).toEqual([
    "hook on Stop: sends each event to https://sink.example/h",
    "hook on Stop: with the header A: $TOKEN",
    "hook on Stop: with TOKEN from Keel's environment",
    "MCP server remote: connects to https://api.example/mcp",
    "MCP server remote: sends the header X-Key: ${API_KEY}",
    "MCP server remote: sends the header Authorization from TOK in Keel's environment",
    "MCP server remote: sends BEARER from Keel's environment as its bearer token",
    "MCP server remote: runs sh ./h.sh at each connect",
    "MCP server local: node s.js",
    "MCP server local: starts in /srv",
    "MCP server local: sets NODE_OPTIONS=--require x",
    "MCP server local: gets SECRET from Keel's environment",
  ]);
  // An update that changes only a variable or the helper changes what was agreed to.
  const before = { version: "1", skills: [], commands: [], agents: [], mcp: ["local"], runs: lines, notTaken: [] };
  const env2 = runsOf(hooks, { remote: server, local: { ...local, env: { NODE_OPTIONS: "--require y" } } }).map(runLine);
  expect(changes(before, { ...before, runs: env2 }).runsChanged).toBe(true);
  const helper2 = runsOf(hooks, { remote: { ...server, headers_helper: "sh ./other.sh" }, local }).map(runLine);
  expect(changes(before, { ...before, runs: helper2 }).runsChanged).toBe(true);
});

test("a version and a name never name a folder that is not the plugin's own", () => {
  for (const v of [".", "..", "a/../../b", ".hidden", ""]) expect(versionProblem(v)).not.toBeNull();
  expect(versionProblem("1.2.0-rc.1+abc")).toBeNull();
  expect(nameProblem(".staging")).not.toBeNull();
  const root = tree({ ".claude-plugin/plugin.json": JSON.stringify({ name: "v", version: ".." }) });
  expect(readPlugin(root).problems.some((m) => m.includes("not a version"))).toBe(true);
});

test("a fetched tree keeps no link that leads out of it", async () => {
  const outside = tree({ "secret.txt": "s" });
  const root = tree({ "skills/ok/SKILL.md": "---\nname: ok\n---\n", "skills/ok/notes.md": "n" });
  mkdirSync(join(root, "skills/leak"), { recursive: true });
  symlinkSync(join(outside, "secret.txt"), join(root, "skills/leak/SKILL.md"));
  symlinkSync(outside, join(root, "out"));
  symlinkSync("notes.md", join(root, "skills/ok/inner.md"));
  symlinkSync(join(root, "gone"), join(root, "dangling"));
  expect((await dropLinksOut(root)).sort()).toEqual(["dangling", "out", "skills/leak/SKILL.md"]);
  expect(existsSync(join(root, "skills/ok/inner.md"))).toBe(true);
  expect(existsSync(join(outside, "secret.txt"))).toBe(true);
});
