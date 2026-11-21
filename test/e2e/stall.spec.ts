import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the daemon says when it was itself unresponsive. Code that holds
// its event loop (here the scripted model's `script:block`, a busy loop inside
// a turn) stops every answer for that long; when the loop runs again the
// daemon leaves one error row and one log line with the duration and the turn
// that was running, and ordinary turns leave none.
const STAND_IN = "scripted:stand-in";
const HELD_MS = 2500;

test("a blocked event loop leaves one error row and one log line with its duration", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const stalls = async () => ((await (await request.get("/api/errors")).json()).errors as any[]).filter((e) => e.context?.kind === "stall");
  const count = async () => (await stalls()).reduce((n, e) => n + (e.count ?? 1), 0);
  const ended = (id: string) => expect.poll(async () => (await (await request.get(`/api/sessions/${id}?events=0`)).json()).session.settings.last_end, { timeout: 30_000 }).toBe("end_turn");

  // Ordinary turns first: none of them is a stall.
  const before = await count();
  const { session: plain } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "An ordinary turn" } })).json();
  await request.put(`/api/sessions/${plain.id}/permissions`, { data: { mode: "full-auto" } });
  await request.post(`/api/sessions/${plain.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "seq 1 2000" } }])}` } });
  await ended(plain.id);
  expect(await count()).toBe(before);

  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Holds the daemon" } })).json();
  const t0 = Date.now();
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:block ${HELD_MS}` } });
  // Nothing is answered while the loop is held: this read comes back after it.
  await request.get("/api/daemon");
  await ended(session.id);
  await expect.poll(count, { timeout: 10_000 }).toBe(before + 1);

  const row = (await stalls()).sort((a, b) => b.ts - a.ts)[0];
  expect(row.source).toBe("server");
  expect(row.message).toMatch(/^Daemon unresponsive for 2\.\d s: blocked by its own code, outside any request handler \(1 turn was running/);
  expect(row.context.ms).toBeGreaterThanOrEqual(HELD_MS - 300);
  expect(row.context.ms).toBeLessThan(HELD_MS + 3000);
  expect(row.context.busy_ms).toBeGreaterThan(HELD_MS / 2);
  expect(row.context.turns).toEqual([expect.objectContaining({ session_id: session.id, doing: "model" })]);
  expect(row.ts).toBeGreaterThanOrEqual(t0);

  // The log has the same line once, as an error.
  const lines = ((await (await request.get(`/api/logs?since_ms=${t0}&level=error&q=${encodeURIComponent("Daemon unresponsive")}`)).json()).lines as any[]);
  expect(lines.map((l) => [l.level, l.text])).toEqual([["error", `[server] ${row.message}`]]);

  // And the Errors panel shows it without a reload.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("errors-button").click();
  const shown = page.getByTestId("errors-panel").getByTestId("error-row").filter({ hasText: "Daemon unresponsive for" }).first();
  await expect(shown).toBeVisible();
  await shown.locator("summary").click();
  await shoot(page, "stall-01-error-row");
});
