import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a session the model declined can start again from a capsule of its records, in one press on the
// declined notice: no model call makes the capsule, the owner's words stay as they were, and the declined
// reply is in neither the capsule nor the context. Runs on the scripted stand-in.
const STAND_IN = "scripted:stand-in";

test("a declined session starts again from a capsule, one press", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  await composer.fill("script:refuse zebrafruit");
  await composer.press("Enter");
  const card = page.getByTestId("refusal");
  await expect(card).toBeVisible({ timeout: 15_000 });
  const press = card.getByTestId("refusal-fresh");
  await expect(press).toBeVisible();
  await shoot(page, "fresh-start-01-declined");

  await press.click();
  // The capsule stands in the transcript where the history was, and the turn goes on from it.
  await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 15_000 });
  // The request is the same one, so the stand-in declines it again: the first notice no longer offers the
  // press (it is not the session's last turn), the new one does.
  await expect(page.getByTestId("refusal")).toHaveCount(2);
  await expect(page.getByTestId("refusal").first().getByTestId("refusal-fresh")).toHaveCount(0);
  await expect(page.getByTestId("refusal").last().getByTestId("refusal-fresh")).toHaveCount(1);
  await shoot(page, "fresh-start-02-started");

  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const cap = events.find((e) => e.kind === "compaction");
  expect(cap.data).toMatchObject({ trigger: "fresh_start", capsule: true, mode: "summary" });
  // The owner's words are kept as they were; the declined reply is nowhere in it.
  expect(cap.data.owner_messages.join("\n")).toContain("script:refuse zebrafruit");
  expect(JSON.stringify(cap.data).replace(/script:refuse zebrafruit/g, "")).not.toContain("zebrafruit");
});
