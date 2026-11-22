import { expect, test } from "./isolate.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

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
      // An event Keel has no moment for (it fires Notification since the hook events the other harnesses use came).
      TeammateIdle: [{ hooks: [{ type: "command", command: "notify-send hi" }] }],
    },
    statusLine: { type: "command", command: "bash ~/.claude/statusline.sh" },
    // Mapped: a prefix and an exact command; already so: a read; left out: a compound
    // command, and an edit allow the deny carves an exception from.
    permissions: { allow: [`Bash(port-${stamp} run *)`, `Bash(port-${stamp} --version)`, "Read(//srv/**)", "Bash(cat a | wc -l)", "Edit(//srv/app/**)", `mcp__p${stamp}__send`], deny: ["Edit(//srv/app/secret/**)"] },
  }));
  put("guard.sh", `#!/bin/sh\n# port-guard-${stamp}\nexit 0\n`);
  put(".claude/projects/-work/memory/MEMORY.md", "- [Note](note.md)\n");
  put(".claude/projects/-work/memory/note.md", "---\nname: note\n---\nA remembered fact.\n");
  put(`.codex/skills/codex-${stamp}/SKILL.md`, `---\nname: codex-${stamp}\ndescription: A Codex skill.\n---\nDo the Codex thing.\n`);
  put(".codex/skills/.system/imagegen/SKILL.md", "---\nname: imagegen\ndescription: Codex built-in.\n---\nx\n");
  put(".codex/config.toml", `[mcp_servers.port-${stamp}]\ncommand = "port-demo-server"\nargs = ["--stdio"]\nenabled = false\n`);
  // A repository Keel has a session in, with Claude Code's project settings: the
  // shared file (rules, a hook running a script of .claude/, an env block) and
  // the personal one. Its ask holds the user's allow of that tool there too.
  const P = join(dirname(H), `port-project-${stamp}`);
  const putP = (p: string, text: string) => { mkdirSync(dirname(join(P, p)), { recursive: true }); writeFileSync(join(P, p), text); };
  mkdirSync(join(P, ".git"), { recursive: true });
  putP(".claude/hooks/check.sh", "#!/bin/sh\nexit 0\n");
  putP(".claude/settings.json", JSON.stringify({
    env: { PROJ_FLAG: `sentinel-${stamp}` },
    permissions: { allow: [`Bash(proj-${stamp} test *)`, "Edit(/src/**)"], deny: ["Edit(/src/secret/**)"], ask: [`mcp__p${stamp}__send`] },
    hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: `bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh ${stamp}` }] }] },
  }));
  putP(".claude/settings.local.json", JSON.stringify({
    permissions: { allow: [`Bash(proj-${stamp} lint)`] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: `echo mine-${stamp}` }] }] },
  }));
  const projectSession = (await (await request.post("/api/sessions", { data: { workspace: P, title: "Port project", model: HAIKU } })).json()).session;
  const beforeP = files(join(P, ".claude"));
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
    await expect(panel.locator('[data-port-item^="hooks:Claude Code:TeammateIdle"]')).toContainText("Keel has no TeammateIdle point");
    await expect(panel.locator('[data-port-item^="hooks:Claude Code:PreToolUse"]')).toContainText("New");
    await expect(panel.locator(`[data-port-item="mcp:codex:port-${stamp}"]`)).toContainText("New");
    await expect(row("memory:claude")).toContainText("2 files in 1 project");
    await expect(row("settings:claude-statusline")).toContainText("Left out");
    const perm = (rule: string) => panel.locator('[data-port-area="permissions"]').locator("..").locator("[data-port-item]", { hasText: rule });
    await expect(perm(`Bash(port-${stamp} run *)`)).toContainText(`shell port-${stamp} run *, in every folder`);
    await expect(perm(`Bash(port-${stamp} run *)`)).toContainText("New");
    await expect(perm("Read(//srv/**)")).toContainText("Here");
    await expect(perm("Bash(cat a | wc -l)")).toContainText("Left out");
    await expect(perm("Edit(//srv/app/**)")).toContainText("also has deny or ask rules");
    await expect(perm("deny Edit(//srv/app/secret/**)")).toContainText("Left out");
    // The project's rules hold in its folder; the user's allow its ask holds stays out.
    await expect(perm(`mcp__p${stamp}__send`).first()).toContainText(`also has deny or ask rules in ${tilde(P)}`);
    await expect(perm(`Bash(proj-${stamp} test *)`)).toContainText(`shell proj-${stamp} test *, in ${tilde(P)}`);
    await expect(perm(`Bash(proj-${stamp} lint)`)).toContainText(`shell proj-${stamp} lint, in ${tilde(P)}`);
    await expect(perm(`Edit(/src/**) (${tilde(P)})`)).toContainText("also has deny or ask rules there");
    const projectHook = panel.locator('[data-port-item^="hooks:Claude Code (project):"]', { hasText: "PostToolUse" });
    await expect(projectHook).toContainText("New");
    await expect(panel.locator('[data-port-area="hooks"]').locator("..")).toContainText("a personal hook of this project");
    await expect(panel.locator('[data-port-area="settings"]').locator("..")).toContainText("PROJ_FLAG");
    await expect(panel.locator('[data-port-area="settings"]').locator("..")).not.toContainText(`sentinel-${stamp}`);
    await panel.locator('[data-port-area="permissions"]').scrollIntoViewIfNeeded();
    await shoot(page, "port-01b-permissions");
    await shoot(page, "port-01-plan");

    // The plan streams one line per area as it is read, every item under its own area.
    const lines = (await (await request.get("/api/port?stream=1&max=0")).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].parts.flat()).toEqual(expect.arrayContaining(["instructions", "permissions", "sessions"]));
    expect(lines.at(-1)).toEqual({ done: true });
    const parts = lines.filter((l) => l.part);
    expect(parts.map((l) => l.part.areas).sort()).toEqual([...lines[0].parts].sort());
    for (const l of parts) for (const i of l.part.items) expect(i.id.startsWith(`${i.area}:`)).toBe(true);

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
    const grants = (await (await request.get("/api/permissions/grants")).json()).grants.filter((g: any) => g.pattern.includes(`port-${stamp}`));
    expect(grants.map((g: any) => [g.kind, g.pattern, g.scope]).sort()).toEqual([["shell", `port-${stamp} --version`, "/"], ["shell", `port-${stamp} run *`, "/"]]);
    const projectGrants = (await (await request.get("/api/permissions/grants")).json()).grants.filter((g: any) => g.pattern.includes(`proj-${stamp}`));
    expect(projectGrants.map((g: any) => [g.kind, g.pattern, g.scope]).sort()).toEqual([["shell", `proj-${stamp} lint`, P], ["shell", `proj-${stamp} test *`, P]]);
    // The project's hook is in its .keel/hooks.json, and runs nothing until pinned (the pin covers the script).
    expect(readFileSync(join(P, ".keel/hooks.json"), "utf8")).toContain(`.claude/hooks/check.sh ${stamp}`);
    const hookSrc = (await (await request.get(`/api/hooks?cwd=${encodeURIComponent(P)}`)).json()).sources.find((x: any) => x.scope === "project");
    expect(hookSrc.active).toBe(false);
    expect(hookSrc.problems.join(" ")).toContain("not pinned");
    expect(hookSrc.covers).toContain(".claude/hooks/check.sh");
    const servers = (await (await request.get("/api/mcp/servers")).json()).servers.map((s: any) => s.name);
    expect(servers).toContain(`port-${stamp}`);

    // A second plan finds it all here and picks nothing of it.
    await page.reload();
    for (const id of ["instructions:claude", "instructions:claude-style", "plugins:demo@mkt", "skills:codex", "memory:claude"]) await expect(row(id)).toContainText("Here");
    await expect(panel.locator(`[data-port-item="mcp:codex:port-${stamp}"]`)).toContainText("Here");
    await expect(panel.locator('[data-port-item^="hooks:Claude Code:PreToolUse"]')).toContainText("Here");
    await expect(panel.locator('[data-port-item^="hooks:Claude Code (project):"]', { hasText: "PostToolUse" })).toContainText("Here");
    const again = await (await request.get("/api/port?max=0")).json();
    expect(again.items.filter((i: any) => i.area !== "sessions" && i.pick && (i.state === "new" || i.state === "update")).map((i: any) => i.id)).toEqual([]);
    await shoot(page, "port-03-again");

    // The sources were only read.
    expect(files(H)).toEqual(before);
    expect(files(join(P, ".claude"))).toEqual(beforeP);
    const errors = (await (await request.get("/api/errors")).json()).errors.slice(errorsBefore);
    expect(errors.filter((e: any) => /port/i.test(JSON.stringify(e)))).toEqual([]);
  } finally {
    for (const [p, text] of keep) text === null ? rmSync(p, { force: true }) : writeFileSync(p, text);
    await request.delete(`/api/mcp/servers/port-${stamp}`).catch(() => {});
    for (const g of (await (await request.get("/api/permissions/grants")).json()).grants) if (g.pattern.includes(`port-${stamp}`) || g.pattern.includes(`proj-${stamp}`)) await request.delete(`/api/permissions/grants/${g.id}`).catch(() => {});
    if (projectSession) await request.delete(`/api/sessions/${projectSession.id}`).catch(() => {});
    rmSync(P, { recursive: true, force: true });
    for (const p of mine) rmSync(p, { recursive: true, force: true });
  }
});
