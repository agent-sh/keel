import { createServer } from "node:http";
import { expect, test, type Page } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: changing a session's model mid-session. A switch made while a turn
// runs takes effect at that turn's next request (not at the next turn); the
// transcript says who switched, from what to what and when; the new model is
// told once that the replies above are another model's; the history crosses
// wires (Anthropic thinking and tool calls to a Chat Completions model and
// back). Before a switch to a window the context does not fit, the picker
// says so and offers to compact on the model in use first.
async function pick(page: Page, m: { id: string; model: string }) {
  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill(m.model);
  await page.getByTestId("model-popup").locator(`[data-testid="model-option"][data-model="${m.id}"]`).first().click();
}

const assistants = async (request: any, id: string) =>
  ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "assistant").map((e) => e.data.model);

test("switch models mid-turn and across providers", async ({ page, request }) => {
  test.setTimeout(240_000);
  const models = (await (await request.get("/api/models")).json()).models as any[];
  // The other provider: a cheap model on another wire (Chat Completions), on a plan.
  const haiku = models.find((m) => m.id === HAIKU);
  const other = models.find((m) => m.id === (process.env.KEEL_SWITCH_MODEL ?? "glm:glm-5.3-flash"))
    ?? models.find((m) => m.provider === "openrouter" && m.tools !== false && m.price?.input > 0 && m.price.input < 0.2 && m.context >= 100_000);
  test.skip(!haiku || !other, "needs Haiku on Bedrock and a second provider");
  await page.setViewportSize({ width: 1700, height: 980 });
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  const confirm = page.getByTestId("confirm");

  // A turn that runs a few seconds in a tool; the switch is made while it runs.
  await composer.fill("Run this shell command with your tool: `timeout 6 tail -f /dev/null; echo ready`. Then reply with only the word it printed.");
  await composer.press("Enter");
  await expect(page.getByTestId("dock-now")).toHaveAttribute("data-moment", "acting", { timeout: 60_000 });
  await pick(page, other);
  // A warm cache asks first; with a turn running there is no compact-first choice.
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
    await expect(confirm).toContainText(`Switch to ${other.name}?`);
    await expect(confirm.getByTestId("confirm-alt")).toHaveCount(0);
    await shoot(page, "modelswitch-01-confirm-running");
    await confirm.getByRole("button", { name: "Switch" }).click();
  }
  const note = page.getByTestId("model-note").last();
  await expect(note).toContainText(`to ${other.name}`);
  await expect(note).toContainText("running turn goes on with it");
  await expect(note).toContainText("By you");
  await shoot(page, "modelswitch-02-note-running");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("turn-error")).toHaveCount(0);
  // The tool call came from Haiku; the reply after it from the new model, in the same turn.
  expect(await assistants(request, session.id)).toEqual([HAIKU, other.id]);

  // Back to Haiku between turns: the other model's history goes back over the Anthropic wire.
  await pick(page, haiku);
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.getByRole("button", { name: "Switch" }).click();
  await expect(page.getByTestId("model-note")).toHaveCount(2);
  await composer.fill("Reply with one short sentence: what did the command print?");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 120_000 });
  await expect(page.getByTestId("turn-error")).toHaveCount(0);
  expect((await assistants(request, session.id)).at(-1)).toBe(HAIKU);
  // Each new model was told once, as a note for the model, hidden on the page.
  const told = ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).filter((e) => e.kind === "note" && e.data.kind === "model_told");
  expect(told.map((e) => e.data.to)).toEqual([other.id, HAIKU]);
  await shoot(page, "modelswitch-03-back-on-haiku");
  await request.delete(`/api/sessions/${session.id}`);
});

// The scripted stand-ins: a context that fits the strict window (80k) but not
// the stand-in's (8k). The switch says so, and compacting first runs the
// summary on the model in use, sized for the one after.
test("a switch to a smaller window offers to compact first", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as any[];
  const small = models.find((m) => m.id === "scripted:stand-in");
  test.skip(!small || !models.some((m) => m.id === "scripted:stand-in-strict"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1700, height: 980 });
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in-strict" } })).json();
  // About 110 KB: with the system prompt and tools the strict model counts it
  // past where the smaller stand-in compacts, and under its own window.
  const long = Array.from({ length: 1_500 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog near the river bank.`).join("\n");
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `Keep this in mind.\n${long}` } });
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
  await pick(page, small);
  const confirm = page.getByTestId("confirm");
  await expect(confirm).toContainText("past where Scripted stand-in compacts");
  const alt = confirm.getByTestId("confirm-alt");
  await expect(alt).toHaveText("Compact first");
  await expect(confirm).toContainText("Scripted strict window summarizes the conversation");
  await shoot(page, "modelswitch-04-over-window");
  await alt.click();
  await expect(page.getByTestId("model-note")).toContainText("to Scripted stand-in");
  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const cp = events.find((e) => e.kind === "compaction");
  expect(cp?.data.model).toBe("scripted:stand-in-strict");
  // The context now fits the new window.
  expect((await (await request.get(`/api/sessions/${session.id}/switch-warning?model=scripted:stand-in`)).json()).fit.over).toBe(false);
  await shoot(page, "modelswitch-05-compacted-then-switched");
  await request.delete(`/api/sessions/${session.id}`);
});

test("a stale switch pick distinguishes a failed listing from a missing model", async ({ page, request }) => {
  const source = "scripted:stand-in-strict";
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === source), "needs a scratch daemon with the scripted provider");

  let state: "failed" | "empty" | "listed" = "listed";
  let listings = 0;
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/v1/models") {
      if (req.method === "POST") calls++;
      res.writeHead(404).end();
      return;
    }
    listings++;
    const data = state === "failed" ? { error: { message: "fixture listing offline" } } : { data: state === "listed" ? [{ id: "target" }] : [] };
    res.writeHead(state === "failed" ? 502 : 200, { "content-type": "application/json" }).end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const endpoint = "/api/providers/endpoints/switch-fixture";
  const target = "switch-fixture:target";
  let path: string | undefined;
  try {
    const added = await request.put(endpoint, { data: { config: { label: "Switch fixture", base_url: `http://127.0.0.1:${address.port}/v1`, auth: "none" } } });
    expect(added.ok()).toBe(true);
    expect((await added.json()).listing.state).toBe("ok");
    const { session } = await (await request.post("/api/sessions", { data: { model: source } })).json();
    path = `/api/sessions/${session.id}`;
    const preview = (model: string) => request.get(`${path}/switch-warning?model=${encodeURIComponent(model)}`);

    expect((await request.post(`${path}/messages`, { data: { text: "Hello there." } })).ok()).toBe(true);
    await page.goto(`/s/${session.id}`);
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    await page.getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill(target);
    const option = page.getByTestId("model-popup").locator(`[data-model="${target}"]`).first();
    await expect(option).toBeVisible();
    // The browser has seen this model, but the daemon no longer has it in its cache.
    state = "empty";
    const withdrawn = await request.post("/api/providers/refresh", { data: { provider: "switch-fixture" } });
    expect((await withdrawn.json()).providers.find((p: any) => p.id === "switch-fixture").listing.models).toBe(0);
    state = "failed";
    const failure = page.waitForResponse((r) => r.url().includes("/switch-warning?"));
    await option.click();
    const message = "No model switch was made: Switch fixture's model listing failed: HTTP 502: fixture listing offline";
    await expect(page.locator(".k-tip[data-open]")).toHaveText(message, { timeout: 6000 });
    await expect(page.getByTestId("announce-alert")).toHaveText(message);
    await shoot(page, "modelswitch-06-listing-failed");
    expect((await failure).status()).toBe(409);
    expect((await (await request.get(path)).json()).session.model).toBe(source);
    const fallback = await request.patch(path, { data: { settings: { fallback: "unknown:target" } } });
    expect(fallback.status()).toBe(400);
    expect(await fallback.json()).toEqual({ error: "provider unknown is not available" });

    state = "empty";
    const absent = await preview(target);
    expect(absent.status()).toBe(400);
    expect(await absent.json()).toMatchObject({ error: expect.stringContaining(`model ${target} is not in`) });

    state = "listed";
    const before = listings;
    await pick(page, { id: target, model: target });
    const confirm = page.getByTestId("confirm");
    await expect(confirm).toContainText("without the prompt cache");
    await expect(confirm.getByTestId("confirm-alt")).toHaveText("Compact first");
    expect(listings).toBe(before + 1);
    expect((await (await request.get(path)).json()).session.model).toBe(source);
    await confirm.getByRole("button", { name: "Switch" }).click();
    await expect(page.getByTestId("model-note")).toContainText("to target");
    expect((await (await request.get(path)).json()).session.model).toBe(target);
    expect(listings).toBe(before + 1);

    // A failed listing can keep a last-known model. It is not a reason to
    // compact on that route or to block leaving it.
    state = "failed";
    expect((await request.post("/api/providers/refresh", { data: { provider: "switch-fixture" } })).ok()).toBe(true);
    expect(await (await preview(target)).json()).toMatchObject({ unchanged: true, fit: { over: expect.any(Boolean) } });
    expect(await (await preview(source)).json()).toMatchObject({ can_compact_first: false });
    const compact = await request.post(`${path}/compact`, { data: { for_model: source } });
    expect(await compact.json()).toMatchObject({ error: "Cannot compact before switching: Switch fixture's model listing failed: HTTP 502: fixture listing offline" });
    expect(compact.status()).toBe(409);
    expect((await request.patch(path, { data: { model: source } })).ok()).toBe(true);
    expect(calls).toBe(0);
  } finally {
    if (path) await request.delete(path);
    await request.delete(endpoint);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
