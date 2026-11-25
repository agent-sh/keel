import { expect, test } from "./isolate.ts";
import { calls, colors } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a finished session on a phone spends its first screen on the conversation. The top bar is
// one row (the list's button, the title with its state, the tools), each step is one line (the few
// words it was given and its call), and a message's actions are one menu beside it, not a row of
// icons under it. Everything stays a tap away: the tools in the bar, the actions in the menu.
const MODEL = "scripted:stand-in";
const SIZES = [{ width: 390, height: 844 }, { width: 412, height: 915 }];

for (const size of SIZES) {
  for (const scale of [1, 1.3]) {
    test.describe(`on a phone, ${size.width}x${size.height} at ${scale * 100}% text`, () => {
      test.use({ viewport: size, hasTouch: true, isMobile: true });
      test.setTimeout(60_000);
      test("a finished session's bar, steps and message actions take little of the page", async ({ page, request }) => {
        const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
        test.skip(!models.includes(MODEL), "requires the scripted provider");
        await page.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
        const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Fix cart total rounding" } })).json();
        try {
          await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
          const steps = ["README.md", "unit.sh", "cart.ts"].map((f) => ({ name: "Bash", input: { command: `echo ${f}` } }));
          await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls(steps) } });
          await expect.poll(async () => { const d = await (await request.get(`/api/sessions/${session.id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 30_000 }).toBe(true);
          await page.goto(`/s/${session.id}`);
          const pane = page.locator(".k-station[data-helm]");
          await expect(pane.getByTestId("turn-end")).toBeVisible();
          await shoot(page, `phone-head-${size.width}-${scale}`);
          const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

          // The bar: one row, with the list's button, the title, the state and the tools in it.
          const bar = await pane.locator(".k-top").boundingBox();
          const title = await pane.getByTestId("station-title").boundingBox();
          const word = await pane.getByTestId("station-word").boundingBox();
          expect(bar!.height, "the bar is one row, not a head over a row of tools").toBeLessThan(scale === 1 ? 4.5 * rem : size.height / 6);
          // (At a larger text size the row folds what has no room into the session's menu. The permission mode lives in
          // the message box's row, UX-S73.)
          for (const id of scale === 1 ? ["show-sidebar", "panel-menu", "session-menu"] : ["session-menu"]) {
            const b = (await pane.getByTestId(id).first().boundingBox())!;
            expect(b, id).toBeTruthy();
            expect(b.y >= bar!.y - 1 && b.y + b.height <= bar!.y + bar!.height + 1, `${id} is in the bar`).toBe(true);
            expect(b.x + b.width, `${id} is inside the page`).toBeLessThanOrEqual(size.width);
          }
          expect(word!.y + word!.height, "the state is in the bar with the title").toBeLessThanOrEqual(bar!.y + bar!.height);
          expect(word!.x, "the state starts under or beside the title, not before it").toBeGreaterThanOrEqual(title!.x - 1);

          // The first message starts under the bar, and its actions are not a row of its own.
          const message = pane.getByTestId("user-message").first();
          const first = (await message.boundingBox())!;
          expect(first.y - (bar!.y + bar!.height), "the conversation starts under the bar").toBeLessThan(1.5 * rem);
          const words = (await message.locator(".k-owner-words").boundingBox())!;
          expect(first.height, "no row of icons under the message").toBeLessThan(words.height + 0.5 * rem);
          await expect(message.getByTestId("copy-message")).toHaveCount(0);

          // Each step is one line: the words it was given and its call, side by side.
          const rows = await pane.locator(".k-step").evaluateAll((els) => els.map((e) => ({ h: e.getBoundingClientRect().height, said: e.querySelector(".k-said")?.getBoundingClientRect().top ?? null, did: e.querySelector(".k-did")?.getBoundingClientRect().top ?? null })));
          expect(rows.length).toBe(3);
          // (At a larger text size a long call may take a second row of its own: that is the way it is whole.)
          for (const r of scale === 1 ? rows : []) {
            expect(r.h, "a step is one line").toBeLessThan(2.9 * rem);
            expect(Math.abs(r.did! - r.said!), "the words and the call are on one line").toBeLessThan(0.8 * rem);
          }

          // Everything of the message is in its menu, by name, as a finger's target.
          await message.getByTestId("message-menu").tap();
          const popup = page.getByTestId("message-menu-popup");
          for (const id of ["copy-message", "edit-message", "rowaction-fork"]) await expect(popup.getByTestId(id)).toBeVisible();
          for (const row of await popup.getByRole("menuitem").all()) expect((await row.boundingBox())!.height, "a row is a finger's target").toBeGreaterThanOrEqual(2.75 * rem - 2);
          await shoot(page, `phone-head-menu-${size.width}-${scale}`);
          await popup.getByTestId("edit-message").tap();
          await expect(pane.getByTestId("user-message")).toHaveCount(0);
          await page.keyboard.press("Escape");

          // The reply's footer: one row with its menu and the cost.
          const foot = pane.getByTestId("turn-end").last();
          await expect(foot).toBeVisible();
          await pane.getByTestId("message-menu").last().tap();
          for (const id of ["copy-reply", "rowaction-fork-reply"]) await expect(page.getByTestId("message-menu-popup").getByTestId(id)).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.getByTestId("message-menu-popup")).toHaveCount(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        } finally {
          await request.delete(`/api/sessions/${session.id}`);
        }
      });
    });
  }
}

// Feature (UX-S141): while a question or an approval waits, a phone's bar still shows the state's dot and its age,
// and the menu: the title is what gives way, cut with an ellipsis, however long it is and at any text size.
const LONG = "Decide how the checkout service should shard its order tables across the three regions before Friday";
for (const [what, ask] of [["a question", colors], ["an approval", { name: "Bash", input: { command: "git push origin release" } }]] as const) {
  for (const scale of [1, 1.5]) {
    test.describe(`on a phone, ${what} at ${scale * 100}% text`, () => {
      test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      test.setTimeout(60_000);
      test("the bar keeps the state's dot and age, and the long title gives way", async ({ page, request }) => {
        const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
        test.skip(!models.includes(MODEL), "requires the scripted provider");
        await page.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
        const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: LONG } })).json();
        try {
          await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: ask === colors ? "full-auto" : "default", sandbox: "off" } });
          await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls([ask]) } });
          await page.goto(`/s/${session.id}`);
          const pane = page.locator(".k-station[data-helm]");
          await expect(pane).toHaveAttribute("data-watch", "need", { timeout: 30_000 });
          await expect(pane.getByTestId(ask === colors ? "question" : "approval")).toBeVisible();
          const bar = (await pane.locator(".k-top").boundingBox())!;
          const [title, word, clock, menu] = await Promise.all(["station-title", "station-word", "station-clock", "session-menu"].map(async (id) => (await pane.getByTestId(id).first().boundingBox())!));
          for (const [id, b] of [["the state's dot", word], ["its age", clock], ["the menu", menu]] as const) {
            expect(b, id).toBeTruthy();
            expect(b!.width, `${id} has a width`).toBeGreaterThan(4);
            expect(b!.x + b!.width, `${id} is inside the page`).toBeLessThanOrEqual(390);
            expect(b!.y + b!.height, `${id} is in the bar`).toBeLessThanOrEqual(bar.y + bar.height + 1);
          }
          expect(title!.x + title!.width, "the title ends where the dot begins").toBeLessThanOrEqual(word!.x + 1);
          expect(await pane.getByTestId("station-title").evaluate((e) => e.scrollWidth > e.clientWidth), "the title is the one that is cut").toBe(true);
          await shoot(page, `phone-head-card-${scale}-${ask === colors ? "question" : "approval"}`);
        } finally {
          await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
          await request.delete(`/api/sessions/${session.id}`).catch(() => {});
        }
      });
    });
  }
}

// Feature (UX-M65): a working session's bar is its title, its dot and the menu: the step's clock stays in the running line of
// the conversation (at a large text size the bar had no room for it, and the title was cut to a few letters).
for (const scale of [1, 1.5]) {
  test.describe(`on a phone, a session at work at ${scale * 100}% text`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test.setTimeout(60_000);
    test("the title takes the room of the clock at a large text size", async ({ page, request }) => {
      const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
      test.skip(!models.includes(MODEL), "requires the scripted provider");
      await page.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
      const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: LONG } })).json();
      try {
        await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
        await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "sleep 60", description: "Building the cache" } }]) } });
        await page.goto(`/s/${session.id}`);
        const pane = page.locator(".k-station[data-helm]");
        await expect(pane).toHaveAttribute("data-watch", "work", { timeout: 30_000 });
        const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        const title = (await pane.getByTestId("station-title").boundingBox())!;
        await expect(pane.getByTestId("station-clock")).toHaveCount(0);
        expect(title.width / rem, "the title has the room the clock left").toBeGreaterThanOrEqual(7);
        await expect(pane.getByTestId("working"), "the step's clock is the running line's").toContainText(/\d+s/, { timeout: 15_000 });
        await shoot(page, `phone-head-work-${scale}`);
      } finally {
        await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
        await request.delete(`/api/sessions/${session.id}`).catch(() => {});
      }
    });
  });
}
