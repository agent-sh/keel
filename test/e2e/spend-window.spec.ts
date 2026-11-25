import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: one spend cap for the whole daemon over a rolling window (Settings > Usage, off until the owner
// sets dollars and hours). At 80 percent the owner is told once; at 100 percent a loop run waits, with the
// reason stated, while the owner's own message in another session still runs with a note; raising the cap
// lets the held run go on.
test("a spend window: told at 80 percent, a loop run is held at the cap, the owner's prompt is not, raised it goes on", async ({ page, request }) => {
  test.setTimeout(180_000);
  const model = "scripted:stand-in";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "needs the scripted provider: priced models whose replies cost something");
  const make = async (title: string) => (await (await request.post("/api/sessions", { data: { model, title } })).json()).session.id as string;
  const events = async (sid: string) => (await (await request.get(`/api/sessions/${sid}`)).json()).events as any[];
  const ends = async (sid: string) => (await events(sid)).filter((e) => e.kind === "turn_end").length;
  const win = async () => (await (await request.get("/api/spend-window")).json()) as { cap: { usd: number; hours: number } | null; spent: number; level: string; rolls_at: number | null };
  const alerts = async () => ((await (await request.get("/api/alerts")).json()).alerts as any[]).filter((a) => a.kind === "limit" && a.data?.cls === "window");
  const owner = await make("Spend window: owner");
  const looped = await make("Spend window: loop");
  let loop: { id: string } | undefined;
  try {
    // Something to count: a turn of the owner's own, with the cap still off.
    expect((await win()).level).toBe("off");
    await request.post(`/api/sessions/${owner}/messages`, { data: { text: "script:say the first answer" } });
    await expect.poll(() => ends(owner), { timeout: 60_000 }).toBe(1);

    // Set from Settings > Usage: dollars and hours, both needed. Half a cap holds nothing.
    await page.goto("/settings/usage");
    const panel = page.getByTestId("usage-window");
    await expect(page.getByTestId("window-state")).toContainText("Off.");
    await panel.getByTestId("window-usd").fill("1000");
    await panel.getByTestId("window-usd").press("Enter");
    await expect(page.getByTestId("window-state")).toContainText("Set both numbers");
    await panel.getByTestId("window-hours").fill("24");
    await panel.getByTestId("window-hours").press("Enter");
    await expect(page.getByTestId("window-state")).toContainText("every session counted");
    const spent = (await win()).spent;
    expect(spent).toBeGreaterThan(0);
    // The bar is in view where the panel is first drawn at the window's height, with no scrolling.
    await page.goto("/settings/usage");
    await expect(page.getByTestId("window-bar")).toBeInViewport({ timeout: 15_000 });
    await shoot(page, "spend-window-00-in-view");
    expect((await alerts()).length).toBe(0);

    // Past 80 percent, under the cap: told once.
    await panel.getByTestId("window-usd").fill(String(spent / 0.9));
    await panel.getByTestId("window-usd").press("Enter");
    await expect.poll(async () => (await win()).level, { timeout: 30_000 }).toBe("warn");
    await expect.poll(async () => (await alerts()).length, { timeout: 30_000 }).toBe(1);
    expect((await alerts())[0].title).toContain("Spend window at 9");
    await page.getByTestId("window-state").scrollIntoViewIfNeeded();
    await shoot(page, "spend-window-01-warn");

    // At the cap: a loop run of a session waits and says why.
    await panel.getByTestId("window-usd").fill(String(spent / 2));
    await panel.getByTestId("window-usd").press("Enter");
    await expect.poll(async () => (await win()).level, { timeout: 30_000 }).toBe("spent");
    await expect(page.getByTestId("window-state")).toContainText("Reached");
    await expect.poll(async () => (await alerts()).length, { timeout: 30_000 }).toBe(2);
    await page.getByTestId("window-state").scrollIntoViewIfNeeded();
    await shoot(page, "spend-window-02-reached");
    loop = await (await request.post("/api/loops", { data: { session_id: looped, name: "Held loop", schedule: "weekdays 09:30", prompt: "script:say the loop ran" } })).json();
    expect((await request.post(`/api/loops/${loop!.id}/run`)).ok()).toBe(true);
    await expect.poll(async () => (await events(looped)).some((e) => e.kind === "note" && e.data.kind === "spend_window"), { timeout: 30_000 }).toBe(true);
    const note = (await events(looped)).find((e) => e.kind === "note" && e.data.kind === "spend_window")!;
    expect(note.data.text).toContain("This turn waits: the spend cap of");
    await page.goto(`/s/${looped}`);
    await expect(page.getByTestId("working-what")).toContainText("Waits for the spend window", { timeout: 30_000 });
    await shoot(page, "spend-window-03-held");
    expect((await events(looped)).some((e) => e.kind === "assistant")).toBe(false);

    // The owner's own message, in another session, runs whole with a note.
    await request.post(`/api/sessions/${owner}/messages`, { data: { text: "script:say the owner speaks past the cap" } });
    await expect.poll(() => ends(owner), { timeout: 60_000 }).toBe(2);
    expect((await events(owner)).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
    expect((await events(owner)).some((e) => e.kind === "note" && e.data.kind === "spend_window" && String(e.data.text).includes("goes on because the owner started it"))).toBe(true);
    expect((await ends(looped))).toBe(0);

    // Raised: the held run goes on by itself.
    await page.goto("/settings/usage");
    await page.getByTestId("window-usd").fill("1000");
    await page.getByTestId("window-usd").press("Enter");
    await expect.poll(() => ends(looped), { timeout: 60_000 }).toBe(1);
    expect((await events(looped)).some((e) => e.kind === "assistant")).toBe(true);
    await expect(page.getByTestId("window-state")).toContainText("every session counted");
    await page.getByTestId("window-state").scrollIntoViewIfNeeded();
    await shoot(page, "spend-window-04-raised");
  } finally {
    if (loop) await request.delete(`/api/loops/${loop.id}`);
    await request.patch("/api/settings", { data: { spend_window: { usd: null, hours: null } } });
    await request.delete(`/api/sessions/${looped}`);
    await request.delete(`/api/sessions/${owner}`);
  }
});
