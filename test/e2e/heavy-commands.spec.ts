import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: heavy commands take a slot of one daemon-wide pool. With every slot
// taken, a session's heavy command waits in line: its tool call is held, its
// state says its place in one line, Settings > Resources shows it waiting, and
// its result's first line says how long it waited. The owner's own command
// never waits. The pattern and the number of slots are the owner's settings.
test("a heavy command waits for a slot, and the owner's does not", async ({ page, request }) => {
  const STAND_IN = "scripted:stand-in";
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: a held call is made on cue only by the stand-in");
  const before = (await (await request.get("/api/settings")).json()).settings.heavy;
  test.skip(!before, "needs a daemon with the heavy-command pool");
  // A pattern no other spec's command matches, and one slot.
  const secs = (12 + Math.random()).toFixed(3);
  const cmd = `sleep ${secs}`;
  const set = await request.patch("/api/settings", { data: { heavy: { patterns: [`sleep ${secs.replace(".", "\\.")}`], slots: 1 } } });
  expect(set.ok()).toBe(true);
  const made: string[] = [];
  try {
    const start = async (title: string) => {
      const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title } })).json();
      made.push(session.id);
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `${cmd}; echo ran-${title.split(" ")[0]}` } }])}` } });
      return session.id as string;
    };
    const heavy = async () => (await (await request.get("/api/resources?history=0")).json()).heavy as { held: { session_id: string; who: string }[]; line: { session_id: string }[] };
    const first = await start("First suite");
    await expect.poll(async () => (await heavy()).held.map((h) => h.session_id), { timeout: 30_000 }).toEqual([first]);
    const second = await start("Second suite");
    await expect.poll(async () => (await heavy()).line.map((l) => l.session_id), { timeout: 30_000 }).toEqual([second]);
    // Its state says its place in one line.
    const state = async (id: string) => (await (await request.get("/api/state")).json()).states[id] as { text?: string };
    await expect.poll(async () => (await state(second))?.text, { timeout: 10_000 }).toBe("Waiting for a heavy-command slot: next in line, 1 running, every slot is taken");

    // The owner's own command starts at once, over the pool.
    const own = await request.post(`/api/sessions/${first}/terminal/run`, { data: { command: `${cmd}; echo owner-ran` } });
    expect(own.ok()).toBe(true);
    await expect.poll(async () => (await heavy()).held.map((h) => h.who).sort(), { timeout: 10_000 }).toEqual(["owner", "session"]);
    expect((await heavy()).line.map((l) => l.session_id)).toEqual([second]);

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto("/settings/resources");
    const pool = page.getByTestId("heavy-pool");
    await expect(pool.getByTestId("heavy-waiting")).toContainText("Second suite");
    await expect(pool.getByTestId("heavy-running").filter({ hasText: "First suite" })).toHaveCount(2);
    await expect(pool.getByTestId("heavy-slots")).toContainText("1 of 1");
    await expect(pool.getByTestId("heavy-slots")).toContainText("and 1 of yours, which never waits");
    await pool.scrollIntoViewIfNeeded();
    await shoot(page, "heavy-01-waiting");

    // The second runs once the slots free; its result says it waited.
    const result = async (id: string) => {
      const ev = (await (await request.get(`/api/sessions/${id}`)).json()).events as { kind: string; data: any }[];
      const r = ev.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results as { content: unknown }[]);
      const c = r.at(-1)?.content;
      return typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("") : "";
    };
    await expect.poll(() => result(second), { timeout: 60_000 }).toContain("ran-Second");
    expect(await result(second)).toMatch(/^\[Waited \d+s for a heavy-command slot \(0 ahead when it asked\); the command's own time starts after that\.\]\n/);
    expect(await result(first)).not.toContain("Waited");
    await expect(pool.getByTestId("heavy-waiting")).toHaveCount(0, { timeout: 15_000 });

    // The owner's patterns are edited in the panel.
    const box = pool.getByTestId("heavy-patterns");
    await expect(box).toHaveValue(`sleep ${secs.replace(".", "\\.")}`);
    await box.fill(`sleep ${secs.replace(".", "\\.")}\nmy-build`);
    await pool.getByTestId("heavy-save").click();
    await expect(pool.getByTestId("heavy-msg")).toHaveText("Saved. It applies to the next command.");
    expect((await (await request.get("/api/settings")).json()).settings.heavy.patterns).toEqual([`sleep ${secs.replace(".", "\\.")}`, "my-build"]);
    await shoot(page, "heavy-02-patterns");
  } finally {
    await request.patch("/api/settings", { data: { heavy: { patterns: before.patterns, slots: before.slots } } });
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});
