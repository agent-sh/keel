import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "./isolate.ts";
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
      // What else waits is said without the key that goes there, and without what is left of its words.
      await expect(pane.getByTestId("waiting-elsewhere")).toHaveText(/wait for you\.$/, { useInnerText: true });
      await shoot(page, "phone-04-targets-approval");
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
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e), c = e.getBoundingClientRect();
        if (cs.overflowX !== "visible") { l = Math.max(l, c.left); r = Math.min(r, c.right); }
        if (cs.overflowY !== "visible") { t = Math.max(t, c.top); btm = Math.min(btm, c.bottom); }
      }
      return { l, t, r, b: btm, w: b.width, h: b.height };
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
