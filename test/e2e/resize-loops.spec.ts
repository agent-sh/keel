import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { observerWrites, watchWindowErrors } from "./loops.ts";
import { shoot } from "./shots.ts";

// Feature: the page raises no window error of its own while a long session streams and the window changes
// size. The browser reports "ResizeObserver loop completed with undelivered notifications" as an error
// event when an observer's call changes the size of something an observer watches in the same frame; the
// page records each as an Errors row. The session here has a long transcript, many agents (some working,
// some done), a plan and changed files, so every observer of the session page has something to measure.
const STAND_IN = "scripted:stand-in";
const E2E = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
const calls = (list: object[]) => `script:calls ${JSON.stringify(list)}`;

test("a long session with many agents raises no window error while it streams and the window resizes", async ({ page, request }) => {
  test.setTimeout(240_000);
  const model = (await (await request.get("/api/models")).json()).models.find((m: { id: string }) => m.id === STAND_IN);
  test.skip(!model, "needs the scripted provider: the stand-in writes the turns");
  const ws = join(E2E, `loops-${Date.now()}`);
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src/a.ts"), "export const a = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "A long session with many agents", workspace: ws } })).json();
  const id = session.id as string;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
  const send = (text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
  // The session at rest with at least n turns ended (an agent's report may start a turn of its own).
  let n = 0;
  const rest = async () => {
    await expect.poll(async () => {
      const d = await (await request.get(`/api/sessions/${id}`)).json();
      return !d.running && d.events.filter((e: any) => e.kind === "turn_end").length;
    }, { timeout: 120_000 }).toBeGreaterThan(n);
    n = (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length;
  };
  const errors = await watchWindowErrors(page);
  try {
    // A long transcript: many turns, each with a command and its output, then a reply.
    const todos = ["Read the notes", "Check the changelog", "Write the summary"].map((content, i) => ({ content, activeForm: `${content} (now)`, status: ["completed", "in_progress", "pending"][i] }));
    await send(calls([{ name: "TodoWrite", input: { todos } }, { name: "Bash", input: { command: "echo more >> src/a.ts; echo new > src/b.ts" } }]));
    await rest();
    for (let i = 0; i < 24; i++) {
      await send(calls([{ name: "Bash", input: { command: `seq 1 ${8 + (i % 5) * 6}`, description: `Counting, round ${i}` } }]));
      await rest();
    }
    // Many agents: some end at once, some work for the length of the spec.
    const agent = (title: string, command: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([{ name: "Bash", input: { command } }])}`, isolation: "none" } });
    const batch = [...Array.from({ length: 8 }, (_, i) => agent(`Finished ${i + 1}`, `echo done ${i}`)), ...Array.from({ length: 6 }, (_, i) => agent(`Working ${i + 1}`, "sleep 150"))];
    await send(`script:batch ${JSON.stringify(batch)}`);
    await rest();
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).tree as { status: string }[]).filter((a) => a.status === "running").length, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${id}`);
    await expect(page.getByTestId("dock-agents")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("turn-end").last()).toBeVisible();
    await shoot(page, "resize-loops-01-long");

    // A reply streams for about ten seconds; the window changes size, and the panels open and close meanwhile.
    await send("script:count");
    const sizes = [[1500, 900], [1100, 800], [820, 1000], [1366, 768], [1920, 1040], [1280, 700], [1920, 1040]] as const;
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      await page.waitForTimeout(350);
    }
    // The reader goes up through the transcript in steps (blocks are drawn at their real heights as they come
    // near the view) and back down, with the reply still streaming and the window changing size.
    await page.mouse.move(700, 400);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -700); await page.waitForTimeout(60); if (i % 10 === 5) await page.setViewportSize({ width: 1500 + (i % 20) * 12, height: 900 }); }
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(60); if (i % 10 === 5) await page.setViewportSize({ width: 1920, height: 1040 - (i % 20) * 10 }); }
    // The list's edge is dragged out and back in small steps: the line of counts and the foot under the list
    // fit their words to each width they pass.
    const grip = (await page.getByTestId("list-grip").boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, 500);
    await page.mouse.down();
    for (let x = 0; x < 330; x += 5) await page.mouse.move(grip.x + grip.width / 2 + x, 500);
    for (let x = 330; x > -60; x -= 5) await page.mouse.move(grip.x + grip.width / 2 + x, 500);
    await page.mouse.up();
    await page.evaluate(() => localStorage.removeItem("keel.listW"));
    // The text size changes, and the window takes widths at random, as fast as the page lays out: every width
    // the list's line and foot change their words at is passed, many times, in both directions.
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const scale of ["1.5", "1", "1.25"]) {
      await page.evaluate((v) => localStorage.setItem("keel.textScale", v), scale);
      await page.reload();
      await expect(page.getByTestId("list-summary")).toBeVisible();
      for (let i = 0; i < 70; i++) { await page.setViewportSize({ width: 330 + Math.floor(rand() * 1200), height: 900 }); await page.waitForTimeout(Math.floor(rand() * 40)); }
    }
    await page.evaluate(() => localStorage.removeItem("keel.textScale"));
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.getByTestId("dock-agents").click();
    await page.waitForTimeout(500);
    for (const [w, h] of [[1500, 900], [1920, 1040]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(400);
    }
    await page.keyboard.press("Escape");
    await rest();
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await page.waitForTimeout(500);
    await shoot(page, "resize-loops-02-after");
    expect(errors, "the page raised window errors").toEqual([]);
    // The cause, not only the report: no observer writes to the page inside its own call.
    expect(await observerWrites(page), "an observer's call wrote to the page; it writes a frame later").toEqual([]);
  } finally {
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
  }
});
