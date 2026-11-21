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
  await expect(page.getByTestId("working-what")).toContainText("Running", { timeout: 60_000 });
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
