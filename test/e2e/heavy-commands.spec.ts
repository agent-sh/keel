import { expect, test } from "./isolate.ts";
import { SCRIPTED, shoot } from "./shots.ts";

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
    await expect.poll(async () => (await state(second))?.text, { timeout: 10_000 }).toBe('Waiting for a heavy-command slot: next in line, held by sleep (another session); every slot is taken');

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

    // The owner's patterns are edited in the panel, each with its cost.
    const pat = `sleep ${secs.replace(".", "\\.")}`;
    const rows = pool.getByTestId("heavy-pattern");
    await expect(rows).toHaveCount(1);
    await expect(pool.getByLabel("Pattern 1", { exact: true })).toHaveValue(pat);
    await expect(pool.getByLabel("Cores of pattern 1", { exact: true })).toHaveValue(String(before.cost.cores));
    await pool.getByTestId("heavy-add").click();
    await pool.getByLabel("Pattern 2", { exact: true }).fill("my-build");
    await pool.getByLabel("Cores of pattern 2", { exact: true }).fill("1.5");
    await pool.getByLabel("Memory of pattern 2", { exact: true }).fill("0.5");
    await pool.getByTestId("heavy-save").click();
    await expect(pool.getByTestId("heavy-msg")).toHaveText("Saved. It applies to the next command.");
    expect((await (await request.get("/api/settings")).json()).settings.heavy.patterns).toEqual([
      { pattern: pat, cores: before.cost.cores, memory_mb: before.cost.memory_mb },
      { pattern: "my-build", cores: 1.5, memory_mb: 512 },
    ]);
    await expect(pool).toContainText("Commands you type in a terminal pane never wait");
    await shoot(page, "heavy-02-patterns");
  } finally {
    await request.patch("/api/settings", { data: { heavy: { patterns: before.patterns, slots: before.slots } } });
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});

test("an agent reads a message without running the command that was still in the slot line", async ({ page, request }) => {
  test.skip(!SCRIPTED, "needs the scripted provider: the agent calls a known command and answers the message");
  const before = (await (await request.get("/api/settings")).json()).settings.heavy;
  const secs = (60 + Math.random()).toFixed(3);
  const holder = `sleep ${secs}`;
  const cmd = `${holder}; echo command-started`;
  const pattern = `sleep ${secs.replace(".", "\\.")}`;
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Slot wait" } })).json();
  const parent = `/api/sessions/${session.id}`;
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const agents = async () => (await (await request.get(`${parent}/agents`)).json()).agents as { id: string; session_id: string }[];
  const pool = async () => (await (await request.get("/api/resources?history=0")).json()).heavy as { line: { session_id: string }[]; held: { session_id: string }[] };
  let job: string | undefined;
  try {
    expect((await request.patch("/api/settings", { data: { heavy: { patterns: [pattern], slots: 1 } } })).ok()).toBe(true);
    expect((await request.put(`${parent}/permissions`, { data: { mode: "full-auto" } })).ok()).toBe(true);
    const started = await request.post(`${parent}/terminal/run`, { data: { command: holder } });
    expect(started.ok()).toBe(true);
    job = (await started.json()).job.id;
    const task = `Check the suite\n${calls([{ name: "Bash", input: { command: cmd } }])}`;
    await request.post(`${parent}/messages`, { data: { text: calls([{ name: "spawn_agent", input: { isolation: "none", message: task } }]) } });
    await expect.poll(async () => (await agents())[0]?.session_id).toBeTruthy();
    const agent = (await agents())[0]!;
    await expect.poll(async () => (await pool()).line.map((e) => e.session_id)).toContain(agent.session_id);
    const reply = "I read the instruction to run it elsewhere.";
    const sent = await request.post(`${parent}/agents/${agent.id}/message`, { data: { message: `Run it on the other machine. script:say ${reply}` } });
    expect(sent.ok()).toBe(true);

    const events = async () => (await (await request.get(`/api/sessions/${agent.session_id}`)).json()).events as { kind: string; data: any }[];
    const result = "Not run: a message arrived while this command was waiting for a heavy-command slot.";
    const results = async () => (await events()).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => r.content);
    await expect.poll(async () => (await results()).join("\n"), { timeout: 7_000 }).toContain(result);
    expect((await results()).join("\n")).not.toContain("command-started");
    expect((await pool()).held.map((e) => e.session_id)).toContain(session.id);
    expect((await pool()).line.map((e) => e.session_id)).not.toContain(agent.session_id);
    await expect.poll(async () => (await events()).filter((e) => e.kind === "assistant").map((e) => JSON.stringify(e.data)).join("\n")).toContain(reply);
    expect((await events()).filter((e) => e.kind === "turn_start")).toHaveLength(1);
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${agent.session_id}`);
    await expect(page.getByTestId("turn-end").last()).toBeVisible();
    await shoot(page, "heavy-message");
  } finally {
    if (job) await request.post(`${parent}/terminal/${job}/stop`);
    for (const a of await agents()) await request.delete(`/api/sessions/${a.session_id}`);
    await request.delete(parent);
    await request.patch("/api/settings", { data: { heavy: { patterns: before.patterns, slots: before.slots } } });
  }
});
