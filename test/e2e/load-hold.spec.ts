import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: agent trees wait for the machine. With the line set under any load the machine has (`load_hold.threads`),
// a loop run, which nobody at the keyboard started, waits at its next step after a minute over the line with the load in its status,
// the rail says how many trees wait, Settings > Health has the row, and the owner's own message still runs. Turning
// the hold off lets the run go on.
test("a loop run waits while the machine is over its line, the rail and Health say so, the owner's prompt runs", async ({ page, request }) => {
  test.setTimeout(240_000);
  const model = "scripted:stand-in";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "needs the scripted provider: a loop run whose reply is scripted");
  const make = async (title: string) => (await (await request.post("/api/sessions", { data: { model, title } })).json()).session.id as string;
  const events = async (sid: string) => (await (await request.get(`/api/sessions/${sid}`)).json()).events as any[];
  const ends = async (sid: string) => (await events(sid)).filter((e) => e.kind === "turn_end").length;
  const hold = async () => (await (await request.get("/api/load-hold")).json()) as { load1: number | null; over: boolean; held: { key: string }[] };
  const owner = await make("Load hold: owner");
  const looped = await make("Load hold: loop");
  let loop: { id: string } | undefined;
  try {
    // A line of a thousandth of a thread: a machine that runs a browser and a daemon is over it.
    expect((await request.patch("/api/settings", { data: { load_hold: { on: true, threads: 0.001 } } })).ok()).toBe(true);
    // Over once the readings cover a minute above the line.
    await expect.poll(async () => (await hold()).over, { timeout: 120_000 }).toBe(true);
    // The run's first step is a command that takes a while; the pulse holds its tree meanwhile and its next step waits.
    expect((await request.put(`/api/sessions/${looped}/permissions`, { data: { mode: "full-auto", sandbox: "off" } })).ok()).toBe(true);
    const calls = [{ name: "Bash", input: { command: "sleep 8" } }, { name: "Bash", input: { command: "echo the loop ran" } }];
    loop = await (await request.post("/api/loops", { data: { session_id: looped, name: "Held by load", schedule: "weekdays 09:30", prompt: `script:calls ${JSON.stringify(calls)}` } })).json();
    expect((await request.post(`/api/loops/${loop!.id}/run`)).ok()).toBe(true);
    await expect.poll(async () => (await hold()).held.map((h) => h.key), { timeout: 30_000 }).toEqual([looped]);
    await expect.poll(async () => (await events(looped)).some((e) => e.kind === "note" && e.data.kind === "spend_window"), { timeout: 15_000 }).toBe(true);
    expect((await events(looped)).find((e) => e.kind === "note" && e.data.kind === "spend_window")!.data.text).toContain("The machine is busy");
    await request.post(`/api/sessions/${owner}/messages`, { data: { text: "script:say the owner speaks while the machine is busy" } });
    await expect.poll(() => ends(owner), { timeout: 60_000 }).toBe(1);
    expect(await ends(looped)).toBe(0);

    await page.goto(`/s/${looped}`);
    await expect(page.getByTestId("dock-action-text")).toContainText("Waits for the machine: load", { timeout: 30_000 });
    await expect(page.getByTestId("dock-now")).toHaveAttribute("data-why", "machine");
    // The rail's line is read whole (its words are not cut), with the quiet grey mark of a wait for the machine,
    // never the owner's; its tooltip names the oldest wait, what lets it go, and that nothing is his to do.
    await expect(page.getByTestId("load-hold").locator(".k-load-line-what")).toHaveText("1 tree waits for the machine");
    await expect(page.getByTestId("load-hold").locator('.k-mark[data-watch="wait"][data-on="machine"]')).toHaveCount(1);
    await expect(page.getByTestId("load-hold")).toHaveAttribute("title", /^1 tree waits for the machine \(load \d+ on [\d.]+ threads\)\.\nThe oldest: Load hold: loop, \d+s for the load; it goes on as the load falls, the oldest first\.\nNothing for you to do for the machine/);
    // The session's own mark says it waits for the machine, in grey.
    await expect.poll(() => page.locator('.k-mark[data-on="machine"]').count(), { timeout: 15_000 }).toBeGreaterThan(1);
    expect(await page.locator('.k-mark[data-watch="need"]').count()).toBe(0);
    expect(await page.getByTestId("load-hold").locator(".k-load-line-what").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await shoot(page, "load-hold-00-held");
    await page.getByTestId("load-hold").click();
    await expect(page.getByTestId("health-panel")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    const row = page.locator('[data-testid="health-row"]').filter({ hasText: "1 tree waits for the machine" });
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    await shoot(page, "load-hold-01-health");

    // Off: the held run goes on by itself and the rail line is gone.
    expect((await request.patch("/api/settings", { data: { load_hold: { on: false, threads: null } } })).ok()).toBe(true);
    await expect.poll(() => ends(looped), { timeout: 60_000 }).toBe(1);
    expect((await events(looped)).some((e) => e.kind === "assistant")).toBe(true);
    await expect(page.getByTestId("load-hold")).toHaveCount(0);
  } finally {
    await request.patch("/api/settings", { data: { load_hold: { on: true, threads: null } } });
    if (loop) await request.delete(`/api/loops/${loop.id}`);
    await request.delete(`/api/sessions/${looped}`);
    await request.delete(`/api/sessions/${owner}`);
  }
});
