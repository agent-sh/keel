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

test("a password in an option's address, a header's credential and a token in an address's path or fragment are hidden; a place named like a secret is not", () => {
  expect(maskedArgs([`--db=postgres://user:${token}@db.invalid/app`, "--header", `Authorization: Bearer ${token}`, "-H", "Content-Type: application/json", `X-Api-Key: ${token}`, "serve"]))
    .toEqual(["--db=postgres://user:***@db.invalid/app", "--header", "Authorization: ***", "-H", "Content-Type: application/json", "X-Api-Key: ***", "serve"]);
  expect(maskedUrl(`https://host.invalid/hook/${token}/run`)).toBe("https://host.invalid/hook/***/run");
  expect(maskedUrl(`https://host.invalid/bot12345:${token}/send`)).toBe("https://host.invalid/***/send");
  expect(maskedUrl(`https://host.invalid/v1/token/${token.slice(0, 9)}`)).toBe("https://host.invalid/v1/token/***");
  expect(maskedUrl(`https://host.invalid/cb#access_token=${token}&state=ok`)).toBe("https://host.invalid/cb#access_token=***&state=ok");
  expect(maskedUrl(`https://host.invalid/cb#${token}`)).toBe("https://host.invalid/cb#***");
  // A path or a file's name is not a token, whatever the option is called.
  const places = ["--config=configs/server-v2.production.json", "--session-dir", "/home/u/.local/state/sessions-2024-11", "--password-file", "/etc/secrets/db-password.txt", "--keyfile=./keys/server.key", "--token-file", "~/.config/tokens/main.txt"];
  expect(maskedArgs(places)).toEqual(places);
  expect(maskedUrl("https://host.invalid/mcp/server-v2.production.json?page=2#top")).toBe("https://host.invalid/mcp/server-v2.production.json?page=2#top");
});
