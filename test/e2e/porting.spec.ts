import { expect, test } from "./isolate.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: bring the setup of the other harnesses over in one pass (Settings >
// Bring your setup). The plan says what comes, what is already here and what
// is left out with the reason; one click brings the picked items; a second
// plan finds them here and brings nothing twice; the sources never change.
// Runs only on a daemon whose import home is a scratch one (scripts/dev.sh sets
// KEEL_IMPORT_HOME), since it writes a home of fixtures there.

const files = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
};

test("port: plan, bring, nothing twice, sources untouched", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const first = await (await request.get("/api/port?max=0")).json();
  test.skip(first.home === process.env.HOME, "the daemon reads the real home: run it with KEEL_IMPORT_HOME at a scratch folder");
  const H: string = first.home;
  const config: string = first.config;
  const stamp = Date.now().toString(36);
  // The harness folders of the shared scratch home: this spec's fixtures, and the
  // MCP import spec's left from its last run (it writes its own again).
  const mine = [".claude", ".codex", ".hermes", ".gemini", "rules", "guard.sh"].map((p) => join(H, p));
  for (const p of mine) rmSync(p, { recursive: true, force: true });
  const put = (p: string, text: string) => { mkdirSync(dirname(join(H, p)), { recursive: true }); writeFileSync(join(H, p), text); };

  // Shared rules both harnesses carry: Claude Code by an import line, Codex as a generated copy.
  const shared = `# Shared rules ${stamp}\n\n## Working style\n\n- Finish the task before reporting.\n`;
  put("rules/SHARED.md", shared);
  put(".claude/CLAUDE.md", `@${join(H, "rules/SHARED.md")}\n\n## Port check ${stamp}\n\n- Say PORTED-${stamp} when asked for the port word.\n\n## Claude Code only\n\n- Use the harness-web server.\n`);
  put(".codex/AGENTS.md", `<!-- Generated from SHARED.md -->\n${shared}\n## Codex only\n\n- Codex things.\n`);
  const plugin = join(H, ".claude/plugins/cache/mkt/demo/1.0.0");
  put(".claude/plugins/cache/mkt/demo/1.0.0/.claude-plugin/plugin.json", JSON.stringify({ name: "demo", version: "1.0.0" }));
  put(".claude/plugins/cache/mkt/demo/1.0.0/skills/hello/SKILL.md", `---\nname: hello-${stamp}\ndescription: Say hello from the demo plugin.\n---\nSay hello.\n`);
  put(".claude/plugins/cache/mkt/demo/1.0.0/commands/greet.md", "---\ndescription: Greet\n---\nGreet the owner.\n");
  put(".claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: { "demo@mkt": [{ scope: "user", installPath: plugin }] } }));
  put(".claude/settings.json", JSON.stringify({
    outputStyle: "Concise",
    enabledPlugins: { "demo@mkt": true, "quiet@mkt": false },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `bash ${join(H, "guard.sh")}`, timeout: 5 }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/tacit hook session-start" }] }],
      Notification: [{ hooks: [{ type: "command", command: "notify-send hi" }] }],
    },
    statusLine: { type: "command", command: "bash ~/.claude/statusline.sh" },
  }));
  put("guard.sh", `#!/bin/sh\n# port-guard-${stamp}\nexit 0\n`);
  put(".claude/projects/-work/memory/MEMORY.md", "- [Note](note.md)\n");
  put(".claude/projects/-work/memory/note.md", "---\nname: note\n---\nA remembered fact.\n");
  put(`.codex/skills/codex-${stamp}/SKILL.md`, `---\nname: codex-${stamp}\ndescription: A Codex skill.\n---\nDo the Codex thing.\n`);
  put(".codex/skills/.system/imagegen/SKILL.md", "---\nname: imagegen\ndescription: Codex built-in.\n---\nx\n");
  put(".codex/config.toml", `[mcp_servers.port-${stamp}]\ncommand = "port-demo-server"\nargs = ["--stdio"]\nenabled = false\n`);
  const before = files(H);
  const tilde = (p: string) => p.replace(process.env.HOME!, "~"); // how an import line names a file of the home

  // Keel's own files the run writes: kept and put back afterwards.
  const keep = ["AGENTS.md", "skills.json", "hooks.json"].map((n) => join(config, n)).map((p) => [p, existsSync(p) ? readFileSync(p, "utf8") : null] as const);
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto("/settings/port");
    const panel = page.getByTestId("port");
    const row = (id: string) => panel.locator(`[data-port-item="${id}"]`);
    await expect(row("instructions:claude")).toContainText("New");
    await expect(row("instructions:claude")).toContainText(tilde(join(H, "rules/SHARED.md")));
    await expect(row("instructions:claude")).toContainText("Claude Code only");
    await expect(row("instructions:codex")).toContainText("Left out");
    await expect(row("instructions:claude-style")).toContainText("Concise");
    await expect(row("plugins:demo@mkt")).toContainText("1 skill, 1 command");
    await expect(row("plugins:off")).toContainText("quiet@mkt");
    await expect(row("skills:codex")).toContainText("New");
    await expect(row("skills:codex-system")).toContainText("Codex's built-in skills");
    await expect(panel.locator('[data-port-item^="hooks:Claude Code:SessionStart"]')).toContainText("Keel runs tacit's hooks itself");
    await expect(panel.locator('[data-port-item^="hooks:Claude Code:Notification"]')).toContainText("Keel has no Notification point");
    await expect(panel.locator('[data-port-item^="hooks:Claude Code:PreToolUse"]')).toContainText("New");
    await expect(panel.locator(`[data-port-item="mcp:codex:port-${stamp}"]`)).toContainText("New");
    await expect(row("memory:claude")).toContainText("2 files in 1 project");
    await expect(row("settings:claude-statusline")).toContainText("Left out");
    await shoot(page, "port-01-plan");

    // Sessions are their own spec's; this one brings everything else it picks.
    for (const box of await panel.locator('[data-port-source] input[type="checkbox"]').all()) if (await box.isChecked()) await box.uncheck();
    await panel.getByRole("button", { name: /^Bring \d+ over$/ }).click();
    await expect(panel.locator("[data-port-summary]")).toContainText("brought", { timeout: 60_000 });
    await expect(panel.locator("[data-port-error]")).toHaveCount(0);
    await expect(row("memory:claude").locator("[data-port-result]")).toContainText("import claude: written 2");
    await shoot(page, "port-02-brought");

    // What came is in Keel: the instructions, the plugin's and Codex's skills, the hook, the server.
    const agents = readFileSync(join(config, "AGENTS.md"), "utf8");
    expect(agents).toContain(`@${tilde(join(H, "rules/SHARED.md"))}`);
    expect(agents).toContain(`PORTED-${stamp}`);
    expect(agents).not.toContain("harness-web");
    expect(agents).toContain("Lead every response with what happened");
    const skills = (await (await request.get(`/api/skills?cwd=${encodeURIComponent(H)}`)).json()).skills.map((s: any) => s.name);
    expect(skills).toEqual(expect.arrayContaining([`demo:hello-${stamp}`, "demo:greet", `codex-${stamp}`]));
    expect(skills).not.toContain("imagegen");
    expect(readFileSync(join(config, "hooks.json"), "utf8")).toContain(join(H, "guard.sh"));
    const servers = (await (await request.get("/api/mcp/servers")).json()).servers.map((s: any) => s.name);
    expect(servers).toContain(`port-${stamp}`);

    // A second plan finds it all here and picks nothing of it.
    await page.reload();
    for (const id of ["instructions:claude", "instructions:claude-style", "plugins:demo@mkt", "skills:codex", "memory:claude"]) await expect(row(id)).toContainText("Here");
    await expect(panel.locator(`[data-port-item="mcp:codex:port-${stamp}"]`)).toContainText("Here");
    await expect(panel.locator('[data-port-item^="hooks:Claude Code:PreToolUse"]')).toContainText("Here");
    const again = await (await request.get("/api/port?max=0")).json();
    expect(again.items.filter((i: any) => i.area !== "sessions" && i.pick && (i.state === "new" || i.state === "update")).map((i: any) => i.id)).toEqual([]);
    await shoot(page, "port-03-again");

    // The sources were only read.
    expect(files(H)).toEqual(before);
    const errors = (await (await request.get("/api/errors")).json()).errors.slice(errorsBefore);
    expect(errors.filter((e: any) => /port/i.test(JSON.stringify(e)))).toEqual([]);
  } finally {
    for (const [p, text] of keep) text === null ? rmSync(p, { force: true }) : writeFileSync(p, text);
    await request.delete(`/api/mcp/servers/port-${stamp}`).catch(() => {});
    for (const p of mine) rmSync(p, { recursive: true, force: true });
  }
});
