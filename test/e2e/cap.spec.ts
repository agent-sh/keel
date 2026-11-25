import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a dollar cap for a session and everything it starts. The owner sets it from the
// session's header; its row and header show the share spent and the rate of the last ten minutes
// with the hour's forecast; at 80 percent the failures list tells it once with the spend and the
// forecast; at 100 percent the agents below it end with their report and the session writes its
// own last step; one press on Raise doubles it and the work goes on.
test("a dollar cap: set in the header, told at 80 percent, stops new work at 100, raised in one press", async ({ page, request }) => {
  test.setTimeout(240_000);
  const model = "scripted:stand-in-strict";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "needs the scripted provider: the stand-in takes a tool every step");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Capped tree" } })).json();
  const id = session.id as string;
  type A = { id: string; session_id: string; status: string; end_reason?: string | null };
  const agent = async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as A[])[0];
  const events = async (sid: string) => (await (await request.get(`/api/sessions/${sid}`)).json()).events as any[];
  const idle = async (sid: string) => { const d = await (await request.get(`/api/sessions/${sid}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
  const cap = async () => (await (await request.get(`/api/sessions/${id}/cap`)).json()).cap as { usd: number; spent: number; level: string; burn_hour: number; forecast_hour: number } | null;
  const users = async (sid: string) => JSON.stringify((await events(sid)).filter((e) => e.kind === "user").map((e) => e.data));
  const step = (n: number) => ({ name: "Bash", input: { command: `echo step-${n}` } });
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });

    // Set from the header: the button is in the session's menu, with the other actions.
    await page.goto(`/s/${id}`);
    await page.getByTestId("session-menu").click();
    await page.getByTestId("cap-set").click();
    await page.getByTestId("cap-input").fill("0.01");
    await page.getByTestId("cap-apply").click();
    await expect(page.getByTestId("cap-figure")).toContainText("of $0.01");
    expect((await (await request.get(`/api/sessions/${id}`)).json()).session.settings.cap_usd).toBe(0.01);
    await expect(page.getByTestId("session-row").filter({ hasText: "Capped tree" }).getByTestId("row-cap")).toBeVisible();
    await page.keyboard.press("Escape");

    // An agent works steps until the tree's spend passes the cap.
    const task = `Counter\nscript:calls ${JSON.stringify(Array.from({ length: 14 }, (_, i) => step(i + 1)))}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: task, isolation: "none" } }])}` } });
    await expect.poll(async () => (await agent())?.end_reason, { timeout: 90_000 }).toBe("budget");
    const a = (await agent())!;
    // Its last step says whose cap it was, and its parent is told what ended it.
    expect(await users(a.session_id)).toContain('The dollar cap of \\"Capped tree\\", the session above you, is reached');
    // The owner has an alert for it, worded as a cap and not as a provider's limit.
    await expect.poll(async () => ((await (await request.get("/api/alerts")).json()).alerts as any[]).some((x) => x.session_id === id && x.kind === "limit" && x.data?.cls === "cap"), { timeout: 60_000 }).toBe(true);
    // The agent's report waits for a raise: it starts no turn of the session, which spent nothing more.
    expect(await users(id)).not.toContain("the dollar cap of the session above it was reached");
    expect(await idle(id)).toBe(true);

    // The 80 percent was told once, with the spend and the forecast, in the session's failures list;
    // and that what waits for a raise is told once too.
    const { failures } = await (await request.get(`/api/errors?session=${id}`)).json();
    const told = failures.filter((g: any) => g.kind === "budget" && g.cls === "80%");
    expect(told).toHaveLength(1);
    expect(told[0].count).toBe(1);
    expect(failures.filter((g: any) => g.kind === "budget" && g.cls === "held").map((g: any) => g.count)).toEqual([1]);
    expect(told[0].sample).toMatch(/of the \$0\.01 cap \(\d+ percent\); at the last ten minutes' rate of \$[\d.]+ an hour it is \$[\d.]+ in an hour/);

    // What the page shows: the cap is reached, the rate and the hour's forecast stand beside it.
    const reached = (await cap())!;
    expect(reached.level).toBe("spent");
    expect(reached.spent).toBeGreaterThanOrEqual(0.01);
    expect(reached.burn_hour).toBeGreaterThan(0);
    expect(reached.forecast_hour).toBeGreaterThan(reached.spent);
    await page.reload();
    const chip = page.getByTestId("cap-chip");
    await expect(chip).toHaveAttribute("data-level", "spent");
    await expect(page.getByTestId("session-row").filter({ hasText: "Capped tree" }).getByTestId("row-cap")).toHaveAttribute("data-level", "spent");
    await chip.click();
    await expect(page.getByTestId("cap-reached")).toBeVisible();
    await expect(page.getByTestId("cap-burn")).toContainText("an hour");
    await expect(page.getByTestId("cap-forecast")).toBeVisible();
    await shoot(page, "cap-01-reached");

    // The owner's own message past the cap runs its turn whole, with a note that the cap is reached.
    const before = (await events(id)).filter((e) => e.kind === "turn_end").length;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say the owner speaks past the cap" } });
    await expect.poll(async () => (await events(id)).filter((e) => e.kind === "turn_end").length, { timeout: 60_000 }).toBeGreaterThan(before);
    expect((await events(id)).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
    expect(await users(id)).toContain("The owner wrote to you, so this turn goes on");
    expect(await users(id)).not.toContain("the dollar cap of the session above it was reached");

    // One press raises it: doubled, past the spend, and the work goes on.
    await page.getByTestId("cap-raise").click();
    await expect(chip).toHaveAttribute("data-level", "ok");
    expect((await cap())!.usd).toBeGreaterThanOrEqual(0.02);
    await expect(page.getByTestId("cap-reached")).toHaveCount(0);
    await shoot(page, "cap-02-raised");
    await page.keyboard.press("Escape");
    // What waited goes on by itself: the agent's report reaches the session.
    await expect.poll(async () => (await users(id)).includes("the dollar cap of the session above it was reached"), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => idle(id), { timeout: 60_000 }).toBe(true);
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});

// Feature: a cap that is set rests in the bar, below the permission mode: at the tightest width the mode stays
// at rest whatever the cap's chip does, and the chip never stands where the mode is not.
test("a set cap rests below the permission mode in the bar once half of it is spent, and is quiet in the menu before", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  const model = models.find((m) => m.id === "scripted:stand-in-strict")?.id;
  test.skip(!model, "needs the scripted provider: the stand-in takes a tool every step (its spend is priced)");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Capped bar" } })).json();
  try {
    const header = page.getByTestId("station").and(page.locator(`[data-station="${session.id}"]`)).getByTestId("session-header");
    const cap = async () => (await (await request.get(`/api/sessions/${session.id}/cap`)).json()).cap as { spent: number; pct: number } | null;
    // The cap counts what is spent after it is set.
    await request.put(`/api/sessions/${session.id}/cap`, { data: { usd: 5000 } });
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo spent" } }, { name: "Bash", input: { command: "echo spent again" } }])}` } });
    await expect.poll(async () => { const d = await (await request.get(`/api/sessions/${session.id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 60_000 }).toBe(true);
    // Far from the cap: the chip is quiet, in the session's menu. (The mode is in the message box's row, not the bar.)
    const spent = (await cap())!.spent;
    test.skip(!(spent > 0), "needs a priced turn: the stand-in's spend is not counted here");
    for (const width of [1050, 1366, 1920]) {
      await page.setViewportSize({ width, height: 1040 });
      await page.goto(`/s/${session.id}`);
      await expect(header.getByTestId("head-mode")).toHaveCount(0);
      await page.mouse.move(width / 2, 900);
      await expect(header.getByTestId("cap-chip"), `at ${width} a cap far from its limit is not in the bar`).toHaveCount(0);
      await header.getByTestId("session-menu").click();
      await expect(page.getByTestId("header-more").getByTestId("cap-chip")).toBeVisible();
      await page.keyboard.press("Escape");
      await shoot(page, `cap-03-quiet-${width}`);
    }
    // Past half of it, a chip that has room rests in the bar.
    // (A cap is whole cents, so it is set from what was spent, to the cent, until the spend is past half of it.)
    await expect.poll(async () => { await request.put(`/api/sessions/${session.id}/cap`, { data: { usd: Math.max(0.01, Math.round((await cap())!.spent * 125) / 100) } }); return (await cap())!.pct; }).toBeGreaterThan(0.5);
    for (const width of [1050, 1366, 1920]) {
      await page.setViewportSize({ width, height: 1040 });
      await page.goto(`/s/${session.id}`);
      await expect(header.getByTestId("head-mode")).toHaveCount(0);
      await page.mouse.move(width / 2, 900);
      // A chip that has room rests in the bar.
      const chip = header.getByTestId("cap-chip");
      if (width > 1050) await expect(chip, `at ${width} a set cap rests in the bar`).toBeVisible();
      if (!(await chip.count())) {
        // No room: it is in the session's menu.
        await header.getByTestId("session-menu").click();
        await expect(page.getByTestId("header-more").getByTestId("cap-chip")).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await shoot(page, `cap-03-bar-${width}`);
    }
    // (A cap is whole cents: the nearest cent from below puts the share between half and all of it.)
    // Raise from past half: the share falls under half, and the chip that came to rest stays in the bar with its popup open, on the new figure.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${session.id}`);
    await request.put(`/api/sessions/${session.id}/cap`, { data: { usd: Math.max(0.01, Math.floor((await cap())!.spent * 200) / 100) } });
    const resting = header.getByTestId("cap-chip");
    await expect(resting).toBeVisible();
    const before = (await cap())!.pct;
    expect(before).toBeGreaterThanOrEqual(0.5);
    await resting.click();
    await expect(page.getByTestId("cap-popup")).toBeVisible();
    await page.getByTestId("cap-raise").click();
    await expect.poll(async () => (await cap())!.pct).toBeLessThan(0.5);
    await expect(page.getByTestId("cap-spent")).toContainText(`(${Math.floor((await cap())!.pct * 100)}%)`);
    await expect(page.getByTestId("cap-popup")).toBeVisible();
    await expect(resting).toBeVisible();
    await shoot(page, "cap-04-raised-under-half");
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});
