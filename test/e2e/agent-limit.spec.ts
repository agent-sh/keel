import { expect, test } from "./isolate.ts";
import { openPanel, remoteHeaders, shoot } from "./shots.ts";

// Feature: a session's agent slots count the agents that work. An agent that
// waits on a wait of its own holds none; an agent asked for while every slot
// works is made and waits in line (never refused, never dropped), and a
// waiting agent whose wake comes then is first in line, ahead of agents asked
// for after it parked. The owner sets the limit in the session's panel and
// sees which agents work and which wait; only the owner's desk may change it.
test("agents that wait hold no slot, and one asked for or woken over the limit waits first in line", async ({ page, request }) => {
  test.setTimeout(240_000);
  const model = "scripted:stand-in-strict";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "requires the scripted provider");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Subagent slots" } })).json();
  const id = session.id as string;
  const path = `/api/sessions/${id}/agents`;
  type A = { id: string; session_id: string; title: string; status: string; slot_wait?: boolean };
  const read = async () => (await (await request.get(path)).json()) as { limit: number; own_limit: number | null; default_limit: number; agents: A[]; slots: { working: number; waiting: number; line: number } };
  const byTitle = async (t: string) => (await read()).agents.find((a) => a.title === t);
  const run = async (calls: unknown[]) => {
    const text = `script:batch ${JSON.stringify(calls)}`;
    expect((await request.post(`/api/sessions/${id}/messages`, { data: { text } })).ok()).toBe(true);
    const results = async () => {
      const { events } = await (await request.get(`/api/sessions/${id}`)).json();
      const i = events.findLastIndex((e: any) => e.kind === "user" && e.data.text === text);
      return events.slice(i + 1).filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results);
    };
    await expect.poll(async () => (await results()).length, { timeout: 30_000 }).toBe(calls.length);
    return results();
  };
  const agent = (title: string, calls: unknown[]) => ({ name: "spawn_agent", input: { message: `${title}\nscript:calls ${JSON.stringify(calls)}`, isolation: "none" } });
  const parks = [{ name: "wait_for", input: { kind: "timer", seconds: 600, note: "Fixture waits" } }];
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
    // The limit from the session's panel, as the owner sets it; a remote device or another origin may not.
    expect((await request.patch(path, { data: { limit: 4 }, headers: await remoteHeaders(request) })).status()).toBe(403);
    expect((await request.patch(path, { data: { limit: 4 }, headers: { origin: "https://other.invalid" } })).status()).toBe(403);
    expect((await request.patch(path, { data: { limit: 1.5 } })).status()).toBe(400);
    await page.goto(`/s/${id}`);
    await openPanel(page, "session");
    const limit = page.getByTestId("agent-limit");
    await expect(limit).toHaveAttribute("placeholder", String((await read()).default_limit));
    await limit.fill("2");
    await limit.press("Enter");
    await expect.poll(async () => (await read()).own_limit).toBe(2);

    // One that ends by itself, then four that park at once on a limit of two: none is refused,
    // the two over the limit wait in line and start as the first two park.
    await run([agent("Quick", [])]);
    await expect.poll(async () => (await byTitle("Quick"))?.status, { timeout: 30_000 }).toBe("completed");
    const four = await run([1, 2, 3, 4].map((n) => agent(`Parked ${n}`, parks)));
    expect(four.filter((r: any) => r.is_error)).toHaveLength(0);
    await expect.poll(async () => (await read()).agents.filter((a) => a.title.startsWith("Parked") && a.status === "waiting" && !a.slot_wait).length, { timeout: 30_000 }).toBe(4);
    expect((await read()).slots).toMatchObject({ working: 0, waiting: 4, line: 0 });
    await expect(page.getByTestId("agent-slots-said")).toHaveText("0 of 2 work, 4 wait on waits of their own");

    // A waiter whose timer fires while two others work: its wake waits in line, ahead of one asked for later.
    await run([agent("Woken", [{ name: "wait_for", input: { kind: "timer", seconds: 20, note: "short" } }])]);
    await expect.poll(async () => (await byTitle("Woken"))?.status, { timeout: 30_000 }).toBe("waiting");
    await run([agent("Busy 1", [{ name: "Bash", input: { command: "sleep 35" } }]), agent("Busy 2", [{ name: "Bash", input: { command: "sleep 50" } }])]);
    await expect.poll(async () => (await byTitle("Woken"))?.slot_wait, { timeout: 40_000 }).toBe(true);
    // Asked for with one the daemon cannot make: the step's line counts neither as started, and names each under it.
    // (The results come in the order the calls ended.)
    const asked = await run([agent("Later", []), { name: "spawn_agent", input: { message: "Wrong type", agent_type: "no-such-type" } }]);
    const later = asked.find((r: any) => !r.is_error), wrong = asked.find((r: any) => r.is_error);
    expect(String(wrong?.content)).toContain('no agent type "no-such-type"');
    const step = page.locator('[data-testid="work-step"][data-family="agents"]').last();
    await expect(step.locator(".k-line").first()).toHaveAttribute("aria-label", /^Asked for 2 agents, 1 waits for a slot, 1 failed to start$/);
    await expect(step.getByTestId("step-peek").getByTestId("agent-call-title")).toHaveText([/Later/, /Wrong type/]);
    await step.scrollIntoViewIfNeeded();
    await shoot(page, "agents-step-line-refused");
    expect(String(later?.content)).toContain("waits_for_slot");
    expect(String(later?.content)).toContain("1 agent is before it in line");
    expect(await byTitle("Later")).toMatchObject({ status: "waiting", slot_wait: true });
    // A finished agent asked to go on takes a slot too: refused, with what works and what waits.
    const quick = (await byTitle("Quick"))!;
    const [again] = await run([{ name: "send_input", input: { target: quick.id, message: "Continue" } }]);
    expect(again.is_error).toBe(true);
    expect(String(again.content)).toContain("AGENT_LIMIT: 2 agent slots of this session are in use (2 work, 2 more wait for a slot; 4 agents wait on waits of their own and hold no slot)");

    // The panel says which work and which wait, and the session's slots line says it in numbers.
    await expect(page.getByTestId("agent-slots-said")).toHaveText("2 of 2 work, 4 wait on waits of their own, 2 in line for a slot");
    await page.getByTestId("background-button").click();
    const row = (t: string) => page.getByTestId("bg-agent").filter({ hasText: t });
    await expect(row("Woken").getByTestId("bg-agent-state")).toHaveText(/free agent slot/);
    await expect(row("Later").getByTestId("bg-agent-state")).toHaveText(/free agent slot/);
    await expect(row("Busy 1").getByTestId("bg-agent-state")).toHaveText(/Working/);
    await shoot(page, "agents-slot-line");
    await page.keyboard.press("Escape");

    // A slot frees: the wake goes first, then the later one.
    await expect.poll(async () => (await byTitle("Later"))?.status, { timeout: 90_000 }).toBe("completed");
    const starts = async (a: A) => ((await (await request.get(`/api/sessions/${a.session_id}`)).json()).events as any[]).filter((e) => e.kind === "turn_start").map((e) => e.ts as number);
    const woke = (await starts((await byTitle("Woken"))!)).at(-1)!, began = (await starts((await byTitle("Later"))!))[0]!;
    expect(woke).toBeLessThan(began);
    // The default limit again.
    expect((await request.patch(path, { data: { limit: null } })).ok()).toBe(true);
    expect((await read()).own_limit).toBe(null);
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});
