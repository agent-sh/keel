import { expect, test } from "./isolate.ts";
import { openFolds, shoot } from "./shots.ts";

// Feature: an agent's budget. An agent given 3 steps works three steps with
// tools; at the limit it gets one more step in which no call runs, writes its
// report, and ends incomplete with ended="budget", said on its parent's card
// and in the report its parent gets. A message with a new budget continues it
// with what it did before in its context, and it ends at that budget again;
// then a budget in dollars, counted from the ledger's spend, overshoots by at
// most the step that crossed it.
test("an agent's budget ends it with a report, and a message continues it", async ({ page, request }) => {
  test.setTimeout(180_000);
  const model = "scripted:stand-in-strict";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "needs the scripted provider: the stand-in takes a tool every step");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Agent budget" } })).json();
  const id = session.id as string;
  type A = { id: string; session_id: string; title: string; status: string; end_reason?: string | null; tasks: number; budget?: { steps?: number } | null };
  const agent = async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as A[])[0]!;
  const events = async (sid: string) => (await (await request.get(`/api/sessions/${sid}`)).json()).events as any[];
  const idle = async (sid: string) => { const d = await (await request.get(`/api/sessions/${sid}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
  const step = (n: number) => ({ name: "Bash", input: { command: `echo step-${n}` } });
  const results = (evs: any[]) => evs.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results as any[]);
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
    const task = `Counter\nscript:calls ${JSON.stringify([1, 2, 3, 4, 5, 6, 7].map(step))}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: task, isolation: "none", budget: { steps: 3 } } }])}` } });

    await expect.poll(async () => (await agent())?.status, { timeout: 60_000 }).toBe("incomplete");
    const a = await agent();
    expect(a.end_reason).toBe("budget");
    expect(a.budget).toEqual({ steps: 3 });
    // Three steps ran their calls; the fourth was the report, in words, with no call run.
    const child = await events(a.session_id);
    expect(results(child).filter((r) => !r.is_error).map((r) => String(r.content).trim().split("\n")[0])).toEqual(["step-1", "step-2", "step-3"]);
    expect(child.filter((e) => e.kind === "assistant")).toHaveLength(4);
    expect(child.some((e) => e.kind === "user" && String(e.data.text).startsWith("[harness] Your budget for this task is spent (3 steps; used 3 steps)"))).toBe(true);
    expect(child.findLast((e) => e.kind === "turn_end")?.data.reason).toBe("budget");
    // The parent is told, the report as written and the end named.
    await expect.poll(async () => (await events(id)).some((e) => e.kind === "user" && JSON.stringify(e.data).includes('ended=\\"budget\\"')), { timeout: 30_000 }).toBe(true);
    const told = JSON.stringify((await events(id)).filter((e) => e.kind === "user").map((e) => e.data));
    expect(told).toContain("Report at the budget: 3 of 7 steps taken.");
    expect(told).toContain("it ran out of its budget (3 steps)");
    await expect.poll(() => idle(id), { timeout: 30_000 }).toBe(true);

    // Its card says why it ended.
    await page.goto(`/s/${id}`);
    await page.getByTestId("lens-to-stream").click();
    const card = page.getByTestId("agent-call").first();
    await expect(card.getByTestId("agent-call-status")).toContainText("budget");
    await expect(card.getByTestId("agent-call-why")).toContainText("Out of its budget");
    await shoot(page, "agent-budget-01-ended");

    // A message with a new budget continues it: two more steps, then its report again.
    // (The stand-in takes the calls the message names, as the task's own were.)
    const resume = async (message: string, budget: unknown, tasks: number) => {
      await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([{ name: "send_input", input: { target: a.id, message, budget } }])}` } });
      await expect.poll(async () => { const x = await agent(); return x.tasks === tasks && x.status === "incomplete"; }, { timeout: 60_000 }).toBe(true);
    };
    await resume(`Go on.\nscript:calls ${JSON.stringify([5, 6, 7].map(step))}`, { steps: 2 }, 1);
    const again = await events(a.session_id);
    expect(results(again).filter((r) => !r.is_error).map((r) => String(r.content).trim().split("\n")[0])).toEqual(["step-1", "step-2", "step-3", "step-5", "step-6"]);
    expect(JSON.stringify(again.at(-2)?.data)).toContain("Report at the budget: 2 of 3 steps taken.");
    // What it wrote before is still in its context.
    expect(again.filter((e) => e.kind === "assistant").map((e) => (e.data.blocks as any[]).filter((b) => b.type === "text").map((b) => b.text).join(""))).toContain("Report at the budget: 3 of 7 steps taken.");
    expect((await agent()).end_reason).toBe("budget");
    await expect.poll(async () => JSON.stringify((await events(id)).filter((e) => e.kind === "user").map((e) => e.data)).includes("it ran out of its budget (2 steps)"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => idle(id), { timeout: 30_000 }).toBe(true);
    await page.reload();
    await expect(page.getByTestId("work-fold").first()).toBeVisible();
    await openFolds(page);
    await expect(page.getByTestId("agent-call").first().getByTestId("agent-call-why")).toContainText("Out of its budget");
    await shoot(page, "agent-budget-02-again");

    // A budget in dollars: the spend the ledger has for its session since the message.
    const before = Date.now();
    await resume(`And more.\nscript:calls ${JSON.stringify([8, 9, 10, 11, 12, 13, 14, 15].map(step))}`, { usd: 0.004 }, 2);
    expect((await agent()).end_reason).toBe("budget");
    const third = (await events(a.session_id)).filter((e) => e.kind === "assistant" && e.ts >= before);
    const costs = third.map((e) => Number(e.data.usage?.cost ?? 0));
    // Its last step is the report: every step before it ran its call, and only the one that crossed the line went over.
    const work = costs.slice(0, -1);
    const crossed = work.reduce((n, c) => n + c, 0);
    console.log(`dollar budget 0.004: ${work.length} steps before the report, ${crossed.toFixed(5)} spent, overshoot ${(crossed - 0.004).toFixed(5)}`);
    expect(crossed).toBeGreaterThanOrEqual(0.004);
    expect(crossed - work.at(-1)!).toBeLessThan(0.004);
    await expect.poll(async () => JSON.stringify((await events(id)).filter((e) => e.kind === "user").map((e) => e.data)).includes("it ran out of its budget ($0.004)"), { timeout: 30_000 }).toBe(true);
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});
