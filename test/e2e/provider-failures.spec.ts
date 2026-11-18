import { expect, test, type Page } from "@playwright/test";
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

  // A dropped stream: the half reply is shown while it streams, then dropped.
  await composer.fill("script:drop");
  await composer.press("Enter");
  await expect(page.getByTestId("transcript")).toContainText("This half reply");
  await expect(texts.last()).toHaveText("The whole reply, after the dropped stream.", { timeout: 15_000 });
  await expect(page.getByTestId("transcript")).not.toContainText("This half reply");

  // Cut at the output limit inside a tool call: the cut call is dropped and the
  // turn goes on after a harness note, in the same turn.
  await send(page, "script:cut", 4);
  await expect(page.getByTestId("harness-note").last()).toContainText("cut off at the output limit");
  await expect(texts.last()).toHaveText("Part two, continued after the cut.");
  await expect(page.getByTestId("tool-call")).toHaveCount(0);

  // pause_turn: the same request goes on, one turn, two replies.
  await send(page, "script:pause", 5);
  await expect(texts.nth(-2)).toHaveText("Paused at a server tool.");
  await expect(texts.last()).toHaveText("Resumed after the pause.");
  await shoot(page, "failures-02-continued");

  // A refusal: the card with the category and explanation, then a retry on another listed model.
  await send(page, "script:refuse", 6);
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
  await expect(texts.last()).toHaveText("The backup model took the request.", { timeout: 15_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(7);

  // A new session for the window: a request too long compacts and goes on.
  const { session: s2 } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  await page.goto(`/s/${s2.id}`);
  await send(page, "script:overflow", 1);
  await expect(page.getByTestId("compacted")).toContainText("Context compacted automatically");
  await expect(texts.last()).toHaveText("Answered after compacting to fit.");

  // A long reply fills the window past the threshold: the meter turns red and
  // the next turn compacts before its request.
  await send(page, "script:fill", 2);
  await page.getByTestId("context-meter").click();
  await expect(page.getByTestId("context-popup")).toContainText("of 8.0k tokens");
  await shoot(page, "failures-04-context-full");
  await page.keyboard.press("Escape");
  await send(page, "Anything else?", 3);
  await expect(page.getByTestId("compacted")).toHaveCount(2);
  await expect(texts.last()).toHaveText("Scripted reply, after a compaction.");
  await shoot(page, "failures-05-auto-compacted");

  // The passing failures are recorded as provider errors of the first session
  // (a kind of failure is one row with a count); the second failed nothing.
  const errors = (await (await request.get("/api/errors")).json()).errors;
  const mine = errors.filter((e: any) => e.session_id === session.id);
  expect(mine.map((e: any) => e.message).sort()).toEqual(["Scripted: 429 rate limited, retry after 4 s", "Scripted: 529 overloaded", "Scripted: the stream broke"]);
  for (const e of mine) expect(e.source).toBe("provider");
  expect(errors.filter((e: any) => e.session_id === s2.id)).toEqual([]);
});
