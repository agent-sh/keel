import { expect, test } from "./isolate.ts";
import { HAIKU, openPanel, shoot } from "./shots.ts";

const FIXTURE = `${import.meta.dirname}/fixtures/echo-mcp.ts`;
const NAME = "offecho";

// Feature: an MCP server turned off for one session. The session panel lists the owner's servers with a switch
// each; off, the server's tools are not found by that session's search, a call of one is told why, and another
// session has the server as before. Customize > MCP servers is untouched (the server stays on for everyone).
test.afterEach(async ({ request }) => { await request.delete(`/api/mcp/servers/${NAME}`).catch(() => {}); });

test("an MCP server turned off for one session leaves that session alone", async ({ page, request }) => {
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  try {
    expect((await request.post("/api/mcp/servers", { data: { name: NAME, command: "bun", args: [FIXTURE] } })).ok()).toBe(true);
    await expect.poll(async () => ((await (await request.get("/api/mcp/servers")).json()).servers as any[]).find((x) => x.name === NAME)?.state, { timeout: 30_000 }).toBe("ready");
    const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { model: HAIKU, title } })).json()).session.id as string;
    const here = await mk("Server off here"), other = await mk("Server on there");
    const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 60_000 }).toBe(true);
    const say = async (id: string, calls: unknown[]) => {
      const before = ((await (await request.get(`/api/sessions/${id}`)).json()).events as unknown[]).length;
      await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
      await idle(id);
      const events = (await (await request.get(`/api/sessions/${id}`)).json()).events as unknown[];
      return JSON.stringify(events.slice(before));
    };
    const echo = (id: string) => say(id, [{ name: "search_tools", input: { query: `select:${NAME}__echo` } }, { name: "mcp_call", input: { tool: `${NAME}__echo`, arguments: { text: "pelican" } } }]);

    // On everywhere: both sessions find it and run it.
    expect(await echo(other)).toContain("echo: pelican");
    expect(await echo(here)).toContain("echo: pelican");

    // Off for one session, in its panel.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${here}`);
    await openPanel(page, "session");
    const row = page.locator(`[data-testid="session-server"][data-server="${NAME}"]`);
    await expect(row).toHaveAttribute("data-off", "no");
    await shoot(page, "mcp-session-off-1-on");
    await row.getByTestId("session-server-toggle").click();
    await expect(row).toHaveAttribute("data-off", "yes");
    await expect(row.getByTestId("session-server-toggle")).toHaveAttribute("aria-checked", "false");
    expect((await (await request.get(`/api/sessions/${here}`)).json()).session.settings.mcp_off).toEqual([NAME]);
    await shoot(page, "mcp-session-off-2-off");

    // Its search finds nothing of it, and a call says why. The other session is as it was; so is the owner's list.
    const gone = await echo(here);
    expect(gone).not.toContain("echo: pelican");
    expect(gone).toContain("turned off for this session");
    expect(await echo(other)).toContain("echo: pelican");
    expect(((await (await request.get("/api/mcp/servers")).json()).servers as any[]).find((x) => x.name === NAME)?.enabled).toBe(true);
    expect(((await (await request.get(`/api/sessions/${here}/mcp`)).json()).servers as any[]).find((x) => x.name === NAME)?.off).toBe(true);

    // On again: the call runs.
    await page.reload();
    await openPanel(page, "session");
    await row.getByTestId("session-server-toggle").click();
    await expect(row).toHaveAttribute("data-off", "no");
    expect((await (await request.get(`/api/sessions/${here}`)).json()).session.settings.mcp_off ?? []).toEqual([]);
    expect(await echo(here)).toContain("echo: pelican");
  } finally {
    await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  }
});
