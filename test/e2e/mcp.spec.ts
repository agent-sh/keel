import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ask, HAIKU, pickModel, SCRIPTED, shoot } from "./shots.ts";

const FIXTURE = `${import.meta.dirname}/fixtures/echo-mcp.ts`;

// Feature: MCP servers. Add a stdio server from Settings > MCP servers, see it ready with
// its tools, turn it off and on, reconnect it, then a model finds its tool
// with ToolSearch (a tool_reference loads it, the cached prefix unchanged) and
// calls it by its own name, mcp__echo__echo, as Claude Code names MCP tools.
// However a test here ends (a step that failed, a timeout), it leaves nothing
// on the daemon for the tests after it: not its echo server (the same command
// under another name is one endpoint to an import) and not the permission
// default it set.
let modeBefore: string | undefined;
test.afterEach(async ({ request }) => {
  await request.delete("/api/mcp/servers/echo").catch(() => {});
  await request.delete("/api/mcp/servers/broken").catch(() => {});
  if (modeBefore !== undefined) await request.put("/api/permissions/settings", { data: { default_mode: modeBefore } });
  modeBefore = undefined;
});

test("mcp servers", async ({ page, request }) => {
  await request.delete("/api/mcp/servers/echo").catch(() => {});
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  // This feature is the tools, not the approval cards: run them without asking.
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  modeBefore = prev;
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

  // The server's tool is found and run from a session. A Claude model loads it with ToolSearch and
  // calls it by its own name; any other family (the stand-in's) finds it with search_tools and runs
  // it with mcp_call. A real model does so from words, the stand-in from its script.
  await pickModel(page);
  await page.getByTestId("composer").fill(ask(
    "Use ToolSearch to find the echo tool, then run it with the text pelican. Then reply with the tool's output only.",
    `script:calls ${JSON.stringify([{ name: "search_tools", input: { query: "select:echo__echo" } }, { name: "mcp_call", input: { tool: "echo__echo", arguments: { text: "pelican" } } }])}`,
  ));
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
  const calls = page.getByTestId("tool-call");
  const search = ask("ToolSearch", "search_tools"), ran = ask("mcp__echo__echo", "echo__echo");
  await expect(calls.filter({ hasText: search }).first()).toBeVisible();
  await expect(calls.filter({ hasText: ran }).last()).toBeVisible();
  await expect(page.getByTestId("assistant-text").last()).toContainText("echo: pelican");
  // The search's card names what it found.
  await calls.filter({ hasText: search }).first().click();
  await expect(calls.filter({ hasText: search }).first()).toContainText(ask("Loaded mcp__echo__echo", "echo__echo"));
  await calls.filter({ hasText: ran }).last().click();
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

// Feature: the other agents' servers in one step. Codex, Hermes and Gemini
// hold the same server under different names, and one server of their own
// each: one row per endpoint, Import all brings each in once, and a copy
// follows its source (a change in Codex's file reaches Keel; a server Codex
// drops is marked, not removed). Their files are never written.
test("mcp import from other agents", async ({ page, request }) => {
  const imp = await (await request.get("/api/mcp/importable")).json();
  test.skip(!String(imp.home).includes("keel-work"), "needs a scratch import home (KEEL_IMPORT_HOME)");
  const { mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const bun = execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  const home = imp.home as string;
  const tag = Date.now().toString(36);
  const names = [`ec${tag}`, `cx${tag}`, `hm${tag}`, `gm${tag}`];
  // Every copy that follows a source on this scratch daemon is this spec's (an earlier run's included),
  // and so is every server that runs the echo fixture: one left by another test is the same endpoint
  // as the one imported here, and Import all would pass it over as already in Keel.
  const clear = async () => {
    const all = (await (await request.get("/api/mcp/servers")).json()).servers as any[];
    for (const s of all) if (s.sync || names.includes(s.name) || String(s.target ?? "").includes(FIXTURE)) await request.delete(`/api/mcp/servers/${s.name}`).catch(() => {});
  };
  await clear();
  rmSync(join(home, ".codex"), { recursive: true, force: true });
  rmSync(join(home, ".hermes"), { recursive: true, force: true });
  rmSync(join(home, ".gemini"), { recursive: true, force: true });
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const codexToml = (extra: string) => `[mcp_servers.ec${tag}]\ncommand = "bun"\nargs = ["${FIXTURE}"]\n\n${extra}`;
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), codexToml(`[mcp_servers.cx${tag}]\ncommand = "bun"\nargs = ["${FIXTURE}", "codex"]\nenv_vars = ["LANG"]\n`));
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(join(home, ".hermes", "config.yaml"), `mcp_servers:\n  echo-${tag}:\n    command: ${bun}\n    args: ["${FIXTURE}"]\n  hm${tag}:\n    command: bun\n    args: ["${FIXTURE}", "hermes"]\n    enabled: false\n`);
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "settings.json"), `{\n  // Gemini's file takes comments\n  "mcpServers": { "gm${tag}": { "command": "bun", "args": ["${FIXTURE}", "gemini"], "timeout": 30000 }, "ec${tag}": { "command": "bun", "args": ["${FIXTURE}"] } }\n}\n`);

  await page.goto("/");
  await page.getByTestId("composer").fill("/mcp");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("mcp-panel");
  await panel.getByTestId("toolkit-add-+import").click();
  // The echo server is one row however many agents hold it.
  const echo = panel.locator(`[data-testid="mcp-import-row"][data-name="ec${tag}"]`);
  await expect(echo).toHaveCount(1);
  await expect(echo).toContainText("Codex");
  await expect(echo).toContainText("Gemini CLI");
  await expect(echo).toContainText(`also echo-${tag}`);
  await expect(panel.locator(`[data-testid="mcp-import-row"][data-name="hm${tag}"]`)).toContainText("off");
  await shoot(page, "mcp-07-import-list");

  await panel.getByTestId("mcp-import-all").click();
  await expect(panel.getByTestId("mcp-note")).toContainText(`ec${tag}`);
  for (const n of [`ec${tag}`, `cx${tag}`, `gm${tag}`]) await expect(panel.locator(`[data-testid="mcp-import-row"][data-name="${n}"]`)).toContainText("In Keel");
  const list = async () => (await (await request.get("/api/mcp/servers")).json()).servers as any[];
  const one = async (n: string) => (await list()).find((s) => s.name === n);
  expect((await one(`ec${tag}`)).sync).toMatchObject({ source: "codex", name: `ec${tag}`, gone: false });
  expect((await one(`hm${tag}`)).enabled).toBe(false); // off there, off here
  expect((await one(`gm${tag}`)).sync.source).toBe("gemini");

  // Codex's file changes: its copy follows (the daemon watches the folder), and restarts ready.
  writeFileSync(join(home, ".codex", "config.toml"), codexToml(`[mcp_servers.cx${tag}]\ncommand = "bun"\nargs = ["${FIXTURE}", "codex", "v2"]\n`));
  await expect.poll(async () => (await one(`cx${tag}`)).target, { timeout: 10_000 }).toContain("codex v2");
  await expect.poll(async () => (await one(`cx${tag}`)).state, { timeout: 20_000 }).toBe("ready");
  // The owner's own choices in Keel stay when the source changes.
  await request.post(`/api/mcp/servers/ec${tag}/toggle`, { data: { enabled: false } });
  writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.ec${tag}]\ncommand = "bun"\nargs = ["${FIXTURE}", "moved"]\n`);
  await expect.poll(async () => (await one(`ec${tag}`)).target, { timeout: 10_000 }).toContain("moved");
  expect((await one(`ec${tag}`)).enabled).toBe(false);
  // cx is gone from Codex's file now: kept, and marked.
  await expect.poll(async () => (await one(`cx${tag}`)).sync?.gone, { timeout: 10_000 }).toBe(true);
  await panel.locator(`[data-testid="mcp-entry"]`).filter({ hasText: `cx${tag}` }).first().click();
  await expect(panel.getByTestId("mcp-sync")).toContainText("Codex, which no longer has it");
  await shoot(page, "mcp-08-follows");

  // Keel never wrote the other agents' files: each holds the spec's own last write.
  expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(`[mcp_servers.ec${tag}]\ncommand = "bun"\nargs = ["${FIXTURE}", "moved"]\n`);
  await clear();
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// Feature: the memory store's own tools. Where Keel runs tacit's hooks it
// brings tacit's MCP server too (the hooks name its tools in every block):
// the server is listed as Keel's own, a session finds tacit_search and calls
// it, and a session with memory off is refused. A configured server that
// cannot start is named, with its reason, where its tools are missing: in the
// search result and in the panel.
test("tacit's tools reach a session, and a server that fails says so", async ({ page, request }) => {
  const info = await (await request.get("/api/integrations")).json();
  test.skip(!info.tacit.bin?.includes("tacit-standin"), "needs the tacit stand-in (TACIT_BIN)");
  test.skip(!SCRIPTED, "drives the calls with the scripted model");
  await request.delete("/api/mcp/servers/broken").catch(() => {});
  const list = async () => (await (await request.get("/api/mcp/servers")).json()).servers as any[];
  const tacit = (await list()).find((s) => s.name === "tacit");
  expect(tacit).toMatchObject({ bundled: "Memory (tacit)", enabled: true });
  expect(tacit.target).toContain("mcp --harness claude");
  expect(tacit.tool_names).toContain("tacit_search");
  // A server whose program is not there: it fails to start.
  expect((await request.post("/api/mcp/servers", { data: { name: "broken", command: "/nonexistent/keel-e2e-server" } })).ok()).toBe(true);
  await expect.poll(async () => (await list()).find((s) => s.name === "broken")?.state, { timeout: 20_000 }).toBe("error");

  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `tacit-mcp-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const open = async (memory: boolean) => {
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    if (!memory) expect((await request.patch(`/api/sessions/${session.id}`, { data: { use_memory: false } })).ok()).toBe(true);
    return session.id as string;
  };
  const results = async (id: string) => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data.results[0].content));
  const calls = (c: { name: string; input: unknown }[]) => `script:calls ${JSON.stringify(c)}`;

  const id = await open(true);
  await page.goto(`/s/${id}`);
  await page.getByTestId("composer").fill(calls([
    { name: "search_tools", input: { query: "tacit search" } },
    // By the name the memory hook's own text gives it (mcp__tacit__tacit_search), as Claude Code names MCP tools.
    { name: "mcp_call", input: { tool: "mcp__tacit__tacit_search", arguments: { query: "code word" } } },
    { name: "search_tools", input: { query: "keel-e2e-server" } },
  ]));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  const [found, answer, missing] = await results(id);
  expect(found).toContain("tacit__tacit_search");
  expect(answer).toContain("heron");
  expect(missing).toMatch(/Not available now: [^"]*broken \(ENOENT[^"]*keel-e2e-server/);
  expect((await list()).find((s) => s.name === "tacit").state).toBe("ready");

  // The owner names another writer: the running server starts again under it, at the next call.
  const writerBefore = (await (await request.get("/api/settings")).json()).settings.memory.writer;
  try {
    expect((await request.patch("/api/settings", { data: { memory: { writer: "codex" } } })).ok()).toBe(true);
    await expect.poll(async () => (await list()).find((s) => s.name === "tacit").target).toContain("--harness codex");
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "mcp_call", input: { tool: "tacit__tacit_add", arguments: { name: "n", description: "d", type: "user_standard" } } }]) } });
    await expect.poll(async () => (await results(id)).at(-1) ?? "", { timeout: 60_000 }).toContain("tacit_add done as codex");
  } finally {
    await request.patch("/api/settings", { data: { memory: { writer: writerBefore } } });
  }

  // Memory off in a session: the store's tools are refused there.
  const off = await open(false);
  await request.post(`/api/sessions/${off}/messages`, { data: { text: calls([{ name: "mcp_call", input: { tool: "tacit__tacit_search", arguments: { query: "code word" } } }]) } });
  await expect.poll(async () => (await results(off))[0] ?? "", { timeout: 60_000 }).toContain("Memory is turned off in this session");
  // Its resources and prompts too.
  await request.post(`/api/sessions/${off}/messages`, { data: { text: calls([{ name: "mcp_call", input: { tool: "mcp__list_resources", arguments: { server: "tacit" } } }, { name: "mcp_call", input: { tool: "mcp__list_prompts", arguments: { server: "tacit" } } }]) } });
  await expect.poll(async () => (await results(off)).slice(1).filter((r) => r.includes("Memory is turned off in this session")).length, { timeout: 60_000 }).toBe(2);

  // The panel: tacit as Keel's own, the broken one failed with its reason.
  await page.goto("/");
  await page.getByTestId("composer").fill("/mcp");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("mcp-panel");
  await panel.locator('[data-testid="mcp-entry"]').filter({ hasText: "broken" }).first().click();
  await expect(panel.getByTestId("mcp-error")).toBeVisible();
  await shoot(page, "mcp-09-failed-server");
  await panel.locator('[data-testid="mcp-entry"]').filter({ hasText: "Memory (tacit)" }).first().click();
  // (The writer put back ended its process: it starts at the next call, under the owner's writer.)
  const tacitRow = panel.locator('[data-testid="mcp-server"][data-name="tacit"]');
  await expect(tacitRow).toHaveAttribute("data-state", /^(ready|idle)$/);
  await expect(tacitRow).toContainText(`--harness ${writerBefore}`);
  await shoot(page, "mcp-10-tacit");
  await request.delete("/api/mcp/servers/broken");
});
