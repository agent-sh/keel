import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginDir } from "./skills.ts";

// Claude Code's plugin list that does not parse for a while (a write under way, other bytes put there)
// keeps the carried plugin where it was; a list that is gone means the plugin is no longer installed.
test("a carried plugin keeps its folder while the plugin list does not parse", () => {
  const claude = mkdtempSync(join(process.env.TMPDIR ?? ".", "plugin-list-"));
  try {
    const dir = join(claude, "plugins", "cache", "learn");
    mkdirSync(dir, { recursive: true });
    const list = join(claude, "plugins", "installed_plugins.json");
    writeFileSync(list, JSON.stringify({ version: 2, plugins: { "learn@market": [{ scope: "user", installPath: dir }] } }));
    const ref = { id: "learn@market", claude };
    expect(pluginDir(ref)).toEqual({ name: "learn", dir });
    writeFileSync(list, "PK\u0003\u0004 not a list");
    expect(pluginDir(ref)).toEqual({ name: "learn", dir });
    rmSync(list);
    expect(pluginDir(ref)).toBeNull();
    writeFileSync(list, "{");
    expect(pluginDir(ref)).toBeNull();
  } finally {
    rmSync(claude, { recursive: true, force: true });
  }
});
