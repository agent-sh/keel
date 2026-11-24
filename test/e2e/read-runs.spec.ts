import { expect, test } from "./isolate.ts";
import { shoot, SCRIPTED } from "./shots.ts";

// Feature: a run of reads told what it costs. In a tree whose top session has
// read_runs (a trial's arm sets it), an agent's second read-only step in a
// row, each of one call, gets a note on its result: each step reads the whole
// context again, at this many tokens and this price, so send the reads it
// already knows it needs as parallel calls in one step. A model that follows
// it sends the rest in one step. The same agent in a tree without the setting
// is told nothing and reads one file a step.
test("an agent told at a run of reads sends the rest in one step", async ({ page, request }) => {
  test.skip(!SCRIPTED, "needs the scripted stand-in: the agent's reads and how it follows the note are scripted");
  const MODEL = "scripted:claude-stand-in";
  const reads = ["*.md", "*.json", "*.ts", "*.sh", "*.txt"].map((pattern) => ({ name: "Glob", input: { pattern } }));
  const agent = { name: "Agent", input: { description: "Reads around", model: MODEL, prompt: `script:calls ${JSON.stringify(reads)}\nscript:then-batch` } };
  const tree = async (told: boolean) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: told ? "Told tree" : "Plain tree" } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    if (told) expect((await request.patch(`/api/sessions/${session.id}`, { data: { settings: { read_runs: "batch" } } })).ok()).toBe(true);
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([agent])}` } });
    await expect.poll(async () => {
      const d = await (await request.get(`/api/sessions/${session.id}`)).json();
      return !d.running && d.events.at(-1)?.kind === "turn_end" && d.events.some((e: any) => e.kind === "tool_result");
    }, { timeout: 60_000 }).toBe(true);
    const a = (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents[0];
    const events = (await (await request.get(`/api/sessions/${a.session_id}/events`)).json()).events as any[];
    const steps = events.filter((e) => e.kind === "assistant");
    const results = events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => typeof r.content === "string" ? r.content : r.content.map((b: any) => b.text ?? "").join(""));
    return { agent: a.session_id as string, steps, results, root: session.id };
  };
  const calls = (s: any) => s.data.blocks.filter((b: any) => b.type === "tool_use").length;

  const told = await tree(true);
  // The note is on the second read's result and on no other, with the context's size and its price.
  const noted = told.results.map((t, i) => [i, t] as const).filter(([, t]) => t.includes("[harness] 2 read-only steps in a row"));
  expect(noted.map(([i]) => i)).toEqual([1]);
  expect(noted[0]![1]).toMatch(/Each step reads your whole context again \(\d+K? tokens, about \$\d/);
  expect(noted[0]![1]).toContain("Send the reads you already know you need as parallel calls in one step");
  // The agent read two files one at a time, then the three left in one step, and answered.
  expect(told.steps.map(calls)).toEqual([1, 1, 3, 0]);
  expect(told.results).toHaveLength(reads.length);

  // The same agent in a tree without the setting: no note, one read a step.
  const plain = await tree(false);
  expect(plain.results.some((t) => t.includes("read-only steps in a row"))).toBe(false);
  expect(plain.steps.map(calls)).toEqual([1, 1, 1, 1, 1, 0]);

  // A setting the trial does not know is refused.
  expect((await request.patch(`/api/sessions/${plain.root}`, { data: { settings: { read_runs: "always" } } })).status()).toBe(400);

  // The agent's transcript shows the note under the read it came on.
  await page.goto(`/s/${told.agent}`);
  // (Reads in a row are shown as groups: each is opened.)
  const cards = page.getByTestId("tool-call");
  await expect(cards.first()).toBeVisible();
  for (let i = 0; i < (await cards.count()); i++) await cards.nth(i).locator("button").first().click();
  await expect(page.getByText("2 read-only steps in a row", { exact: false }).first()).toBeVisible();
  await shoot(page, "read-runs-01-agent");
});
