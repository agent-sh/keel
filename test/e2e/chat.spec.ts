import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: start a session, the model calls tools, the reply streams in, the
// turn footer shows usage with cache reads; a second message continues it.
test("chat with tools", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await page.goto("/");
  await expect(page.getByText("What should we work on?")).toBeVisible();
  await shoot(page, "01-home");

  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("haiku 5.5");
  await page.getByRole("option").first().click();
  await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5");

  await page.getByTestId("composer").fill("List the files in the working directory with Bash, then tell me how many there are in one short sentence.");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/s\//);
  await expect(page.getByTestId("user-message")).toBeVisible();
  await expect(page.getByTestId("tool-call").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("assistant-text").last()).not.toBeEmpty();
  await shoot(page, "02-turn-done");

  await page.getByTestId("tool-call").first().click();
  await expect(page.getByTestId("tool-call").first().locator("pre").first()).toBeVisible();
  await shoot(page, "03-tool-open");

  await page.getByTestId("composer").fill("Now say only the word done.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 120_000 });
  await expect(page.getByTestId("turn-end").last()).toContainText("cached");
  await shoot(page, "04-second-turn");

  await expect(page.getByTestId("session-list")).toContainText("List the files");

  // Opened fresh, the session page asks for its snapshot once: the socket's replay brings the rest.
  const id = new URL(page.url()).pathname.split("/s/")[1]!;
  const loads: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname === `/api/sessions/${id}`) loads.push(r.url()); });
  await page.reload();
  await expect(page.getByTestId("turn-end")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete");
  await page.waitForLoadState("networkidle");
  expect(loads).toHaveLength(1);
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A session whose conversation is still on its way says so, in the shape of
// what is coming, instead of an empty pane that reads as an empty session.
test("a session that is loading shows that it is loading", async ({ page, request }) => {
  test.skip(!(await (await request.get("/api/models")).json()).models.some((m: { id: string }) => m.id === "scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title } })).json()).session.id as string;
  const slow = await mk("Slow to load");
  const other = await mk("Open first");
  try {
    expect((await request.post(`/api/sessions/${slow}/messages`, { data: { text: "A prompt in the slow session." } })).ok()).toBe(true);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${slow}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 15_000 }).toBe(true);
    await page.goto(`/s/${other}`);
    await expect(page.getByTestId("composer")).toBeVisible();
    // The conversation takes 2.5 s to come.
    await page.route(`**/api/sessions/${slow}`, async (r) => { await new Promise((done) => setTimeout(done, 2_500)); await r.fallback(); });
    await page.locator(`[data-testid="session-row"][data-session="${slow}"]`).click();
    const loading = page.getByTestId("transcript-loading");
    await expect(loading).toBeVisible({ timeout: 1_500 });
    await expect(loading).toContainText("Loading the conversation");
    // It fades in after a moment: the shot is taken once it is fully there.
    await expect.poll(() => loading.locator("div").first().evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await expect(page.getByTestId("user-message")).toHaveCount(0);
    await shoot(page, "05-loading-session");
    await expect(page.getByTestId("user-message")).toContainText("A prompt in the slow session.", { timeout: 15_000 });
    await expect(loading).toHaveCount(0);
  } finally {
    for (const id of [slow, other]) await request.delete(`/api/sessions/${id}`);
  }
});
