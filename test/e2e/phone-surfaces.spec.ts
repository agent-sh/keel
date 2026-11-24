import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "./isolate.ts";
import { inHead, leaveHead, shoot } from "./shots.ts";

// Feature: the surfaces that landed after the phone page was last checked fit a phone and are
// reached by a finger: the session menu's rows and what opens from them, the dollar cap, the
// list's rows, Settings > Telemetry and the work board. At 390x844 and 412x915: no sideways
// scroll, nothing past the page's edge, a target at least 2.75rem, no control that waits for a
// hover, and a popup opened from the menu stands over the menu.
const STAND_IN = "scripted:stand-in";
const SIZES = [{ width: 390, height: 844 }, { width: 412, height: 915 }];

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  return models.some((m) => m.id === STAND_IN);
}
async function start(request: APIRequestContext, title: string, opts: { mode?: string; cap?: number } = {}) {
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: opts.mode ?? "full-auto", sandbox: "off" } });
  if (opts.cap) await request.put(`/api/sessions/${session.id}/cap`, { data: { usd: opts.cap } });
  return session.id as string;
}
const idle = async (request: APIRequestContext, id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
const drop = async (request: APIRequestContext, ...ids: string[]) => {
  for (const id of ids) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
};
// Whether what is at the middle of the box's first line is the box (or part of it), not something over it.
const onTop = (box: Locator) => box.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const at = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height - 2, 24));
  return !!at && el.contains(at);
});
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
// What a finger presses in the box and is under 2.75rem each way.
const small = (box: Locator) => box.evaluate((el) => {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const out: string[] = [];
  for (const c of el.querySelectorAll<HTMLElement>("button, [role=button], a[href], input, select, textarea, summary")) {
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.height < 2.75 * rem - 1 || r.width < 2.75 * rem - 1) out.push(`${c.dataset.testid ?? c.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return out;
});
const inside = async (page: Page, box: Locator) => {
  const b = (await box.boundingBox())!, w = page.viewportSize()!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(w.width);
  expect(b.y + b.height).toBeLessThanOrEqual(w.height);
};

for (const size of SIZES) {
  test.describe(`on a phone, ${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true });

    test("the background list opens over the session menu", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const id = await start(request, "Phone background");
      try {
        const task = `Watch CI on main\nscript:calls ${JSON.stringify([{ name: "wait_for", input: { kind: "timer", seconds: 3600, note: "CI on main turns green" } }])}`;
        await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: task, isolation: "none" } }])}` } });
        await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as unknown[]).length, { timeout: 60_000 }).toBe(1);
        await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
        await page.goto(`/s/${id}`);
        const button = await inHead(page, "background-button");
        await button.tap();
        const popup = page.getByTestId("background-popup");
        await expect(popup.getByTestId("bg-agent")).toHaveCount(1);
        // The menu is open under it: the list is what a finger reaches, whole, inside the page.
        expect(await onTop(popup), "the list is over the menu").toBe(true);
        await inside(page, popup);
        expect(await small(popup), "every control of the list is a finger's target").toEqual([]);
        await shoot(page, `phone-surfaces-01-background-${size.width}`);
        await popup.getByTestId("bg-agent-open").first().tap();
        await expect(page.locator(".k-station[data-helm]")).not.toHaveAttribute("data-station", id);
      } finally {
        await drop(request, id);
      }
    });
    test("Settings > Telemetry names each control whole and in a line of its own", async ({ page }) => {
      // Two controls whose names are alike to the 14th character and long, as the menu's actions are.
      const names = ["header-action-export-to-another-machine", "header-action-voice-dictation-and-reading", "snooze-button"];
      const now = Date.now();
      const report = {
        record: true, since_ms: now - 30 * 864e5, days: 30, presses: 9, first_ms: now - 864e5, rows: 9, row_cap: 50_000, kept_days: 90,
        views: [{ view: "session", presses: 9, controls: names.map((control, i) => ({ control, presses: 5 - i * 2 + 1, last_ms: now - i * 6e4, surfaces: "phone" })) }],
        never: names.map((control) => ({ control, views: "session,project", seen_since_ms: now - 864e5 })),
      };
      await page.route("**/api/presses?*", (route) => route.fulfill({ json: report }));
      await page.goto("/settings/telemetry");
      const panel = page.getByTestId("telemetry-panel");
      await expect(panel.getByTestId("press-never-row")).toHaveCount(3);
      await page.getByTestId("settings-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      // Every name is there whole: not cut at the column's edge, so two controls are never one name.
      const cut = await panel.locator("li span.font-mono").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth || getComputedStyle(e).textOverflow === "ellipsis").map((e) => e.textContent));
      expect(cut, "names cut off").toEqual([]);
      for (const row of await panel.getByTestId("press-never-row").all()) {
        const name = (await row.locator("span.font-mono").first().boundingBox())!, seen = (await row.getByText(/^seen since/).boundingBox())!;
        expect(name.y + name.height, "the date is under the name").toBeLessThanOrEqual(seen.y + 1);
      }
      await noSideScroll(page);
      await shoot(page, `phone-surfaces-02-telemetry-${size.width}`);
    });
  });
}
