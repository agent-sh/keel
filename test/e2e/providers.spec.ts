import { expect, test, type Page } from "./isolate.ts";
import { HAIKU, shoot, SCRIPTED } from "./shots.ts";

// Feature: Settings > Providers shows every provider with its listing state and
// the plugins; one session moves between providers and model families
// (Claude on Bedrock, GPT on the ChatGPT sign-in, then a provider plugin)
// and each turn runs its tool call and shows its cost where a price is known.
// Every model comes from this daemon's listing; a step whose kind of model is
// not listed here is skipped with a note, so the spec runs on any accounts.
type Listed = { id: string; name: string; provider: string; family: string };
const pick = async (page: Page, m: Listed) => {
  await page.getByTestId("model-picker").last().click();
  await page.getByPlaceholder("Search models").fill(m.name);
  await page.locator(`[data-testid="model-option"][data-model="${m.id}"]`).first().click();
  // With a warm prompt cache the switch asks first (switch-warning.spec covers it).
  const confirm = page.getByTestId("confirm");
  const trigger = page.getByTestId("model-picker").last().filter({ hasText: m.name });
  await expect(confirm.or(trigger)).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: "Switch" }).click();
  await expect(trigger).toBeVisible();
};

test("providers and a cross-family session", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs the listings of real providers, and models of two families");
  // A refresh first: a listing that keeps failing is recorded once, so the
  // refresh in the panel below adds no error.
  const providers = await (await request.post("/api/providers/refresh", { data: {}, timeout: 120_000 })).json();
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;

  await page.goto("/settings/providers");
  const panel = page.getByTestId("providers-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-provider="bedrock"]')).toContainText("models");
  await panel.getByTestId("providers-refresh").click();
  await expect(panel.getByTestId("providers-refresh")).toBeEnabled({ timeout: 120_000 });
  // The plugins are Settings > Plugins's: here one line links there, no copy of their rows.
  await expect(panel.getByTestId("plugin-row")).toHaveCount(0);
  if (providers.plugins.length) await expect(panel.getByTestId("providers-plugins-link")).toContainText(`${providers.plugins.length} provider plugin`);
  await shoot(page, "providers-01-panel");
  if (providers.plugins.length) {
    await panel.getByTestId("providers-plugins-link").click();
    await expect(page.getByTestId("plugins-settings")).toBeVisible();
  }
  await page.goto("/");

  const listed: Listed[] = (await (await request.get("/api/models")).json()).models;
  const haiku = listed.find((m) => m.id === HAIKU);
  expect(haiku, `${HAIKU} is listed`).toBeTruthy();
  await pick(page, haiku!);
  await page.getByTestId("composer").fill("Run `echo one` with the Bash tool, then reply with its output only.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("turn-cost").first()).toBeVisible();

  let turns = 1;
  // A GPT model on a built-in provider, the ChatGPT sign-in first.
  const gpts = listed.filter((m) => m.family === "gpt" && !m.provider.includes("/") && !/pro|high/i.test(m.name));
  const gpt = gpts.find((m) => m.provider === "chatgpt") ?? gpts[0];
  if (!gpt) test.info().annotations.push({ type: "skipped step", description: "no GPT model is listed on this daemon" });
  if (gpt) {
    await pick(page, gpt);
    await page.getByTestId("composer").fill("Run `echo two` with your shell tool, then reply with its output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(++turns, { timeout: 120_000 });
  }
  // A plugin provider's model: one whose family is not Claude, to cross a wire.
  const viaPlugin = listed.find((m) => m.provider.includes("/") && m.family !== "claude" && !/pro|high|orchestr/i.test(m.name));
  if (!viaPlugin) test.info().annotations.push({ type: "skipped step", description: "no provider plugin lists a non-Claude model here" });
  if (viaPlugin) {
    await pick(page, viaPlugin);
    await page.getByTestId("composer").fill("Run `echo three` with your shell tool, then reply with its output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(++turns, { timeout: 120_000 });
  }
  await expect(page.getByTestId("assistant-text").last()).not.toBeEmpty();
  expect(await page.getByTestId("tool-call").count()).toBeGreaterThanOrEqual(turns);
  await shoot(page, "providers-02-switched");

  // The usage report prices the Bedrock calls and counts the plan calls as included.
  const sid = page.url().match(/\/s\/([\w-]+)/)![1];
  const usage = await (await request.get(`/api/usage?group=provider&session_id=${sid}`)).json();
  const bedrock = usage.buckets.find((b: any) => b.key === "bedrock");
  expect(bedrock.priced_cost_usd).toBeGreaterThan(0);
  expect(usage.total.calls).toBeGreaterThanOrEqual(turns * 2);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// The report answers within a bound, also while a key is still being read
// (a keyring that waits on an unlock, a helper that hangs): it then says
// `keys_read: false`, and a provider it lists as set up may have no key.
// The page says the keys are still being read and reads again until they
// are. The daemon is real; its report is answered here as a daemon with a
// slow key store would: unread at first, with a provider nobody confirmed.
test("a report whose keys are still being read says so and is read again", async ({ page, request }) => {
  const real = await (await request.get("/api/providers")).json();
  expect(real.keys_read).toBe(true);
  const ghost = { id: "unread-e2e", label: "Unconfirmed provider", wire: "openai_chat", kind: "builtin", available: true, detail: "keyring unread-e2e-key", listing: { state: "never", models: 0 } };
  let reads = 0, unreadAnswers = 2;
  await page.route("**/api/providers", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    reads++;
    return r.fulfill({ json: unreadAnswers-- > 0 ? { ...real, keys_read: false, providers: [...real.providers, ghost] } : real });
  });
  await page.goto("/settings/providers");
  const panel = page.getByTestId("providers-panel");
  await expect(panel.getByTestId("providers-keys-unread")).toBeVisible();
  await expect(panel).toContainText("Unconfirmed provider");
  await shoot(page, "providers-05-keys-unread");
  // Read again without a click, until the keys are read: the unconfirmed provider goes, and so does the notice.
  await expect(panel.getByTestId("providers-keys-unread")).toHaveCount(0, { timeout: 15_000 });
  await expect(panel).not.toContainText("Unconfirmed provider");
  expect(reads).toBe(3);
  // And no more reads once they are.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 4000)));
  expect(reads).toBe(3);
});
