import { expect, test, type Page } from "./isolate.ts";
import { approvals, ask, calls, create, drop, folder, scripted } from "./answering.ts";
import { endsAre, shoot } from "./shots.ts";

// Feature: Focus on a phone (ui/src/lib/focus.ts), the default there as at a desk. A session is the
// conversation and the message box under a bar that holds the list's button, card or no card: the list
// is one tap away. No strip of marks runs along the bottom; what needs the owner in other sessions is a
// quiet dot and figure in the bar that goes to the next. The bar keeps the state's dot, not its clock.
// The box is one line, its plus, Stop and Send a line's small icons in a finger's target. The agents
// over the box are one quiet item, the word and how many, never their names.

const rootPx = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
const sleeper = (title: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([{ name: "Bash", input: { command: "sleep 120" } }])}` } });

for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`Focus on a phone, ${size.width}x${size.height}`, () => {
    // No saved choice: what the owner sees the first time.
    test.use({ storageState: { cookies: [], origins: [] }, viewport: size, hasTouch: true, isMobile: true });
    test.setTimeout(120_000);

    test("opening a fold keeps the first revealed line at the tap", async ({ page, request }) => {
      await scripted(request);
      const id = await create(request, "A folded run", folder("phone-fold"));
      try {
        await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
        const work = Array.from({ length: 12 }, (_, i) => ({ name: "Bash", input: { command: `echo check ${i}; exit 3` } }));
        await request.post(`/api/sessions/${id}/messages`, { data: { text: `Check the output.\n${calls(work)}` } });
        await page.goto(`/s/${id}`);
        await endsAre(page, 1);
        await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say Checks complete." } });
        await endsAre(page, 2);
        await page.reload();
        const fold = page.getByTestId("work-fold");
        await expect(fold).toHaveCount(1);
        await fold.scrollIntoViewIfNeeded();
        const y = (await fold.boundingBox())!.y;
        await fold.tap();
        const first = page.getByTestId("work").first();
        await expect(first).toBeVisible();
        // Let the transcript's resize observer run before reading the position, without resizing for the shots.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        try {
          expect(Math.abs((await first.boundingBox())!.y - y)).toBeLessThan(2);
        } finally {
          await shoot(page, `phone-fold-${size.width}`);
        }
      } finally {
        await drop(request, id);
      }
    });

    test("the conversation and a one-line box, the list one tap away, the agents one quiet item", async ({ page, request }) => {
      await scripted(request);
      const coord = await create(request, "Phone coordinator", folder("phone-focus-coord"));
      const asker = await create(request, "Phone asks for a command", folder("phone-focus-asker"));
      try {
        await request.put(`/api/sessions/${coord}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
        // Two agents at work and a command of its own: the turn runs, so Stop is in the box.
        await request.post(`/api/sessions/${coord}/messages`, { data: { text: calls([sleeper("Phone agent one"), sleeper("Phone agent two"), { name: "Bash", input: { command: "sleep 100" } }]) } });
        await page.goto(`/s/${coord}`);
        const pane = page.locator(".k-station[data-helm]");
        await expect(pane.getByTestId("composer")).toBeVisible();
        const px = await rootPx(page);

        // No strip of marks along the bottom; the bar holds the list's button and the state's dot, no clock.
        await expect(page.locator(".k-dock")).toBeHidden();
        await expect(pane.getByTestId("show-sidebar")).toBeVisible();
        await expect(pane.getByTestId("station-clock")).toBeHidden();

        // The agents: one quiet item, the word and how many are live, no names.
        await expect(page.getByTestId("dock-agents-count")).toHaveText("2", { timeout: 30_000 });
        await expect(page.getByTestId("dock-agents-line")).not.toContainText("Phone agent");
        await expect(page.getByTestId("dock-agent")).toHaveCount(0);
        expect(await page.getByTestId("dock-agents").locator(".k-agents-label").evaluate((e) => getComputedStyle(e).fontWeight)).toBe("400");

        // A run's line in the conversation is a finger's height, its words in its middle with the dot.
        const run = pane.getByTestId("lens-run-toggle").first();
        await expect(run).toBeVisible({ timeout: 30_000 });
        const mid = async (l: ReturnType<Page["locator"]>) => { const r = (await l.boundingBox())!; return r.y + r.height / 2; };
        expect(Math.abs((await mid(run.locator(".k-lens-dot"))) - (await mid(run.getByTestId("lens-run-came"))))).toBeLessThanOrEqual(2);

        // The box is one line while the turn runs: Stop and Send stand on the field's line, each drawn a line's icon.
        const box = pane.getByTestId("composer-box"), field = pane.getByTestId("composer");
        const stop = pane.getByTestId("stop"), send = pane.getByTestId("send");
        await expect(stop).toBeVisible({ timeout: 30_000 });
        const f = (await field.boundingBox())!, b = (await box.boundingBox())!;
        expect(b.height, `the box is ${b.height}px tall`).toBeLessThanOrEqual(f.height + 0.5 * px + 2);
        for (const btn of [stop, send]) {
          const r = (await btn.boundingBox())!;
          expect(r.y).toBeGreaterThanOrEqual(f.y - 1);
          expect(r.y + r.height).toBeLessThanOrEqual(f.y + f.height + 1);
          // A finger's target, but no fill or ring of that size: what shows is the icon.
          expect(r.height).toBeGreaterThanOrEqual(2.75 * px - 1);
          const look = await btn.evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, border: s.borderTopWidth }; });
          expect(look.bg).toBe("rgba(0, 0, 0, 0)");
          expect(look.border).toBe("0px");
        }
        // Typed text gives Send its fill, a line's icon square.
        await field.fill("steer this");
        const fill = await send.evaluate((e) => { const s = getComputedStyle(e, "::before"); return { w: parseFloat(s.width), bg: s.backgroundColor }; });
        expect(fill.w).toBeLessThanOrEqual(1.75 * px + 1);
        expect(fill.bg).not.toBe("rgba(0, 0, 0, 0)");
        await field.fill("");
        // The mode and the model are behind the box's plus, with attach.
        await expect(box.getByTestId("model-picker")).toHaveCount(0);
        await box.getByTestId("box-more").click();
        // (Each session's box keeps its popup in the page while it is closed: the open one is the one in view.)
        const popup = page.locator('[data-testid="box-more-popup"]:visible');
        await expect(popup.getByTestId("model-picker")).toBeVisible();
        await expect(popup.getByTestId("attach")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(popup).toHaveCount(0);
        await shoot(page, `phone-focus-01-working-${size.width}`);

        // Another session asks: the bar says it as a quiet dot and figure, the list's button stays.
        await ask(request, asker, "approval", "phone");
        const need = pane.getByTestId("head-need");
        await expect(need).toBeVisible({ timeout: 30_000 });
        await expect(need).toHaveText(/^\d+ needs? you$/);
        expect(await need.locator(".k-dock-need-n").evaluate((e) => getComputedStyle(e).fontWeight)).toBe("400");
        // The list is one tap away, and the bar's count goes to the session that asks.
        await pane.getByTestId("show-sidebar").click();
        await expect(page.getByTestId("sidebar")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("sidebar")).toBeHidden();
        await need.click();
        await expect(page).toHaveURL(new RegExp(asker));
        // With its card on screen the bar keeps the list's button.
        const there = page.locator(".k-station[data-helm]");
        await expect(there.getByTestId("approval").first()).toBeVisible({ timeout: 30_000 });
        await expect(there.getByTestId("show-sidebar")).toBeVisible();
        // (The pages slide to it: the shot waits until it has come to rest in the window.)
        await expect.poll(async () => Math.abs((await there.boundingBox())?.x ?? 99) < 2, { timeout: 10_000 }).toBe(true);
        await shoot(page, `phone-focus-02-card-${size.width}`);
      } finally {
        await drop(request, coord, asker);
      }
    });

    // The list opens at its top, where the rows that call the owner are, also when the open row is far
    // down it: on its side a phone has room for a few rows, and a scroll to the open row hid them.
    test("the list opens with the rows that call in view, the keys on the open row", async ({ page, request }) => {
      await scripted(request);
      const ws = folder(`phone-focus-drawer-${size.width}`);
      const resting: string[] = [];
      for (let i = 0; i < 7; i++) resting.push(await create(request, `Resting session ${i + 1}`, ws));
      const asker = await create(request, "Asks before it touches the release", ws);
      try {
        await request.put(`/api/sessions/${asker}/permissions`, { data: { mode: "ask", sandbox: "off" } });
        await request.post(`/api/sessions/${asker}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "touch release.txt" } }]) } });
        await expect.poll(async () => (await approvals(request, asker)).filter((a) => a.state === "pending").length, { timeout: 30_000 }).toBeGreaterThan(0);
        // The oldest resting session is open: its row is the list's last.
        await page.goto(`/s/${resting[0]}`);
        const pane = page.locator(".k-station[data-helm]");
        await expect(pane.getByTestId("station-title")).toBeVisible({ timeout: 30_000 });
        await pane.getByTestId("show-sidebar").tap();
        const rail = page.getByTestId("sidebar");
        const open = rail.locator(`[data-testid="session-row"][data-session="${resting[0]}"]`);
        await expect(open).toBeFocused();
        const calling = rail.locator(`[data-testid="session-row"][data-session="${asker}"]`);
        await expect(calling).toBeVisible();
        await page.waitForTimeout(400);
        await shoot(page, `phone-focus-03-list-${size.width}`);
        const top = await rail.locator(".k-list-scroll").evaluate((e) => e.scrollTop);
        expect(top, "the list is at its top").toBe(0);
        const box = (await rail.locator(".k-list-scroll").boundingBox())!, r = (await calling.boundingBox())!;
        expect(r.y >= box.y - 1 && r.y + r.height <= box.y + box.height + 1, "the row that calls is in view").toBe(true);
        await page.keyboard.press("Escape");
      } finally {
        await drop(request, asker, ...resting);
      }
    });

    // A running step beside the words it was given is one line, the command cut at its end with a mark;
    // a tap on it shows the whole command. (It was three columns, the command wrapped into the last.)
    test("a running step is one line, its command whole on a tap", async ({ page, request }) => {
      await scripted(request);
      const id = await create(request, "Run the slow suite", folder(`phone-focus-step-${size.width}`));
      const command = "echo starting the integration suite for the importer and the exporter; sleep 60; echo the integration suite is done";
      try {
        await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
        await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command } }]) } });
        await page.goto(`/s/${id}`);
        const pane = page.locator(".k-station[data-helm]");
        const call = pane.locator('[data-testid="tool-call"][data-state="running"]');
        await expect(call).toBeVisible({ timeout: 30_000 });
        await expect(call.getByTestId("call-clock")).toBeVisible();
        const px = await rootPx(page);
        await shoot(page, `phone-focus-04-step-${size.width}`);
        const step = pane.locator(".k-step").filter({ has: page.locator('[data-testid="tool-call"][data-state="running"]') });
        const said = (await step.locator(".k-said").boundingBox())!, line = (await call.locator(".k-line").boundingBox())!;
        expect(line.height, "the step's line is a finger's row, not two").toBeLessThan(3 * px);
        expect(Math.abs(said.y - line.y), "the words and the line stand on one row").toBeLessThan(0.8 * px);
        const what = call.locator(".k-line-what");
        const words = await call.locator(".k-line-text").evaluate((e) => ({ cut: e.scrollWidth > e.clientWidth + 1, mark: getComputedStyle(e).textOverflow, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) }));
        expect(words, "the command is one row, cut with a mark").toEqual({ cut: true, mark: "ellipsis", lines: 1 });
        // The verb and the command it ran stand together: no column of verbs between them.
        const verbEnd = await call.locator(".k-line-verb").evaluate((e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().right; });
        const w = (await what.boundingBox())!;
        expect(w.x - verbEnd, "the command follows its verb").toBeLessThan(0.75 * px);
        await call.locator(".k-line").tap();
        await expect(call.getByText(command, { exact: true }).first()).toBeVisible();
        // Opened, the call has the pane's width under the words it was given.
        const above = (await step.locator(".k-said").boundingBox())!, opened = (await call.boundingBox())!;
        expect(opened.y, "the opened call stands under the words").toBeGreaterThanOrEqual(above.y + above.height - 1);
        await call.getByTestId("terminal").scrollIntoViewIfNeeded();
        await shoot(page, `phone-focus-05-step-open-${size.width}`);
      } finally {
        await drop(request, id);
      }
    });

    // After a steer the command moved behind and its end started a turn of its own: that input is named for what
    // it is, the note that asked the model to reply first is nowhere, and each reply's marks stand together.
    test("a steered turn reads as what happened, and a reply's marks are one row", async ({ page, request }) => {
      test.setTimeout(150_000);
      await scripted(request);
      const id = await create(request, "Run the slow suite", folder(`phone-focus-steer-${size.width}`));
      try {
        await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
        await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "echo starting; sleep 14; echo done" } }]) } });
        await page.goto(`/s/${id}`);
        const pane = page.locator(".k-station[data-helm]");
        await expect(pane.locator('[data-testid="tool-call"][data-state="running"]')).toBeVisible({ timeout: 30_000 });
        await pane.getByTestId("composer").tap();
        await pane.getByTestId("composer").fill("Why is the suite so slow today?");
        await pane.getByTestId("composer").press("Enter");
        // The steer moves the command behind; its end, later, starts the second turn.
        await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}`)).json()).events as { kind: string }[]).filter((e) => e.kind === "turn_end").length, { timeout: 90_000 }).toBe(2);
        await expect(pane.getByTestId("turn-end")).toHaveCount(2);
        await page.waitForTimeout(500);
        await shoot(page, `phone-focus-06-steered-${size.width}`);
        const ended = pane.getByTestId("job-notice");
        await expect(ended, "the command's end is named").toContainText("Background command ended");
        await expect(ended).toContainText("exited with code 0");
        await expect(pane.getByTestId("harness-notice"), "no bare harness note").toHaveCount(0);
        await expect(pane.getByText("waiting for your reply"), "the reply-first note is not shown").toHaveCount(0);
        // Each footer's marks stand side by side, their glyphs on one line.
        for (const foot of await pane.locator(".k-turn-foot").all()) {
          const marks = await foot.evaluate((f) => [...f.querySelectorAll<HTMLElement>('[data-testid="message-menu"], .k-note-chip, [data-testid="turn-figures"]')].filter((m) => m.getClientRects().length && m.getBoundingClientRect().width > 0).map((m) => {
            const r = m.getBoundingClientRect();
            const g = m.querySelector("svg") ?? m;
            const range = document.createRange(); range.selectNodeContents(g); const t = g instanceof SVGElement ? g.getBoundingClientRect() : range.getBoundingClientRect();
            return { left: r.left, right: r.right, mid: (t.top + t.bottom) / 2 };
          }));
          for (let i = 1; i < marks.length; i++) {
            expect(marks[i]!.left - marks[i - 1]!.right, "no gap between the footer's marks").toBeLessThanOrEqual(1);
            expect(Math.abs(marks[i]!.mid - marks[0]!.mid), "the footer's marks on one line").toBeLessThanOrEqual(2);
          }
        }
      } finally {
        await drop(request, id);
      }
    });
  });
}
