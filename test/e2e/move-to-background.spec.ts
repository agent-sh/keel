import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { openPanel, scriptBash, shoot } from "./shots.ts";

// Feature: the owner moves a command that runs in front of a tool call behind it, at any time. A control
// on the running card, one in the terminal panel and a key all end the call's wait at once (as the timeout
// does): the call returns with the command's ID, the command runs on, and its end starts the next turn.
const STAND_IN = "scripted:stand-in";
type Ev = { kind: string; ts: number; data: any };

async function start(request: any, title: string) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs KEEL_SCRIPTED_PROVIDER=1: the scripted stand-in sends the exact calls");
  const ws = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/move-bg-${Date.now().toString(36)}`;
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: ws } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const events = async (): Promise<Ev[]> => (await (await request.get(`/api/sessions/${session.id}/events`)).json()).events;
  const jobs = async () => ((await (await request.get(`/api/sessions/${session.id}/terminal`)).json()).commands as { key: string; command: string; state: string; job_id?: string; output: string }[]);
  const say = (command: string) => request.post(`/api/sessions/${session.id}/messages`, { data: { text: scriptBash(command) } });
  return { session, events, jobs, say };
}

// The result of the call the owner moved: when it came, and what it says.
const moved = async (events: () => Promise<Ev[]>, n: number) => {
  const results = (await events()).filter((e) => e.kind === "tool_result");
  const r = results[n];
  return r ? { ts: r.ts, text: String(r.data.results[0].content) } : undefined;
};

test("a running command moves behind its call from the card, the key and the terminal panel", async ({ page, request }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1920, height: 1040 });
  const { session, events, jobs, say } = await start(request, "Move to background");
  // Test the command handoff and its end, independently of the unattended-turn pace.
  expect((await request.patch(`/api/sessions/${session.id}`, { data: { settings: { pace_min: 0 } } })).ok()).toBe(true);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const tail = (cmd: string) => `${cmd}; echo finished-${cmd.length}`;
  const cmds = [tail("sleep 30"), tail("sleep 30 "), tail("sleep 30  ")];
  const ids: string[] = [];
  await page.goto(`/s/${session.id}`);

  // 1. The control on the running card, once the owner opened its line (a command that runs is one line until then).
  await say(cmds[0]!);
  const card = page.getByTestId("tool-call").last();
  await expect(card).toHaveAttribute("data-state", "running", { timeout: 30_000 });
  await expect(card.getByTestId("move-to-background")).toHaveCount(0);
  await card.locator(".k-line").click();
  const control = card.getByTestId("move-to-background");
  await expect(control).toBeVisible();
  // Its key is in its tooltip: no key caps stand beside a running command. With nothing printed yet it is one quiet
  // line, not an empty box.
  await expect(control).toHaveAttribute("title", /\(Ctrl Alt B\)$/);
  await expect(card.getByTestId("move-keys")).toHaveCount(0);
  const silent = card.getByTestId("live-output");
  await expect(silent).toHaveText("No output yet");
  expect(await card.getByTestId("terminal").evaluate((el) => getComputedStyle(el).borderTopColor), "no box around it").toBe("rgba(0, 0, 0, 0)");
  expect(await silent.evaluate((el) => getComputedStyle(el).fontFamily), "in the text face, not the code face").not.toMatch(/mono/i);
  await shoot(page, "move-bg-01-running-card");
  const t0 = Date.now();
  await control.click();
  await expect.poll(() => moved(events, 0), { timeout: 5000 }).toBeTruthy();
  const first = (await moved(events, 0))!;
  // The call returned within a second of the press, with the command's ID, and says who moved it.
  expect(first.ts - t0).toBeLessThan(1000);
  expect(first.text).toMatch(/^The owner moved the command to the background with ID: (\S+);/);
  ids.push(/ID: ([^;\s]+);/.exec(first.text)![1]!);
  await expect(card).toHaveAttribute("data-state", "ok");
  // The process runs on: the terminal list holds it as a background command, still running.
  let row = (await jobs()).find((j) => j.job_id === ids[0]);
  expect(row?.state).toBe("background");
  await shoot(page, "move-bg-02-moved-card");

  // 2. The key, with the focus in the page and not in a field.
  await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await say(cmds[1]!);
  await expect(page.getByTestId("tool-call").last()).toHaveAttribute("data-state", "running", { timeout: 30_000 });
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const t1 = Date.now();
  await page.keyboard.press("Control+Alt+b");
  await expect.poll(() => moved(events, 1), { timeout: 5000 }).toBeTruthy();
  const second = (await moved(events, 1))!;
  expect(second.ts - t1).toBeLessThan(1000);
  expect(second.text).toMatch(/^The owner moved the command to the background/);
  ids.push(/ID: ([^;\s]+);/.exec(second.text)![1]!);

  // 3. The terminal panel's control on the running row.
  await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await say(cmds[2]!);
  await openPanel(page, "terminal");
  const panel = page.getByTestId("terminal-panel");
  const running = panel.locator('[data-testid="term-entry"][data-state="running"]');
  await expect(running).toHaveCount(1, { timeout: 30_000 });
  await shoot(page, "move-bg-03-panel-running");
  const t2 = Date.now();
  await running.getByTestId("term-background").click();
  await expect.poll(() => moved(events, 2), { timeout: 5000 }).toBeTruthy();
  const third = (await moved(events, 2))!;
  expect(third.ts - t2).toBeLessThan(1000);
  ids.push(/ID: ([^;\s]+);/.exec(third.text)![1]!);
  await expect(panel.locator('[data-testid="term-entry"][data-state="background"]')).toHaveCount(3);
  await expect(running).toHaveCount(0);
  await shoot(page, "move-bg-04-panel-moved");

  // A command that is no longer in front of a call has nothing to move: the route says so.
  const again = await request.post(`/api/sessions/${session.id}/terminal/${ids[2]}/background`);
  expect(await again.json()).toEqual({ moved: false });
  // And the key with nothing in front does nothing (its command is not offered).
  await expect(page.getByTestId("tool-call").locator('[data-movable][data-state="running"]')).toHaveCount(0);

  // Every command still runs, and its end is told to the session (ends a moment apart go as one input).
  const told = async () => (await events()).filter((e) => e.kind === "user" && e.data.kind === "harness").map((e) => String(e.data.text)).join("\n");
  const ended = async () => { const t = await told(); return ids.filter((id) => t.includes(`(ID ${id}) exited with code 0, after 3`)).length; };
  try { await expect.poll(ended, { timeout: 70_000 }).toBe(3); } catch (e) {
    const all = (await events()).filter((x) => x.kind === "user" || x.kind === "turn_end").map((x) => [x.kind, x.data.kind, x.data.job, String(x.data.text ?? "").slice(0, 160)]);
    throw new Error(`${(e as Error).message}\n${JSON.stringify(all)}\n${JSON.stringify(ids)}`);
  }
  // The commands ran to their end.
  for (const id of ids) expect((await jobs()).find((j) => j.job_id === id)?.state).toBe("ok");
  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the control on the running card is a finger's size and moves the command", async ({ page, request }) => {
    const { session, events, jobs, say } = await start(request, "Move to background on a phone");
    await page.goto(`/s/${session.id}`);
    await say("sleep 25; echo phone-done");
    const card = page.getByTestId("tool-call").last();
    await expect(card).toHaveAttribute("data-state", "running", { timeout: 30_000 });
    await card.locator(".k-line").tap();
    const control = card.getByTestId("move-to-background");
    await expect(control).toBeVisible();
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43);
    expect(box.width).toBeGreaterThanOrEqual(43);
    // No key hint on a phone: it has no keyboard.
    await expect(card.getByTestId("move-keys")).toBeHidden();
    await shoot(page, "move-bg-05-phone-running");
    await control.tap();
    await expect(card).toHaveAttribute("data-state", "ok", { timeout: 5000 });
    const job = (await jobs()).find((j) => j.state === "background")!;
    expect(job).toBeTruthy();
    await shoot(page, "move-bg-06-phone-moved");
    // It was a real background command: the owner stops it, which is what ends the test.
    await request.post(`/api/sessions/${session.id}/terminal/${job.job_id}/stop`);
    await expect.poll(async () => (await jobs()).find((j) => j.job_id === job.job_id)?.state, { timeout: 10_000 }).toBe("stopped");
    expect((await events()).some((e) => e.kind === "tool_result")).toBe(true);
  });
});
