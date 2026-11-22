import { expect, test } from "./isolate.ts";
import { remoteHeaders, shoot } from "./shots.ts";

test("the owner can refill one session to its subagent limit without oversubscribing it", async ({ page, request }) => {
  const model = "scripted:stand-in-strict";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "requires the scripted provider");
  const create = async (title: string) => (await (await request.post("/api/sessions", { data: { model, title } })).json()).session.id as string;
  const id = await create("Subagent slots");
  const other = await create("Default slots");
  const path = `/api/sessions/${id}/agents`;
  const read = async (p = path) => (await (await request.get(p)).json()) as {
    limit: number; agents: { id: string; session_id: string; status: string }[];
  };
  const patch = (limit: unknown, headers?: Record<string, string>) => request.patch(path, { data: { limit }, headers });
  const run = async (calls: unknown[]) => {
    const text = `script:batch ${JSON.stringify(calls)}`;
    expect((await request.post(`/api/sessions/${id}/messages`, { data: { text } })).ok()).toBe(true);
    const results = async () => {
      const { events } = await (await request.get(`/api/sessions/${id}`)).json();
      const i = events.findLastIndex((e: any) => e.kind === "user" && e.data.text === text);
      return events.slice(i + 1).filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results);
    };
    await expect.poll(async () => (await results()).length).toBe(calls.length);
    return results();
  };
  const batch = async (n: number, rejections: number, limit: number) => {
    const untilStopped = { name: "wait_for", input: { kind: "timer", seconds: 600, note: "Fixture holds the slot" } };
    const calls = Array.from({ length: n }, (_, i) => ({
      name: "spawn_agent",
      input: { message: `Worker ${i + 1}\nscript:calls ${JSON.stringify([untilStopped])}`, isolation: "none", limit: 999 },
    }));
    const refused = (await run(calls)).filter((r: any) => r.is_error);
    expect(refused).toHaveLength(rejections);
    for (const r of refused) expect(JSON.stringify(r.content)).toContain(`AGENT_LIMIT: ${limit}`);
    await expect.poll(async () => (await read()).agents.filter((a) => a.status === "waiting").length).toBe(limit);
  };
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
    const fallback = (await read()).limit;
    expect(fallback).toBeGreaterThan(0);
    if (fallback < 12) await batch(12, 12 - fallback, fallback);
    expect((await patch(12, await remoteHeaders(request))).status()).toBe(403);
    expect((await patch(12, { origin: "https://other.invalid" })).status()).toBe(403);
    expect((await patch(1.5)).status()).toBe(400);
    expect((await read()).limit).toBe(fallback);
    const raised = await patch(12);
    expect(raised.ok()).toBe(true);
    expect((await raised.json()).limit).toBe(12);
    expect((await read(`/api/sessions/${other}/agents`)).limit).toBe(fallback);
    // One agent that ends by itself: it holds no slot once it reported, and is there to be asked again below.
    await run([{ name: "spawn_agent", input: { message: "Quick worker\nscript:say done", isolation: "none" } }]);
    const over = (a: { status: string }) => !["waiting", "running", "stopped"].includes(a.status);
    await expect.poll(async () => (await read()).agents.filter(over).length, { timeout: 30_000 }).toBe(1);
    await batch(13 - (fallback < 12 ? fallback : 0), 1, 12);
    const kid = (await read()).agents[0]!;
    expect((await request.patch(`/api/sessions/${kid.session_id}/agents`, { data: { limit: 12 } })).status()).toBe(409);
    const stop = async () => {
      const { id: agent } = (await read()).agents.find((a) => a.status === "waiting")!;
      expect((await request.post(`${path}/${agent}/stop`)).ok()).toBe(true);
      await expect.poll(async () => (await read()).agents.find((a) => a.id === agent)?.status).toBe("stopped");
    };
    for (const n of [2, 3]) {
      await stop();
      await batch(n, n - 1, 12);
    }
    // An agent that ended is not started again over the limit: the message that would is refused.
    const ended = (await read()).agents.find(over)!;
    const [resume] = await run([{ name: "send_input", input: { target: ended.id, message: "Continue" } }]);
    expect(resume.is_error).toBe(true);
    expect(JSON.stringify(resume.content)).toContain("AGENT_LIMIT: 12");
    // One the owner stopped is not started by a message at all: it waits for the owner, the sender is
    // told so, and the session still holds its twelve.
    const held = (await read()).agents.find((a) => a.status === "stopped")!;
    const [waits] = await run([{ name: "send_input", input: { target: held.id, message: "Continue" } }]);
    expect(JSON.stringify(waits.content)).toContain("the owner stopped that agent");
    expect((await read()).agents.find((a) => a.id === held.id)?.status).toBe("stopped");
    expect((await read()).agents.filter((a) => a.status === "waiting")).toHaveLength(12);
    await page.goto(`/s/${id}`);
    await page.getByTestId("background-button").click();
    await expect(page.getByTestId("bg-agent")).toHaveCount(15);
    await shoot(page, "agents-limit-refilled");
    const reset = await patch(null);
    expect(reset.ok()).toBe(true);
    expect((await read()).limit).toBe(fallback);
    expect((await read()).agents.filter((a) => a.status === "waiting")).toHaveLength(12);
  } finally {
    await request.delete(`/api/sessions/${id}`);
    await request.delete(`/api/sessions/${other}`);
  }
});
