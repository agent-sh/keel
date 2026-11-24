import { expect, test, type APIRequestContext } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openMcp, SCRIPTED, shoot } from "./shots.ts";

const FIXTURE = `${import.meta.dirname}/fixtures/shapes-mcp.ts`;
// The Claude stand-in: its requests are built by the Anthropic wire's own codec, and it refuses a
// tool whose schema that wire refuses, in the API's words (src/providers/scripted.ts schemaRefusal).
const STAND_IN = "scripted:claude-stand-in";
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
const events = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
const results = async (request: APIRequestContext, id: string) => (await events(request, id)).filter((e) => e.kind === "tool_result")
  .flatMap((e) => (e.data.results as any[]).map((r) => (typeof r.content === "string" ? r.content : (r.content ?? []).map((c: any) => c.text ?? "").join("\n")) as string));

test.afterEach(async ({ request }) => {
  await request.delete("/api/mcp/servers/shapes").catch(() => {});
});

// Feature: MCP input schemas fit each wire. One server lists a tool with a root
// oneOf, one keyed by a column title with a space, one whose input is a string,
// and a plain one. The session's requests go through: the oneOf tool is one
// object whose description names its groups, the column is renamed for the
// wire and given back to the server under its own name, the string tool is
// left out and named once in the session's failures and in Customize > MCP
// servers (its tool search does not load it), and a schema the provider still refuses is sent once more with that
// tool declared without its parameters.
test("mcp schemas: a server with tools a provider refuses works end to end", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!SCRIPTED || !models.some((m) => m.id === STAND_IN), "needs the scripted Claude stand-in: run on the scripted provider (KEEL_SCRIPTED_PROVIDER=1)");
  await request.delete("/api/mcp/servers/shapes").catch(() => {});
  expect((await request.post("/api/mcp/servers", { data: { name: "shapes", command: "bun", args: [FIXTURE] } })).ok()).toBe(true);

  // Customize > MCP servers: which tools were changed to fit and where, and the one left out with why.
  await openMcp(page, "shapes");
  const server = page.locator('[data-testid="mcp-server"][data-name="shapes"]');
  await expect(server).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  const fit = server.getByTestId("mcp-schema-fit");
  await expect(fit).toContainText("1 tool left out");
  await expect(fit.locator('[data-tool="textual"]').getByTestId("mcp-schema-left")).toContainText('Left out on Anthropic, OpenAI Responses, Chat Completions, Gemini, ACP agents: its input is "string", and a tool\'s input is an object.');
  await expect(fit.locator('[data-tool="pick"]').getByTestId("mcp-schema-changed")).toContainText("give exactly one of: (1) id; (2) name");
  await expect(fit.locator('[data-tool="cells"]').getByTestId("mcp-schema-changed")).toContainText('"unit price" is unit_price');
  await expect(fit.locator('[data-tool="echo"]')).toHaveCount(0);
  await fit.scrollIntoViewIfNeeded();
  await shoot(page, "mcp-schemas-01-settings");

  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `mcp-schemas-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: STAND_IN, title: "MCP schemas" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const ends = (n: number) => expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(n);
  try {
    // The requests declare every tool of the server that fits (deferred, with its schema): the
    // stand-in takes them, and the calls reach the server as it names its parameters.
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(calls([
      { name: "ToolSearch", input: { query: "select:mcp__shapes__pick,mcp__shapes__cells" } },
      { name: "mcp__shapes__pick", input: { name: "kettle" } },
      { name: "mcp__shapes__cells", input: { unit_price: "4.20" } },
    ]));
    await page.keyboard.press("Enter");
    await ends(1);
    const ends1 = (await events(request, session.id)).filter((e) => e.kind === "turn_end");
    expect(ends1.at(-1).data.reason).not.toBe("error");
    const got = await results(request, session.id);
    // (A result may carry more after it: a memory hook's lines.)
    expect(got.some((r) => r.startsWith('pick got {"name":"kettle"}'))).toBe(true);
    expect(got.some((r) => r.startsWith('cells got {"unit price":"4.20"}'))).toBe(true);
    await expect(page.getByTestId("turn-end").last()).toBeVisible();
    await shoot(page, "mcp-schemas-02-calls");

    // The tool left out is not one the search loads: by its name the search says why, and a
    // keyword that matches it finds only the tools the request declares. A reference to a tool
    // the request does not declare is refused by the provider, so the next request shows it.
    await page.getByTestId("composer").fill(calls([
      { name: "ToolSearch", input: { query: "select:mcp__shapes__textual" } },
      { name: "ToolSearch", input: { query: "+shapes text" } },
    ]));
    await page.keyboard.press("Enter");
    await ends(2);
    expect((await events(request, session.id)).filter((e) => e.kind === "turn_end").at(-1).data.reason).not.toBe("error");
    const refs = (await events(request, session.id)).filter((e) => e.kind === "tool_result")
      .flatMap((e) => (e.data.results as any[]).flatMap((r) => (Array.isArray(r.content) ? r.content : []).filter((c: any) => c.type === "tool_reference").map((c: any) => c.tool_name as string)));
    expect(refs).toContain("mcp__shapes__echo");
    expect(refs).not.toContain("mcp__shapes__textual");
    expect((await results(request, session.id)).some((r) => r.includes('mcp__shapes__textual is not offered: its input is "string"'))).toBe(true);

    // The tool left out is in the session's failures, once, however many requests left it out.
    const left = async () => ((await (await request.get(`/api/errors?session=${session.id}`)).json()).failures ?? [])
      .filter((g: any) => g.cls === "tool left out");
    await expect.poll(async () => (await left()).map((g: any) => [g.count, g.sample]), { timeout: 10_000 })
      .toEqual([[1, expect.stringContaining("mcp__shapes__textual is not offered to the model: its input is \"string\"")]]);

    // A schema the provider still refuses (it names the tool by its position): sent once more with
    // that tool declared without its parameters, and the turn goes on.
    const errorsBefore = (await (await request.get("/api/errors")).json()).errors.filter((e: any) => /input_schema/.test(e.message)).length;
    await page.getByTestId("composer").fill("script:refuse-schema echo");
    await page.keyboard.press("Enter");
    await ends(3);
    await expect(page.getByTestId("assistant-text").last()).toContainText("The tool mcp__shapes__echo was declared without its parameters, after 1 refusal of its schema.");
    const refused = (await (await request.get("/api/errors")).json()).errors.filter((e: any) => /input_schema/.test(e.message));
    expect(refused.length).toBe(errorsBefore + 1);
    expect(refused.at(-1).message).toContain("tools.");
    // Recorded in the session's failures too, and the next turn does not ask the provider again.
    await expect.poll(async () => ((await (await request.get(`/api/errors?session=${session.id}`)).json()).failures ?? []).filter((g: any) => g.cls === "tool schema refused").length).toBe(1);
    await page.getByTestId("composer").fill("script:refuse-schema echo again");
    await page.keyboard.press("Enter");
    await ends(4);
    await expect(page.getByTestId("assistant-text").last()).toContainText("declared without its parameters, after 0 refusals of its schema.");
    await shoot(page, "mcp-schemas-03-refused");
  } finally {
    await request.delete(`/api/sessions/${session.id}`).catch(() => {});
  }
});
