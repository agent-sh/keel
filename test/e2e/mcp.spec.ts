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
  // A marked tool the server no longer offers is not counted, and is listed apart.
  await request.put("/api/mcp/servers/echo/reads", { data: { tools: ["echo", "vanished"] } });
  await expect(row.getByTestId("mcp-reads-count")).toHaveText("1 of 2 current tools count as reads");
  await expect(row.getByTestId("mcp-reads-gone")).toContainText("vanished");
  await row.getByTestId("mcp-reads-gone").getByRole("button", { name: "Forget them" }).click();
  await expect(row.getByTestId("mcp-reads-gone")).toHaveCount(0);
  await row.locator('[data-testid="mcp-tool-read"][data-tool="echo"]').click();
  await expect(row.getByTestId("mcp-reads-count")).toHaveText("Every tool asks first");

  // The server's resources and prompt templates: read one, fill one.
  const gets: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/prompts/greet")) gets.push(r.postData() ?? ""); });
  await row.getByTestId("mcp-contents-toggle").click();
  // The listing goes on past a page that ends in an empty cursor.
  await expect(row.getByTestId("mcp-resource")).toHaveText(["echo://readme", "echo://bundle"]);
  await expect(row.getByTestId("mcp-list-failed")).toHaveCount(0); // no templates is not a failure
  await row.getByTestId("mcp-resource").filter({ hasText: "echo://readme" }).click();
  await expect(row.getByTestId("mcp-content-text")).toContainText("The echo server repeats what it is given.");
  // A read of several items keeps each apart, under its own URI, with a binary's real size.
  await row.getByTestId("mcp-resource").filter({ hasText: "echo://bundle" }).click();
  const items = row.getByTestId("mcp-resource-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("echo://bundle/a");
  await expect(items.nth(1)).toContainText("beta\nsecond line");
  await expect(items.nth(2)).toContainText("Binary application/octet-stream, 1 byte");
  // A required argument is asked for before anything is sent; an optional one left empty is not sent.
  const greet = row.locator('[data-testid="mcp-prompt"][data-name="greet"]');
  await expect(greet).toContainText("Whom to greet");
  await greet.getByTestId("mcp-prompt-get").click();
  await expect(greet.getByTestId("mcp-prompt-error")).toHaveText("who is required");
  await expect(row.getByLabel("greet who")).toBeFocused();
  expect(gets).toHaveLength(0);
  await row.getByLabel("greet who").fill("the owner");
  await greet.getByTestId("mcp-prompt-get").click();
  await expect(row.getByTestId("mcp-content-text")).toContainText("Say hello to the owner.");
  expect(gets.map((b) => JSON.parse(b).arguments)).toEqual([{ who: "the owner" }]);
  // Only optional arguments: the field shows before anything is asked; empty, none is sent.
  const sum = row.locator('[data-testid="mcp-prompt"][data-name="summarize"]');
  await expect(sum).toContainText("optional");
  await sum.getByTestId("mcp-prompt-get").click();
  await expect(row.getByTestId("mcp-content-text")).toContainText("Summarize.");
  await expect(row.getByTestId("mcp-content-text")).not.toContainText("Tone");
  await row.getByLabel("summarize tone").fill("plain English");
  await sum.getByTestId("mcp-prompt-get").click();
  await expect(row.getByTestId("mcp-content-text")).toContainText("Tone: plain English.");
  // A conversation shows who says what, one message each.
  await row.locator('[data-testid="mcp-prompt"][data-name="dialog"]').getByTestId("mcp-prompt-get").click();
  const msgs = row.getByTestId("mcp-prompt-message");
  await expect(msgs).toHaveCount(2);
  await expect(msgs.nth(0)).toHaveAttribute("data-role", "user");
  await expect(msgs.nth(1)).toHaveAttribute("data-role", "assistant");
  await expect(msgs.nth(1)).toContainText("Hello back");
  await row.locator('[data-testid="mcp-prompt"][data-name="greet"]').getByTestId("mcp-prompt-get").click();
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
  await expect(menu).toContainText("/echo:dialog");
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
