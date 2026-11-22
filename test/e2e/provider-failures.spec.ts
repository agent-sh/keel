import { expect, test, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: what the owner sees when the provider fails or stops early. A real
// model cannot be made to do these on demand, so the scripted stand-in
// provider (src/providers/scripted.ts, listed only when the daemon runs with
// KEEL_SCRIPTED_PROVIDER=1) plays each one: a 429 with retry-after and a 529
// (countdown, then the answer), a dropped stream (its half reply is gone), a
// reply cut at the output limit inside a tool call and a pause_turn (both go on
// in the same turn), a refusal (the card, then a retry on another model), a
// request too long for the window and a context that fills up (compaction).
const STAND_IN = "scripted:stand-in";

async function send(page: Page, text: string, ends: number) {
  const composer = page.getByTestId("composer");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(ends, { timeout: 30_000 });
}

test("retries, continuation, refusal and compaction as the owner sees them", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");

  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  // The cut-call case runs a command; approvals have their own e2e.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  const texts = page.getByTestId("assistant-text");

  // 429 with retry-after 4 s: the provider's message, a countdown and the attempt.
  await composer.fill("script:rate-limit");
  await composer.press("Enter");
  const retrying = page.getByTestId("retrying");
  await expect(retrying).toContainText("429 rate limited");
  await expect(retrying).toContainText(/retrying in [1-4]s, attempt 1 of 9/);
  await shoot(page, "failures-01-retry-countdown");
  await expect(texts.last()).toHaveText("Answered after the rate limit passed.", { timeout: 15_000 });
  await expect(retrying).toHaveCount(0);

  // 529 twice: backoff without retry-after, attempt 2 shown.
  await composer.fill("script:overloaded");
  await composer.press("Enter");
  await expect(retrying).toContainText(/attempt 2 of 9/, { timeout: 5_000 });
  await expect(texts.last()).toHaveText("Answered after the overload passed.", { timeout: 15_000 });

  // A model slow to start: the working line says what the turn waits on.
  await composer.fill("script:slow");
  await composer.press("Enter");
  await expect(page.getByTestId("working")).toContainText(/Calling Scripted stand-in\s*2s/);
  await expect(texts.last()).toHaveText("Answered after a slow start.", { timeout: 15_000 });

  // Connected but no output yet (only keep-alives): said apart from the network wait.
  await composer.fill("script:quiet");
  await composer.press("Enter");
  await expect(page.getByTestId("working")).toContainText(/Connected to Scripted stand-in, no output yet\s*2s/);
  await shoot(page, "failures-03-connected-quiet");
  await expect(texts.last()).toHaveText("Answered after a quiet start.", { timeout: 15_000 });

  // A dropped stream: the half reply is shown while it streams, then dropped.
  await composer.fill("script:drop");
  await composer.press("Enter");
  await expect(page.getByTestId("transcript")).toContainText("This half reply");
  await expect(texts.last()).toHaveText("The whole reply, after the dropped stream.", { timeout: 15_000 });
  await expect(page.getByTestId("transcript")).not.toContainText("This half reply");

  // Cut at the output limit inside a tool call: the whole call before it runs,
  // the cut one is kept but never run, and the turn goes on after a harness note.
  await send(page, "script:cut", 6);
  await expect(page.getByTestId("harness-note").last()).toContainText("cut off at the output limit");
  await expect(texts.last()).toHaveText("Part two, continued after the cut.");
  // The two calls are one step of the rail: its line counts them, and it opens to both.
  await expect(page.getByTestId("work-step").last()).toHaveAttribute("data-calls", "2");
  const results = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results);
  expect(results.find((r: any) => r.tool_use_id.startsWith("whole-")).content).toContain("first-ran");
  expect(results.find((r: any) => r.tool_use_id.startsWith("cut-")).content).toContain("Not run: this call was cut at the output limit");

  // pause_turn: the same request goes on, one turn, two replies.
  await send(page, "script:pause", 7);
  await expect(texts.nth(-2)).toHaveText("Paused at a server tool.");
  await expect(texts.last()).toHaveText("Resumed after the pause.");
  await shoot(page, "failures-02-continued");

  // A provider that asks to wait longer than a turn waits: no early retry, the
  // turn ends with the time it named.
  await send(page, "script:rate-limit-long", 8);
  await expect(page.getByTestId("turn-error").last()).toContainText(/asked to wait until \d\d:\d\d/);
  // The turn goes on by itself when the wait is over: its footer says it waits, not that it failed.
  await expect(page.getByTestId("turn-end").last()).toContainText("Waiting for the provider");

  // A refusal: the card with the category and explanation, then a retry on another listed model.
  await send(page, "script:refuse", 9);
  const card = page.getByTestId("refusal");
  await expect(card).toContainText("The model declined this request");
  await expect(card).toContainText("cyber");
  await expect(card).toContainText("Scripted refusal for the test.");
  await expect(page.getByTestId("turn-end").last()).toContainText("Declined");
  await shoot(page, "failures-03-refusal");
  await card.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("Scripted backup");
  await page.getByRole("option", { name: /Scripted backup/ }).first().click();
  await card.getByRole("button", { name: "Retry on it" }).click();
  // The retry is a model switch like the picker's: the warm cache is warned about first.
  await page.getByTestId("confirm").getByRole("button", { name: "Switch" }).click();
  await expect(texts.last()).toHaveText("The backup model took the request.", { timeout: 15_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(10);

  // A new session for the window: a request too long compacts what came before
  // the prompt and goes on (the prompt itself is sent whole after the summary).
  // Its compaction line is set low, so one long reply reaches it.
  const { session: s2 } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  await request.patch(`/api/sessions/${s2.id}`, { data: { settings: { compact_at: 6_800 } } });
  await page.goto(`/s/${s2.id}`);
  await send(page, "Hello.", 1);
  await send(page, "script:overflow", 2);
  await expect(page.getByTestId("compacted")).toContainText("Context compacted automatically");
  await expect(texts.last()).toHaveText("Answered after compacting to fit.");

  // A long reply takes the context past its compaction line: the meter says
  // where that is, and the next turn compacts before its request.
  await send(page, "script:fill", 3);
  await page.getByTestId("context-meter").click();
  await expect(page.getByTestId("context-popup")).toContainText("of 64k tokens · compacts at 6.8k");
  await shoot(page, "failures-04-context-full");
  await page.keyboard.press("Escape");
  await send(page, "Anything else?", 4);
  await expect(page.getByTestId("compacted")).toHaveCount(2);
  await expect(texts.last()).toHaveText("Scripted reply, after a compaction.");
  await shoot(page, "failures-05-auto-compacted");

  // A context that grows turn by turn: past 70% of the way to its compaction
  // line a summary is written in the background; at the line it swaps in
  // without a wait, and the steps after the point it covers stay verbatim.
  const { session: s3 } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  await request.patch(`/api/sessions/${s3.id}`, { data: { settings: { compact_at: 6_800 } } });
  await page.goto(`/s/${s3.id}`);
  for (let n = 1; n <= 8; n++) await send(page, `script:grow ${n}`, n);
  await expect(page.getByTestId("compacted")).toContainText("summary prepared ahead");
  await expect(page.getByTestId("compacting")).toHaveCount(0);
  const cp = (await (await request.get(`/api/sessions/${s3.id}`)).json()).events.find((e: any) => e.kind === "compaction");
  expect(cp.data.ahead).toBe(true);
  expect(cp.data.covered).toBeTruthy();
  await page.getByTestId("compacted").scrollIntoViewIfNeeded();
  await shoot(page, "failures-06-prepared-ahead");

  // The passing failures are recorded as provider errors of the first session
  // (a kind of failure is one row with a count); the second failed nothing.
  const errors = (await (await request.get("/api/errors")).json()).errors;
  const mine = errors.filter((e: any) => e.session_id === session.id);
  for (const m of ["Scripted: 429 rate limited, retry after 4 s", "Scripted: 529 overloaded", "Scripted: the stream broke"]) expect(mine.map((e: any) => e.message)).toContain(m);
  for (const e of mine) expect(e.source).toBe("provider");
  expect(errors.filter((e: any) => e.session_id === s2.id)).toEqual([]);
});

// Feature: the box a failed turn leaves. It comes before the turn's footer,
// leads with what failed in plain words, gives the provider's words with the
// address in them as a link, and offers what fits as labelled buttons: the
// page that fixes it, trying again, another model. A turn with no reply has
// nothing to copy, mark or rate, so its footer offers none of that; only the
// failure the session stopped on has buttons.
test("a failure box leads with plain words, links its address and offers what fits", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Out of credit" } })).json();
  try {
    await page.goto(`/s/${session.id}`);
    await send(page, "script:billing please summarize", 1);
    const box = page.getByTestId("turn-error");
    await expect(box).toHaveCount(1);
    await expect(box.getByTestId("failure-lead")).toHaveText("The provider's account is out of credit or over its quota.");
    await expect(box.getByTestId("failure-words")).toContainText("Scripted: your credit balance is too low to make this request. Add credits at https://example.com/billing.");
    await expect(box.getByTestId("failure-words")).not.toContainText("HTTP 402:");
    await expect(box.getByTestId("failure-status")).toHaveText("HTTP 402");
    const link = box.getByTestId("failure-url");
    await expect(link).toHaveAttribute("href", "https://example.com/billing");
    await expect(link).toHaveAttribute("target", "_blank");
    const fix = box.getByTestId("failure-fix");
    await expect(fix).toHaveText("Open billing");
    await expect(fix).toHaveAttribute("href", "https://example.com/billing");
    await expect(box.getByTestId("try-again")).toHaveText("Try again");
    await expect(box.getByTestId("failure-switch")).toHaveText("Switch model");

    // The failure first, then the footer, which offers only what applies to a turn with no reply.
    const foot = page.getByTestId("turn-end").last().locator("xpath=..");
    expect((await box.boundingBox())!.y).toBeLessThan((await foot.boundingBox())!.y);
    await expect(foot.getByTestId("turn-reason")).toHaveText("Failed");
    await expect(foot.locator('[data-testid^="rowaction-"]')).toHaveCount(0);
    await expect(foot.getByTestId("copy-reply")).toHaveCount(0);
    await expect(foot.getByTestId("resume")).toHaveCount(0);
    await expect(foot.getByTestId("retry")).toHaveCount(1);
    await shoot(page, "failures-08-billing-box");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(box.getByTestId("try-again")).toBeVisible();
    await shoot(page, "failures-09-billing-box-narrow");
    await page.setViewportSize({ width: 1920, height: 1040 });

    // Try again says what happened (the turn failed, it was not stopped); the new failure has the buttons, the old one none.
    await box.getByTestId("try-again").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("harness-note").last()).toHaveText("Keel to the modelThe previous turn failed before it finished. Try again, and continue where it left off.");
    await expect(box).toHaveCount(2);
    await expect(page.getByTestId("failure-actions")).toHaveCount(1);
    await expect(box.last().getByTestId("failure-actions")).toHaveCount(1);

    // Another model takes the same request.
    await box.last().getByTestId("failure-switch").click();
    const pick = box.last().getByTestId("failure-models");
    await pick.getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("Scripted backup");
    await page.getByRole("option", { name: /Scripted backup/ }).first().click();
    await pick.getByRole("button", { name: "Try on it" }).click();
    const confirm = page.getByTestId("confirm").getByRole("button", { name: "Switch" });
    await Promise.race([confirm.click(), expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 30_000 })]).catch(() => {});
    await expect(page.getByTestId("assistant-text").last()).toHaveText("The backup model took the request.", { timeout: 30_000 });
    await expect(page.getByTestId("failure-actions")).toHaveCount(0);
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});
