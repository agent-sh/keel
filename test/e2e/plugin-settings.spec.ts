import { expect, test } from "./isolate.ts";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: a plugin's settings (the userConfig of its manifest). The plan
// says what it asks for, and a hook that would hand a value to a shell is
// not taken. Installed with a required value missing, its server and hooks
// wait and say for what. The owner gives the values in Customize > Plugins:
// the server starts with ${user_config.KEY} filled in, the hooks get
// CLAUDE_PLUGIN_OPTION_<KEY> and their args the value; a sensitive value goes
// to the system keyring only (or is refused, plainly, where there is none)
// and is never shown back or written to plugins.json.
const ECHO = join(import.meta.dirname, "fixtures/echo-mcp.ts");
const put = (root: string, files: Record<string, string>) => {
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
};

test("plugin settings: asked for, the plugin waits for a required one, values reach its server and hooks", async ({ page, request }) => {
  test.setTimeout(180_000);
  const first = await (await request.get("/api/plugins/installed")).json();
  const config = dirname(first.registry);
  test.skip(!config.includes("keel-work") && !config.includes("/dev-"), "needs a scratch config folder: this test installs a plugin there");
  const keyring = (await (await request.get("/api/providers/setup")).json()).keyring?.ready === true;
  const base = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `plugin-settings-${Date.now()}`);
  const kit = join(base, "kit"), ws = join(base, "ws");
  const userConfig = {
    endpoint: { type: "string", title: "API endpoint", description: "Where the service answers.", required: true },
    token: { type: "string", title: "API token", description: "Sent to the service; kept in the keyring.", sensitive: true },
    tone: { type: "string", title: "Tone", description: "Voice for replies.", options: ["neutral", "warm", "formal"], default: "neutral" },
    retries: { type: "number", title: "Retries", description: "How often to try again.", min: 1, max: 5, default: 3 },
  };
  put(kit, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "e2e-set", version: "1.0.0", description: "A plugin with settings", userConfig }),
    ".mcp.json": JSON.stringify({ mcpServers: { svc: { command: "bun", args: ["${CLAUDE_PLUGIN_ROOT}/server.ts", "${user_config.endpoint}"], env: { E2E_TONE: "${user_config.tone}", E2E_TOKEN: "${user_config.token}" } } } }),
    "hooks/hooks.json": JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
      { type: "command", command: "printf 'opt-said-%s' \"$CLAUDE_PLUGIN_OPTION_ENDPOINT\"" },
      { type: "command", command: "printf", args: ["arg-said-%s", "${user_config.tone}"] },
      { type: "command", command: "printf '${user_config.endpoint}'" },
    ] }] } }),
    // The server says what it was started with, then speaks MCP.
    "server.ts": "import { writeFileSync } from \"node:fs\";\nwriteFileSync(`${process.env.CLAUDE_PLUGIN_DATA}/seen.json`, JSON.stringify({ argv: process.argv.slice(2), tone: process.env.E2E_TONE, token: process.env.E2E_TOKEN ?? null }));\nawait import(\"./echo.ts\");\n",
  });
  copyFileSync(ECHO, join(kit, "echo.ts"));
  mkdirSync(join(ws, ".git"), { recursive: true });

  // Read: the settings it asks for are said, and the hook that would hand a value to its shell is not taken.
  await page.goto("/customize/plugins");
  await page.getByTestId("toolkit-add-+install").click();
  await page.getByTestId("install-source").fill(kit);
  await page.getByTestId("install-read").click();
  const plan = page.getByTestId("plugin-plan");
  await expect(plan).toHaveAttribute("data-id", "e2e-set");
  await expect(plan.getByTestId("plan-setting")).toHaveCount(4);
  await expect(plan.locator('[data-testid="plan-setting"][data-key="endpoint"]')).toContainText("API endpoint");
  await expect(plan.locator('[data-testid="plan-setting"][data-key="endpoint"]')).toContainText("required");
  await expect(plan.locator('[data-testid="plan-setting"][data-key="token"]')).toContainText("sensitive");
  await expect(plan.getByTestId("plan-not-taken")).toContainText("a shell-form hook command cannot take ${user_config.*}");
  await expect(plan.getByTestId("plan-run")).toHaveCount(5); // two hooks; the server's command, and the two variables it sets
  await expect(plan.getByTestId("plan-runs")).toContainText("sets E2E_TOKEN=${user_config.token}");
  await shoot(page, "plugin-settings-01-plan");

  // Installed: the required endpoint has no value, so its server and its hooks wait and say for what.
  await plan.getByTestId("plan-install").click();
  const reader = page.getByTestId("unit-reader");
  await expect(reader).toHaveAttribute("data-id", "e2e-set");
  await expect(reader.getByTestId("unit-waiting")).toContainText("API endpoint (no value yet)");
  await expect(reader.locator('[data-testid="unit-mcp"]')).toHaveAttribute("data-state", "waiting");
  await expect(reader.locator('[data-testid="setting"][data-key="endpoint"]')).toHaveAttribute("data-missing", "true");
  const servers = async () => (await (await request.get("/api/mcp/servers")).json()).servers as any[];
  expect((await servers()).some((s) => s.plugin === "e2e-set")).toBe(false);
  const unit = (await (await request.get("/api/plugins/installed/e2e-set")).json()).plugin;
  const seen = join(unit.data, "seen.json");
  expect(existsSync(seen)).toBe(false);
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  const notes = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).filter((e) => e.kind === "note").map((e) => JSON.stringify(e.data)).join(" ");
  const say = async (n: number) => {
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(`script:say ok ${n}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 60_000 });
  };
  await say(1);
  expect(await notes()).not.toContain("opt-said");
  await page.goto("/customize/plugins");
  await page.locator('[data-testid="unit-entry"][data-id="e2e-set"]').click();
  await expect(reader.getByTestId("unit-waiting")).toBeVisible();
  await shoot(page, "plugin-settings-02-waiting");

  // A value out of its bounds is refused, plainly.
  const field = (k: string) => reader.locator(`[data-testid="setting"][data-key="${k}"] [data-testid="setting-input"]`);
  await field("retries").fill("9");
  await reader.getByTestId("settings-save").click();
  await expect(reader.getByTestId("settings-error")).toContainText("Retries: the value is above 5");
  await field("retries").fill("");

  // The values: the server starts with them filled in, the hooks get them.
  await field("endpoint").fill("https://api.example.test/v1");
  await field("tone").click();
  await page.getByRole("option", { name: "warm" }).click();
  await reader.getByTestId("settings-save").click();
  await expect(reader.getByTestId("settings-saved")).toBeVisible();
  await expect(reader.getByTestId("unit-waiting")).toHaveCount(0);
  await expect(reader.locator('[data-testid="unit-mcp"]')).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect.poll(() => (existsSync(seen) ? JSON.parse(readFileSync(seen, "utf8")) : null)).toEqual({ argv: ["https://api.example.test/v1"], tone: "warm", token: "" });
  const record = () => readFileSync(first.registry, "utf8");
  expect(JSON.parse(record()).plugins.find((p: any) => p.id === "e2e-set").values).toEqual({ endpoint: "https://api.example.test/v1", tone: "warm" });
  await say(2);
  await expect.poll(notes).toContain("opt-said-https://api.example.test/v1");
  expect(await notes()).toContain("arg-said-warm");
  await page.goto("/customize/plugins");
  await page.locator('[data-testid="unit-entry"][data-id="e2e-set"]').click();
  await expect(field("endpoint")).toHaveValue("https://api.example.test/v1");
  await reader.getByTestId("unit-servers").scrollIntoViewIfNeeded();
  await shoot(page, "plugin-settings-03-given");

  // A sensitive value: to the keyring and the server, never shown back or written; where no keyring answers, refused plainly.
  const secret = "e2e-plugin-token-value";
  await field("token").fill(secret);
  await reader.getByTestId("settings-save").click();
  if (keyring) {
    await expect(reader.locator('[data-testid="setting"][data-key="token"]')).toContainText("saved in the keyring");
    await expect(field("token")).toHaveValue("");
    await expect.poll(() => JSON.parse(readFileSync(seen, "utf8")).token).toBe(secret);
    await reader.getByTestId("setting-forget").click();
    await expect(reader.locator('[data-testid="setting"][data-key="token"]')).not.toContainText("saved in the keyring");
  } else {
    await expect(reader.getByTestId("settings-error")).toContainText("the keyring did not take API token");
    await expect(reader.getByTestId("settings-error")).toContainText("a sensitive setting is kept only in the system keyring");
  }
  await shoot(page, "plugin-settings-04-sensitive");
  expect(record()).not.toContain(secret);
  expect(JSON.stringify((await (await request.get("/api/plugins/installed/e2e-set")).json()).plugin)).not.toContain(secret);

  // Removed: its record and its folder go.
  await page.getByTestId("unit-remove").click();
  await page.getByTestId("unit-remove-confirm").click();
  await expect(page.locator('[data-testid="unit-entry"][data-id="e2e-set"]')).toHaveCount(0);
  expect((await servers()).some((s) => s.plugin === "e2e-set")).toBe(false);
});
