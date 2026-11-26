// INT-S59: Keel read no Codex plugin. Port lists the ones turned on in Codex's config.toml and carries a picked one's
// skills by reference (<plugin>:<skill>, from Codex's plugin cache), as it does a Claude Code plugin's.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { configDir } from "../providers/config.ts";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../test/env.ts";

const home = tempTree("keel-port-codex-");
ownEnv({ KEEL_IMPORT_HOME: home, CODEX_HOME: join(home, ".codex") });

// The config folder is the run's: its skills.json is put back as it was when the file ends.
const skillsFile = join(configDir(), "skills.json");
const kept = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
const before = [skillsFile, `${skillsFile}.prev`].map((f) => [f, kept(f)] as const);
afterAll(() => { for (const [f, text] of before) { if (text === null) rmSync(f, { force: true }); else writeFileSync(f, text); } });

const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const cache = join(home, ".codex", "plugins", "cache");
put(join(cache, "m", "docs", "1.0.0", "skills", "write", "SKILL.md"), "---\nname: write\ndescription: Write DOCX files.\n---\nWrite.");
put(join(cache, "m", "biz", "2.0.0", "skills", "sell", "SKILL.md"), "---\nname: sell\ndescription: Sell.\n---\nSell.");
put(join(cache, "m", "conn", "0.1.0", ".app.json"), "{}");
put(join(cache, "m", "both", "0.1.0", "skills", "x", "SKILL.md"), "---\nname: x\ndescription: x\n---\nx");
put(join(home, ".codex", "config.toml"), [
  '[plugins."docs@m"]', "enabled = true", '[plugins."biz@m"]', "enabled = true", '[plugins."conn@m"]', "enabled = true",
  '[plugins."both@m"]', "enabled = true", '[plugins."off@m"]', "enabled = false", '[plugins."gone@m"]', "enabled = true",
].join("\n"));
put(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "biz@synced": false, "both@other": true } }));

test("port lists the Codex plugins turned on and carries a picked one's skills", async () => {
  const port = await import("./port.ts");
  const { discoverSkills } = await import("../tools/skills.ts");
  const deps = { workspace: home } as any;
  const items = await port.planParts(deps, { only: ["plugins"] });
  const of = (id: string) => items.find((i) => i.id === `plugins:codex:${id}`);
  expect(of("docs@m")).toMatchObject({ state: "new", pick: true, detail: "1 skill" });
  expect(of("biz@m")).toMatchObject({ state: "new", pick: false, reason: "turned off in Claude Code under the same name" });
  expect(of("conn@m")).toMatchObject({ state: "skip", reason: "nothing Keel can run: its app connectors are Codex's own" });
  expect(of("both@m")).toMatchObject({ state: "skip", reason: "Claude Code has it turned on too: Keel carries that one" });
  expect(of("gone@m")).toMatchObject({ state: "skip", reason: "turned on but not in Codex's plugin cache" });
  expect(of("off@m")).toBeUndefined();
  expect(discoverSkills(home).some((s) => s.name === "docs:write")).toBe(false);
  const done = await port.apply(deps, { ids: ["plugins:codex:docs@m"] });
  expect(done.items.find((i) => i.id === "plugins:codex:docs@m")).toMatchObject({ ok: true });
  expect(discoverSkills(home).find((s) => s.name === "docs:write")?.file).toBe(join(cache, "m", "docs", "1.0.0", "skills", "write", "SKILL.md"));
  expect((await port.planParts(deps, { only: ["plugins"] })).find((i) => i.id === "plugins:codex:docs@m")).toMatchObject({ state: "done", pick: false });
});
