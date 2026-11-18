import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import shipped from "./chrome_bridge_tools.json" with { type: "json" };
import { discoverChromeBridge, TabClaims, tabArg, tabOfResult } from "./chrome.ts";

test("a tab one session acts on is refused to another until released", () => {
  const c = new TabClaims();
  expect(c.claim(7, "a")).toBeNull();
  expect(c.claim(7, "a")).toBeNull();
  expect(c.claim(7, "b")).toContain("TAB_IN_USE");
  expect(c.claim(8, "b")).toBeNull();
  c.release(7, "b");
  expect(c.claim(7, "b")).toContain("TAB_IN_USE");
  c.releaseSession("a");
  expect(c.claim(7, "b")).toBeNull();
  expect(tabArg({ tabId: "6" })).toBe(6);
  expect(tabArg({})).toBeUndefined();
  expect(tabOfResult({ content: '{"tab":{"id":9}}' })).toBe(9);
  expect(tabOfResult({ content: "not json" })).toBeUndefined();
});

test("the shipped list names the tools that act", () => {
  const names = new Set(shipped.tools.map((t) => t.name));
  for (const t of ["chrome_click", "chrome_type", "chrome_navigate", "chrome_new_tab", "chrome_close_tab"]) expect(shipped.mutating).toContain(t);
  for (const t of ["chrome_tabs", "chrome_snapshot", "chrome_find"]) expect(shipped.mutating).not.toContain(t);
  expect(shipped.mutating.every((t) => names.has(t))).toBe(true);
});

test("the bridge is found from its setup copy, its native host, or the variable; node from nvm", () => {
  const home = mkdtempSync(join(tmpdir(), "keel-chrome-"));
  const none = () => undefined;
  expect("error" in discoverChromeBridge(home, none)).toBe(true);
  const bin = join(home, "src/bridge/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "mcp-server.js"), "");
  const hosts = join(home, ".config/google-chrome/NativeMessagingHosts");
  mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, "dev.agent_chrome_bridge.json"), JSON.stringify({ path: join(bin, "native-host.js") }));
  for (const v of ["v9.1.0", "v26.12.0", "v26.10.0"]) {
    mkdirSync(join(home, ".nvm/versions/node", v, "bin"), { recursive: true });
    writeFileSync(join(home, ".nvm/versions/node", v, "bin/node"), "");
  }
  expect(discoverChromeBridge(home, none)).toEqual({ entry: join(bin, "mcp-server.js"), node: join(home, ".nvm/versions/node/v26.12.0/bin/node") });
  const app = join(home, ".local/share/agent-chrome-bridge/app/bin");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "mcp-server.js"), "");
  expect((discoverChromeBridge(home, none) as any).entry).toBe(join(app, "mcp-server.js"));
  const env = (k: string) => (k === "KEEL_CHROME_BRIDGE" ? bin : undefined);
  expect((discoverChromeBridge(home, env) as any).entry).toBe(join(bin, "mcp-server.js"));
});
