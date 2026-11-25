import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: one switch for the whole fleet, in the menu of a pane's top bar. Paused, every start the owner did
// not make (a loop run here) waits with its reason, the owner's own message still runs, the bar says the fleet
// is paused, and a resume lets the held run go on.
test("pause the fleet from the top bar's menu: a loop run waits, the owner's prompt runs, resume frees the run", async ({ page, request }) => {
  test.setTimeout(180_000);
  const model = "scripted:stand-in";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "needs the scripted provider: a loop run whose reply is scripted");
  const make = async (title: string) => (await (await request.post("/api/sessions", { data: { model, title } })).json()).session.id as string;
  const events = async (sid: string) => (await (await request.get(`/api/sessions/${sid}`)).json()).events as any[];
  const ends = async (sid: string) => (await events(sid)).filter((e) => e.kind === "turn_end").length;
  const fleet = async () => (await (await request.get("/api/fleet-pause")).json()) as { paused: boolean; since: number | null };
  const owner = await make("Fleet pause: owner");
  const looped = await make("Fleet pause: loop");
  let loop: { id: string } | undefined;
  try {
    expect((await fleet()).paused).toBe(false);
    await page.goto(`/s/${owner}`);
    await page.getByTestId("session-menu").click();
    await expect(page.getByTestId("menu-fleet-pause")).toBeVisible();
    await shoot(page, "fleet-pause-00-menu");
    await page.getByTestId("menu-fleet-pause").click();
    await expect.poll(async () => (await fleet()).paused, { timeout: 15_000 }).toBe(true);
    await expect(page.getByTestId("fleet-paused-pill")).toBeVisible();
    await shoot(page, "fleet-pause-01-paused");

    // A loop run is held and says why; the owner's own message in another session runs whole.
    loop = await (await request.post("/api/loops", { data: { session_id: looped, name: "Held loop", schedule: "weekdays 09:30", prompt: "script:say the loop ran" } })).json();
    expect((await request.post(`/api/loops/${loop!.id}/run`)).ok()).toBe(true);
    await expect.poll(async () => (await events(looped)).some((e) => e.kind === "note" && e.data.kind === "spend_window"), { timeout: 30_000 }).toBe(true);
    expect((await events(looped)).find((e) => e.kind === "note" && e.data.kind === "spend_window")!.data.text).toContain("The owner paused the fleet");
    await request.post(`/api/sessions/${owner}/messages`, { data: { text: "script:say the owner speaks while paused" } });
    await expect.poll(() => ends(owner), { timeout: 60_000 }).toBe(1);
    expect((await events(owner)).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
    expect(await ends(looped)).toBe(0);
    expect((await events(looped)).some((e) => e.kind === "assistant")).toBe(false);
    await page.goto(`/s/${looped}`);
    await expect(page.getByTestId("dock-action-text")).toContainText("Waits for the fleet to resume", { timeout: 30_000 });
    await shoot(page, "fleet-pause-02-held");

    // The menu offers the way back; resumed, the held run goes on by itself and the pill is gone.
    await page.getByTestId("session-menu").click();
    await expect(page.getByTestId("menu-fleet-resume")).toBeVisible();
    await shoot(page, "fleet-pause-03-resume-row");
    await page.getByTestId("menu-fleet-resume").click();
    await expect.poll(async () => (await fleet()).paused, { timeout: 15_000 }).toBe(false);
    await expect(page.getByTestId("fleet-paused-pill")).toHaveCount(0);
    await expect.poll(() => ends(looped), { timeout: 60_000 }).toBe(1);
    expect((await events(looped)).some((e) => e.kind === "assistant")).toBe(true);
    await shoot(page, "fleet-pause-04-resumed");
  } finally {
    await request.post("/api/fleet-pause", { data: { on: false } });
    if (loop) await request.delete(`/api/loops/${loop.id}`);
    await request.delete(`/api/sessions/${looped}`);
    await request.delete(`/api/sessions/${owner}`);
  }
});
