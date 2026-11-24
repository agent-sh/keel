import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, webkit, type APIRequestContext, type Page } from "./isolate.ts";
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
      // (One row: a finger's target, 2.75rem, and the row's foot under it.)
      const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      expect((await tools.boundingBox())!.height).toBeLessThanOrEqual(3.375 * rem);
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
      // A model change is taken by the running turn too, so the picker stays a tap away: its mark alone,
      // whole in the row (its name showed as its first letters under the row's fade), named for a
      // screen reader, and it opens the menu.
      const pick = pane.getByTestId("model-picker");
      await expect(pick).toBeInViewport({ ratio: 1 });
      await expect(pick.locator(".k-model-name")).toHaveCSS("position", "absolute");
      await expect(pick).toHaveAccessibleName(/^Model: .*stand-in/i);
      await shoot(page, "phone-03-working");
      await pick.tap();
      await expect(page.getByTestId("model-popup")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("model-popup")).toBeHidden();
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

  // Feature: on a phone every target a finger presses is 2.75rem each way (44 px at the default
  // text size) and none lies over another: the start page, a session page and its header, the
  // message box at rest and with its tools, the dock, the list, the menus, and each kind of card.
  // None of them names a key (Enter, Esc, Ctrl and the like): a phone has no keyboard.
  test("every target is a finger's size, and none lies over another", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const made: string[] = [];
    const make = async (title: string, mode: string, calls: unknown[] | string) => {
      const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title } })).json();
      made.push(session.id);
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, sandbox: "off" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: typeof calls === "string" ? calls : `script:calls ${JSON.stringify(calls)}` } });
      return session.id as string;
    };
    try {
      const plain = await make("Targets plain", "full-auto", "script:render");
      const ask = await make("Targets approval", "ask", [{ name: "Bash", input: { command: "mkdir -p out/reports && touch out/reports/a" } }]);
      const q = await make("Targets question", "full-auto", [{ name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } }]);
      const plan = await make("Targets plan", "plan", [{ name: "present_plan", input: { plan: "1. Bound the retry delay.\n2. Run the tests." } }]);
      const pending = async (id: string, path: string) => (await (await request.get(`/api/sessions/${id}/${path}`)).json());
      await expect.poll(async () => (await pending(ask, "approvals")).approvals?.length ?? 0, { timeout: 30_000 }).toBe(1);
      await expect.poll(async () => (await pending(plan, "plan")).open?.length ?? 0, { timeout: 30_000 }).toBe(1);
      const pane = page.locator(".k-station[data-helm]");
      const seen: string[] = [];
      const check = async (where: string) => {
        const bad = await misfits(page);
        seen.push(`${where}: ${bad.count}`);
        expect(bad.small, `${where}: targets under 2.75rem`).toEqual([]);
        expect(bad.over, `${where}: targets over one another`).toEqual([]);
        expect(await keyWords(page), `${where}: words of keys`).toEqual([]);
      };

      await page.goto("/");
      await expect(page.getByTestId("home-open").first()).toBeVisible();
      await check("start page");
      await page.getByTestId("workspace-picker").tap();
      await expect(page.getByRole("dialog").or(page.getByRole("menu")).first()).toBeVisible();
      await check("folder picker");
      await page.keyboard.press("Escape");
      await page.goto(`/s/${plain}`);
      await expect(pane.getByTestId("assistant-text").last()).toBeVisible();
      await check("session at rest");
      await pane.getByTestId("composer").tap();
      await expect(pane.getByTestId("composer-tools")).toBeVisible();
      await check("message box tools");
      await pane.getByTestId("model-picker").tap();
      await expect(page.getByTestId("model-popup")).toBeVisible();
      await check("model menu");
      await page.keyboard.press("Escape");
      for (const menu of ["session-menu", "permission-menu", "panel-menu"]) {
        await pane.getByTestId(menu).first().tap();
        await expect(page.getByRole("menu").or(page.getByRole("dialog")).first()).toBeVisible();
        await check(menu);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu").or(page.getByRole("dialog"))).toHaveCount(0);
      }
      await pane.getByTestId("show-sidebar").tap();
      await expect(page.getByTestId("session-row").first()).toBeInViewport();
      await check("session list");
      await page.goto(`/s/${ask}`);
      await expect(pane.getByTestId("allow-once")).toBeVisible();
      await check("approval card");
      // What else waits is said without the key that goes there, and without what is left of its words:
      // a finger's way to the next stands in their place, and goes there.
      await expect(pane.getByTestId("waiting-elsewhere")).toHaveText(/waits? for you\.\s*\nGo to the next$/, { useInnerText: true });
      // (Beside the words, out of their live region: a screen reader tells a status's words, not a control in it.)
      expect(await pane.getByTestId("waiting-next").evaluate((b) => !!b.closest('[role="status"]'))).toBe(false);
      await expect(pane.getByTestId("waiting-elsewhere").getByRole("status")).toHaveText(/waits? for you\.\s*$/, { useInnerText: true });
      await shoot(page, "phone-04-targets-approval");
      await pane.getByTestId("waiting-next").tap();
      await expect(page).not.toHaveURL(new RegExp(`/s/${ask}$`));
      await page.goto(`/s/${q}`);
      await expect(pane.getByTestId("question-option").first()).toBeVisible();
      await check("question card");
      await shoot(page, "phone-05-targets-question");
      await page.goto(`/s/${plan}`);
      await expect(pane.getByTestId("plan-approve")).toBeVisible();
      await check("plan card");
      await page.goto("/settings/general");
      await expect(page.getByText("Text size")).toBeVisible();
      await check("settings");
      console.log(`targets measured: ${seen.join(", ")}`);
    } finally { for (const id of made) await request.delete(`/api/sessions/${id}`); }
  });

  // Feature: on a phone the session list has the screen. The tabs and the counts scroll away with the
  // rows; the find stays at the top, also when the list opens on a session far down it. What failed and
  // is out of view is named at the list's foot, which stands under the rows and never over one: at every
  // place of the scroll, a failed row is either seen whole or named.
  test("the list has the screen: the find stays, and a failed row is seen or named", async ({ page, request }) => {
    test.setTimeout(180_000);
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const made: string[] = [];
    const make = async (title: string, text?: string) => {
      const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title } })).json();
      made.push(session.id);
      if (text) await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
      return session.id as string;
    };
    const ended = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end");
    try {
      // Failures every few rows of a list longer than the screen: as the list scrolls, one is out of
      // view (so the foot names something) while another stands where the foot is.
      const failed: string[] = [];
      for (let i = 1; i <= 24; i++) {
        if (i % 3 === 1) failed.push(await make(`List ${tag} failed ${i}`, "script:billing"));
        else await make(`List ${tag} filler ${i}`, "script:say Done.");
      }
      for (const id of made) await expect.poll(() => ended(id), { timeout: 60_000 }).toBe(true);
      // Opened from the session lowest in the list: its row in view, and the find above it. (A filler:
      // a failure looked at is not news, and not named.)
      const fillers = made.filter((id) => !failed.includes(id));
      const rows = page.getByTestId("session-list").locator('[data-testid="session-row"]');
      await page.goto(`/s/${fillers[0]}`);
      await page.getByRole("button", { name: "All sessions" }).first().tap();
      await expect(rows.first()).toBeVisible();
      const lowest = await page.evaluate((ids) => {
        const all = [...document.querySelectorAll<HTMLElement>('[data-testid="session-list"] [data-testid="session-row"]')].map((r) => r.dataset.session!);
        return ids.map((id) => [id, all.indexOf(id)] as const).filter(([, i]) => i >= 0).sort((a, b) => b[1] - a[1])[0]![0];
      }, fillers);
      await page.goto(`/s/${lowest}`);
      await page.getByRole("button", { name: "All sessions" }).first().tap();
      const current = page.locator(`[data-testid="session-list"] [data-testid="session-row"][data-session="${lowest}"]`);
      await expect(current).toBeInViewport();
      const find = page.getByTestId("list-find");
      await expect(find).toBeInViewport();
      const [f, c] = [(await find.boundingBox())!, (await current.boundingBox())!];
      expect(c.y, "the open session's row stands under the find, not behind it").toBeGreaterThanOrEqual(f.y + f.height - 0.5);
      await shoot(page, "phone-list-open");

      // Step through the whole scroll: at each place a failed row is seen whole (nothing over it)
      // or named at the foot, and named only then.
      const scroller = () => current.evaluate((r) => {
        let el: HTMLElement | null = r.parentElement;
        while (el && !(/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)) el = el.parentElement;
        return el ? { max: el.scrollHeight - el.clientHeight } : { max: 0 };
      });
      const { max } = await scroller();
      expect(max, "the list is longer than the screen").toBeGreaterThan(200);
      const unseen = () => page.evaluate((ids) => {
        const shown = new Set([...document.querySelectorAll<HTMLElement>('[data-testid="need-strip"] [data-session]')].map((b) => b.dataset.session));
        // Past the strip's first names the rest are behind its "+N", by their titles.
        const more = document.querySelector<HTMLElement>('[data-testid="need-strip-more"]')?.title.split(", ") ?? [];
        const out: string[] = [];
        for (const id of ids) {
          const r = document.querySelector<HTMLElement>(`[data-testid="session-list"] [data-testid="session-row"][data-session="${id}"]`);
          const named = { has: (x: string) => shown.has(x) || (!!r && more.includes(r.querySelector(".k-row-title")?.textContent ?? "")) };
          if (!r) { if (!named.has(id)) out.push(`${id} not drawn and not named`); continue; }
          let box: HTMLElement | null = r.parentElement;
          while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
          const b = r.getBoundingClientRect(), v = box!.getBoundingClientRect();
          const inside = b.top >= v.top - 0.5 && b.bottom <= v.bottom + 0.5;
          const hit = [b.top + 2, (b.top + b.bottom) / 2, b.bottom - 2].every((y) => r.contains(document.elementFromPoint(b.left + b.width / 2, y)));
          const where = `${r.querySelector(".k-row-title")?.textContent} at ${Math.round(b.top)}..${Math.round(b.bottom)} in ${Math.round(v.top)}..${Math.round(v.bottom)}`;
          if (!(inside && hit) && !named.has(id)) out.push(`${where}: out of view, not named`);
          // And the foot follows the scroll: a row clearly in view is not named (a pixel's slack at the
          // box's edges, and half a rem under the find, whose edge is a shadow no point hits).
          const under = document.elementFromPoint(b.left + b.width / 2, b.top - 8)?.closest(".k-find");
          const clear = b.top >= v.top + 1 && b.bottom <= v.bottom - 1 && hit && !under;
          if (clear && named.has(id)) out.push(`${where}: in view, named`);
        }
        // Each name the strip shows is inside it, whole: none scrolls out of its sight.
        const strip = document.querySelector<HTMLElement>('[data-testid="need-strip"]');
        if (strip) {
          const s = strip.getBoundingClientRect();
          for (const b of strip.querySelectorAll<HTMLElement>("button")) {
            const r = b.getBoundingClientRect();
            if (r.top < s.top - 0.5 || r.bottom > s.bottom + 0.5) out.push(`"${b.textContent}" outside the strip (${Math.round(r.top)}..${Math.round(r.bottom)} in ${Math.round(s.top)}..${Math.round(s.bottom)})`);
          }
        }
        return out;
      }, failed);
      for (let y = 0; y <= max + 40; y += 40) {
        await current.evaluate((r, y) => {
          let el: HTMLElement | null = r.parentElement;
          while (el && !(/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)) el = el.parentElement;
          el!.scrollTop = y;
        }, y);
        await expect.poll(unseen, { timeout: 3000, message: `at ${y} px of the scroll` }).toEqual([]);
      }
      await expect(page.getByTestId("need-strip")).toBeVisible();
      await shoot(page, "phone-list-foot");
      // A short screen (a smaller phone, or the keyboard up): the strip holds fewer names, and the
      // rest are behind its "+N".
      await page.setViewportSize({ width: 390, height: 600 });
      for (const y of [0, Math.round(max / 2)]) {
        await current.evaluate((r, y) => {
          let el: HTMLElement | null = r.parentElement;
          while (el && !(/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)) el = el.parentElement;
          if (el) el.scrollTop = y;
        }, y);
        await expect.poll(unseen, { timeout: 3000, message: `at ${y} px of the scroll, 600 px tall` }).toEqual([]);
      }
      await shoot(page, "phone-list-foot-short");
      // A bigger text size: the find is taller, and a row behind it is still out of view and named.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.keyboard.press("Control+Equal");
      await page.keyboard.press("Control+Equal");
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim())).toBe("1.2");
      const { max: big } = await scroller();
      for (let y = 0; y <= big + 40; y += 40) {
        await current.evaluate((r, y) => {
          let el: HTMLElement | null = r.parentElement;
          while (el && !(/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)) el = el.parentElement;
          if (el) el.scrollTop = y;
        }, y);
        await expect.poll(unseen, { timeout: 3000, message: `at ${y} px of the scroll, text at 120%` }).toEqual([]);
      }
      // The page lets the browser resize it for the keyboard, so the foot stands above the keyboard.
      expect(await page.locator('meta[name="viewport"]').getAttribute("content")).toContain("interactive-widget=resizes-content");
    } finally {
      await page.evaluate(() => localStorage.removeItem("keel.textScale")).catch(() => {});
      for (const id of made) await request.delete(`/api/sessions/${id}`);
    }
  });

  // Feature: on a phone the open session's row keeps its place on the screen while sessions arrive
  // above it in the list, and the list is padded for none of them: its box scrolls for them (all but
  // a part of a pixel, made up above the rows). In Chromium and in WebKit (whose
  // scroll does not anchor by itself).
  const arrivals = async (page: Page, request: APIRequestContext) => {
    const tag = Math.random().toString(36).slice(2, 6);
    const made: string[] = [];
    const make = async (title: string) => {
      const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title } })).json();
      made.push(session.id);
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:say Done." } });
      return session.id as string;
    };
    const ended = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end");
    try {
      for (let i = 1; i <= 16; i++) await make(`Anchor ${tag} ${i}`);
      for (const id of made) await expect.poll(() => ended(id), { timeout: 60_000 }).toBe(true);
      const target = made[8]!;
      await page.goto(`/s/${target}`);
      await page.getByRole("button", { name: "All sessions" }).first().tap();
      const row = page.locator(`[data-testid="session-list"] [data-testid="session-row"][data-session="${target}"]`);
      await expect(row).toBeInViewport();
      const at = () => page.evaluate((id) => {
        const nav = document.querySelector<HTMLElement>('[data-testid="session-list"]')!;
        const r = nav.querySelector<HTMLElement>(`[data-testid="session-row"][data-session="${id}"]`);
        const rows = [...nav.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].map((x) => x.dataset.session);
        return { top: r ? Math.round(r.getBoundingClientRect().top) : null, padTop: nav.style.paddingTop, padBottom: nav.style.paddingBottom, above: rows.slice(0, rows.indexOf(id)) };
      }, target);
      const before = await at();
      const fresh: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const id = await make(`Anchor ${tag} arrival ${i}`);
        fresh.push(id);
        await expect.poll(() => ended(id), { timeout: 60_000 }).toBe(true);
        await expect.poll(async () => (await at()).above.includes(id), { timeout: 10_000, message: `arrival ${i} is drawn above the open row` }).toBe(true);
        await expect.poll(async () => { const now = await at(); return { top: now.top, padTop: parseFloat(now.padTop || "0") < 1, padBottom: parseFloat(/([\d.]+)px/.exec(now.padBottom)?.[1] ?? "0") < 1 }; }, { timeout: 5000, message: `after arrival ${i}` }).toEqual({ top: before.top, padTop: true, padBottom: true });
      }
      await shoot(page, "phone-list-arrivals");
    } finally { for (const id of made) await request.delete(`/api/sessions/${id}`); }
  };
  test("the open row keeps its place as sessions arrive above it", async ({ page, request }) => {
    test.setTimeout(180_000);
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    await arrivals(page, request);
  });
  test("the open row keeps its place as sessions arrive above it, in WebKit", async ({ request, baseURL }) => {
    test.setTimeout(180_000);
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    test.skip(!existsSync(webkit.executablePath()), "needs WebKit: npx playwright install webkit");
    const browser = await webkit.launch({ headless: true });
    try {
      const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true,
        storageState: { cookies: [], origins: [{ origin: new URL(baseURL!).origin, localStorage: [{ name: "keel.focus", value: "true" }] }] } });
      await arrivals(await ctx.newPage(), request);
    } finally { await browser.close(); }
  });
});

// Feature: on a phone's home, requests are answered one after another at a finger's pace. An
// answered row keeps its room for the settle time (and while a finger is down), so the next row's
// Allow stays where it stood and takes the next tap; a row that moves is still refused.
test.describe("on a phone's home", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("four requests are allowed with four taps: the next row stays where it stood, and the list closes up at once when none is left in view", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const ids: string[] = [];
    try {
      for (let i = 1; i <= 4; i++) {
        const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Burst ${i}` } })).json();
        ids.push(session.id);
        await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
        await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `touch burst-${i}.txt` } }])}` } });
      }
      const waiting = async () => { let n = 0; for (const id of ids) n += ((await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals ?? []).length; return n; };
      await expect.poll(waiting, { timeout: 30_000 }).toBe(4);
      await page.goto("/");
      // (Only these sessions' rows: a daemon others work on may have requests of its own waiting.)
      const allows = page.getByTestId("home-lists").locator(ids.map((id) => `[data-testid="home-session"][data-session="${id}"] [data-testid="home-allow"]`).join(", "));
      await expect(allows).toHaveCount(4);
      // The first is pressable once it has stood; each next one is pressable as soon as the one before was taken.
      await expect(allows.first()).not.toHaveAttribute("aria-disabled", /./);
      // The second stands where it stood while the first is answered, and takes a tap at once.
      const second = (await allows.nth(1).boundingBox())!.y;
      for (let k = 0; k < 4; k++) {
        const next = allows.first();
        if (k === 1) {
          // (Under a pixel: what the Allow's own rule calls standing still, lib/approvals.ts.)
          expect(Math.abs((await next.boundingBox())!.y - second)).toBeLessThan(1);
          expect(await next.getAttribute("aria-disabled")).toBeNull();
        }
        // Once the rows in view are answered the list closes up at once; the rows that come up are
        // pressed once they say they can be (a tap before that would be refused, and none is made).
        await expect(next).not.toHaveAttribute("aria-disabled", /./);
        const b = (await next.boundingBox())!;
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
        await expect.poll(waiting).toBe(3 - k);
        await expect(allows).toHaveCount(3 - k);
        if (k === 0) await shoot(page, "phone-06-home-answered-row");
      }
      await expect(page.getByTestId("home-note")).toHaveCount(0);
    } finally { for (const id of ids) await request.delete(`/api/sessions/${id}`); }
  });
});

// Feature: on a phone, what waits on the owner is answered one card after another. The dock's
// count of what needs them is a button in a slot of its own: a tap goes to the card that has
// waited longest (the phone's Alt+A). An answer given on the phone goes on to the next session's
// card, however the owner came to the first, and the last answer leads back where they began.
test.describe("on a phone, what waits", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const bash = (command: string) => `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`;
  const question = `script:calls ${JSON.stringify([{ name: "AskUserQuestion", input: { questions: [{ header: "Scope", question: "Fix only cart.js or the whole module?", options: [{ label: "Only cart.js" }, { label: "Whole module" }], multiSelect: false }] } }])}`;
  // Sessions made in order (the first has waited longest), each sent its prompt; resolves once each waits.
  async function waiting(request: import("@playwright/test").APIRequestContext, tag: string, prompts: { title: string; mode: string; text: string }[]) {
    const ids: string[] = [];
    for (const p of prompts) {
      const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `${p.title} ${tag}` } })).json();
      ids.push(session.id);
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: p.mode, sandbox: "off" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: p.text } });
      // One at a time, so the order of waiting is the order made.
      const asks = async () => ((await (await request.get(`/api/sessions/${session.id}/approvals`)).json()).approvals ?? []).length
        + ((await (await request.get(`/api/sessions/${session.id}/questions`)).json()).pending ?? []).length;
      await expect.poll(asks, { timeout: 30_000 }).toBe(1);
    }
    return ids;
  }
  // Taps what the card asks once it can be pressed, and counts the tap.
  const tapWhenReady = async (loc: import("@playwright/test").Locator) => {
    await expect(loc).toBeVisible();
    await expect(loc).not.toHaveAttribute("aria-disabled", /./);
    await loc.tap();
  };

  test("the dock's count is a button of its own that goes to the card that waited longest", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const made: string[] = [];
    try {
      const { session: home } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Desk ${tag}` } })).json();
      made.push(home.id);
      await request.post(`/api/sessions/${home.id}/messages`, { data: { text: "script:say ready" } });
      const ids = await waiting(request, tag, [
        { title: "Wait one", mode: "ask", text: bash("touch one.txt") },
        { title: "Wait two", mode: "ask", text: bash("touch two.txt") },
        { title: "Wait three", mode: "ask", text: bash("touch three.txt") },
      ]);
      made.push(...ids);
      await page.goto(`/s/${home.id}`);
      const pill = page.getByRole("button", { name: /need you/ });
      await expect(pill).toBeVisible();
      await shoot(page, "phone-07-dock-need");
      // A finger's size, and in a slot of its own: no mark of the dock lies under it.
      const b = (await pill.boundingBox())!;
      const tap = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.75);
      expect(b.height).toBeGreaterThanOrEqual(tap - 0.5);
      const list = (await page.locator(".k-dock-list").boundingBox())!;
      expect(list.x + list.width).toBeLessThanOrEqual(b.x + 0.5);
      await pill.tap();
      const pane = page.locator(".k-station[data-helm]");
      await expect(page).toHaveURL(new RegExp(`/s/${ids[0]}$`));
      await expect(pane.getByTestId("allow-once")).toBeVisible();
      // (Once the page has glided into place.)
      await expect(pane).toBeInViewport({ ratio: 1 });
      await shoot(page, "phone-08-dock-need-went");
    } finally { for (const id of made) await request.delete(`/api/sessions/${id}`); }
  });

  test("three approvals and a question are answered with six taps from one dock mark, and the last answer leads back", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const made: string[] = [];
    try {
      const { session: home } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Desk ${tag}` } })).json();
      made.push(home.id);
      await request.post(`/api/sessions/${home.id}/messages`, { data: { text: "script:say ready" } });
      const ids = await waiting(request, tag, [
        { title: "Ask one", mode: "ask", text: bash("touch one.txt") },
        { title: "Ask two", mode: "ask", text: bash("touch two.txt") },
        { title: "Ask three", mode: "ask", text: bash("touch three.txt") },
        { title: "Ask scope", mode: "full-auto", text: question },
      ]);
      made.push(...ids);
      // What still waits in these sessions, as the daemon tells it.
      const left = async () => {
        let n = 0;
        for (const id of ids.slice(0, 3)) n += ((await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals ?? []).length;
        return n + ((await (await request.get(`/api/sessions/${ids[3]}/questions`)).json()).pending ?? []).length;
      };
      await expect.poll(left, { timeout: 30_000 }).toBe(4);
      await page.goto(`/s/${home.id}`);
      const pane = page.locator(".k-station[data-helm]");
      await expect(pane.getByTestId("assistant-text").last()).toBeVisible();
      let taps = 0;
      // The owner goes to the first by its mark in the dock, as from any list.
      const mark = page.locator(`.k-dock-mark[aria-label^="Ask one ${tag},"]`);
      await mark.scrollIntoViewIfNeeded();
      await mark.tap(); taps++;
      for (let k = 0; k < 3; k++) {
        await expect(page).toHaveURL(new RegExp(`/s/${ids[k]}$`));
        await tapWhenReady(pane.getByTestId("allow-once")); taps++;
        if (k === 0) {
          // The next waiting card shows: the page went on by itself.
          await expect(page).toHaveURL(new RegExp(`/s/${ids[1]}$`));
          await expect(pane).toBeInViewport({ ratio: 1 });
          // And the dock's mark of it is in view.
          await expect(page.locator(".k-dock-mark[aria-current]")).toBeInViewport({ ratio: 1 });
          await shoot(page, "phone-09-answer-went-on");
        }
      }
      await expect(page).toHaveURL(new RegExp(`/s/${ids[3]}$`));
      await tapWhenReady(pane.getByTestId("question-option").first()); taps++;
      await tapWhenReady(pane.getByTestId("question-submit")); taps++;
      // Nothing is left: back where the owner began.
      await expect(page).toHaveURL(new RegExp(`/s/${home.id}$`));
      expect(taps).toBe(6);
      console.log(`taps to answer three approvals and a question: ${taps}`);
      await expect.poll(left, { timeout: 15_000 }).toBe(0);
    } finally { for (const id of made) await request.delete(`/api/sessions/${id}`); }
  });

  // A question with three choices and a long text, and another session waiting: every choice and the
  // field for an answer of the owner's own show above the Answer row with no scroll. The box rests as
  // its one line meanwhile, and a tap on it brings its tools back, Stop among them.
  test("a waiting question shows every choice without a scroll, and the box gives it the room", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const long = `script:calls ${JSON.stringify([{ name: "AskUserQuestion", input: { questions: [{ header: "Scope", question: "Fix only cart.js or the whole checkout module? The module has four other callers of the retry helper.", options: [{ label: "Only cart.js", description: "Smallest change, ships today" }, { label: "Whole module", description: "Every caller of the helper gets the bound" }, { label: "Ask the team first" }], multiSelect: false }] } }])}`;
    const made = await waiting(request, tag, [{ title: "Other request", mode: "ask", text: bash("touch other.txt") }, { title: "Choose the fix scope again", mode: "full-auto", text: long }]);
    try {
      await page.goto(`/s/${made[1]}`);
      const pane = page.locator(".k-station[data-helm]");
      await expect(pane.getByTestId("question-option")).toHaveCount(3);
      await expect(pane.getByTestId("waiting-elsewhere")).toBeVisible();
      // What shows of the card in the region, above its Answer row, as the page laid it out.
      const shown = () => pane.evaluate((el) => {
        const t = el.querySelector('[data-testid="composer-tray"]')!.getBoundingClientRect();
        const foot = el.querySelector('[data-testid="question-foot"]')!.getBoundingClientRect();
        const bottom = Math.min(t.bottom, foot.top);
        const whole = (e: Element) => { const r = e.getBoundingClientRect(); return r.top >= t.top - 1 && r.bottom <= bottom + 1; };
        return { options: [...el.querySelectorAll('[data-testid="question-option"]')].filter(whole).length, other: whole(el.querySelector('[data-testid="question-other"]')!) };
      });
      await expect.poll(shown, { timeout: 5000 }).toEqual({ options: 3, other: true });
      await expect(pane.getByTestId("composer-tools")).toBeHidden();
      await shoot(page, "phone-12-question-room");
      // A tap on the box: its tools, and the running turn's Stop.
      await pane.getByTestId("composer").tap();
      await expect(pane.getByTestId("stop")).toBeVisible();
      await expect(pane.getByTestId("composer-tools")).toBeVisible();
      // Whole where a finger finds them: inside the window and the pane, above the dock, and the
      // press at Stop's middle lands on Stop. The cards above give the room and scroll.
      const reach = () => pane.evaluate((el) => {
        const p = el.getBoundingClientRect();
        const dock = document.querySelector(".k-dock")?.getBoundingClientRect();
        const floor = Math.min(innerHeight, p.bottom, dock && dock.height ? dock.top : Infinity);
        const inside = (e: Element) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.top >= p.top - 1 && r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= floor + 1; };
        const stop = el.querySelector('[data-testid="stop"]')!;
        const r = stop.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { stop: inside(stop), tools: inside(el.querySelector('[data-testid="composer-tools"]')!), pressed: !!hit && stop.contains(hit) };
      });
      await expect.poll(reach, { timeout: 5000 }).toEqual({ stop: true, tools: true, pressed: true });
      await shoot(page, "phone-12b-question-box-open");
      // A long draft too: it gives way after the cards, never over its own tools.
      await pane.getByTestId("composer").fill(Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a long steer`).join("\n"));
      await expect.poll(reach, { timeout: 5000 }).toEqual({ stop: true, tools: true, pressed: true });
      await expect(pane.getByTestId("composer-tray")).toBeInViewport();
      await pane.getByTestId("composer").fill("");
    } finally { for (const id of made) await request.delete(`/api/sessions/${id}`); }
  });
});

// At the largest text sizes a phone's head is the title and its state, read whole: pin and close are in
// the session's menu, and a phone has no panes to focus. A waiting approval's three answers show with
// no scroll. (390x844 at 150%: the heads took 245 px, the title cut to 10 characters.)
test.describe("on a phone at a large text size, the head", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("leaves the room to what waits, and the title reads whole", async ({ browser, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Clean the docs cache ${tag}` } })).json();
    try {
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "touch clean.txt" } }])}` } });
      await expect.poll(async () => ((await (await request.get(`/api/sessions/${session.id}/approvals`)).json()).approvals ?? []).length, { timeout: 30_000 }).toBe(1);
      for (const [width, height] of [[390, 844], [412, 915]] as const) for (const scale of [1.3, 1.5]) {
        const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width, height }, hasTouch: true, isMobile: true });
        await ctx.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
        const page = await ctx.newPage();
        try {
          await page.goto(`/s/${session.id}`);
          const pane = page.locator(".k-station[data-helm]");
          await expect(pane.getByTestId("deny")).toBeAttached();
          // The title whole, the head with no tools of its own.
          await expect.poll(() => pane.getByTestId("station-title").evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          await expect(pane.getByTestId("station-focus")).toBeHidden();
          // The three answers whole in the region, with no scroll.
          const shown = () => pane.evaluate((el) => {
            const t = el.querySelector('[data-testid="composer-tray"]')!.getBoundingClientRect();
            return ["allow-once", "allow-always", "deny"].filter((k) => { const r = el.querySelector(`[data-testid="${k}"]`)!.getBoundingClientRect(); return r.top >= t.top - 1 && r.bottom <= t.bottom + 1; });
          });
          await expect.poll(shown, { timeout: 5000 }).toEqual(["allow-once", "allow-always", "deny"]);
          // The heads keep under a quarter of the screen.
          const heads = await pane.evaluate((el) => el.querySelector('[data-testid="session-header"]')!.getBoundingClientRect().bottom - el.querySelector('[data-testid="station-head"]')!.getBoundingClientRect().top);
          expect(heads).toBeLessThan(height / 4);
          await shoot(page, `phone-13-head-${width}-${scale}`);
          // Pin and close are in the session's menu.
          await pane.getByTestId("session-menu").tap();
          await expect(page.getByTestId("menu-pin")).toBeVisible();
          await expect(page.getByTestId("menu-close")).toBeVisible();
          await page.keyboard.press("Escape");
        } finally { await ctx.close(); }
      }
    } finally { await request.delete(`/api/sessions/${session.id}`); }
  });
});

// At 130% and 150% text a waiting question still shows every choice with no scroll: while it waits the
// card takes the room of the session's tools row, the state line and the conversation's strip; its
// header leads the question, a long question is cut at three lines (a tap reads it all), and the
// line of the other sessions that wait goes under it.
test.describe("on a phone at a large text size, a waiting question", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("shows every choice without a scroll, and reads whole with a tap", async ({ browser, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const made: string[] = [];
    const make = async (title: string, mode: string, text: string) => {
      const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `${title} ${tag}` } })).json();
      made.push(session.id);
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, sandbox: "off" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
      return session.id as string;
    };
    try {
      await make("Other request", "ask", `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "touch other.txt" } }])}`);
      const id = await make("Choose the fix scope", "full-auto", `script:calls ${JSON.stringify([{ name: "AskUserQuestion", input: { questions: [{ header: "Scope", question: "Fix only cart.js or the whole checkout module? The module has four other callers of the retry helper.", options: [{ label: "Only cart.js", description: "Smallest change, ships today" }, { label: "Whole module", description: "Every caller of the helper gets the bound" }, { label: "Ask the team first" }], multiSelect: false }] } }])}`);
      await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}/questions`)).json()).pending ?? []).length, { timeout: 30_000 }).toBe(1);
      for (const [width, height] of [[390, 844], [412, 915]] as const) for (const scale of [1.3, 1.5]) {
        const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width, height }, hasTouch: true, isMobile: true });
        await ctx.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
        const page = await ctx.newPage();
        try {
          await page.goto(`/s/${id}`);
          const pane = page.locator(".k-station[data-helm]");
          await expect(pane.getByTestId("question-option")).toHaveCount(3);
          await expect(pane.getByTestId("waiting-elsewhere")).toBeAttached();
          const shown = () => pane.evaluate((el) => {
            const t = el.querySelector('[data-testid="composer-tray"]')!.getBoundingClientRect();
            const foot = el.querySelector('[data-testid="question-foot"]')!.getBoundingClientRect();
            const bottom = Math.min(t.bottom, foot.top);
            return [...el.querySelectorAll('[data-testid="question-option"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.top >= t.top - 1 && r.bottom <= bottom + 1; }).length;
          });
          await expect.poll(shown, { timeout: 5000 }).toBe(3);
          await shoot(page, `phone-14-question-${width}-${scale}`);
          // A question cut short reads whole with a tap on it.
          const text = pane.getByTestId("question-text");
          if (await pane.getByTestId("question-more").count()) {
            await text.tap();
            await expect(pane.getByTestId("question-more")).toHaveCount(0);
            await expect.poll(() => text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
          }
        } finally { await ctx.close(); }
      }
    } finally { for (const id of made) await request.delete(`/api/sessions/${id}`); }
  });
});

// The dock's row shows whole marks only, at every text size: none is cut at the edge of the button for
// what needs the owner (which says its count with the need mark), and the marks out of view are
// counted on the list's button. (390 px: a mark cut there read "D".)
test.describe("on a phone, the dock", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("shows whole marks and counts the rest", async ({ browser, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const made: string[] = [];
    try {
      for (let i = 0; i < 7; i++) {
        const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Dock ${i} ${tag}` } })).json();
        made.push(session.id);
        if (i < 3) {
          await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
          await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `touch dock${i}.txt` } }])}` } });
        }
      }
      for (const id of made.slice(0, 3)) await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals ?? []).length, { timeout: 30_000 }).toBe(1);
      for (const [width, height] of [[390, 844], [412, 915]] as const) for (const scale of [1, 1.3, 1.5]) {
        const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width, height }, hasTouch: true, isMobile: true });
        await ctx.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
        const page = await ctx.newPage();
        try {
          await page.goto(`/s/${made[6]}`);
          await expect(page.locator(".k-dock-mark")).toHaveCount(6);
          await expect(page.getByTestId("dock-need")).toHaveAccessibleName(/need you/);
          const look = () => page.evaluate(() => {
            const l = document.querySelector(".k-dock-list")!.getBoundingClientRect();
            const ms = [...document.querySelectorAll(".k-dock-mark")].map((m) => m.getBoundingClientRect());
            return { cut: ms.filter((b) => b.left < l.right - 0.5 && b.right > l.right + 0.5).length, out: ms.filter((b) => b.right > l.right + 0.5 || b.left < l.left - 0.5).length, said: document.querySelector('[data-testid="dock-out"]')?.textContent ?? "" };
          });
          await expect.poll(look).toEqual(expect.objectContaining({ cut: 0 }));
          const r = await look();
          expect(r.said).toBe(r.out ? `+${r.out}` : "");
          await shoot(page, `phone-15-dock-${width}-${scale}`);
        } finally { await ctx.close(); }
      }
    } finally { for (const id of made) await request.delete(`/api/sessions/${id}`); }
  });
});

// The home's "N failed" for a session that failed through its agents opens the agent that failed, its
// failure in its head, and the session no longer counts it. (It opened the coordinator at its end, the
// failed agent named only far up, the head saying what another agent ran.)
test.describe("on a phone's home, a failed agent", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("is one tap from the failed count", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Coordinator ${tag}` } })).json();
    const spawn = (message: string) => ({ name: "spawn_agent", input: { message } });
    try {
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn(`Linter ${tag}\nscript:say lint clean`), spawn(`Fetcher ${tag}\nscript:billing`)])}` } });
      const agents = async () => ((await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents ?? []) as any[];
      await expect.poll(async () => (await agents()).find((a) => a.status === "failed")?.session_id ?? null, { timeout: 60_000 }).not.toBeNull();
      const failed = (await agents()).find((a) => a.status === "failed")!.session_id as string;
      await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.agents_failed_ms ?? null, { timeout: 30_000 }).not.toBeNull();
      await page.goto("/");
      const count = page.getByTestId("home-count-fail");
      await expect(count).toBeVisible();
      await shoot(page, "phone-16-home-failed");
      await count.tap();
      await expect(page).toHaveURL(new RegExp(`/s/${failed}$`));
      const pane = page.locator(".k-station[data-helm]");
      await expect(pane.getByTestId("station-word")).toHaveText(/Failed/);
      await expect(pane.getByTestId("station-head")).toBeInViewport();
      await shoot(page, "phone-17-failed-agent");
      // Looked at: the coordinator counts its agents' failure no more.
      await expect.poll(async () => { const s = (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings; return s.agents_fail_seen_ms === s.agents_failed_ms; }).toBe(true);
    } finally { await request.delete(`/api/sessions/${session.id}`); }
  });
});

// What broke is one tap from a session on a phone: while errors wait unread, the dock has their button.
// The panel reads each message whole, and its note under its title. (It was two taps away, through the
// list, each message cut to one line.)
test.describe("on a phone, the errors", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("are one tap from a session and read whole", async ({ browser, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const tag = Math.random().toString(36).slice(2, 6);
    const message = `Daemon unresponsive for 3.5 s ${tag}: 1.8 s waiting for the disk in a write of the session store, 1.2 s on a processor`;
    const { id: error } = await (await request.post("/api/errors", { data: { message, source: "browser", stack: "at a test" } })).json();
    const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Errors ${tag}` } })).json();
    try {
      for (const [width, height] of [[390, 844], [412, 915]] as const) for (const scale of [1, 1.5]) {
        const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width, height }, hasTouch: true, isMobile: true });
        await ctx.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
        const page = await ctx.newPage();
        try {
          await page.goto(`/s/${session.id}`);
          const button = page.getByTestId("dock-errors");
          await expect(button).toHaveAccessibleName(/^Errors\./);
          await button.tap();
          const panel = page.getByTestId("errors-panel");
          await expect(panel).toBeVisible();
          const row = panel.getByTestId("error-message").filter({ hasText: tag });
          await expect(row).toBeVisible();
          const whole = (el: Element) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1;
          expect(await row.evaluate(whole)).toBe(true);
          expect(await panel.getByTestId("errors-note").evaluate(whole)).toBe(true);
          await shoot(page, `phone-18-errors-${width}-${scale}`);
        } finally { await ctx.close(); }
      }
    } finally {
      await request.delete(`/api/sessions/${session.id}`);
      await request.patch(`/api/errors/${error}`, { data: { resolved: true } });
    }
  });
});

// A session opens at the end of its last reply. When that reply is longer than the view, a way to its
// first line stands at the conversation's foot; a tap puts that line at the view's top. (A 30-item
// reply's start was 3,235 px above, with no way there but a long scroll.)
test.describe("on a phone, a long last reply", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("has a way to its start", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
    const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Long reply" } })).json();
    try {
      const items = Array.from({ length: 30 }, (_, i) => `${i + 1}. The retry at step ${i + 1} waits \`${(i + 1) * 250} ms\` before it tries the request again, longer than the gateway's timeout on a slow day.`).join("\\n");
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:say ## Findings\\n${items}` } });
      await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);
      await page.goto(`/s/${session.id}`);
      const pane = page.locator(".k-station[data-helm]");
      const reply = pane.getByTestId("assistant-text").last();
      await expect(reply).toContainText("The retry at step 30");
      const jump = pane.getByTestId("reply-start-jump");
      await expect(jump).toBeVisible();
      await shoot(page, "phone-19-reply-start");
      // Looking at the view runs a moment after every scroll (a timer of 200 ms); it does not search the
      // page for the last reply each time. (The count of those timers that ran says that looks ran.)
      await page.evaluate(() => {
        const w = window as any;
        w.__searches = 0; w.__looks = 0;
        const find = Element.prototype.querySelectorAll;
        Element.prototype.querySelectorAll = function (this: Element, sel: string) { if (String(sel).includes("assistant-text")) w.__searches++; return find.call(this, sel) as any; } as any;
        const set = window.setTimeout.bind(window);
        window.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => set(ms === 200 && typeof fn === "function" ? (...a: any[]) => { try { return fn(...a); } finally { w.__looks++; } } : fn, ms, ...rest)) as any;
      });
      for (let i = 0; i < 4; i++) {
        const before = await page.evaluate(() => (window as any).__looks);
        await pane.evaluate((el, d) => { el.querySelector(".k-reading")!.scrollBy(0, d); }, i % 2 ? 4 : -4);
        await expect.poll(() => page.evaluate(() => (window as any).__looks)).toBeGreaterThan(before);
      }
      expect(await page.evaluate(() => (window as any).__searches)).toBeLessThanOrEqual(1);
      await expect(jump).toBeVisible();
      await jump.tap();
      const at = () => pane.evaluate((el) => { const v = el.querySelector(".k-reading")!.getBoundingClientRect(); const all = el.querySelectorAll('[data-testid="assistant-text"]'); return Math.round(all[all.length - 1]!.getBoundingClientRect().top - v.top); });
      await expect.poll(at).toBeGreaterThanOrEqual(0);
      expect(await at()).toBeLessThan(80);
      await expect(jump).toHaveCount(0);
      await shoot(page, "phone-20-reply-start-went");
    } finally { await request.delete(`/api/sessions/${session.id}`); }
  });
});

// The targets on screen that a finger cannot press well: under 2.75rem a side, or lying over
// another target of the same layer (a fixed bar, a popup or a dialog is a layer of its own; a
// box is taken as it shows, cut by what clips it). A target is what a press acts on: a
// control, a link outside the words of a message, a row; one inside another is its part.
async function misfits(page: Page) {
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const sel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=option], [role=tab], [role=switch], [role=radio], [role=checkbox]';
    const tap = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.75;
    const shown = (el: Element) => {
      if (el.closest("[inert], .prose-keel")) return false;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2 || b.right <= 0 || b.bottom <= 0 || b.left >= innerWidth || b.top >= innerHeight) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.pointerEvents === "none" || Number(cs.opacity) === 0) return false;
      const top = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, b.left + b.width / 2)), Math.min(innerHeight - 1, Math.max(0, b.top + b.height / 2)));
      return !!top && (el.contains(top) || top.contains(el));
    };
    const all = [...document.querySelectorAll(sel)].filter(shown);
    const outer = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
    const name = (el: Element) => `${(el as HTMLElement).dataset.testid ?? el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32)}"`;
    const layer = (el: Element) => { for (let e = el.parentElement; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.position === "fixed" || cs.position === "sticky" || /^(dialog|menu|listbox)$/.test(e.getAttribute("role") ?? "")) return e; } return document.body; };
    const box = (el: Element) => {
      const b = el.getBoundingClientRect();
      let l = b.left, t = b.top, r = b.right, btm = b.bottom;
      // A box that cuts what it holds for good (overflow hidden) makes the target as small as it shows;
      // one that scrolls shows part of a target that a scroll brings in whole.
      // (Not past a box that scrolls: what lies outside it is a scroll away, whatever cuts it further out.)
      let w = b.width, h = b.height, scrollsX = false, scrollsY = false;
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e), c = e.getBoundingClientRect();
        const cuts = (o: string) => o === "hidden" || o === "clip";
        if (cs.overflowX !== "visible") { l = Math.max(l, c.left); r = Math.min(r, c.right); if (cuts(cs.overflowX) && !scrollsX) w = Math.min(w, Math.max(0, Math.min(b.right, c.right) - Math.max(b.left, c.left))); else scrollsX = true; }
        if (cs.overflowY !== "visible") { t = Math.max(t, c.top); btm = Math.min(btm, c.bottom); if (cuts(cs.overflowY) && !scrollsY) h = Math.min(h, Math.max(0, Math.min(b.bottom, c.bottom) - Math.max(b.top, c.top))); else scrollsY = true; }
      }
      return { l, t, r, b: btm, w, h };
    };
    const items = outer.map((el) => ({ el, n: name(el), L: layer(el), ...box(el) }));
    const small = items.filter((t) => t.w < tap - 0.5 || t.h < tap - 0.5).map((t) => `${t.n} ${t.w.toFixed(1)}x${t.h.toFixed(1)}`);
    const over: string[] = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      if (a.L !== b.L) continue;
      const x = Math.min(a.r, b.r) - Math.max(a.l, b.l), y = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (x > 0.5 && y > 0.5) over.push(`${a.n} over ${b.n}`);
    }
    return { count: items.length, small, over };
  });
}

// Words of keys on screen and in the fields' placeholders, outside what a message says.
async function keyWords(page: Page) {
  return page.evaluate(() => {
    const keys = /\b(Enter|Esc|Escape|Ctrl|Cmd|Alt|Shift|Tab|PgUp|PgDn|Page Up|Page Down)\b|[⌘⌥⇧↵⏎]/;
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const el = t.parentElement;
      if (!el || !t.textContent?.trim() || !keys.test(t.textContent)) continue;
      if (el.closest("[inert], .prose-keel, pre, code, [data-testid=user-text], [data-testid=plan-text], .sr-only")) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2 || b.bottom <= 0 || b.top >= innerHeight) continue;
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      out.push(`${el.closest("[data-testid]")?.getAttribute("data-testid") ?? el.tagName}: ${t.textContent.trim().slice(0, 60)}`);
    }
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[placeholder], textarea[placeholder]")) {
      const b = el.getBoundingClientRect();
      if (b.width > 2 && b.bottom > 0 && b.top < innerHeight && keys.test(el.placeholder)) out.push(`${el.dataset.testid ?? el.tagName} placeholder: ${el.placeholder}`);
    }
    return out;
  });
}
