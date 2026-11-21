import { expect, test, type APIRequestContext } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the memory system's efficiency, where the owner looks. Settings >
// Usage has one Memory panel: per recall path, how often memory was added to a
// turn, the tokens it added, whether the turn used it, what was not added again
// and the time it took. A fact the context already holds is not added a second
// time, so a second prompt that gets the same fact shows no memory chip.
// A store that does not answer in time does not hold a turn past the hook's
// deadline: the session says so once, later turns do not wait for it, and
// the panel counts it.
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
  // A shell command gets the store's rule for it with its result.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: 'script:calls [{"name":"Bash","input":{"command":"echo hi"}}]' } });
  await ended(request, session.id, 3);

  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const notes = events.filter((e) => e.kind === "note" && e.data.memory);
  expect(notes).toHaveLength(1);
  expect(notes[0].data.text).toContain("code-word");
  expect(events.filter((e) => e.kind === "assistant").map((e) => e.data.blocks.map((b: any) => b.text ?? "").join(""))[0]).toBe("From memory: code-word.");

  // The measurement: one row per ask, nothing of the facts themselves.
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

  await page.goto("/settings/usage");
  const panel = page.getByTestId("usage-memory");
  await expect(panel).toBeVisible();
  for (const label of ["Memory store, session start", "Memory store, with a prompt", "Memory store, with a tool call", "All memory"]) await expect(panel).toContainText(label);
  const row = panel.locator("tbody tr").filter({ hasText: "with a prompt" });
  await expect(row).toContainText(/\d+ of \d+/);
  await expect(panel.getByTestId("memory-notes")).toContainText("not added again");
  await panel.scrollIntoViewIfNeeded();
  await shoot(page, "memory-usage-02-panel");

  // The store hangs for one prompt. The turn goes on after the hook's deadline, and the session says so.
  const t0 = Date.now();
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:memory standin:slow Is the store there?" } });
  await ended(request, session.id, 4);
  expect(Date.now() - t0).toBeLessThan(8_000);
  const out = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).filter((e) => e.kind === "note" && e.data.kind === "memory_out");
  expect(await out()).toHaveLength(1);
  const prompts = async () => (await (await request.get(`/api/telemetry/memory?session_id=${session.id}`)).json()).paths.find((p: any) => p.path === "store_prompt");
  const held = await prompts();
  expect(held).toMatchObject({ asked: 4, timeouts: 1 });
  expect(held.wait_max_ms).toBeGreaterThan(2_000);
  // The next prompt does not wait for it (its answer, in time again, ends the outage) and is not told again.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:memory Back again?" } });
  await ended(request, session.id, 5);
  expect(await out()).toHaveLength(1);
  const after = await prompts();
  expect(after).toMatchObject({ asked: 5, timeouts: 1 });
  expect(after.wait_ms - held.wait_ms).toBeLessThan(500);

  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("turn-end")).toHaveCount(5);
  await expect(page.getByText("Memory did not answer in time")).toHaveCount(1);
  await page.getByText("Memory did not answer in time").scrollIntoViewIfNeeded();
  await shoot(page, "memory-usage-03-not-answering");
  await page.goto("/settings/usage");
  await expect(panel.getByTestId("memory-out")).toContainText(/did not answer \d+ times? \(\d+ timed out, 0 failed\)/);
  await panel.scrollIntoViewIfNeeded();
  await shoot(page, "memory-usage-04-panel-outage");

  await request.delete(`/api/sessions/${session.id}`);
  // The outage is in the errors once, and nothing else is new there. It is marked resolved for the next spec.
  const OUT = "the memory store did not answer in time: turns go on without it until it does";
  const now = await errorList();
  expect(now.filter((e) => !errorsBefore.has(e.id)).every((e) => e.message === OUT)).toBe(true);
  const mine = now.find((e) => e.message === OUT);
  expect(mine).toBeTruthy();
  await request.patch(`/api/errors/${mine!.id}`, { data: { resolved: true } });
});
