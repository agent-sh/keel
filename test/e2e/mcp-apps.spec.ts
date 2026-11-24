import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

const FIXTURE = `${import.meta.dirname}/fixtures/app-mcp.ts`;
const STAND_IN = "scripted:stand-in";
const NAME = "board";

// Feature: MCP Apps. A tool whose definition names a ui:// page has the page
// drawn beside its call, in a sandboxed frame under the policy its server
// declared. The app calls a tool of its own server through the permission
// gate (a card, as the model's call of it would have), and the result comes
// back into the app; a tool its server keeps from apps, and a tool of another
// server, are refused with a line under the app. A link opens only on the
// owner's press, and a message goes to the model as the app's. A reload
// draws the same app, from what the session kept.
test.afterEach(async ({ request }) => {
  await request.delete(`/api/mcp/servers/${NAME}`).catch(() => {});
});

test("mcp apps: drawn beside the call, calling its own tools through the gate", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.delete(`/api/mcp/servers/${NAME}`).catch(() => {});
  expect((await request.post("/api/mcp/servers", { data: { name: NAME, command: "bun", args: [FIXTURE, "--domains"] } })).ok()).toBe(true);
  const server = async () => ((await (await request.get("/api/mcp/servers")).json()).servers as any[]).find((s) => s.name === NAME);
  await expect.poll(async () => (await server())?.state, { timeout: 30_000 }).toBe("ready");
  // The board is a read; the app's tally is not, so a call of it asks first.
  expect((await request.put(`/api/mcp/servers/${NAME}/reads`, { data: { tools: ["board"] } })).ok()).toBe(true);

  const { session } = await (await request.post("/api/sessions", { data: { title: `Apps ${Date.now()}`, model: STAND_IN } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
  await page.goto(`/s/${session.id}`);
  // The model calls the board; a tool the server keeps for its apps is not the model's to call.
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([
    { name: "mcp_call", input: { tool: "board__board", arguments: { team: "blue" } } },
    { name: "mcp_call", input: { tool: "board__tally", arguments: {} } },
  ])}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="tool-call"]').last()).toContainText("board__tally");
  const evs = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const results = evs.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
  expect(results.at(-1).content).toContain("No tool named board__tally");

  const app = page.getByTestId("mcp-app");
  await expect(app).toHaveCount(1);
  await expect(app).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(app.getByTestId("mcp-app-server")).toHaveText(NAME);
  const frame = page.frameLocator('[data-testid="mcp-app-frame"]');
  // A press in the app, as the owner makes it: the pointer comes over the frame first (a frame the
  // owner left is closed to input until the pointer is over it again: ui/src/lib/frames.ts).
  const press = async (id: string) => {
    const box = (await frame.locator(id).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await frame.locator(id).click();
  };
  await expect(frame.locator("#first")).toHaveText("first: blue has 0 points");
  await expect(frame.locator("#theme")).toHaveText(/theme: (light|dark)/);
  // Sized to its content: the app said how tall it is.
  const tall = await app.locator(".k-mcpapp-frame").evaluate((el) => el.getBoundingClientRect().height);
  expect(tall).toBeGreaterThan(48);
  // The page reaches only what its server declared, with scripts only and no same origin.
  const frameEl = app.getByTestId("mcp-app-frame");
  expect(await frameEl.getAttribute("sandbox")).toBe("allow-scripts");
  const pageRes = await request.get((await frameEl.getAttribute("src"))!);
  const csp = pageRes.headers()["content-security-policy"]!;
  expect(csp).toContain("sandbox allow-scripts");
  expect(csp).toContain("connect-src https://api.example.com;");
  expect(csp).toContain("script-src 'unsafe-inline' https://cdn.example.com;");
  expect(csp).not.toContain("'self'");
  await shoot(page, "mcp-apps-01-drawn");
  // The theme reaches the app as the owner changes it.
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(frame.locator("#theme")).toHaveText("theme: dark");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await expect(frame.locator("#theme")).toHaveText("theme: light");

  // The app's call goes through the session's gate: a card, as the model's call of tally would have.
  await press("#tally");
  const card = page.getByTestId("approval").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("tally");
  await shoot(page, "mcp-apps-02-asks");
  await card.getByTestId("allow-once").click();
  await expect(frame.locator("#out")).toHaveText("tally: blue has 1 points");
  const calls = app.getByTestId("mcp-app-call");
  await expect(calls).toHaveCount(1);
  await expect(calls.first()).toContainText("Called");
  await expect(calls.first()).toContainText("blue has 1 points");

  // A tool its server keeps from apps, and another server's tool, are refused, each with a line.
  await press("#secret");
  await expect(frame.locator("#out")).toHaveText(`secret refused: ${NAME} keeps its tool secret from its apps`);
  await press("#other");
  await expect(frame.locator("#out")).toHaveText(`echo__echo refused: ${NAME} offers no tool echo__echo: an app calls only its own server's tools`);
  await expect(calls).toHaveCount(3);
  await expect(calls.nth(1)).toContainText("Refused");
  await expect(calls.nth(2)).toContainText("echo__echo");

  // A link waits for the owner's press; dismissed, the app is told so and nothing opens.
  const opened: string[] = [];
  page.context().on("page", (p) => opened.push(p.url()));
  await press("#link");
  const ask = app.getByTestId("mcp-app-link");
  await expect(ask).toBeVisible();
  await expect(app.getByTestId("mcp-app-link-url")).toHaveText("https://example.com/rules");
  await shoot(page, "mcp-apps-03-link");
  await ask.getByTestId("mcp-app-link-dismiss").click();
  await expect(frame.locator("#out")).toHaveText("link refused: Link opening denied by user");
  expect(opened).toEqual([]);

  // A message goes to the model as the app's, shown to the owner as not theirs.
  await press("#say");
  await expect(frame.locator("#out")).toHaveText("message: sent");
  const said = page.getByTestId("channel-event");
  await expect(said).toBeVisible({ timeout: 20_000 });
  await expect(said.getByTestId("channel-source")).toHaveText(`${NAME} app`);
  await expect(said).toContainText("The board says blue leads.");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
  const told = ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).find((e) => e.kind === "user" && e.data.kind === "channel");
  expect(told.data.text).toContain("not the owner's words");
  await shoot(page, "mcp-apps-04-message");

  // A reload draws the same app from what the session kept, with the calls it made.
  await page.reload();
  const again = page.getByTestId("mcp-app");
  await expect(again).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(page.frameLocator('[data-testid="mcp-app-frame"]').locator("#first")).toHaveText("first: blue has 0 points");
  await expect(again.getByTestId("mcp-app-call")).toHaveCount(3);
  await shoot(page, "mcp-apps-05-reloaded");

  const errors = (await (await request.get("/api/errors")).json()).errors as any[];
  expect(errors.length, JSON.stringify(errors.slice(0, 3).map((e) => e.message))).toBe(errorsBefore);
});
