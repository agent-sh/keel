import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

const FIXTURE = `${import.meta.dirname}/fixtures/echo-mcp.ts`;

// Feature: MCP servers. Add a stdio server from Settings > MCP servers, see it ready with
// its tools, turn it off and on, reconnect it, then a model finds its tool
// with search_tools and runs it with mcp_call.
test("mcp servers", async ({ page, request }) => {
  await request.delete("/api/mcp/servers/echo").catch(() => {});
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  // This feature is the tools, not the approval cards: run them without asking.
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });

  // Opened with the slash command (the palette path is in the chrome spec).
  await page.goto("/");
  await page.getByTestId("composer").fill("/mcp");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("mcp-panel");
  await expect(panel).toBeVisible();
  await shoot(page, "mcp-01-panel");

  await panel.getByTestId("toolkit-add-+add").click();
  await panel.getByTestId("mcp-add-name").fill("echo");
  await panel.getByTestId("mcp-add-target").fill(`bun ${FIXTURE}`);
  await panel.getByTestId("mcp-add-submit").click();
  const row = panel.locator('[data-testid="mcp-server"][data-name="echo"]');
  await expect(row).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(row.getByTestId("mcp-tool-count")).toHaveText("2 tools");
  await shoot(page, "mcp-02-ready");

  // Reads are the owner's call per tool: the server's own read-only hint is offered, not taken.
  const add = row.locator('[data-testid="mcp-tool-read"][data-tool="add"]');
  await expect(add).toHaveAttribute("aria-pressed", "false");
  await row.getByTestId("mcp-reads-hinted").click();
  await expect(add).toHaveAttribute("aria-pressed", "true");
  await expect(row.locator('[data-testid="mcp-tool-read"][data-tool="echo"]')).toHaveAttribute("aria-pressed", "false");
  await shoot(page, "mcp-02a-reads");
  await add.click();
  await expect(add).toHaveAttribute("aria-pressed", "false");

  // The server's resources and prompt templates: read one, fill one.
  await row.getByTestId("mcp-contents-toggle").click();
  await row.getByTestId("mcp-resource").filter({ hasText: "echo://readme" }).click();
  await expect(row.getByTestId("mcp-content-text")).toContainText("The echo server repeats what it is given.");
  await row.getByLabel("greet who").fill("the owner");
  await row.locator('[data-testid="mcp-prompt"][data-name="greet"]').getByTestId("mcp-prompt-get").click();
  await expect(row.getByTestId("mcp-content-text")).toContainText("Say hello to the owner.");
  await shoot(page, "mcp-02b-contents");
  await row.getByTestId("mcp-contents-toggle").click();

  await row.getByTestId("mcp-toggle").click();
  await expect(row).toHaveAttribute("data-state", "disabled");
  await shoot(page, "mcp-03-off");
  await row.getByTestId("mcp-toggle").click();
  await expect(row).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await row.getByTestId("mcp-reconnect").click();
  await expect(row).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await page.goto("/");

  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("haiku 5.5");
  await page.getByRole("option").first().click();
  await page.getByTestId("composer").fill(
    "Use search_tools to find the echo tool, then run it with mcp_call with the text pelican. Then reply with the tool's output only.",
  );
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
  const calls = page.getByTestId("tool-call");
  await expect(calls.filter({ hasText: "search_tools" }).first()).toBeVisible();
  await expect(calls.filter({ hasText: "mcp_call" }).first()).toBeVisible();
  await expect(page.getByTestId("assistant-text").last()).toContainText("echo: pelican");
  await calls.filter({ hasText: "mcp_call" }).first().click();
  await shoot(page, "mcp-04-chat");

  // The server's prompts are slash commands, as Claude Code lists them
  // (/server:prompt); the words after it fill the prompt's arguments, and what
  // the server returns reaches the model as a note before the message.
  const sp = (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "MCP prompt" } })).json()).session;
  await page.goto(`/s/${sp.id}`);
  await page.getByTestId("composer").fill("/echo:");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toContainText("/echo:greet");
  await expect(menu).toContainText("<who>");
  await shoot(page, "mcp-05-prompt-menu");
  // Picked from the menu, it waits for its argument; sent without one, it says what it needs.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer")).toHaveValue("/echo:greet ");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-notice")).toContainText("needs <who>");
  await page.getByTestId("composer").fill("/mcp__echo__greet the owner");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 30_000 });
  const evs = (await (await request.get(`/api/sessions/${sp.id}`)).json()).events;
  expect(evs.find((e: any) => e.kind === "note" && e.data?.mcp_prompt === "echo:greet")?.data.text).toContain("Say hello to the owner.");
  await shoot(page, "mcp-06-prompt-run");
  await request.delete(`/api/sessions/${sp.id}`);

  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
  await request.delete("/api/mcp/servers/echo");
});
