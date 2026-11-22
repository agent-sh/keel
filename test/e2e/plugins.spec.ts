import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: a plugin installs as one unit. A plugin in the Claude Code format
// (a skill, a command, an agent, a hook and an MCP server, with a part Keel
// does not take) is read from a local git repository and says what it runs;
// nothing of it runs before the owner's yes. Installed, each part works;
// turned off, all of it stops; an update says what changes first and asks
// again for what it runs; a plugin a repository names is offered, from a
// marketplace folder, and installed only with a yes; removed, all of it goes
// and the owner's own config is byte for byte as it was.
const ECHO = join(import.meta.dirname, "fixtures/echo-mcp.ts");
const put = (root: string, files: Record<string, string>) => {
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
// Every file of the config folder but the plugins' own (their record and their folders).
const snapshot = (dir: string) => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n), rel = relative(dir, p);
      if (rel === "plugins" || rel.startsWith("plugins.json")) continue;
      if (statSync(p).isDirectory()) walk(p); else out[rel] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
};

test("plugins: install as one unit, each part works, off, update, offered, removed", async ({ page, request }) => {
  test.setTimeout(240_000);
  const first = await (await request.get("/api/plugins/installed")).json();
  const config = dirname(first.registry);
  test.skip(!config.includes("keel-work") && !config.includes("/dev-"), "needs a scratch config folder: this test writes the owner's skills and MCP servers there");
  const base = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `plugins-${Date.now()}`);
  const repo = join(base, "kit-repo"), ws = join(base, "ws"), market = join(base, "market");

  // The plugin, in a git repository: Claude Code's layout, its hook and server naming ${CLAUDE_PLUGIN_ROOT}.
  const hooks = (word: string) => JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf 'plugin-hook-said-${word}'; date >> "\${CLAUDE_PLUGIN_DATA}/fired"` }] }] } }, null, 1);
  put(repo, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "e2e-kit", version: "1.0.0", description: "A kit for the plugin e2e" }),
    "skills/greet/SKILL.md": "---\nname: greet\ndescription: Greet the owner with the word KIT-GREET.\n---\nReply with KIT-GREET.\n",
    "commands/stamp.md": "---\ndescription: Stamp a word\n---\nReply with STAMP-$ARGUMENTS.\n",
    "agents/checker.md": "---\nname: checker\ndescription: Checks the work of the plugin e2e.\n---\nYou check things.\n",
    "hooks/hooks.json": hooks("PINEAPPLE"),
    ".mcp.json": JSON.stringify({ mcpServers: { echo: { command: "bun", args: ["${CLAUDE_PLUGIN_ROOT}/server.ts"], env: { E2E_MODE: "plain" } } } }),
    "output-styles/terse.md": "---\nname: terse\n---\nBe terse.\n",
  });
  copyFileSync(ECHO, join(repo, "server.ts"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  // A marketplace in a folder, and a repository whose settings name one of its plugins.
  put(market, {
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "e2e-market", owner: { name: "e2e" }, plugins: [{ name: "local-kit", source: "./local-kit", description: "A plugin with one skill" }] }),
    "local-kit/skills/greet/SKILL.md": "---\nname: greet\ndescription: The local kit's greeting.\n---\nReply with LOCAL-GREET.\n",
  });
  put(ws, { ".claude/settings.json": JSON.stringify({ extraKnownMarketplaces: { "e2e-market": { source: { source: "directory", path: market } } }, enabledPlugins: { "local-kit@e2e-market": true } }) });
  mkdirSync(join(ws, ".git"), { recursive: true });

  // The owner's own: a skill and an MCP server with the names the plugin also uses.
  put(config, { "skills/greet/SKILL.md": "---\nname: greet\ndescription: The owner's own greeting.\n---\nHello.\n" });
  expect((await request.post("/api/mcp/servers", { data: { name: "echo", command: "bun", args: [ECHO] } })).ok()).toBe(true);
  const before = snapshot(config);

  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  const servers = async () => (await (await request.get("/api/mcp/servers")).json()).servers as any[];
  const skills = async () => ((await (await request.get(`/api/skills?cwd=${encodeURIComponent(ws)}`)).json()).skills as any[]).map((s) => s.name);
  const agents = async () => ((await (await request.get(`/api/agents/files?cwd=${encodeURIComponent(ws)}`)).json()).agents as any[]).map((a) => a.name);
  const notes = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).filter((e) => e.kind === "note" && JSON.stringify(e.data).includes("plugin-hook-said")).map((e) => JSON.stringify(e.data));
  const say = async (n: number) => {
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(`script:say ok ${n}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 60_000 });
  };

  // Two hooks that run the same line are two rows, and the yes says what of
  // Keel's environment its programs get. Read only, then let go.
  const twin = join(base, "twin");
  const twice = { hooks: [{ type: "command", command: "printf twin" }] };
  put(twin, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "e2e-twin", version: "1.0.0" }),
    "hooks/hooks.json": JSON.stringify({ hooks: { Stop: [twice, twice] } }),
    ".mcp.json": JSON.stringify({ mcpServers: { twin: { command: "bun", args: ["${CLAUDE_PLUGIN_ROOT}/server.ts"] } } }),
  });
  copyFileSync(ECHO, join(twin, "server.ts"));
  const keyWarnings: string[] = [];
  page.on("console", (m) => { if (/same key|unique "key"/i.test(m.text())) keyWarnings.push(m.text()); });
  await page.goto("/settings/plugins");
  await page.getByTestId("toolkit-add-+install").click();
  await page.getByTestId("install-source").fill(twin);
  await page.getByTestId("install-read").click();
  const plan = page.getByTestId("plugin-plan");
  await expect(plan).toHaveAttribute("data-id", "e2e-twin");
  await expect(plan.getByTestId("plan-run").filter({ hasText: "hook on Stop: printf twin" })).toHaveCount(2);
  await expect(plan.getByTestId("plan-env")).toHaveText("A command hook gets Keel's environment; a server started as a program gets it without the names that look like credentials or a provider's or Keel's settings.");
  expect(keyWarnings).toEqual([]);
  await plan.getByTestId("plan-cancel").click();
  await expect(plan).toHaveCount(0);

  // Read it: what it brings, what it does not take, its names, and each line it runs. Nothing runs yet.
  await page.goto("/settings/plugins");
  await page.getByTestId("toolkit-add-+install").click();
  await page.getByTestId("install-source").fill(`file://${repo}`);
  await page.getByTestId("install-read").click();
  await expect(plan).toHaveAttribute("data-id", "e2e-kit");
  await expect(plan.getByTestId("plan-run")).toHaveCount(3);
  await expect(plan.getByTestId("plan-runs")).toContainText("hook on UserPromptSubmit: printf 'plugin-hook-said-PINEAPPLE'");
  // Each line as it will run: the plugin's folder filled in, and every variable it sets its own line.
  await expect(plan.getByTestId("plan-runs")).toContainText(/MCP server e2e-kit-echo: bun \S+\/plugins\/e2e-kit\/versions\/1\.0\.0\/server\.ts/);
  await expect(plan.getByTestId("plan-runs")).toContainText("MCP server e2e-kit-echo: sets E2E_MODE=plain");
  await expect(page.getByTestId("plan-fetched")).toContainText("cloned from file://");
  await expect(plan.getByTestId("plan-not-taken")).toContainText("output-styles/");
  await expect(plan.getByTestId("plan-notes")).toContainText("The skill greet is also yours");
  await expect(plan.getByTestId("plan-notes")).toContainText("this plugin's is e2e-kit-echo, and yours is left as it is");
  await expect(plan.getByTestId("plan-install")).toContainText("Install and let it run these 3");
  expect((await servers()).some((s) => s.plugin)).toBe(false);
  expect((await skills()).some((n) => n.startsWith("e2e-kit:"))).toBe(false);
  await shoot(page, "plugins-01-consent");

  // Installed: every part at once.
  await plan.getByTestId("plan-install").click();
  const reader = page.getByTestId("unit-reader");
  await expect(reader).toHaveAttribute("data-id", "e2e-kit");
  await expect(reader.locator('[data-testid="unit-mcp"][data-name="e2e-kit-echo"]')).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await shoot(page, "plugins-02-installed");
  const unit = (await (await request.get("/api/plugins/installed/e2e-kit")).json()).plugin;
  expect(await skills()).toEqual(expect.arrayContaining(["e2e-kit:greet", "e2e-kit:stamp", "greet"]));
  expect(await agents()).toContain("e2e-kit:checker");
  const echo = (await servers()).find((s) => s.name === "e2e-kit-echo");
  expect(echo).toMatchObject({ plugin: "e2e-kit", state: "ready" });
  expect(echo.tool_names).toContain("echo");
  expect((await servers()).find((s) => s.name === "echo")?.plugin).toBeUndefined(); // the owner's own, untouched
  await say(1);
  await expect.poll(notes).toHaveLength(1);
  expect(existsSync(join(unit.data, "fired"))).toBe(true);
  // The skill and the command are offered in the message box.
  await page.getByTestId("composer").fill("/e2e-kit:");
  await expect(page.getByTestId("slash-menu")).toContainText("e2e-kit:greet");
  await expect(page.getByTestId("slash-menu")).toContainText("e2e-kit:stamp");
  await page.getByTestId("composer").fill("");
  // The server is in Settings > MCP servers, from the plugin; the hooks in Settings > Hooks.
  await page.goto("/settings/mcp");
  await expect(page.locator('[data-testid="toolkit-group"][data-group="plugins"] [data-testid="mcp-entry"]')).toContainText("e2e-kit-echo");
  await page.goto("/settings/hooks");
  await expect(page.locator('[data-testid="hook-source"][data-scope="plugin"]')).toHaveAttribute("data-plugin", "e2e-kit");

  // Off: its hooks, its server, its skills, its command and its agent stop at once.
  await page.goto("/settings/plugins");
  await page.locator('[data-testid="unit-entry"][data-id="e2e-kit"]').click();
  await page.getByTestId("unit-toggle").click();
  await expect(reader).toHaveAttribute("data-enabled", "false");
  expect((await servers()).some((s) => s.plugin === "e2e-kit")).toBe(false);
  expect((await skills()).some((n) => n.startsWith("e2e-kit:"))).toBe(false);
  expect(await agents()).not.toContain("e2e-kit:checker");
  await page.goto("/settings/plugins");
  await page.locator('[data-testid="unit-entry"][data-id="e2e-kit"]').click();
  await shoot(page, "plugins-03-off");
  await say(2);
  expect(await notes()).toHaveLength(1);
  await page.goto("/settings/plugins");
  await page.locator('[data-testid="unit-entry"][data-id="e2e-kit"]').click();
  await page.getByTestId("unit-toggle").click();
  await expect(reader.locator('[data-testid="unit-mcp"][data-name="e2e-kit-echo"]')).toHaveAttribute("data-state", "ready", { timeout: 30_000 });

  // An update: what changes is said before it is applied, and a changed hook asks again.
  put(repo, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "e2e-kit", version: "1.1.0", description: "A kit for the plugin e2e" }),
    "skills/farewell/SKILL.md": "---\nname: farewell\ndescription: Say goodbye.\n---\nBye.\n",
    "hooks/hooks.json": hooks("MANGO"),
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "two");
  await page.getByTestId("unit-update").click();
  await expect(plan.getByTestId("plan-changes")).toContainText("version 1.0.0 to 1.1.0");
  await expect(plan.getByTestId("plan-changes")).toContainText("adds skills: farewell");
  await expect(plan.getByTestId("plan-changes")).toContainText("will run hook on UserPromptSubmit: printf 'plugin-hook-said-MANGO'");
  await expect(plan.getByTestId("plan-changes")).toContainText("no longer runs hook on UserPromptSubmit: printf 'plugin-hook-said-PINEAPPLE'");
  await expect(plan).toHaveAttribute("data-asks", "true");
  expect((await (await request.get("/api/plugins/installed/e2e-kit")).json()).plugin.version).toBe("1.0.0");
  await shoot(page, "plugins-04-update");
  await plan.getByTestId("plan-install").click();
  await expect(reader.getByTestId("unit-skills")).toContainText("e2e-kit:farewell");
  expect((await (await request.get("/api/plugins/installed/e2e-kit")).json()).plugin.version).toBe("1.1.0");
  await say(3);
  await expect.poll(async () => (await notes()).join(" ")).toContain("MANGO");

  // Offered by the repository: shown, not installed, until read and said yes to.
  expect((await (await request.get(`/api/plugins/installed?cwd=${encodeURIComponent(ws)}`)).json()).offers).toEqual([expect.objectContaining({ key: "local-kit@e2e-market", input: market })]);
  await page.goto("/settings/plugins");
  const offer = page.locator('[data-testid="offer-entry"][data-key="local-kit@e2e-market"]');
  await offer.click();
  expect((await skills()).some((n) => n.startsWith("local-kit:"))).toBe(false);
  await page.getByTestId("offer-read").click();
  await expect(plan).toHaveAttribute("data-id", "local-kit");
  await expect(plan.getByTestId("plan-runs")).toHaveCount(0);
  await shoot(page, "plugins-05-offered");
  await plan.getByTestId("plan-install").click();
  await expect(reader).toHaveAttribute("data-id", "local-kit");
  expect(await skills()).toEqual(expect.arrayContaining(["local-kit:greet", "e2e-kit:greet", "greet"]));
  await expect(offer).toHaveCount(0);

  // Removed: all of it goes, and the owner's config is as it was.
  for (const id of ["local-kit", "e2e-kit"]) {
    await page.locator(`[data-testid="unit-entry"][data-id="${id}"]`).click();
    await page.getByTestId("unit-remove").click();
    await page.getByTestId("unit-remove-confirm").click();
    await expect(page.locator(`[data-testid="unit-entry"][data-id="${id}"]`)).toHaveCount(0);
  }
  await shoot(page, "plugins-06-removed");
  expect((await (await request.get("/api/plugins/installed")).json()).plugins).toEqual([]);
  expect((await servers()).some((s) => s.plugin)).toBe(false);
  expect((await skills()).filter((n) => n.includes(":"))).toEqual([]);
  expect(existsSync(join(config, "plugins", "e2e-kit"))).toBe(false);
  // (The owner's own skill and server are put back as they were before the test.)
  const after = snapshot(config);
  expect(after).toEqual(before);
  await request.delete("/api/mcp/servers/echo");
  rmSync(join(config, "skills", "greet"), { recursive: true, force: true });
});
