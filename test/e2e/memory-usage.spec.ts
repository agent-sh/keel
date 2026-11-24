import { expect, test, type APIRequestContext } from "./isolate.ts";
import { endsAre, shoot } from "./shots.ts";

// Feature: the memory system's efficiency, where the owner looks. Settings >
// Usage has one Memory panel: per recall path, how often memory was added to a
// turn, the tokens it added, whether the turn used it, what was not added again
// and the time it took. A fact the context already holds is not added a second
// time, so a second prompt that gets the same fact shows no memory chip.
// A store that does not answer in time does not hold a turn past the hook's
// wait. One such call is only counted; two in a row are an outage: the
// session says so once, a probe that asks nothing finds the store answering
// again, and the panel counts both.
// The daemon runs with TACIT_BIN at test/e2e/fixtures/tacit-standin.sh (the same
// fact for every prompt, a rule for every shell command, no answer to a prompt
// holding standin:slow) and the scripted provider (`script:memory` replies
// with the name of the fact it was given).
const STAND_IN = "scripted:stand-in";

const ended = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 60_000 }).toBeGreaterThanOrEqual(n);

test("memory usage: tokens added, recalls used, nothing added twice, shown in Settings > Usage", async ({ page, request }) => {
  const info = await (await request.get("/api/integrations")).json();
  test.skip(!info.tacit.bin?.includes("tacit-standin"), "needs the tacit stand-in (TACIT_BIN)");
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorList = async () => (await (await request.get("/api/errors")).json()).errors as { id: string; message: string }[];
  const errorsBefore = new Set((await errorList()).map((e) => e.id));

  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Memory check", text: "script:memory What is the code word?" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await ended(request, session.id, 1);
  // The same fact comes back for the second prompt: it is in the context already.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:memory And once more?" } });
  await ended(request, session.id, 2);
  // A shell command that changes something gets the store's rule for it with its result
  // (the result is held for it; a read's rule would follow with the next request instead).
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: 'script:calls [{"name":"Bash","input":{"command":"touch memory-usage-check.txt"}}]' } });
  await ended(request, session.id, 3);

  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const notes = events.filter((e) => e.kind === "note" && e.data.memory);
  expect(notes).toHaveLength(1);
  expect(notes[0].data.text).toContain("code-word");
  expect(events.filter((e) => e.kind === "assistant").map((e) => e.data.blocks.map((b: any) => b.text ?? "").join(""))[0]).toBe("From memory: code-word.");

  // The measurement: one row per ask, nothing of the facts themselves.
  // (Whether a recall was used is judged from the reply once its turn is over, a moment after the turn's
  // end is stored: the report is read until the last turn's recall is counted.)
  const measured = async () => { const r = await (await request.get(`/api/telemetry/memory?session_id=${session.id}`)).json(); return { r, tool: r.paths.find((p: any) => p.path === "store_tool") }; };
  await expect.poll(async () => (await measured()).tool?.used ?? 0, { timeout: 15_000 }).toBe(1);
  const res = await request.get(`/api/telemetry/memory?session_id=${session.id}`);
  const report = await res.json();
  const by = Object.fromEntries(report.paths.map((p: any) => [p.path, p]));
  expect(by.store_start).toMatchObject({ asked: 1, recalls: 1, facts: 1, used: 0 });
  expect(by.store_prompt).toMatchObject({ asked: 3, recalls: 1, facts: 1, facts_checked: 1, used: 1, recalls_used: 1, repeats: 2, timeouts: 0, failures: 0 });
  expect(by.store_tool).toMatchObject({ asked: 1, recalls: 1, facts: 1, used: 1 });
  expect(report.total.tokens).toBeGreaterThan(0);
  expect(report.total).toMatchObject({ recalls: 3, recalls_used: 2, repeats: 2 });
  for (const word of ["heron", "code-word", "echo-rule", "script:memory"]) expect(JSON.stringify(report)).not.toContain(word);
  expect((await request.get("/api/telemetry/memory?session_id=nope")).status()).toBe(404);

  // Where the owner looks: the turn's memory chip on the first turn only, and the panel in Usage.
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("turn-end")).toHaveCount(3);
  await expect(page.getByTestId("memory-note")).toHaveCount(1);
  await shoot(page, "memory-usage-01-session");

  // Memory has a view of its own on the usage page.
  const memory = async () => { await page.goto("/settings/usage"); await page.getByTestId("usage-panel").getByRole("radio", { name: "Memory" }).click(); };
  await memory();
  const panel = page.getByTestId("usage-memory");
  await expect(panel).toBeVisible();
  for (const label of ["Memory store, session start", "Memory store, with a prompt", "Memory store, with a tool call", "All memory"]) await expect(panel).toContainText(label);
  const row = panel.locator("tbody tr").filter({ hasText: "with a prompt" });
  await expect(row).toContainText(/\d+ of \d+/);
  await expect(panel.locator("thead")).toContainText("Named in reply (estimate)");
  await expect(panel.getByTestId("memory-notes")).toContainText("It reads low");
  await expect(panel.getByTestId("memory-notes")).toContainText("not added again");
  await panel.scrollIntoViewIfNeeded();
  await shoot(page, "memory-usage-02-panel");
  // On a phone the table fits the screen: nothing runs off its right edge, the paths read whole,
  // and what a person opens it for stays (how often memory was added, what it cost, whether it was used).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  const fits = await panel.locator("table").evaluate((t) => {
    const box = t.parentElement!;
    const cut = [...t.querySelectorAll<HTMLElement>("tbody td:first-child")].filter((td) => td.scrollWidth > td.clientWidth + 1).length;
    return { over: box.scrollWidth - box.clientWidth, right: Math.round(t.getBoundingClientRect().right), cut };
  });
  expect(fits.over).toBeLessThanOrEqual(1);
  expect(fits.right).toBeLessThanOrEqual(390);
  expect(fits.cut).toBe(0);
  // A path wraps at its words there and reads whole: no word is broken, so it takes a line a word at most.
  // (How many lines that is depends on the room the counts leave the column, and the counts are the whole
  // daemon's, every earlier spec's recalls with them: two lines for this spec's own rows, three in a run of
  // the whole suite, where the counts have three digits and more paths are listed, the longest among them.)
  const lines = await panel.locator("tbody td:first-child > span").evaluateAll((els) => els.map((el) => ({ words: (el as HTMLElement).innerText.trim().split(/\s+/).length, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) })));
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(l.lines).toBeLessThanOrEqual(l.words);
  for (const h of ["Recalls", "Tokens added", "Named in reply (estimate)"]) await expect(panel.locator("thead th").filter({ hasText: h })).toBeVisible();
  await shoot(page, "memory-usage-03-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });

  // The store takes too long for one prompt. The turn goes on after the
  // hook's wait; one slow call is not an outage: nothing is said, no error is filed.
  const t0 = Date.now();
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:memory standin:slow Is the store there?" } });
  await ended(request, session.id, 4);
  expect(Date.now() - t0).toBeLessThan(8_000);
  const out = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).filter((e) => e.kind === "note" && e.data.kind === "memory_out");
  expect(await out()).toHaveLength(0);
  const OUT = "the memory store did not answer in time: turns go on without it until it does";
  expect((await errorList()).filter((e) => !errorsBefore.has(e.id) && e.message === OUT)).toHaveLength(0);
  const prompts = async () => (await (await request.get(`/api/telemetry/memory?session_id=${session.id}`)).json()).paths.find((p: any) => p.path === "store_prompt");
  expect(await prompts()).toMatchObject({ asked: 4, timeouts: 1 });
  // A second one in a row is an outage: the session says so, once.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:memory standin:slow And now?" } });
  await ended(request, session.id, 5);
  expect(await out()).toHaveLength(1);
  const held = await prompts();
  expect(held).toMatchObject({ asked: 5, timeouts: 2 });
  expect(held.wait_max_ms).toBeGreaterThan(2_000);
  // The next prompt costs no further wait (the probe found the store answering) and is not told again.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:memory Back again?" } });
  await ended(request, session.id, 6);
  expect(await out()).toHaveLength(1);
  const after = await prompts();
  expect(after).toMatchObject({ asked: 6, timeouts: 2 });
  // The report also says how the store answers right now: not out any more, and not often late.
  expect((await (await request.get("/api/telemetry/memory")).json()).store).toMatchObject({ out: { ask: false, tool: false }, degraded: { ask: false, tool: false } });
  expect(after.wait_ms - held.wait_ms).toBeLessThan(500);

  await page.goto(`/s/${session.id}`);
  await endsAre(page, 6);
  await expect(page.getByText("Memory did not answer in time")).toHaveCount(1);
  await page.getByText("Memory did not answer in time").scrollIntoViewIfNeeded();
  await shoot(page, "memory-usage-03-not-answering");
  await memory();
  await expect(panel.getByTestId("memory-out")).toContainText(/did not answer \d+ times? \(\d+ timed out, 0 failed\)/);
  await panel.scrollIntoViewIfNeeded();
  await shoot(page, "memory-usage-04-panel-outage");

  await request.delete(`/api/sessions/${session.id}`);
  // The outage is in the errors once, and nothing else is new there. It is marked resolved for the next spec.
  const now = await errorList();
  expect(now.filter((e) => !errorsBefore.has(e.id)).every((e) => e.message === OUT)).toBe(true);
  const mine = now.find((e) => e.message === OUT);
  expect(mine).toBeTruthy();
  await request.patch(`/api/errors/${mine!.id}`, { data: { resolved: true } });
});
