import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importable } from "./config.ts";

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
