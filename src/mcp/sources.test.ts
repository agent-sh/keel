import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importable } from "./config.ts";
import { readSources } from "./sources.ts";

// Two configs are one server only when the endpoint (scheme and host in any
// case, path and query exact) and the account (env, headers) both match.
test("an imported server is already configured only when endpoint and account match", () => {
  const dir = join(process.env.TMPDIR ?? join(process.env.HOME!, ".cache"), `mcp-identity-${Date.now()}`);
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "project"), { recursive: true });
  // The other agents' home is this test's folder, and the run's own again when the test is over.
  const homeBefore = process.env.KEEL_IMPORT_HOME;
  process.env.KEEL_IMPORT_HOME = join(dir, "home");
  try {
  const url = "https://example.invalid/MCP/Lookup", stdio = { command: "node", args: ["fixture-server.js"] };
  const cases: [string, object, object, boolean][] = [
    ["same URL", { url }, { url }, true],
    ["host case and default port only", { url }, { url: "HTTPS://EXAMPLE.invalid:443/MCP/Lookup" }, true],
    ["path case differs", { url }, { url: "https://example.invalid/mcp/lookup" }, false],
    ["query case differs", { url: `${url}?resource=AbC` }, { url: `${url}?resource=abc` }, false],
    ["path slash differs", { url }, { url: `${url}/` }, false],
    ["query slash differs", { url: `${url}?resource=AbC` }, { url: `${url}?resource=AbC/` }, false],
    ["same stdio account", { ...stdio, env: { FIXTURE_ACCOUNT: "A" } }, { ...stdio, env: { FIXTURE_ACCOUNT: "A" } }, true],
    ["different stdio account", { ...stdio, env: { FIXTURE_ACCOUNT: "A" } }, { ...stdio, env: { FIXTURE_ACCOUNT: "B" } }, false],
    ["same HTTP auth", { url, headers: { Authorization: "Bearer synthetic-A" } }, { url, headers: { authorization: "Bearer synthetic-A" } }, true],
    ["different HTTP auth", { url, headers: { Authorization: "Bearer synthetic-A" } }, { url, headers: { Authorization: "Bearer synthetic-B" } }, false],
  ];
  for (const [name, existing, incoming, same] of cases) {
    writeFileSync(join(dir, "home", ".claude.json"), JSON.stringify({ mcpServers: { incoming } }));
    const item = importable(join(dir, "project"), { existing } as any).find((x) => x.name === "incoming")!;
    expect({ name, configured: item.configured }).toEqual({ name, configured: same });
    // Another account at the same endpoint says which Keel server it shares it with; the values never show.
    if (name.startsWith("different")) expect(item.other_account).toBe("existing");
    expect(JSON.stringify({ group: item.group, endpoint: item.endpoint })).not.toMatch(/synthetic|FIXTURE_ACCOUNT/);
  }
  } finally {
    if (homeBefore === undefined) delete process.env.KEEL_IMPORT_HOME; else process.env.KEEL_IMPORT_HOME = homeBefore;
  }
});

// A plugin whose mcpServers names a bundle (a zip) has no servers here, said once; a plugin that
// fails names its own file and its own source, and the plugins after it are still read.
test("a plugin's bundle is no servers and one plugin's failure is its own", () => {
  const dir = join(process.env.TMPDIR ?? join(process.env.HOME!, ".cache"), `mcp-plugin-bundle-${Date.now()}`);
  const plugin = (name: string, manifest: object, files: Record<string, string> = {}) => {
    const root = join(dir, "plugins", name);
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
    for (const [f, text] of Object.entries(files)) writeFileSync(join(root, f), text);
    return root;
  };
  const bundled = plugin("bundled", { mcpServers: "./dist/x.mcpb" }, { "dist/x.mcpb": "PK\u0003\u0004 not json" });
  const sniffed = plugin("sniffed", { mcpServers: "./dist/y.bin" }, { "dist/y.bin": "PK\u0003\u0004 not json" });
  const broken = plugin("broken", { mcpServers: "./servers.json" }, { "servers.json": "{ nope" });
  const good = plugin("good", { mcpServers: { s: { command: "node", args: ["s.js"] } } });
  mkdirSync(join(dir, "home", ".claude", "plugins"), { recursive: true });
  const ids = ["bundled@m", "sniffed@m", "broken@m", "good@m"];
  const roots = [bundled, sniffed, broken, good];
  writeFileSync(join(dir, "home", ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: Object.fromEntries(ids.map((id, i) => [id, [{ installPath: roots[i] }]])) }));
  writeFileSync(join(dir, "home", ".claude", "settings.json"), JSON.stringify({ enabledPlugins: Object.fromEntries(ids.map((id) => [id, true])) }));
  mkdirSync(join(dir, "project"), { recursive: true });
  const before = process.env.KEEL_IMPORT_HOME;
  process.env.KEEL_IMPORT_HOME = join(dir, "home");
  try {
    const failed: { file: string; error: string; source?: string }[] = [], notes: string[] = [];
    const src = readSources(join(dir, "project"), failed, notes);
    expect(src.map((s) => s.name)).toEqual(["s"]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.file).toBe(join(broken, "servers.json"));
    expect(failed[0]!.source).toBe("claude:plugin:broken@m");
    expect(notes).toHaveLength(2);
    // The second sync says nothing of the bundles again.
    const again: string[] = [];
    readSources(join(dir, "project"), [], again);
    expect(again).toEqual([]);
  } finally {
    if (before === undefined) delete process.env.KEEL_IMPORT_HOME; else process.env.KEEL_IMPORT_HOME = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
