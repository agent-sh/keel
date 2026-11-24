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

    // Set from the header: the button is in the row, or in the More list when the row is short.
    await page.goto(`/s/${id}`);
    const set = page.getByTestId("cap-set");
    if (!(await set.count())) await page.getByTestId("header-more-button").click();
    await set.click();
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
    await expect.poll(async () => (await users(id)).includes("the dollar cap of the session above it was reached"), { timeout: 60_000 }).toBe(true);
    // The session's own turn that took the report ends at the cap too, with its own last step.
    await expect.poll(() => idle(id), { timeout: 60_000 }).toBe(true);
    expect(await users(id)).toContain("The dollar cap of this session is reached");
    expect((await events(id)).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("budget");

    // The owner has an alert for it, worded as a cap and not as a provider's limit.
    const { alerts } = await (await request.get("/api/alerts")).json();
    expect(alerts.some((x: any) => x.session_id === id && x.kind === "limit" && x.data?.cls === "cap")).toBe(true);

    // The 80 percent was told once, with the spend and the forecast, in the session's failures list.
    const { failures } = await (await request.get(`/api/errors?session=${id}`)).json();
    const told = failures.filter((g: any) => g.kind === "budget");
    expect(told).toHaveLength(1);
    expect(told[0].cls).toBe("80%");
    expect(told[0].count).toBe(1);
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

    // One press raises it: doubled, past the spend, and the work goes on.
    await page.getByTestId("cap-raise").click();
    await expect(chip).toHaveAttribute("data-level", "ok");
    expect((await cap())!.usd).toBeGreaterThanOrEqual(0.02);
    await expect(page.getByTestId("cap-reached")).toHaveCount(0);
    await shoot(page, "cap-02-raised");
    await page.keyboard.press("Escape");
    await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say still working" } });
    await expect.poll(async () => (await events(id)).filter((e) => e.kind === "turn_end").length, { timeout: 60_000 }).toBeGreaterThan(2);
    expect((await events(id)).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});
