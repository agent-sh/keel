import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: Settings > Experiments. An experiment is made from a template in
// the page; a live one, started there, gives each new session an arm (the
// sessions panel counts them) and is stopped with a decision; an offline one
// shows the runner's uploaded runs as per-arm means with intervals, the
// effect against the control and the winner.
const STAND_IN = "scripted:stand-in";

test("experiments: create, run live, stop and decide; an offline report", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  // A live experiment left running by another run would take the new sessions.
  for (const e of (await (await request.get("/api/experiments")).json()).experiments) {
    if (e.state === "running" && e.mode === "live") await request.post(`/api/experiments/${e.id}/stop`);
  }
  const tag = Math.random().toString(36).slice(2, 7);

  await page.goto("/settings/experiments");
  const panel = page.getByTestId("experiments-panel");
  // isVisible does not wait: the panel's list must have loaded before it is asked.
  await expect(panel.getByTestId("experiment-create").or(panel.getByTestId("experiment-new")).first()).toBeVisible();
  if (!(await panel.getByTestId("experiment-create").isVisible())) await panel.getByTestId("experiment-new").click();
  await expect(panel.getByTestId("experiment-create")).toBeVisible();

  // From the "Effort level" template: a live experiment with two arms.
  await panel.getByTestId("experiment-template").click();
  await page.getByRole("option", { name: "Effort level" }).click();
  await expect(panel.getByTestId("experiment-arms")).toHaveValue(/"effort": "low"/);
  await panel.getByTestId("experiment-name").fill(`Effort ${tag}`);
  await shoot(page, "experiments-01-template");
  await panel.getByTestId("experiment-make").click();
  const detail = panel.getByTestId("experiment-detail");
  await expect(detail).toContainText(`Effort ${tag}`);
  await expect(detail.getByTestId("experiment-state")).toHaveText("draft");

  await detail.getByTestId("experiment-start").click();
  await expect(detail.getByTestId("experiment-state")).toHaveText("running");
  const id = (await (await request.get("/api/experiments")).json()).experiments.find((e: any) => e.name === `Effort ${tag}`).id;

  // New sessions get arms at their first turn; the low arm's sessions run at low effort.
  // Sessions until both arms have some (the split is a hash, so a few may land on one side).
  const made: string[] = [];
  const counts = async () => (await (await request.get(`/api/experiments/${id}`)).json()).experiment.sessions as { arm: string; n: number }[];
  while (made.length < 6 || ((await counts()).length < 2 && made.length < 24)) {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `exp ${tag} ${made.length}`, text: "Say hello." } })).json();
    made.push(session.id);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.last_end, { timeout: 30_000 }).toBeTruthy();
  }
  expect((await counts()).length).toBe(2);
  await expect.poll(async () => {
    const r = await (await request.get(`/api/experiments/${id}`)).json();
    return r.report.arms.reduce((n: number, a: any) => n + a.units, 0);
  }, { timeout: 30_000 }).toBe(made.length);
  // The low arm's sessions got its setting; the default arm's did not.
  const low = (await counts()).find((c) => c.arm === "low")!.n;
  const efforts = await Promise.all(made.map(async (sid) => (await (await request.get(`/api/sessions/${sid}`)).json()).session.settings.effort));
  expect(efforts.filter((x) => x === "low").length).toBe(low);
  await page.reload();
  await expect(detail.getByTestId("experiment-sessions")).toContainText("effort");
  await expect(detail.getByTestId("experiment-report")).toContainText("n=");
  await shoot(page, "experiments-02-live-running");

  await detail.getByTestId("experiment-stop").click();
  await expect(detail.getByTestId("experiment-state")).toHaveText("stopped");
  await expect(detail.getByTestId("experiment-decision")).toContainText("Decision");
  await expect(detail.getByTestId("experiment-stop-reason")).toContainText("stopped by the owner");
  // A session made after the stop is in no arm.
  const after = (await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `exp ${tag} after`, text: "Say hello." } })).json()).session;
  await expect.poll(async () => (await (await request.get(`/api/sessions/${after.id}`)).json()).session.settings.last_end, { timeout: 30_000 }).toBeTruthy();
  expect((await (await request.get(`/api/experiments/${id}`)).json()).experiment.sessions.reduce((n: number, s: any) => n + s.n, 0)).toBe(made.length);
  // The report is frozen with the decision: a reply rated down after the stop changes the telemetry, not the report.
  const final = await (await request.get(`/api/experiments/${id}`)).json();
  const reply = (await (await request.get(`/api/sessions/${made[0]}`)).json()).events.findLast((e: any) => e.kind === "assistant");
  expect((await request.post("/api/features/rating", { data: { event_id: reply.id, value: -1 } })).ok()).toBe(true);
  expect(await (await request.get(`/api/experiments/${id}`)).json()).toEqual(final);
  expect(final.report.arms.reduce((n: number, a: any) => n + a.units, 0)).toBe(made.length);
  await expect(detail.getByTestId("experiment-report")).toContainText("final, frozen when it stopped");
  await shoot(page, "experiments-03-live-decided");

  // Offline: the runner uploads one row per run; the report judges them.
  const off = (await (await request.post("/api/experiments", { data: { template: "readers", name: `Readers ${tag}` } })).json()).experiment;
  await request.post(`/api/experiments/${off.id}/start`);
  const runs = [];
  for (const task of ["readlog", "readspec", "readcode"]) for (let rep = 1; rep <= 3; rep++) {
    const base = { readlog: 0.006, readspec: 0.004, readcode: 0.005 }[task]! + rep * 0.0001;
    runs.push({ arm: "readers on", task, rep, metrics: { cost_usd: base * 0.7, ok: 1, prompt_tokens: 40_000 + rep * 300, ms: 14_000 + rep * 200 } });
    runs.push({ arm: "readers off", task, rep, metrics: { cost_usd: base, ok: 1, prompt_tokens: 66_000 + rep * 300, ms: 13_000 + rep * 200 } });
  }
  expect((await request.post(`/api/experiments/${off.id}/runs`, { data: { runs } })).status()).toBe(201);
  await request.post(`/api/experiments/${off.id}/stop`, { data: { reason: "the offline run finished" } });
  await page.reload();
  await panel.getByTestId("experiment-item").filter({ hasText: `Readers ${tag}` }).click();
  await expect(detail.getByTestId("metric-cost_usd")).toContainText("worse");
  await expect(detail.getByTestId("experiment-decision")).toContainText("readers on wins");
  await expect(detail.getByTestId("experiment-command")).toContainText(`--experiment ${off.id}`);
  await shoot(page, "experiments-04-offline-report");

  for (const x of [id, off.id]) await request.delete(`/api/experiments/${x}`);
  for (const s of [...made, after.id]) await request.delete(`/api/sessions/${s}`);
});
