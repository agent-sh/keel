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
  // A press on a mark in the dock or a row of the list ends on the conversation pressed, with motion on: the glide
  // to it passes other pages, and none of them is taken for the one the owner swiped to.
  // The owner's own swipe (a wheel here) still takes the page it comes to.
  test("a press in the dock or a row of the list lands where pressed, with motion on and off", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const ids: string[] = [];
    try {
      for (let i = 1; i <= 5; i++) {
        const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Dock ${tag} ${i}` } })).json();
        ids.push(session.id);
        await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:say page ${i}` } });
      }
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`/s/${ids[0]}`);
      const mark = (n: number) => page.locator(`.k-dock-mark[aria-label^="Dock ${tag} ${n},"]`);
      // The page in the middle of the track, the address and the dock's current mark.
      const where = () => page.evaluate(() => {
        const t = document.querySelector(".k-stations")!.getBoundingClientRect();
        const p = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 3)?.closest<HTMLElement>("[data-station]");
        const label = (el: Element | null | undefined) => el?.getAttribute("aria-label")?.split(",")[0] ?? null;
        return { shown: label(p), at: location.pathname.slice(3), mark: label(document.querySelector(".k-dock-mark[aria-current]")) };
      });
      const lands = async (n: number) => {
        const want = { shown: `Dock ${tag} ${n}`, at: ids[n - 1], mark: `Dock ${tag} ${n}` };
        await expect.poll(where, { timeout: 10_000 }).toEqual(want);
        // And stays there once the glide is over.
        await page.waitForTimeout(800);
        expect(await where()).toEqual(want);
      };
      await expect(mark(5)).toBeVisible();
      for (const n of [4, 2, 5, 1, 3]) {
        await mark(n).tap();
        await lands(n);
      }
      await shoot(page, "phone-04-dock-press");
      // The owner's wheel over the track takes the next page.
      const was = (await where()).at;
      await page.mouse.move(200, 400);
      await page.mouse.wheel(390, 0);
      await expect.poll(async () => (await where()).at, { timeout: 10_000 }).not.toBe(was);
      const now = await where();
      expect([now.shown, now.mark]).toEqual([`Dock ${tag} ${ids.indexOf(now.at) + 1}`, `Dock ${tag} ${ids.indexOf(now.at) + 1}`]);
      // From the start page a row of the list opens the session tapped, and the next message is stored there.
      for (const n of [3, 5, 2, 4, 1, 3]) {
        await page.goto("/");
        await page.getByRole("button", { name: "All sessions" }).first().tap();
        await page.locator(`[data-testid="session-row"][data-session="${ids[n - 1]}"]`).tap();
        await lands(n);
      }
      const box = page.locator(".k-station[data-helm]").getByTestId("composer");
      await box.tap();
      await box.fill(`script:say stored in ${tag} 3`);
      await page.locator(".k-station[data-helm]").getByTestId("send").tap();
      const said = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "user" && JSON.stringify(e.data).includes(`stored in ${tag} 3`));
      await expect.poll(() => said(ids[2]!), { timeout: 30_000 }).toBe(true);
      for (const id of ids.filter((_, i) => i !== 2)) expect(await said(id)).toBe(false);
      // Without motion the press lands as well.
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const n of [5, 2]) {
        await mark(n).tap();
        await lands(n);
      }
    } finally {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      for (const id of ids) await request.delete(`/api/sessions/${id}`);
    }
  });
});
