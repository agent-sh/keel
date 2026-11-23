import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a session the owner stopped is paused, and its agents' reports start
// no turn in it. The page says how many wait. A loop run that goes on in the
// paused session brings a report along and shows as itself beside the report's
// card. Resume sends what still waits.
test("a paused session shows its waiting reports; a loop run brings one, Resume the other", async ({ page, request }) => {
  const STAND_IN = "scripted:stand-in";
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Paused coordinator" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const helper = (title: string, seconds: number) => ({
    name: "spawn_agent",
    input: { message: `${title}\nscript:calls ${JSON.stringify([{ name: "Bash", input: { command: `sleep ${seconds}` } }])}`, isolation: "none" },
  });
  const calls = [helper("Quick helper", 2), helper("Slow helper", 14), { name: "Bash", input: { command: "sleep 60" } }];
  let loop: { id: string } | undefined;
  try {
    const agents = async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents as { id: string; title: string; status: string }[];
    const status = async (title: string) => (await agents()).find((a) => a.title === title)?.status;
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify(calls)}`);
    await page.getByTestId("composer").press("Enter");
    await expect.poll(async () => (await agents()).length, { timeout: 30_000 }).toBe(2);
    await page.getByTestId("stop").click();
    await expect.poll(() => status("Quick helper"), { timeout: 30_000 }).toBe("completed");

    // Paused, nothing queued, one report waiting: the line says so and no turn started for it.
    const paused = page.getByTestId("queue-held");
    await expect(paused).toContainText("Paused after the stop.");
    await expect(page.getByTestId("queue-reports")).toHaveText("1 agent report is held.");
    await expect(page.getByTestId("agent-report")).toHaveCount(0);
    await shoot(page, "held-reports-01-paused");

    // A loop run goes on in the paused session: the report comes with it, and the run shows as itself.
    loop = await (await request.post("/api/loops", { data: { session_id: session.id, name: "Check lanes", schedule: "weekdays 09:30", prompt: "Say only the word tick." } })).json();
    expect((await request.post(`/api/loops/${loop!.id}/run`)).ok()).toBe(true);
    await expect(page.getByTestId("agent-report")).toHaveCount(1, { timeout: 30_000 });
    const run = page.getByTestId("loop-notice");
    await expect(run).toHaveCount(1);
    await run.getByRole("button").click();
    await expect(run).toContainText("Say only the word tick.");
    await expect(run).not.toContainText("subagent_result");
    await expect(page.getByTestId("queue-held")).toHaveCount(0); // nothing waits any more
    await shoot(page, "held-reports-02-loop-run");

    // The second agent finishes: still paused, so its report waits until the owner resumes.
    await expect.poll(() => status("Slow helper"), { timeout: 40_000 }).toBe("completed");
    await expect(page.getByTestId("queue-reports")).toHaveText("1 agent report is held.");
    await expect(page.getByTestId("agent-report")).toHaveCount(1);
    await paused.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByTestId("agent-report")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("queue-held")).toHaveCount(0);
    const { events } = await (await request.get(`/api/sessions/${session.id}`)).json();
    const carried = events.filter((e: any) => e.kind === "user").map((e: any) => (e.data.parts ?? [e.data]).map((p: any) => p.kind ?? "owner"));
    expect(carried).toEqual([["owner"], ["loop", "subagent"], ["subagent"]]);
  } finally {
    if (loop) await request.delete(`/api/loops/${loop.id}`);
    await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${session.id}`);
  }
});

// The owner's Stop of a coordinator ends its turn, not its agents: the Stop says they go on as it
// is pressed, the turn's end line counts them, and one button there stops them too.
test("a coordinator's Stop says its agents go on, and stops them too on asking", async ({ page, request }) => {
  const STAND_IN = "scripted:stand-in";
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Stopped coordinator" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const helper = (title: string) => ({ name: "spawn_agent", input: { message: `${title}\nscript:calls ${JSON.stringify([{ name: "Bash", input: { command: "sleep 120" } }])}`, isolation: "none" } });
  const calls = [helper("Long helper 1"), helper("Long helper 2"), { name: "Bash", input: { command: "sleep 60" } }];
  const agents = async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents as { id: string; status: string }[];
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify(calls)}`);
  await page.getByTestId("composer").press("Enter");
  await expect.poll(async () => (await agents()).filter((a) => a.status === "running").length, { timeout: 30_000 }).toBe(2);
  const stop = page.getByTestId("stop");
  await expect(stop).toHaveAttribute("data-leaves", "its 2 agents go on");
  await stop.click();
  await expect(page.getByTestId("composer-notice")).toContainText("its 2 agents go on");
  const end = page.getByTestId("turn-end").last();
  await expect(end.getByTestId("turn-reason")).toHaveText("Stopped by you");
  await expect(end.getByTestId("agents-go-on")).toHaveText("its 2 agents go on");
  await shoot(page, "held-reports-04-stop-leaves-agents");
  await page.getByTestId("stop-agents").click();
  await expect.poll(async () => (await agents()).filter((a) => a.status === "running" || a.status === "waiting").length, { timeout: 30_000 }).toBe(0);
  await expect(page.getByTestId("agents-go-on")).toHaveCount(0);
  await expect(page.getByTestId("stop-agents")).toHaveCount(0);
});
