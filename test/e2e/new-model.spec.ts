import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a model its provider lists for the first time is news. The home says so in one line, and
// Settings > Models shows one card: the model, its provider, window, price and efforts, with an offer to
// try it in a role (reader, small model, builder). Nothing starts until the press. The trial is an
// experiment on half of the new session trees; the card shows its state and, once it ended, its result.
// The scripted provider lists the new model when a prompt says so (`script:list-model`).
const STAND_IN = "scripted:stand-in";

test("new model: the card appears, a trial starts on press and stops on press", async ({ page, request }) => {
  const models = async () => (await (await request.get("/api/models?refresh=1")).json()).models.map((m: any) => m.id) as string[];
  test.skip(!(await models()).includes(STAND_IN), "needs KEEL_SCRIPTED_PROVIDER=1: the scripted provider lists the new model");
  // A live experiment left running by another run would take the new sessions, and a second one is refused.
  for (const e of (await (await request.get("/api/experiments")).json()).experiments) {
    if (e.state === "running" && e.mode === "live") await request.post(`/api/experiments/${e.id}/stop`);
  }
  const tag = Math.random().toString(36).slice(2, 7);
  const fresh = `stand-in-fresh-${tag}`, id = `scripted:${fresh}`;
  const plain = `stand-in-bare-${tag}-plain`, plainId = `scripted:${plain}`;
  const say = async (text: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `new model ${tag}`, text } })).json();
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.last_end, { timeout: 30_000 }).toBeTruthy();
    return session.id as string;
  };
  const made: string[] = [];
  let trial: string | undefined;
  try {
    // The listing so far is the baseline: nothing in it is new.
    expect(await models()).not.toContain(id);
    expect((await (await request.get("/api/models/new")).json()).models.filter((m: any) => m.id === id)).toEqual([]);
    await say(`script:list-model ${fresh}`);
    expect(await models()).toContain(id);

    // The home says it in one line that leads to the card.
    await page.goto("/");
    const news = page.getByTestId("new-model-news");
    await expect(news).toBeVisible();
    await expect(news).toContainText("Scripted " + fresh);
    await shoot(page, "new-model-01-home");
    await news.click();

    const card = page.locator(`[data-testid="new-model"][data-model="${id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("new-model-name")).toHaveText(`Scripted ${fresh}`);
    await expect(card.getByTestId("new-model-facts")).toContainText("64k context");
    await expect(card.getByTestId("new-model-facts")).toContainText("$1 in, $5 out per million tokens");
    await expect(card.getByTestId("new-model-facts")).toContainText("efforts low, high");
    await expect(card).toHaveAttribute("data-trial", "none");
    // Nothing has started: no experiment is running.
    expect((await (await request.get("/api/experiments")).json()).experiments.some((e: any) => e.state === "running")).toBe(false);
    await shoot(page, "new-model-02-card");

    // The press starts the trial in the chosen role.
    await card.getByTestId("new-model-role-builder").click();
    await card.getByTestId("new-model-trial").click();
    await expect(card.getByTestId("new-model-state")).toHaveText("On trial");
    await expect(card).toHaveAttribute("data-trial", "running");
    const running = (await (await request.get("/api/experiments")).json()).experiments.filter((e: any) => e.state === "running");
    expect(running).toHaveLength(1);
    trial = running[0].id;
    expect(running[0].mode).toBe("live");
    expect(running[0].arms[1].settings.trial).toEqual({ role: "builder", model: id, exp: running[0].id });
    expect(running[0].arms[0].settings).toBeUndefined();

    // New session trees draw an arm; the trial arm's top session carries the trial, the other has none.
    const trees: boolean[] = [];
    while ((!trees.includes(true) || !trees.includes(false)) && trees.length < 24) {
      const sid = await say("Say hello.");
      made.push(sid);
      trees.push(!!(await (await request.get(`/api/sessions/${sid}`)).json()).session.settings.trial);
    }
    expect(trees).toContain(true);
    expect(trees).toContain(false);
    await expect(card.getByTestId("new-model-result")).toContainText(`${trees.length} session trees`);
    await expect(card.getByTestId("new-model-row-cost_usd")).toBeVisible();
    await shoot(page, "new-model-03-running");

    // A second trial is refused while one runs, and the card says so.
    expect((await request.post("/api/models/new/trial", { data: { model: id, role: "reader" } })).status()).toBe(409);

    // The press ends it; the card keeps the result.
    await card.getByTestId("new-model-stop").click();
    await expect(card.getByTestId("new-model-state")).toHaveText("Trial ended");
    await expect(card.getByTestId("new-model-decision")).toBeVisible();
    await expect(card.getByTestId("new-model-offer")).toBeVisible();
    expect((await (await request.get("/api/experiments")).json()).experiments.some((e: any) => e.state === "running")).toBe(false);
    await shoot(page, "new-model-04-ended");

    // Dismissed, it is news no more.
    await card.getByTestId("new-model-dismiss").click();
    await expect(card).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByTestId("new-model-news")).toHaveCount(0);

    // A model that lists no price takes no builder trial: the dollars an agent on it spends could not be counted.
    await say(`script:list-model ${plain}`);
    expect(await models()).toContain(plainId);
    await page.goto("/");
    await page.getByTestId("new-model-news").click();
    const bare = page.locator(`[data-testid="new-model"][data-model="${plainId}"]`);
    await expect(bare).toBeVisible();
    await expect(bare.getByTestId("new-model-role-builder")).toBeDisabled();
    await expect(bare.getByTestId("new-model-role-off")).toContainText("lists no price");
    await expect(bare.getByTestId("new-model-role-reader")).toBeEnabled();
    expect((await request.post("/api/models/new/trial", { data: { model: plainId, role: "builder" } })).status()).toBe(409);
    expect((await (await request.get("/api/experiments")).json()).experiments.some((e: any) => e.state === "draft" && e.name.includes(plain))).toBe(false);
    await bare.getByTestId("new-model-dismiss").click();
    await expect(bare).toHaveCount(0);
  } finally {
    // Put back what the test changed: the model is unlisted and its trial removed.
    if (trial) {
      await request.post(`/api/experiments/${trial}/stop`);
      await request.delete(`/api/experiments/${trial}`);
    }
    await say(`script:unlist-model ${fresh} script:unlist-model ${plain}`);
    await models();
  }
});

// Feature: a listing that brings hundreds of models is one summary and a list, not a card each. The summary
// says what to do once and shows the best three to try; the rest is a folded list by provider, one line a
// model, drawn only as far as it shows. The home's line leads to the summary. Dismissing puts them all away.
test("new models: a listing of hundreds is one summary and a folded list", async ({ page, request }) => {
  const FLOOD = 700, batch = `flood${Math.random().toString(36).slice(2, 6)}`;
  const models = async () => (await (await request.get("/api/models?refresh=1")).json()).models.map((m: any) => m.id) as string[];
  test.skip(!(await models()).includes(STAND_IN), "needs KEEL_SCRIPTED_PROVIDER=1: the scripted provider lists the models");
  for (const e of (await (await request.get("/api/experiments")).json()).experiments) {
    if (e.state === "running" && e.mode === "live") await request.post(`/api/experiments/${e.id}/stop`);
  }
  const say = async (text: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `new models ${batch}`, text } })).json();
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.last_end, { timeout: 30_000 }).toBeTruthy();
  };
  const news = async () => (await (await request.get("/api/models/new")).json()).models.filter((m: any) => m.id.startsWith(`scripted:${batch}.`)) as any[];
  try {
    await say(`script:list-models ${batch} ${FLOOD}`);
    expect((await models()).filter((id) => id.startsWith(`scripted:${batch}.`))).toHaveLength(FLOOD);
    expect(await news()).toHaveLength(FLOOD);

    for (const [w, h, name] of [[1920, 1040, "wide"], [390, 844, "narrow"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      const line = page.getByTestId("new-model-news");
      await expect(line).toContainText(`${FLOOD} new models`);
      await line.click();

      // One summary: the count, what a trial does said once, the best three as cards. Not a card each.
      const summary = page.getByTestId("new-models-summary");
      await expect(summary).toBeVisible();
      await expect(page.getByTestId("new-models-count")).toHaveText(`${FLOOD} new models`);
      await expect(page.getByTestId("new-models-note")).toContainText("Nothing starts until you press");
      await expect(page.getByTestId("new-models-best").getByTestId("new-model")).toHaveCount(3);
      await expect(page.getByTestId("new-model")).toHaveCount(3);
      await expect(page.getByText("Half of the new session trees would use it")).toHaveCount(0);
      // The page is the summary's height, not seven hundred cards'.
      const heightOf = async () => (await page.getByTestId("new-models").boundingBox())!.height;
      expect(await heightOf()).toBeLessThan(name === "wide" ? 1300 : 2400);
      await shoot(page, `new-models-flood-${name}-01-summary`);

      // The list is folded: providers, then one line a model, and only the rows in view are in the page.
      await page.getByTestId("new-models-toggle").click();
      const group = page.locator('[data-testid="new-models-group"][data-provider="scripted"]');
      await expect(group).toBeVisible();
      await expect(group.getByTestId("new-models-row")).toHaveCount(0);
      await group.getByTestId("new-models-group-toggle").click();
      await expect(group.getByTestId("new-models-row").first()).toBeVisible();
      expect(await group.getByTestId("new-models-row").count()).toBeLessThan(60);
      expect(await heightOf()).toBeLessThan(name === "wide" ? 2200 : 3200);
      // A row is one line: name, window, price, each at the same place on every row.
      const rows = group.getByTestId("new-models-row");
      const boxes = await Promise.all([0, 1, 2, 3].map(async (i) => (await rows.nth(i).locator("span").nth(1).boundingBox())!.x));
      expect(new Set(boxes.map((x) => Math.round(x))).size).toBe(1);
      expect((await rows.first().boundingBox())!.height).toBeLessThan(40);
      // Scrolling the list brings other rows, still few.
      const firstBefore = await rows.first().getAttribute("data-model");
      await group.getByTestId("new-models-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect.poll(async () => rows.last().getAttribute("data-model")).not.toBe(firstBefore);
      await expect(rows.last()).toBeVisible();
      expect(await rows.count()).toBeLessThan(60);
      // A press on a row opens its card, to try it.
      const last = (await rows.last().getAttribute("data-model"))!;
      await rows.last().click();
      await expect(group.getByTestId("new-models-picked").locator(`[data-model="${last}"]`)).toBeVisible();
      await expect(group.getByTestId("new-models-picked").getByTestId("new-model-trial")).toBeVisible();
      await shoot(page, `new-models-flood-${name}-02-list`);
    }

    // Dismissing puts every one away.
    await page.getByTestId("new-models-dismiss-all").click();
    await expect.poll(async () => (await news()).length).toBe(0);
    await expect(page.getByTestId("new-models-summary")).toHaveCount(0);
  } finally {
    await say(`script:unlist-models ${batch}`);
    await models();
  }
});
