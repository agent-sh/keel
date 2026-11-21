import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the daemon says when it was itself unresponsive. Code that holds
// its event loop (here the scripted model's `script:block`, a busy loop inside
// a turn) stops every answer for that long; when the loop runs again the
// daemon leaves one error row and one log line with the duration and the turn
// that was running, and ordinary turns leave none.
// The row also says what took the time: a watcher on a thread of its own
// looks at the daemon's main thread for as long as the loop is held (its own
// code, a child it waited for, a stop signal), and stalls with one cause are
// one row.
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
  expect(row.message).toMatch(/^Daemon unresponsive for 2\.\d s: blocked by its own code, outside anything it times \(1 turn was running/);
  expect(row.context.ms).toBeGreaterThanOrEqual(HELD_MS - 300);
  expect(row.context.ms).toBeLessThan(HELD_MS + 3000);
  expect(row.context.busy_ms).toBeGreaterThan(HELD_MS / 2);
  if (process.platform === "linux") {
    // The watcher saw the main thread on a processor for it, and says the code itself is not visible to it.
    expect(row.context.cause).toMatchObject({ kind: "compute", key: "compute", note: expect.stringContaining("no JavaScript frames across threads") });
    expect(row.context.cause.run_ms).toBeGreaterThan(HELD_MS / 2);
  }
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

test("each stall names what took the time: a child it waited for, its own code, a stop signal", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.skip(process.platform !== "linux", "the watcher reads Linux's /proc");
  const daemon = await (await request.get("/api/daemon")).json();
  const stalls = async () => ((await (await request.get("/api/errors")).json()).errors as any[]).filter((e) => e.context?.kind === "stall");
  const of = async (kind: string) => (await stalls()).filter((e) => e.context.cause?.kind === kind);
  const times = async (kind: string) => (await of(kind)).reduce((n, e) => n + (e.count ?? 1), 0);
  const ended = (id: string) => expect.poll(async () => (await (await request.get(`/api/sessions/${id}?events=0`)).json()).session.settings.last_end, { timeout: 30_000 }).toBe("end_turn");
  const turn = async (title: string, text: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title } })).json();
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    await request.get("/api/daemon");
    await ended(session.id);
    return session.id as string;
  };
  const before = { child: await times("child"), compute: await times("compute"), stopped: await times("stopped") };
  const rows = (await of("child")).length;

  // A synchronous child that takes three seconds: the daemon used no processor, and was not starved either.
  const waited = await turn("Waits for a child", "script:child 3000");
  await expect.poll(() => times("child"), { timeout: 10_000 }).toBe(before.child + 1);
  const child = (await of("child"))[0];
  expect(child.message).toMatch(/^Daemon unresponsive for [23]\.\d s: [23]\.\d s waiting for a child: sleep 3 \(pid \d+\) \(1 turn was running/);
  expect(child.context.cause).toMatchObject({ kind: "child", key: "child sleep", state: "S", call: { child: { command: "sleep 3" } } });
  expect(child.context.cause.sampled_ms).toBeGreaterThan(2000);
  expect(child.context.cause.run_ms).toBeLessThan(500);

  // A busy loop of three seconds: its own code.
  await turn("Computes", "script:block 3000");
  await expect.poll(() => times("compute"), { timeout: 10_000 }).toBe(before.compute + 1);
  const computed = (await of("compute"))[0];
  expect(computed.message).toMatch(/^Daemon unresponsive for [23]\.\d s: blocked by its own code, outside anything it times/);
  expect(computed.context.cause.run_ms).toBeGreaterThan(2000);

  // The whole process stopped for three seconds by a signal, then continued. A read a moment before keeps its timer short.
  await request.get("/api/daemon");
  await page.waitForTimeout(1200);
  process.kill(daemon.pid, "SIGSTOP");
  try { await page.waitForTimeout(3000); } finally { process.kill(daemon.pid, "SIGCONT"); }
  await expect.poll(() => times("stopped"), { timeout: 10_000 }).toBe(before.stopped + 1);
  const stopped = (await of("stopped"))[0];
  expect(stopped.message).toMatch(/^Daemon unresponsive for [23]\.\d s: [23]\.\d s stopped by a signal \(continued by SIGCONT\)/);
  expect(stopped.context.cause).toMatchObject({ kind: "stopped", cont: true });

  // The same cause again is the same row, counted: a second child, another pid, another duration.
  await turn("Waits for a child again", "script:child 2600");
  await expect.poll(() => times("child"), { timeout: 10_000 }).toBe(before.child + 2);
  expect((await of("child")).length).toBe(Math.max(1, rows));
  expect(new Set([child.id, computed.id, stopped.id]).size).toBe(3);

  // The turn that ran through the stall has it as a span of its trace, with the same cause.
  const { traces } = await (await request.get(`/api/debug/traces?session_id=${waited}`)).json();
  const { spans } = await (await request.get(`/api/debug/traces/${traces[0].trace_id}`)).json();
  const span = (spans as any[]).find((x) => x.name === "daemon stall");
  expect(span).toMatchObject({ kind: "wait", status: "ok", error_id: child.id, attrs: { cause: { kind: "child", key: "child sleep" } } });
  expect(span.end_ms - span.start_ms).toBeGreaterThan(2000);

  // The Errors panel shows the cause of the row that is opened: whose doing it was, and each part with its time.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${waited}`);
  await page.getByTestId("errors-button").click();
  const shown = page.getByTestId("errors-panel").getByTestId("error-row").filter({ hasText: "waiting for a child: sleep" }).first();
  await expect(shown.getByTestId("error-count")).toHaveText(/^[2-9]\d*x$/);
  await shown.locator("summary").click();
  const cause = shown.getByTestId("error-cause");
  await expect(cause).toHaveAttribute("data-kind", "child");
  await expect(cause).toContainText("Child process");
  await expect(cause.getByTestId("error-cause-share").first()).toContainText(/waiting for a child: sleep/);
  await expect(cause).toContainText("Machine then: load");
  await shoot(page, "stall-02-cause");

  // Settings > Daemon lists the stalls of this start, the newest first, each with its cause.
  await page.goto("/settings/daemon");
  const list = page.getByTestId("daemon-stalls").getByTestId("daemon-stall");
  await expect(list.first()).toHaveAttribute("data-kind", "child");
  await expect(list.first()).toContainText("waiting for a child: sleep");
  await expect(page.getByTestId("daemon-stalls").locator('[data-kind="stopped"]').first()).toContainText("stopped by a signal");
  await expect(page.getByTestId("daemon-stalls").locator('[data-kind="compute"]').first()).toContainText("blocked by its own code");
  await page.getByTestId("daemon-stalls").scrollIntoViewIfNeeded();
  await shoot(page, "stall-03-daemon-list");
});
