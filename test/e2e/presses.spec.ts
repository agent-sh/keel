import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: Settings > Telemetry records what the owner presses, on this
// machine. Three controls pressed 3, 2 and 1 times come back most used first
// under the view they were pressed in, a control drawn and never pressed is in
// the "never pressed" list, a word typed is nowhere in what is kept, the page
// on a phone is recorded as a phone, turning recording off stops it, and turning it on again resumes a tab that was already open.
const STAND_IN = "scripted:stand-in";

test("telemetry: what you press, most used first, never a word typed", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await request.delete("/api/presses");
  const tag = Math.random().toString(36).slice(2, 7);
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Press ${tag}` } })).json();
  const typed = `private-words-${tag}`;

  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("session-menu")).toBeVisible();
  const press = async (id: string, times: number) => {
    for (let i = 0; i < times; i++) {
      await page.getByTestId(id).click();
      // (a key is no press) Escape until the menu is gone: one sent before it opened closes nothing.
      await expect.poll(async () => { await page.keyboard.press("Escape"); return page.locator("[data-base-ui-inert]").count(); }, { timeout: 15_000 }).toBe(0);
    }
  };
  await press("session-menu", 3);
  await press("model-picker", 2);
  await press("panel-menu", 1);
  // A word typed into the message box is no press and is kept nowhere.
  await page.getByTestId("composer").fill(typed);
  await page.getByTestId("composer").fill("");

  // The page draws controls a moment after it changes; one of them is never pressed.
  await expect.poll(async () => {
    const r = await (await request.get("/api/presses")).json();
    return r.presses === 6 && r.never.length > 0;
  }, { timeout: 30_000 }).toBe(true);

  await page.goto("/settings/telemetry");
  const panel = page.getByTestId("telemetry-panel");
  await expect(panel.getByTestId("press-disclosure")).toContainText("Never a word you type");
  await expect(panel.getByTestId("press-disclosure")).toContainText("not sent");
  // The intro is two lines; how a press is counted is behind a disclosure of its own.
  const how = panel.getByTestId("press-disclosure").locator("details", { hasText: "How it is counted" });
  await expect(how.locator("summary")).toBeVisible();
  await expect(how.getByText("plain keys, such as Enter to send, are not counted")).toBeHidden();
  await how.locator("summary").click();
  await expect(how.getByText("plain keys, such as Enter to send, are not counted")).toBeVisible();
  await expect(panel.getByTestId("press-disclosure").locator(".k-set-hint > p")).toHaveCount(2);
  const view = panel.locator('[data-testid="press-view"][data-view="session"]');
  await expect(view).toBeVisible();
  const rows = view.getByTestId("press-row");
  await expect.poll(async () => (await rows.evaluateAll((els) => els.map((e) => `${e.getAttribute("data-control")}:${e.querySelector("[data-testid=press-count]")?.textContent}`)))).toEqual(["session-menu:3", "model-picker:2", "panel-menu:1"]);
  const never = panel.getByTestId("press-never");
  await expect(never.getByTestId("press-never-row").first()).toBeVisible();
  // Pressed controls are not in the list of the never pressed.
  await expect(never.locator('[data-control="session-menu"]')).toHaveCount(0);
  await shoot(page, "presses-01-what-you-press");

  // Nothing typed is kept, and no control is named by a session's id.
  const all = JSON.stringify(await (await request.get("/api/presses?days=90")).json());
  expect(all).not.toContain(typed);
  expect(all).not.toContain(session.id);

  // The page on a phone is recorded as a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("show-sidebar").click();
  await expect.poll(async () => {
    const r = await (await request.get("/api/presses")).json();
    return r.views.flatMap((v: any) => v.controls).find((c: any) => c.control === "show-sidebar")?.surfaces ?? null;
  }, { timeout: 30_000 }).toBe("phone");
  await page.goto("/settings/telemetry");
  await expect(panel.getByTestId("press-view").first()).toBeVisible();
  await shoot(page, "presses-02-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });

  // With recording off, a press is not kept; the setting goes back after.
  await page.goto("/settings/telemetry");
  await panel.getByRole("radio", { name: "Do not record" }).click();
  await expect.poll(async () => (await (await request.get("/api/presses")).json()).record).toBe(false);
  const before = (await (await request.get("/api/presses")).json()).presses;
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("session-menu").click();
  await page.keyboard.press("Escape");
  await page.goto("/settings/telemetry");
  await expect(panel.getByTestId("press-empty").or(panel.getByTestId("press-view").first())).toBeVisible();
  expect((await (await request.get("/api/presses")).json()).presses).toBe(before);
  await shoot(page, "presses-03-off");
  // A second tab learns it is off from its own press, and takes recording up again by itself when it is turned on.
  const other = await page.context().newPage();
  const posts = (pg: typeof other, record: boolean, empty: boolean) => pg.waitForResponse(async (r) => {
    if (!r.url().endsWith("/api/presses") || r.request().method() !== "POST") return false;
    const body = JSON.parse(r.request().postData() ?? "{}");
    return (body.presses.length === 0 && body.seen.length === 0) === empty && (await r.json()).record === record;
  }, { timeout: 45_000 });
  const off = posts(other, false, false);
  await other.goto(`/s/${session.id}`);
  await other.getByTestId("session-menu").click();
  await off;
  await panel.getByRole("radio", { name: "Record", exact: true }).click();
  await posts(other, true, true); // its own ask, with no press
  const again = (await (await request.get("/api/presses")).json()).presses;
  await other.keyboard.press("Escape");
  await other.getByTestId("session-menu").click();
  await expect.poll(async () => (await (await request.get("/api/presses")).json()).presses, { timeout: 30_000 }).toBeGreaterThan(again);
  await other.close();
  await expect.poll(async () => (await (await request.get("/api/presses")).json()).record).toBe(true);
  await request.delete("/api/sessions/" + session.id);
});
