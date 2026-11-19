import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the model starts two background subagents in one step; they run as
// child sessions shown under the parent, live; their reports come back to the
// parent as one message; a running agent can be stopped from the page.
test("subagents run in parallel, report back, and stop", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const r = await request.post("/api/sessions", { data: { model: HAIKU } });
  const { session } = await r.json();
  // Commands run without cards here: the gate has its own e2e.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);

  await page.getByTestId("composer").fill(
    "Call the Agent tool twice in one message, both with run_in_background true: one agent counts the files in the working directory with Bash, the other prints the date with Bash. Then end your turn with one short line. When both reports arrive, answer in one sentence with both results.",
  );
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("agent-call")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("child-session")).toHaveCount(2);
  await expect(page.getByTestId("background-button")).toBeVisible();
  await shoot(page, "agents-01-started");

  await expect(page.getByTestId("agent-report")).toHaveCount(2, { timeout: 120_000 });
  // The reports may come in one message or two: wait until the parent is done with them.
  const idle = async () => {
    const d = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !d.running && d.events.at(-1)?.kind === "turn_end";
  };
  await expect.poll(idle, { timeout: 120_000 }).toBe(true);
  await expect(page.getByTestId("agent-call-status").first()).toHaveText("Done");
  await page.getByTestId("agent-report").first().click();
  await shoot(page, "agents-02-reported");

  await page.getByTestId("background-button").click();
  await expect(page.getByTestId("bg-agent")).toHaveCount(2);
  await shoot(page, "agents-03-background");
  await page.keyboard.press("Escape");

  await page.getByTestId("child-session").first().click();
  await expect(page.getByTestId("task-notice")).toBeVisible();
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await shoot(page, "agents-04-child");

  // A long agent, stopped by the owner from the agent card.
  await page.goto(`/s/${session.id}`);
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);
  await page.getByTestId("composer").fill("Call the Agent tool once with run_in_background true: the agent runs `sleep 120` with Bash, then reports. End your turn right after starting it.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("agent-call")).toHaveCount(3, { timeout: 60_000 });
  const card = page.getByTestId("agent-call").nth(2);
  await expect(card.getByTestId("agent-call-status")).toHaveText("Running in background", { timeout: 30_000 });
  await shoot(page, "agents-05-running");
  // Reading the running agent is safe: Escape from the page or from its
  // message box goes back to the parent and stops nothing.
  const parentUrl = page.url();
  for (const where of ["page", "composer"] as const) {
    await card.getByTestId("agent-call-open").click();
    await expect(page.getByTestId("task-notice")).toBeVisible();
    const child = page.url().split("/s/")[1]!;
    await expect(page.getByTestId("stop")).toHaveText("Stop this agent");
    // The head's line is the agent's task (or what it does now), never the harness's preamble.
    // Read once, as the page opens: the agent has usually not called a tool yet.
    const line = (await page.getByTestId("station-head").locator(".k-station-line").textContent()) ?? "";
    expect(line).not.toContain("subagent of a Keel session");
    expect(line).toContain("sleep 120");
    if (where === "page") { await shoot(page, "agents-05b-child-running"); await page.getByTestId("transcript").click(); }
    else await page.getByTestId("composer").focus();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(parentUrl);
    await page.waitForTimeout(1_000); // a stop request would have ended the turn by now
    expect((await (await request.get(`/api/sessions/${child}`)).json()).running).toBe(true);
    await expect(card.getByTestId("agent-call-status")).toHaveText("Running in background");
  }
  await card.getByTestId("agent-call-stop").click();
  // Who stopped it travels with it: the card and the report the parent got say it was the owner.
  await expect(card.getByTestId("agent-call-status")).toHaveText("Stopped · You stopped this agent", { timeout: 30_000 });
  await expect(page.getByTestId("agent-report-status").last()).toContainText("Stopped · You stopped this agent", { timeout: 60_000 });
  await shoot(page, "agents-06-stopped");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
  await request.delete(`/api/sessions/${session.id}`);
});

// Feature: a timer the model sets while its agents run (models do, though the
// spawn says the reports wake it) is cancelled by the last report, which says
// so, instead of waking the parent again after the work is done.
test("the last agent report ends a timer set while the agents ran", async ({ page, request }) => {
  const STAND_IN = "scripted:stand-in";
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Agents and a timer" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const calls = [
    { name: "spawn_agent", input: { message: "Slow helper\nscript:long-tool" } },
    { name: "wait_for", input: { kind: "timer", seconds: 600, note: "wait for the agent" } },
  ];
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("agent-report")).toHaveCount(1, { timeout: 90_000 });
  const timer = async () => (await (await request.get(`/api/sessions/${session.id}/background`)).json()).waits.find((w: any) => w.kind === "timer");
  await expect.poll(async () => (await timer())?.status, { timeout: 30_000 }).toBe("cancelled");
  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events;
  const report = events.find((e: any) => e.kind === "user" && String(e.data.text).includes("<subagent_result"));
  expect(report.data.text).toContain("cancelled now that their reports are in");
  await shoot(page, "agents-07-timer-ended");
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
  await request.delete(`/api/sessions/${session.id}`);
});

// Feature: an agent's own page stops it whole, as its card in the parent
// does (by the owner, its waits cancelled), and a held Escape on that page
// goes back to the parent once, stopping nothing there.
test("an agent's page stops the whole agent; a held Escape stops nothing", async ({ page, request }) => {
  const STAND_IN = "scripted:stand-in";
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Agent page stop" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const child = [{ name: "wait_for", input: { kind: "timer", seconds: 600, note: "check back" } }, { name: "Bash", input: { command: "sleep 40" } }];
  const calls = [{ name: "spawn_agent", input: { message: `Timer helper\nscript:calls ${JSON.stringify(child)}` } }, { name: "Bash", input: { command: "sleep 40" } }];
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  const agent = async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents[0];
  await expect.poll(async () => (await agent())?.session_id, { timeout: 30_000 }).toBeTruthy();
  const a = await agent();
  const timer = async () => (await (await request.get(`/api/sessions/${a.session_id}/background`)).json()).waits.find((w: any) => w.kind === "timer");
  await expect.poll(async () => (await timer())?.status, { timeout: 30_000 }).toBe("active");
  const running = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).running;
  await expect.poll(() => running(a.session_id), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => running(session.id), { timeout: 30_000 }).toBe(true);

  // Held: the first keydown goes back to the parent, the repeats stop nothing there.
  await page.goto(`/s/${a.session_id}`);
  await expect(page.getByTestId("stop")).toHaveText("Stop this agent");
  await page.getByTestId("transcript").click();
  await page.keyboard.down("Escape");
  await page.keyboard.down("Escape");
  await page.keyboard.down("Escape");
  await page.keyboard.up("Escape");
  await expect(page).toHaveURL(new RegExp(`/s/${session.id}$`));
  await page.waitForTimeout(1_000); // a stop would have ended the turn by now
  expect(await running(session.id)).toBe(true);

  // Stop from the agent's page: the agent is stopped by the owner and its timer goes.
  await page.goto(`/s/${a.session_id}`);
  await page.getByTestId("stop").click();
  await expect.poll(async () => (await agent()).status, { timeout: 30_000 }).toBe("stopped");
  expect((await agent()).stopped_by).toBe("owner");
  expect((await timer()).status).toBe("cancelled");
  await request.post(`/api/sessions/${session.id}/interrupt`);
  await request.delete(`/api/sessions/${session.id}`);
});
