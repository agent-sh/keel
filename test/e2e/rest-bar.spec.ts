import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the top bar at rest, and rows that read calm. Every pane's head ends on one line at every
// desk width, in one title size, whichever pane holds the keys. The bar rests with the permission
// mode, a worktree when the session has one, Panels and the session's one menu; the rest is in that
// menu. Whether the head is one line or two is the width's choice, never the turn's: a reason that
// comes and goes moves no line. The pane's own tools are seen at rest, quietly, and take their own
// room. A row red for its agents says how many failed; a quiet row's time shows only where it says
// something the row above did not, and a row with news has its dot in the time's place.

const scripted = async (request: APIRequestContext) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string }[];
  return models.find((m) => m.id === "scripted:stand-in")?.id;
};
const pane = (page: Page, id: string) => page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
const row = (page: Page, id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`);
const gate = () => `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/rest-bar-${Date.now().toString(36)}`;

test("every pane's head ends on one line, in one title size, at every desk width", async ({ page, request }) => {
  const model = await scripted(request);
  test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  const make = async (title: string) => { const { session } = await (await request.post("/api/sessions", { data: { model, title } })).json(); made.push(session.id); return session.id as string; };
  try {
    const a = await make("Rest bar: the pane on the left");
    const b = await make("Rest bar: the pane worked in");
    for (const width of [1050, 1366, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/s/${a}`);
      await page.getByTestId("panes-2").click();
      const second = page.getByTestId("bridge").locator(':scope > [data-slot="1"]');
      await page.locator(`[data-testid="session-row"][data-session="${b}"]`).dragTo(second);
      await expect(second).toHaveAttribute("data-station", b);
      await page.mouse.move(width / 2, 800);
      const tops = await page.locator(".k-top").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().bottom)));
      expect(tops.length).toBe(2);
      expect(Math.abs(tops[0]! - tops[1]!), `at ${width} the panes' heads end at ${tops.join(" and ")}`).toBeLessThanOrEqual(1);
      const sizes = await page.getByTestId("station-title").evaluateAll((els) => els.map((e) => getComputedStyle(e).fontSize));
      expect(new Set(sizes).size, `at ${width} the titles are ${sizes.join(" and ")}`).toBe(1);
      // The head itself is the brand row's height in both: what is under it (tools, preview) is one row's.
      const brand = (await page.locator(".k-rail-brand").boundingBox())!;
      for (const id of [a, b]) {
        const title = (await pane(page, id).getByTestId("station-title").boundingBox())!;
        expect(title.y + title.height, `at ${width} a title sits below the brand row`).toBeLessThanOrEqual(brand.y + brand.height);
      }
      if (width !== 1920) await shoot(page, `rest-bar-01-two-${width}`);
      await page.getByTestId("panes-1").click();
    }
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});

test("the bar rests with three or four controls, the rest in the session's one menu", async ({ page, request }) => {
  const model = await scripted(request);
  test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Rest bar: a session with a cost" } })).json();
  try {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:say Done." } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.usage.output, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${session.id}`);
    const header = pane(page, session.id).getByTestId("session-header");
    await expect(header.getByTestId("permission-menu")).toBeVisible();
    await page.mouse.move(1000, 800);
    const shown = await header.evaluate((el) => [...el.querySelectorAll("button")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && !b.closest("[hidden]") && !b.closest("[data-stow]"); }).map((b) => b.getAttribute("aria-label") ?? b.textContent));
    expect(shown.length, `the bar shows ${shown.join(", ")}`).toBeLessThanOrEqual(4);
    // The cost is in the menu, over the session's actions; there is no second menu.
    await expect(header.getByTestId("session-usage")).toHaveCount(0);
    await expect(header.getByTestId("header-more-button")).toHaveCount(0);
    await header.getByTestId("session-menu").click();
    const menu = page.getByTestId("header-more");
    await expect(menu.getByTestId("session-usage")).toBeVisible();
    await expect(menu.getByTestId("menu-rename")).toBeVisible();
    await shoot(page, "rest-bar-02-menu");
    // Up and Down walk its actions.
    await menu.getByTestId("menu-rename").focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByTestId("menu-link")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(header.getByTestId("session-menu")).toBeFocused();
    // Tab past the last action leaves the menu and gives the keys back to its button.
    await header.getByTestId("session-menu").click();
    await expect(menu).toBeVisible();
    await menu.getByTestId("menu-delete").focus();
    await page.keyboard.press("Tab");
    await expect(menu).toBeHidden();
    await expect(header.getByTestId("session-menu")).toBeFocused();
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});

test("a turn that starts or ends moves no line of the head, and its tools rest beside the reason", async ({ page, request }) => {
  const model = await scripted(request);
  test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const done = gate();
  const made: string[] = [];
  const make = async (title: string) => { const { session } = await (await request.post("/api/sessions", { data: { model, title } })).json(); made.push(session.id); return session.id as string; };
  try {
    // One at rest, one with a command in the background (its reason is the head's second word).
    const idle = await make("x");
    const busy = await make("x");
    await request.put(`/api/sessions/${busy}/permissions`, { data: { mode: "full-auto" } });
    await request.post(`/api/sessions/${busy}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `until [ -f ${done} ]; do sleep 1; done`, run_in_background: true } }])}` } });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(`/s/${busy}`);
    await expect(pane(page, busy).getByTestId("station-why")).toBeVisible({ timeout: 15_000 });
    // Titles from short to long: at each, the title stands where it stands in the session at rest.
    const at = async (id: string) => {
      await page.goto(`/s/${id}`);
      await page.mouse.move(700, 800);
      const t = pane(page, id).getByTestId("station-title");
      await expect(t).toBeVisible();
      return Math.round((await t.boundingBox())!.y);
    };
    for (const n of [30, 45, 55, 65, 75, 90]) {
      const title = `Rest bar ${"steady ".repeat(20)}`.slice(0, n).trim();
      for (const id of [idle, busy]) await request.patch(`/api/sessions/${id}`, { data: { title } });
      const [still, working] = [await at(idle), await at(busy)];
      expect(working, `a title of ${n} characters moves ${working - still}px when a reason shows`).toBe(still);
    }
    // The pane's tools are seen at rest, and under the pointer they cover nothing of the reason (1050: the tightest bar).
    await page.setViewportSize({ width: 1050, height: 900 });
    await page.goto(`/s/${busy}`);
    const head = pane(page, busy).getByTestId("station-head");
    const tools = head.locator(".k-station-tools");
    await page.mouse.move(700, 800);
    expect(Number(await tools.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
    await expect(head.getByTestId("station-pin")).toBeVisible();
    const h = (await head.boundingBox())!;
    await page.mouse.move(h.x + h.width - 30, h.y + h.height / 2);
    const why = (await head.getByTestId("station-why").boundingBox())!, box = (await tools.boundingBox())!;
    const rows = Math.abs(why.y + why.height / 2 - (box.y + box.height / 2)) < why.height;
    if (rows) expect(why.x + why.width, "the pane's tools lie over the reason").toBeLessThanOrEqual(box.x + 1);
    await shoot(page, "rest-bar-03-tools-1050");
  } finally {
    await import("node:fs").then((fs) => { fs.mkdirSync(done.replace(/\/[^/]+$/, ""), { recursive: true }); fs.writeFileSync(done, ""); });
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});

test("a row red for its agents says how many failed, and a calm list says a time once", async ({ page, request }) => {
  const model = await scripted(request);
  test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  const make = async (title: string, text: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model, title } })).json();
    made.push(session.id);
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    return session.id as string;
  };
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto("/");
    const coord = await make("Rest bar: a coordinator", `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: "Fails at once\nscript:billing", isolation: "none" } }])}`);
    await expect(row(page, coord)).toHaveAttribute("data-watch", "fail", { timeout: 30_000 });
    await expect(row(page, coord).getByTestId("row-on")).toHaveText("1 failed");

    // Two quiet rows read side by side, both within the hour: the lower one keeps its time in its tooltip.
    const one = await make("Rest bar: calm one", "script:say Done.");
    const two = await make("Rest bar: calm two", "script:say Done.");
    for (const id of [one, two]) await expect(row(page, id)).toHaveAttribute("data-watch", "done", { timeout: 30_000 });
    for (const id of [one, two]) await request.post(`/api/sessions/${id}/marks`, { data: { unread: false } });
    await page.reload();
    await expect(row(page, two)).toBeVisible();
    // In each group, along its quiet rows that were read, a time shows only where its bucket changes.
    const said = await page.evaluate(() => {
      const bucket = (t: string) => t === "now" ? 0 : t.endsWith("m") ? 1 : t.endsWith("h") ? 2 : 3;
      const out: { shown: number; hidden: number; twice: string[] } = { shown: 0, hidden: 0, twice: [] };
      for (const group of new Set([...document.querySelectorAll('[data-testid="session-row"]')].map((r) => r.parentElement!.parentElement!))) {
        let above = -1;
        for (const r of group.querySelectorAll<HTMLElement>(':scope > div > [data-testid="session-row"]')) {
          if (!["done", "idle", "stop"].includes(r.dataset.watch ?? "") || r.dataset.unread) continue;
          const t = r.querySelector<HTMLElement>('[data-testid="row-time"]');
          if (!t) continue;
          const b = bucket(t.textContent ?? ""), shown = getComputedStyle(t).display !== "none";
          if (shown) out.shown++; else out.hidden++;
          if (shown && b === above) out.twice.push(t.textContent ?? "");
          above = b;
        }
      }
      return out;
    });
    expect(said.twice, "a quiet row says the time the quiet row above it said").toEqual([]);
    expect(said.hidden).toBeGreaterThan(0);
    // A row with news has its dot in the time's place: one thing in the column.
    await request.post(`/api/sessions/${two}/marks`, { data: { unread: true } });
    await expect(row(page, two)).toHaveAttribute("data-unread", "true");
    await expect(row(page, two).getByTestId("unread-dot")).toBeVisible();
    await expect(row(page, two).getByTestId("row-time")).toBeHidden();
    await expect(row(page, two).getByTestId("row-time")).toHaveAttribute("title", /\d/);
    await shoot(page, "rest-bar-04-rows");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});
