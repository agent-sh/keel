import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { scriptBash, shoot, WORKBENCH } from "./shots.ts";

// Feature: Focus, the way a session is shown while the owner works in it (ui/src/lib/focus.ts). Its
// title in quiet ink, the conversation and the message box, and the line over the box that says what
// runs: no list, no session tools, no state chip. A card that asks him shows where it belongs, and the
// other sessions that wait are one line at the bottom edge that goes to the next. The list comes back
// laid over the page (Ctrl B, or the window's left edge) and goes on Escape or when a session is
// picked. A finished run of calls is one quiet line between replies that opens on a press. Ctrl . leaves for the workbench and comes back, and the choice is kept across a reload.
// And the bar everywhere: the title at the body's size in regular weight, one text line high.

const scripted = async (request: APIRequestContext) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  return models.find((m) => m.id === "scripted:stand-in")?.id;
};
const rootPx = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
// The line's count, in its words ("Two other sessions need you"): sessions of the daemon that waited before this spec count too.
const WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const counted = async (line: ReturnType<Page["getByTestId"]>) => { const t = (await line.textContent()) ?? ""; const w = t.split(" ")[0]!; return WORDS.includes(w) ? WORDS.indexOf(w) + 1 : Number(w); };
const titleLook = (page: Page) => page.getByTestId("station-title").first().evaluate((e) => ({ size: parseFloat(getComputedStyle(e).fontSize), weight: getComputedStyle(e).fontWeight }));

test.describe("Focus is the default", () => {
  // No saved choice: what the owner sees the first time.
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1920, height: 1040 } });

  test("a session in Focus: the title, the conversation and the box; the list laid over; one line for the others", async ({ page, request }) => {
    const model = await scripted(request);
    test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
    const made: string[] = [];
    // Three sessions that each wait on an approval.
    const asking = async (title: string) => {
      const { session } = await (await request.post("/api/sessions", { data: { model, title } })).json();
      made.push(session.id);
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: scriptBash(`touch ${title.toLowerCase().replace(/\W+/g, "-")}.txt`) } });
      return session.id as string;
    };
    try {
      const a = await asking("Focus: the session worked in");
      const b = await asking("Focus: another that waits");
      const c = await asking("Focus: a third that waits");
      await page.goto(`/s/${a}`);
      const shell = page.locator(".k-shell");
      await expect(shell).toHaveAttribute("data-mode", "focus");
      // The card that needs him is in the conversation.
      await expect(page.getByTestId("approval").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("station-title")).toHaveText("Focus: the session worked in");
      // Nothing else stands on the screen: no list, no state chip or word, no session tools, no pane map, no reach line.
      for (const id of ["sidebar", "station-word", "session-header", "panel-menu", "session-menu", "inbox-button", "errors-button", "reach-line", "waiting-elsewhere", "station-clock"]) {
        await expect(page.getByTestId(id), `${id} is not shown in Focus`).toBeHidden();
      }
      await expect(page.locator(".k-pane-map")).toHaveCount(0);
      // The conversation is at a reading width, centered.
      const box = (await page.getByTestId("composer-box").boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(48 * (await rootPx(page)));
      expect(Math.abs(box.x + box.width / 2 - 960)).toBeLessThan(40);
      // The title in quiet ink at the body's size, regular weight.
      const look = await titleLook(page);
      expect(look.size).toBeCloseTo(0.9375 * (await rootPx(page)), 0);
      expect(look.weight).toBe("400");
      // The other two sessions that wait: one line at the bottom edge.
      const others = page.getByTestId("focus-others");
      await expect(others).toHaveText(/^\w+ other sessions need you$/, { timeout: 30_000 });
      await expect.poll(() => counted(others), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      await shoot(page, "focus-mode-01-focus");

      // The list, laid over the page: Ctrl B opens it, Escape puts it away.
      await page.keyboard.press("Control+b");
      await expect(page.getByTestId("sidebar")).toBeVisible();
      await shoot(page, "focus-mode-02-list");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("sidebar")).toBeHidden();
      // The window's left edge opens it too, and picking a session closes it there.
      await page.getByTestId("focus-edge").click();
      await expect(page.getByTestId("sidebar")).toBeVisible();
      await page.locator(`[data-testid="session-row"][data-session="${b}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/s/${b}`));
      await expect(page.getByTestId("sidebar")).toBeHidden();
      await expect(shell).toHaveAttribute("data-mode", "focus");

      // The line goes to the next session that waits.
      await expect(others).toHaveText(/^\w+ other sessions need you$/);
      await others.click();
      await expect(page).not.toHaveURL(new RegExp(`/s/${b}`));

      // A finished run of calls is one quiet line between the replies; a press opens it.
      const { session: done } = await (await request.post("/api/sessions", { data: { model, title: "Focus: a finished run" } })).json();
      made.push(done.id);
      await request.post(`/api/sessions/${done.id}/messages`, { data: { text: scriptBash("echo focus-run") } });
      await page.goto(`/s/${done.id}`);
      const fold = page.getByTestId("work-fold");
      await expect(fold).toHaveText("Ran commands", { timeout: 30_000 });
      await expect(page.getByTestId("work")).toHaveCount(0);
      await shoot(page, "focus-mode-03-run-folded");
      await fold.click();
      await expect(page.getByTestId("work")).toBeVisible();
      await expect(fold).toHaveCount(0);

      // Ctrl . leaves for the workbench and comes back; the choice is kept.
      await page.keyboard.press("Control+.");
      await expect(shell).not.toHaveAttribute("data-mode", "focus");
      await expect(page.getByTestId("sidebar")).toBeVisible();
      await page.reload();
      await expect(page.getByTestId("sidebar")).toBeVisible();
      await expect(shell).not.toHaveAttribute("data-mode", "focus");
      await page.keyboard.press("Control+.");
      await expect(shell).toHaveAttribute("data-mode", "focus");
      await expect(page.getByTestId("sidebar")).toBeHidden();
      // And the quiet control at the top right does the same.
      await page.getByTestId("focus-leave").click();
      await expect(shell).not.toHaveAttribute("data-mode", "focus");
      await page.keyboard.press("Control+.");
      await expect(shell).toHaveAttribute("data-mode", "focus");
    } finally {
      for (const id of made) await request.delete(`/api/sessions/${id}`);
    }
  });

  test("in Focus the box is one line, its buttons a line's icons, the agents one quiet item, the owner's words the reply's size", async ({ page, request }) => {
    const model = await scripted(request);
    test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
    const { session } = await (await request.post("/api/sessions", { data: { model, title: "Focus: a coordinator" } })).json();
    const calls = (l: unknown[]) => `script:calls ${JSON.stringify(l)}`;
    const spawn = (title: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([{ name: "Bash", input: { command: "sleep 120" } }])}` } });
    try {
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:say A short reply." } });
      await page.goto(`/s/${session.id}`);
      await expect(page.getByTestId("assistant-text").last()).toContainText("A short reply.", { timeout: 30_000 });
      const px = await rootPx(page);
      // The owner's words are the reply's size.
      const size = (sel: string) => page.locator(sel).last().evaluate((e) => getComputedStyle(e).fontSize);
      expect(await size(".k-owner-words")).toBe(await size('[data-testid="assistant-text"] .prose-keel'));
      // At rest the box is one line: the field and Send share it; the mode and the model are not drawn in it.
      const box = page.getByTestId("composer-box"), field = page.getByTestId("composer"), send = page.getByTestId("send");
      await expect(box.getByTestId("permission-menu")).toHaveCount(0);
      await expect(box.getByTestId("model-picker")).toHaveCount(0);
      const b = (await box.boundingBox())!, f = (await field.boundingBox())!, s2 = (await send.boundingBox())!;
      const line = await field.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight));
      expect(b.height, `the box is ${b.height}px for a line of ${line}px`).toBeLessThanOrEqual(line + 1.5 * px);
      expect(s2.y).toBeGreaterThanOrEqual(f.y - 1);
      expect(s2.y + s2.height).toBeLessThanOrEqual(f.y + f.height + 1);
      // Send is a line's icon button, in quiet ink while there is nothing to send.
      expect(s2.width).toBeLessThanOrEqual(1.75 * px + 1);
      expect(s2.height).toBeLessThanOrEqual(1.75 * px + 1);
      // The mode and the model are behind the box's +.
      await page.getByTestId("box-more").click();
      await expect(page.getByTestId("box-more-popup").getByTestId("model-picker")).toBeVisible();
      await page.keyboard.press("Escape");
      // Agents at work: one quiet item, the word and how many, no names; it lies inside the dock.
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls([spawn("Focus agent one"), spawn("Focus agent two")]) } });
      const agents = page.getByTestId("dock-agents-line");
      await expect(page.getByTestId("dock-agents-count")).toHaveText("2", { timeout: 30_000 });
      await expect(agents).not.toContainText("Focus agent");
      await expect(page.getByTestId("dock-agent")).toHaveCount(0);
      const a = (await agents.boundingBox())!, dock = (await page.getByTestId("session-dock").boundingBox())!;
      expect(a.height).toBeLessThanOrEqual(2 * px);
      const first = (await page.getByTestId("session-dock").locator(".k-docket-line, .k-docket-row > *").first().boundingBox())!;
      expect(first.x).toBeGreaterThanOrEqual(dock.x);
      expect(first.x + first.width).toBeLessThanOrEqual(dock.x + dock.width + 0.5);
      // Stop, while the turn runs, is the same size as Send.
      const stop = page.getByTestId("stop");
      if (await stop.count()) { const t = (await stop.boundingBox())!; expect(t.width).toBeLessThanOrEqual(1.75 * px + 1); }
      await shoot(page, "focus-mode-05-box-and-agents");
    } finally {
      await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
      await request.delete(`/api/sessions/${session.id}`);
    }
  });
});

test.describe("the bar in the workbench", () => {
  test.use({ storageState: WORKBENCH, viewport: { width: 1920, height: 1040 } });

  test("the session's bar is one text line: the title at the body's size, regular weight", async ({ page, request }) => {
    const model = await scripted(request);
    test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
    const { session } = await (await request.post("/api/sessions", { data: { model, title: "Focus: a quiet bar" } })).json();
    try {
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:say Done." } });
      await page.goto(`/s/${session.id}`);
      await expect(page.getByTestId("sidebar")).toBeVisible();
      const title = page.getByTestId("station-title");
      await expect(title).toHaveText("Focus: a quiet bar");
      const px = await rootPx(page);
      const look = await titleLook(page);
      expect(look.size).toBeCloseTo(0.9375 * px, 0);
      expect(look.weight).toBe("400");
      // One text line and a small pad.
      const head = (await page.getByTestId("station-head").boundingBox())!, t = (await title.boundingBox())!;
      expect(head.height, `the bar is ${head.height}px for a title of ${t.height}px`).toBeLessThanOrEqual(t.height + 1.5 * px);
      // The state is its dot; the word is its tooltip.
      const word = page.getByTestId("station-word");
      await expect(word).toHaveAttribute("title", /\S/);
      expect((await word.boundingBox())!.width).toBeLessThan(1.25 * px);
      await shoot(page, "focus-mode-04-workbench-bar");
    } finally {
      await request.delete(`/api/sessions/${session.id}`);
    }
  });
});
