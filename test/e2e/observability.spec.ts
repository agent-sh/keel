import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: Settings > Observability. Every turn is one row with its outcome
// and the features that shaped it; a readers job books what it saved against
// the working model reading the same material; the owner rates a reply under
// it; the view groups turns by feature, shows the savings, the daily trend
// and the regression check on the daily values.
const STAND_IN = "scripted:stand-in";

test("observability: turn rows, a rating, readers savings, the per-feature view", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  for (const e of (await (await request.get("/api/experiments")).json()).experiments) {
    if (e.state === "running" && e.mode === "live") await request.post(`/api/experiments/${e.id}/stop`);
  }
  const tag = Math.random().toString(36).slice(2, 7);
  const file = `material-${tag}.txt`;
  // A file long enough for readers, then a readers job over it (the scripted
  // stand-in sends the exact calls; its reader is itself).
  const calls = [
    { name: "Bash", input: { command: `seq 1 400 | sed 's/^/Line: the archive keeps each record with its owner, number /' > ${file}` } },
    { name: "ask_readers", input: { question: "What does each record keep?", paths: [file] } },
  ];
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Observe ${tag}` } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.last_end, { timeout: 60_000 }).toBe("end_turn");

  // The rating under the reply, kept across a reload.
  await page.goto(`/s/${session.id}`);
  const reply = page.getByTestId("assistant-text").last();
  await expect(reply).toContainText("Done with 2 calls");
  await reply.hover();
  const up = page.getByTestId("rowaction-rate-up").last();
  await up.click();
  await expect(up.locator("[data-rated]")).toHaveAttribute("data-rated", "on");
  await shoot(page, "observability-01-rated-reply");
  await page.reload();
  await page.getByTestId("assistant-text").last().hover();
  await expect(page.getByTestId("rowaction-rate-up").last().locator("[data-rated]")).toHaveAttribute("data-rated", "on");

  const f = await (await request.get("/api/features?period=day")).json();
  expect(f.total.thumbs_up).toBeGreaterThan(0);
  expect(f.savings.find((s: any) => s.feature === "readers")?.calls).toBeGreaterThan(0);

  await page.goto("/settings/observability");
  const panel = page.getByTestId("observability-panel");
  await panel.getByRole("radio", { name: "Day" }).click();
  await expect(panel.getByTestId("obs-turns")).not.toContainText(/^Turns0/);
  await expect(panel.getByTestId("obs-ratings")).toContainText(/rated up[1-9]/);
  await expect(panel.getByTestId("obs-savings")).toContainText("readers");
  const features = panel.getByTestId("obs-features");
  await expect(features.getByTestId("obs-group").filter({ hasText: /^used$/ })).toBeVisible();
  // A store with under 6 days of history has no normal range yet: no alert is raised from it.
  await panel.getByTestId("obs-check").click();
  await expect(panel.getByTestId("reg-cost_per_turn")).toContainText(/needs 6 days|ok|regression|good side/);
  await shoot(page, "observability-02-overview");
  await features.getByRole("radio", { name: "Model" }).click();
  await expect(features.getByTestId("obs-group").filter({ hasText: STAND_IN }).first()).toBeVisible();
  await features.scrollIntoViewIfNeeded();
  await shoot(page, "observability-03-by-model");

  await request.delete(`/api/sessions/${session.id}`);
});
