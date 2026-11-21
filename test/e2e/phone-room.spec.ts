import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: on a phone the conversation has the screen. The message box rests
// as one line under it and opens its tools, in one row, when it is tapped; the
// plan is one slim line above it. While a turn runs, the box's hint names what
// a finger does (Send, the list button), not keys a phone does not have.
test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the conversation gets the screen, and hints name touch actions", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Phone room" } })).json();
    const turns = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length;
    const todos = [{ content: "Bound the retry delay", status: "completed", activeForm: "Bounding the retry delay" }, { content: "Run the tests", status: "in_progress", activeForm: "Running the tests" }];
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "TodoWrite", input: { todos } }])}` } });
    await expect.poll(turns, { timeout: 60_000 }).toBe(1);
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:render" } });
    await expect.poll(turns, { timeout: 60_000 }).toBe(2);
    try {
      await page.goto(`/s/${session.id}`);
      // On a phone every open session is a page of its own: this one is the pane at the helm.
      const pane = page.locator(".k-station[data-helm]");
      const box = pane.getByTestId("composer-box");
      const tools = pane.getByTestId("composer-tools");
      await expect(pane.getByTestId("dock-plan")).toBeVisible();
      await expect(pane.getByTestId("assistant-text").last()).toBeVisible();

      // At rest: the plan line and the box together take under a seventh of the screen.
      const under = async () => { const a = (await pane.getByTestId("session-dock").boundingBox())!, b = (await box.boundingBox())!; return Math.round(b.y + b.height - a.y); };
      expect(await under()).toBeLessThanOrEqual(112);
      await expect(tools).toBeHidden();
      await shoot(page, "phone-01-rest");
      // A context that is nearly full shows its ring on the resting box; an emptier one keeps out of the way.
      const ring = pane.getByTestId("rest-meter").getByTestId("context-meter");
      await expect(ring).toHaveCount(0);
      await request.patch(`/api/sessions/${session.id}`, { data: { settings: { compact_at: 1 } } });
      await expect(ring).toBeVisible();
      await expect(tools).toBeHidden();
      await shoot(page, "phone-01b-rest-full");
      await request.patch(`/api/sessions/${session.id}`, { data: { settings: { compact_at: null } } });
      await expect(ring).toHaveCount(0);

      // A tap opens the tools, in one row; a tap on one of them keeps them.
      await pane.getByTestId("composer").tap();
      await expect(tools).toBeVisible();
      await expect(pane.getByTestId("send")).toBeVisible();
      expect((await tools.boundingBox())!.height).toBeLessThanOrEqual(48);
      for (const id of ["attach", "model-picker", "effort-picker", "context-meter", "send"]) await expect(pane.getByTestId(id)).toBeInViewport({ ratio: 1 });
      await shoot(page, "phone-02-open");
      await pane.getByTestId("model-picker").tap();
      await expect(page.getByRole("listbox").or(page.getByRole("dialog")).first()).toBeVisible();
      await expect(tools).toBeVisible();
      await page.keyboard.press("Escape");
      // A tap beside the model list closes the list, not the tools with it: the control it hangs
      // from stays where it is (hidden under an open list, it raised a page error).
      await page.evaluate(() => { (window as any).__errs = []; addEventListener("error", (e: ErrorEvent) => (window as any).__errs.push(String(e.message))); });
      await pane.getByTestId("model-picker").tap();
      await expect(page.getByTestId("model-popup")).toBeVisible();
      await page.touchscreen.tap(4, 200);
      await expect(page.getByTestId("model-popup")).toBeHidden();
      await expect(tools).toBeVisible();
      expect(await page.evaluate(() => (window as any).__errs)).toEqual([]);
      // A tap on the conversation puts the box to rest again.
      await pane.getByTestId("assistant-text").last().tap();
      await expect(tools).toBeHidden();
      // A scroll drag outside puts the box to rest while it still has the focus (a pointer goes
      // down, nothing blurs): the next tap in the box opens the tools again.
      await pane.getByTestId("composer").tap();
      await expect(tools).toBeVisible();
      await pane.getByTestId("assistant-text").last().dispatchEvent("pointerdown", { bubbles: true });
      await expect(tools).toBeHidden();
      await expect(pane.getByTestId("composer")).toBeFocused();
      await pane.getByTestId("composer").tap();
      await expect(tools).toBeVisible();
      await pane.getByTestId("assistant-text").last().tap();
      // A draft keeps the tools: Send is needed.
      await pane.getByTestId("composer").tap();
      await pane.getByTestId("composer").fill("a draft");
      await pane.getByTestId("assistant-text").last().tap();
      await expect(pane.getByTestId("send")).toBeVisible();
      await pane.getByTestId("composer").fill("");
      // The tools button opens them without the keyboard: the box does not take the focus.
      await pane.getByTestId("assistant-text").last().tap();
      await expect(tools).toBeHidden();
      await pane.getByTestId("composer-open").tap();
      await expect(pane.getByTestId("model-picker")).toBeVisible();
      await expect(pane.getByTestId("composer")).not.toBeFocused();

      // While a turn runs, the hint names what a finger does.
      const gate = join(mkdtempSync(join(tmpdir(), "keel-phone-")), "go");
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:hold ${gate}` } });
      await expect(pane.getByTestId("stop")).toBeVisible({ timeout: 30_000 });
      const hint = await pane.getByTestId("composer").getAttribute("placeholder");
      expect(hint).not.toMatch(/Ctrl|Enter|Cmd|Shift/);
      expect(hint).toMatch(/Send steers/);
      // With Stop, the queue button and Send on the right, the effort and the context ring are still whole.
      for (const id of ["effort-picker", "context-meter", "stop", "queue-button", "send"]) await expect(pane.getByTestId(id)).toBeInViewport({ ratio: 1 });
      // The model cannot change under a running turn: it stands last on the left, after the effort.
      expect(await pane.getByTestId("effort-picker").evaluate((el) => el.getBoundingClientRect().left)).toBeLessThan(await pane.getByTestId("model-picker").evaluate((el) => el.getBoundingClientRect().left));
      await shoot(page, "phone-03-working");
      writeFileSync(gate, "");
      await expect.poll(turns, { timeout: 60_000 }).toBe(3);
    } finally { await request.delete(`/api/sessions/${session.id}`); }
  });
});
