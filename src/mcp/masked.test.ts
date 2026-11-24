// What the API shows of the owner's MCP servers: where each is, with the values that make it someone's left out
// (the file itself is the owner's alone, an agent reads it through this).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "./manager.ts";
import { maskedArgs, maskedUrl } from "./sources.ts";

const token = ["Planted", "Tok3n", "Value", "9x2q"].join("");

test("an address and arguments are shown without their secrets, and the rest as they are", () => {
  expect(maskedUrl(`https://me:${token}@host.invalid/mcp?api_key=${token}&region=eu&q=${token}${token}`)).toBe("https://me:***@host.invalid/mcp?api_key=***&region=eu&q=***");
  expect(maskedUrl("https://host.invalid/mcp?page=2")).toBe("https://host.invalid/mcp?page=2");
  expect(maskedArgs(["--api-key", token, "--port", "80", `--token=${token}`, `TOKEN=${token}`, "NODE_ENV=production", `https://u:${token}@h.invalid/x`, "serve", "--token", "${user_config.token}"]))
    .toEqual(["--api-key", "***", "--port", "80", "--token=***", "TOKEN=***", "NODE_ENV=production", "https://u:***@h.invalid/x", "serve", "--token", "${user_config.token}"]);
});

test("the list of servers carries no value of the file's: not in a target, not in an endpoint", () => {
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-masked-"));
  const m = new McpManager({ capture() {} } as any, join(d, "state"), "/", join(d, "mcp.json"));
  expect(m.add("remote", { url: `https://me:${token}@host.invalid/mcp?access_token=${token}`, enabled: false, headers: { authorization: `Bearer ${token}` } })).toBeNull();
  expect(m.add("local", { command: "srv", args: ["--api-key", token, `--secret=${token}`], env: { API_KEY: token }, enabled: false })).toBeNull();
  const shown = JSON.stringify(m.list());
  expect(shown).not.toContain(token);
  expect(m.list().map((s) => s.target)).toEqual(["srv --api-key *** --secret=***", "https://me:***@host.invalid/mcp?access_token=***"]);
  m.dispose();
});
