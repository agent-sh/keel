// A plugin's server runs with the owner's settings filled in; a sensitive one
// is never shown in the server list nor written to the state folder.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canon } from "./config.ts";
import { McpManager } from "./manager.ts";
import { shownValues, substitute } from "../plugins/options.ts";

const errors = { capture() {} } as any;
const SECRET = "tok-sensitive-4711";
const specs = { token: { type: "string", title: "Token", description: "d", sensitive: true }, region: { type: "string", title: "Region", description: "d" } } as any;
const text = { token: SECRET, region: "eu" };
const written = { url: "https://api.example.test/${user_config.region}/mcp?key=${user_config.token}", enabled: false };
const local = { command: "srv", args: ["--region", "${user_config.region}", "--token", "${user_config.token}"], enabled: false };

test("a plugin server's sensitive setting is not in the server list and not in the published instructions", () => {
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-plugin-shown-"));
  const state = join(d, "state");
  const m = new McpManager(errors, state, "/", join(d, "mcp.json"));
  m.setPluginServers("kit", [
    { name: "web", label: "kit-web", config: substitute(written, text), shown: substitute(written, shownValues(specs, text)) },
    { name: "local", label: "kit-local", config: substitute(local, text), shown: substitute(local, shownValues(specs, text)) },
  ]);
  const listed = m.list().filter((s) => s.plugin === "kit");
  expect(listed.map((s) => [s.name, s.target, s.endpoint])).toEqual([
    ["kit-local", "srv --region eu --token ${user_config.token}", "srv --region eu --token ${user_config.token}"],
    ["kit-web", "https://api.example.test/eu/mcp?key=${user_config.token}", "https://api.example.test/eu/mcp?key=${user_config.token}"],
  ]);
  expect(JSON.stringify(listed)).not.toContain(SECRET);

  // What it publishes is kept under a digest of its config, not the config.
  const e = (m as any).entries.get("kit-web");
  expect(e.config.url).toContain(SECRET); // what runs has the value
  (m as any).publish(e, "Use the web tools.");
  const file = join(state, "mcp-instructions.json");
  expect(readFileSync(file, "utf8")).not.toContain(SECRET);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect((m as any).lastPublished(e)).toEqual({ instructions: "Use the web tools." });
  m.dispose();

  // A new manager reads it back under the same key.
  const again = new McpManager(errors, state, "/", join(d, "mcp.json"));
  again.setPluginServers("kit", [{ name: "web", label: "kit-web", config: substitute(written, text) }]);
  expect((again as any).lastPublished((again as any).entries.get("kit-web"))).toEqual({ instructions: "Use the web tools." });
  again.dispose();
});

test("a file of published instructions an older build kept with whole configs as keys is rewritten with digests", () => {
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-plugin-old-"));
  const state = join(d, "state");
  mkdirSync(state, { recursive: true });
  const config = substitute(written, text);
  const file = join(state, "mcp-instructions.json");
  writeFileSync(file, JSON.stringify({ "kit-web": { key: canon({ ...config, enabled: undefined }), instructions: "Kept." } }));
  const m = new McpManager(errors, state, "/", join(d, "mcp.json"));
  expect(readFileSync(file, "utf8")).not.toContain(SECRET);
  m.setPluginServers("kit", [{ name: "web", label: "kit-web", config }]);
  expect((m as any).lastPublished((m as any).entries.get("kit-web"))).toEqual({ instructions: "Kept." });
  m.dispose();
});
