import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ask, choose, HAIKU, shoot } from "./shots.ts";

// Feature: plan mode. The session reads and plans but changes nothing; the
// model presents its plan on a card; the owner sends it back once, then
// approves it and picks the mode the work goes on in, and the work happens.
test("plan mode and plan approval", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `plan-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("permission-menu").click();
  await page.getByTestId("mode-plan").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("permission-mode")).toHaveText("Plan");

  // A real model plans from words. The stand-in presents the plan its script holds, presents the
  // second one when the first comes back, and runs the command once a plan is approved: the card,
  // the modes and the gate after it are the product's.
  const first = "1. Create hello.txt with the line hi, in one command.";
  await page.getByTestId("composer").fill(ask(
    "Plan how to create hello.txt containing the line hi. Present the plan with your plan tool; after it is approved, create the file with one command.",
    `script:calls ${JSON.stringify([{ name: "present_plan", input: { plan: first } }, { name: "present_plan", input: { plan: `${first}\n2. The file ends with a newline.` } }, { name: "Bash", input: { command: "echo hi > hello.txt" } }])}`,
  ));
  await page.keyboard.press("Enter");
  const card = page.getByTestId("plan-card");
  await expect(card).toBeVisible({ timeout: 90_000 });
  expect(existsSync(join(ws, "hello.txt"))).toBe(false);
  await shoot(page, "plan-01-card");

  // Sent back once with a change; the model presents again.
  await card.getByTestId("plan-back").click();
  await card.getByTestId("plan-feedback").fill("Also say in the plan that the file ends with a newline.");
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(1, { timeout: 90_000 });
  await expect(card.getByTestId("plan-text")).toContainText(/newline/i, { timeout: 90_000 });

  // An emptied edit approves nothing: not from the card, not through the route.
  await card.getByTestId("plan-edit").click();
  const shown = await card.locator("textarea").inputValue();
  await card.locator("textarea").fill("  ");
  await expect(card.getByTestId("plan-approve")).toBeDisabled();
  const open = (await (await request.get(`/api/sessions/${session.id}/plan`)).json()).open;
  expect(open).toHaveLength(1);
  const blank = await request.post(`/api/sessions/${session.id}/plan/${open[0].id}`, { data: { approve: true, mode: "auto-edits", plan: " \n " } });
  expect(blank.status()).toBe(400);
  const after = await (await request.get(`/api/sessions/${session.id}/plan`)).json();
  expect(after.open.map((c: { id: string }) => c.id)).toEqual([open[0].id]);
  expect(after.plan).toBeNull();
  await expect(page.getByTestId("permission-mode")).toHaveText("Plan");
  await card.locator("textarea").fill(shown);
  await card.getByTestId("plan-edit").click();

  await choose(card.getByTestId("plan-mode"), "auto-edits");
  await card.getByTestId("plan-approve").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("permission-mode")).toHaveText("Auto edits");
  // Auto edits still asks before a command that writes (no sandbox here).
  const asks = page.getByTestId("approval");
  await expect(asks).toBeVisible({ timeout: 90_000 });
  await asks.getByTestId("allow-once").click();
  await expect.poll(() => existsSync(join(ws, "hello.txt")), { timeout: 120_000 }).toBe(true);
  expect(readFileSync(join(ws, "hello.txt"), "utf8").trim()).toBe("hi");
  const { plan } = await (await request.get(`/api/sessions/${session.id}/plan`)).json();
  expect(plan.mode).toBe("auto-edits");
  expect(plan.plan).toMatch(/newline/i);
  await shoot(page, "plan-02-done");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A plan update the tool rejects leaves the plan before it in the dock, and
// its card says it was not applied. A question's answers show under each
// question, quotes and all, and the picked options stay checked.
test("a rejected plan update and answered questions read right", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const todos = [{ content: "Write the parser", status: "in_progress", activeForm: "Writing the parser" }, { content: "Test it", status: "pending", activeForm: "Testing it" }];
  const qs = [
    { question: "Keep backup?", header: "Backup", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false },
    { question: "Retain logs?", header: "Logs", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false },
  ];
  const calls = [{ name: "TodoWrite", input: { todos } }, { name: "TodoWrite", input: { todos: "not a list" } }, { name: "AskUserQuestion", input: { questions: qs } }];
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Plan and questions" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify(calls)}`);
  await page.getByTestId("composer").press("Enter");
  const card = page.getByTestId("question");
  await expect(card).toHaveAttribute("data-state", "open", { timeout: 20_000 });
  // The rejected update says so on its line, with the tool's reason under it; the dock keeps the accepted plan.
  const refused = page.locator('[data-testid="tool-call"][data-kind="plan"]').filter({ hasText: "Plan update not applied" });
  await expect(refused).toHaveCount(1);
  await expect(refused.getByTestId("plan-rejected")).toContainText("The plan before it stays.");
  await expect(page.getByTestId("dock-plan")).toContainText("Writing the parser");

  await card.getByTestId("question-option").nth(0).click(); // Keep backup: Yes
  await card.getByTestId("question-other").nth(0).fill('use "weekly" copies');
  await card.getByTestId("question-option").nth(3).click(); // Retain logs: No
  // Enter twice before the first answer lands: one answer, no "no question is waiting".
  await card.getByTestId("question-other").nth(1).evaluate((el) => {
    for (let i = 0; i < 2; i++) el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await expect(card).toHaveAttribute("data-state", "answered", { timeout: 20_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 20_000 });
  await expect(card).not.toContainText("no question is waiting");
  // Answered, the question is a line of the rail: what was asked and the first answer. It opens to the card.
  await expect(card.getByTestId("question-line-answer")).toHaveText('Yes, use "weekly" copies');
  await card.locator(".k-line").click();
  const answers = card.getByTestId("question-answer");
  // The record is rows of the rail: what was asked with what it offered, and what the owner said.
  await expect(answers.nth(0)).toHaveText('YouYes, use "weekly" copies');
  await expect(answers.nth(1)).toHaveText("YouNo");
  await expect(card.getByTestId("question-option").nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(card.getByTestId("question-option").nth(3)).toHaveAttribute("aria-checked", "true");
  await shoot(page, "plan-02-rejected-and-answered");
  // Reopened, the same.
  await page.reload();
  await page.getByTestId("question").locator(".k-line").click();
  await expect(page.getByTestId("question-answer").nth(0)).toHaveText('YouYes, use "weekly" copies');
  await expect(page.getByTestId("question-option").nth(3)).toHaveAttribute("aria-checked", "true");
  await request.delete(`/api/sessions/${session.id}`);
});

// The approval and the mode it starts are one unit on the card: on a narrow
// screen at a large text size the button says all of what it does, the mode
// keeps its name and its label, and the two stay together when they stack.
// Keep planning stands apart from them.
test("plan approval stays paired with its mode on a narrow screen", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Plan on a narrow screen" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "plan" } });
  const plan = "## Retry policy\n\n1. Read the importer.\n2. Change the retry policy.\n3. Run the tests.";
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "present_plan", input: { plan } }])}` } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/plan`)).json()).open.length, { timeout: 30_000 }).toBe(1);

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`/s/${session.id}`);
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
  await page.reload();
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeCloseTo(25.5, 1);
  const card = page.locator(`[data-station="${session.id}"]`).getByTestId("plan-card");
  await expect(card).toBeVisible();
  const approve = card.getByTestId("plan-approve"), mode = card.getByTestId("plan-mode"), back = card.getByTestId("plan-back");
  // Whole inside the card and the screen, with none of its words cut.
  const whole = async (l: typeof approve) => {
    await l.scrollIntoViewIfNeeded();
    const b = (await l.boundingBox())!, c = (await card.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(c.x);
    expect(b.x + b.width).toBeLessThanOrEqual(Math.min(320, c.x + c.width));
    expect(await l.evaluate((el) => [el, ...el.querySelectorAll("*")].every((n) => !(n instanceof HTMLElement) || n.scrollWidth <= n.clientWidth + 1))).toBe(true);
  };
  // The button says what it does on its own; the mode shows its name under a label.
  await expect(approve).toHaveText("Approve plan");
  await whole(approve);
  await expect(mode).toHaveText("Auto edits");
  await expect(mode).toHaveAccessibleName("Work goes on in");
  await whole(mode);
  const unit = card.getByRole("group", { name: "Approve the plan" });
  await expect(unit.getByText("Work goes on in")).toBeVisible();
  // One unit holds both, stacked or not; Keep planning is outside it.
  await expect(unit.getByTestId("plan-mode")).toHaveCount(1);
  await expect(unit.getByTestId("plan-approve")).toHaveCount(1);
  await expect(unit.getByTestId("plan-back")).toHaveCount(0);
  await expect(back).toHaveText("Keep planning");
  await whole(back);
  const u = (await unit.boundingBox())!, k = (await back.boundingBox())!;
  expect(k.y >= u.y + u.height || k.x >= u.x + u.width).toBe(true);
  // Tab goes mode, Approve, Keep planning.
  await mode.focus();
  await page.keyboard.press("Tab");
  await expect(approve).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(back).toBeFocused();
  await approve.scrollIntoViewIfNeeded();
  await shoot(page, "plan-03-approval-narrow");

  // It still approves in the mode picked.
  await choose(mode, "full-auto");
  await expect(mode).toHaveText("Full auto");
  // Approve takes the press once every line of the plan was in view: read through it from its top.
  await card.getByTestId("plan-text").evaluate((el) => el.scrollIntoView({ block: "start" }));
  const tray = (await page.locator(`[data-station="${session.id}"]`).getByTestId("composer-tray").boundingBox())!;
  for (let i = 0; i < 40 && !(await card.getAttribute("data-read")); i++) {
    await page.mouse.move(tray.x + tray.width / 2, tray.y + 20);
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(60);
  }
  await expect(card).toHaveAttribute("data-read", "true");
  await approve.click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/plan`)).json()).plan?.mode).toBe("full-auto");
  expect((await (await request.get(`/api/sessions/${session.id}/permissions`)).json()).perm.mode).toBe("full-auto");
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1"));

  // A wide card keeps the unit on one line.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "plan" } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "present_plan", input: { plan: `${plan}\n4. Report.` } }])}` } });
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.reload();
  await expect(card).toBeVisible({ timeout: 30_000 });
  expect((await unit.boundingBox())!.height).toBeLessThan(2.6 * 17);
  await shoot(page, "plan-04-approval-wide");
  await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } });
  await request.delete(`/api/sessions/${session.id}`);
});

// The decision on a plan is `approve`, true or false. A body that says it any
// other way is refused and the plan keeps waiting: before, a body without
// `approve` answered ok and was recorded as the owner rejecting the plan.
test("a plan decision the endpoint does not understand is refused and the plan stays open", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Plan decision" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "plan" } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "present_plan", input: { plan: "1. Read the importer.\n2. Change the retry policy." } }])}` } });
  const open = async () => (await (await request.get(`/api/sessions/${session.id}/plan`)).json()).open as { id: string }[];
  await expect.poll(async () => (await open()).length, { timeout: 30_000 }).toBe(1);
  const [{ id }] = await open() as [{ id: string }];
  const decide = (data: unknown) => request.post(`/api/sessions/${session.id}/plan/${id}`, { data });

  for (const body of [{ decision: "approve" }, {}, { approve: "yes" }, { approve: 1, mode: "auto-edits" }, { feedback: "make it shorter" }]) {
    const r = await decide(body);
    expect(r.status(), JSON.stringify(body)).toBe(400);
    expect((await r.json()).error).toContain("approve");
  }
  expect((await open()).map((c) => c.id)).toEqual([id]);
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("plan-card")).toBeVisible();
  await expect(page.getByTestId("turn-end")).toHaveCount(0); // the turn still waits on the card
  await shoot(page, "plan-04-still-open");

  // The two answers it does understand still work.
  expect((await decide({ approve: false, feedback: "make it shorter" })).status()).toBe(200);
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
  expect(await open()).toEqual([]);
  await request.delete(`/api/sessions/${session.id}`);
});

// Feature: on a phone a plan's Approve is in view when the plan comes, at the foot of its card
// while the card goes on under the message box, and a tap on it approves only a plan that was
// read: every line of it has been in view (the approval cards' rule). A tap before that is
// refused and says how much was not seen; scrolling through the plan reads it.
test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("Approve stands in view, and a tap approves only a plan that was read", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "A long plan on a phone" } })).json();
    const open = async () => (await (await request.get(`/api/sessions/${session.id}/plan`)).json()).open.length as number;
    try {
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "plan", sandbox: "off" } });
      const steps = Array.from({ length: 30 }, (_, i) => `${i + 1}. Step ${i + 1}: change the part of the retry loop that bounds the delay.`).join("\n");
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "present_plan", input: { plan: steps } }])}` } });
      await expect.poll(open, { timeout: 30_000 }).toBe(1);
      await page.goto(`/s/${session.id}`);
      const pane = page.locator(".k-station[data-helm]");
      const card = pane.getByTestId("plan-card");
      const approve = card.getByTestId("plan-approve");
      await expect(card).toBeVisible();
      // In view, whole, and nothing lies over it (the message box was over half of it).
      const free = () => approve.evaluate((el) => { const b = el.getBoundingClientRect(); const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height - 2); return b.top >= 0 && b.bottom <= innerHeight && !!at && el.contains(at); });
      await expect(approve).toBeInViewport({ ratio: 1 });
      expect(await free()).toBe(true);
      await shoot(page, "plan-02-phone-arrival");
      // A tap before the plan was read approves nothing, and says why, in words of no key.
      await page.waitForTimeout(1200);
      await approve.tap();
      await expect(card.getByTestId("plan-hint")).toHaveText(/not seen yet/);
      await expect(card).not.toContainText(/\b(Enter|Tab|Esc)\b/);
      await shoot(page, "plan-03-phone-unread");
      expect(await open()).toBe(1);
      // Scrolled through as a finger does, a step at a time: read, with Approve in view all along.
      const tray = pane.getByTestId("composer-tray");
      const box = (await tray.boundingBox())!;
      for (let i = 0; i < 60 && !(await card.getAttribute("data-read")); i++) {
        await page.mouse.move(box.x + box.width / 2, box.y + 40);
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(50);
        expect(await free()).toBe(true);
      }
      await expect(card).toHaveAttribute("data-read", "true");
      await approve.tap();
      await expect.poll(open).toBe(0);
    } finally { await request.delete(`/api/sessions/${session.id}`); }
  });
});
