import { expect, test } from "./isolate.ts";
import { shoot, SCRIPTED } from "./shots.ts";

// Feature: an agent compacts by price. Before each step Keel weighs what the
// steps it is expected to take would read of its context above what a summary
// keeps against what the summary and the rewrite of what it keeps cost, and
// compacts when the first is larger, long before the window's line. The summary
// is written in the background and put in place at the next step, the newest
// step kept as it was; the agent's next step reads the summary. A tree runs it
// when the session at its top says so (a trial's arm sets it there): the same
// agent in a tree that does not compacts nothing.
test("a long agent compacts at the priced point and goes on from the summary", async ({ page, request }) => {
  test.skip(!SCRIPTED, "needs the scripted stand-in: the agent's calls and the summary's words are scripted");
  const MODEL = "scripted:claude-stand-in";
  const window = (await (await request.get("/api/models")).json()).models.find((m: any) => m.id === "scripted:stand-in-strict").context as number;
  // Forty steps that each add under a thousand tokens: about 50K at the end, under the line where the window rule
  // prepares a summary. A small step makes the cheapest gap to compact at small (it grows with the square root of a step).
  const calls = Array.from({ length: 40 }, (_, k) => ({ name: "Bash", input: { command: `yes ${String.fromCharCode(97 + (k % 26))} | head -c 1000` } }));
  // The agent runs on the strict stand-in, which counts its system prompt and tools as a provider does.
  const agent = { name: "Agent", input: { description: "Long agent", model: "scripted:stand-in-strict", prompt: `script:calls ${JSON.stringify(calls)}\nscript:then-summary` } };
  const tree = async (byPrice: boolean) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: byPrice ? "Priced tree" : "Window tree" } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    if (byPrice) expect((await request.patch(`/api/sessions/${session.id}`, { data: { settings: { compact_by_price: true } } })).ok()).toBe(true);
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([agent])}` } });
    // The agent's report is the top session's answer.
    await expect.poll(async () => {
      const d = await (await request.get(`/api/sessions/${session.id}`)).json();
      return !d.running && d.events.at(-1)?.kind === "turn_end" && d.events.some((e: any) => e.kind === "tool_result");
    }, { timeout: 60_000 }).toBe(true);
    const a = (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents[0];
    return { root: session.id, agent: a.session_id as string, events: (await (await request.get(`/api/sessions/${a.session_id}/events`)).json()).events as any[] };
  };

  const priced = await tree(true);
  const at = priced.events.findIndex((e) => e.kind === "compaction");
  expect(at).toBeGreaterThan(0);
  const cp = priced.events[at].data;
  // Compacted by price, below the window's line, from a summary written ahead that kept the newest step.
  expect(cp).toMatchObject({ mode: "summary", trigger: "price", ahead: true, auto: true });
  expect(cp.tokens_before).toBeLessThan(window * 0.7);
  expect(cp.price.save_usd).toBeGreaterThan(cp.price.cost_usd);
  expect(cp.price.steps).toBeGreaterThan(0);
  expect(priced.events.slice(0, at).some((e) => e.id === cp.covered)).toBe(true);
  // Its next step read the summary (the stand-in says what it found there) and ended the work with it.
  const next = priced.events.slice(at + 1).find((e) => e.kind === "assistant");
  expect(next.data.blocks.find((b: any) => b.type === "text").text).toBe("Went on from the summary: State: the scripted scenario ran; next, answer the newest prompt.");
  expect(next.data.usage.cache_read + next.data.usage.input).toBeLessThan(cp.tokens_before);
  const ran = (events: any[]) => events.filter((e) => e.kind === "tool_result").length;
  expect(ran(priced.events)).toBeLessThan(calls.length);

  // The same agent in a tree that does not compact by price: no summary, all of its calls.
  const plain = await tree(false);
  expect(plain.events.some((e) => e.kind === "compaction")).toBe(false);
  expect(ran(plain.events)).toBe(calls.length);

  // The agent's transcript says why it was compacted.
  await page.goto(`/s/${priced.agent}`);
  const divider = page.getByTestId("compacted");
  await expect(divider).toContainText(`Context compacted by price with a summary prepared ahead (the newest steps stay as they were): over the ${Math.round(cp.price.steps)} steps expected ahead it saves about`);
  await divider.scrollIntoViewIfNeeded();
  await shoot(page, "compaction-price-01-agent");
});
