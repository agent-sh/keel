import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: what just broke, told before the owner asks. A cause that touches
// work across sessions is one incident (src/automation/incident-book.ts): one
// row at the top of every page with what it touched and what Keel does, the
// details of each session and agent, one alert for the owner however many
// sessions it touched, and it clears by itself. The scripted stand-in plays
// the causes: refused connections for a while (`script:outage`), and a refused
// credential (`script:auth`).
const STAND_IN = "scripted:stand-in";
const NARROW = { width: 390, height: 844 };
const WIDE = { width: 1920, height: 1040 };

async function open(request: APIRequestContext, title: string) {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "needs KEEL_SCRIPTED_PROVIDER=1: the stand-in plays the outage and the refused credential");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title } })).json();
  return session.id as string;
}
const say = (request: APIRequestContext, id: string, text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
const incidents = async (request: APIRequestContext) => (await (await request.get("/api/incidents")).json()) as { open: any[]; cleared: any[] };
const outageAlerts = async (request: APIRequestContext, id: string) => ((await (await request.get("/api/alerts")).json()).alerts as any[]).filter((a) => a.kind === "outage" && a.data?.incident === id);
const both = async (page: Page, name: string) => {
  await shoot(page, `${name}-wide`);
  await page.setViewportSize(NARROW);
  await shoot(page, `${name}-narrow`);
  await page.setViewportSize(WIDE);
};

// Ends an outage a test may have left: the next one starts with a provider that answers.
test.afterEach(async ({ request }) => {
  const id = await open(request, "Incidents: provider back");
  await say(request, id, "script:outage-end");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 60_000 }).toBe(true);
});

test("a provider that cannot be reached is one row for every session it holds, and it clears when it answers", async ({ page, request }) => {
  const ids = [await open(request, "Held: first"), await open(request, "Held: second"), await open(request, "Held: third")];
  await page.setViewportSize(WIDE);
  await page.goto("/");
  // 25 s: confirmed also when an earlier outage left the wait's tries five seconds apart (src/providers/outage.ts, flapMs).
  await say(request, ids[0]!, "script:outage refused 25000");
  await say(request, ids[1]!, "Second, while it is down.");
  await say(request, ids[2]!, "Third, while it is down.");

  // One row, at the top of the page: what broke, since when, what it holds, what Keel does.
  const band = page.getByTestId("incident-band");
  await expect(band).toHaveAttribute("data-key", "provider:scripted", { timeout: 30_000 });
  await expect(band).toHaveAttribute("data-count", "1");
  await expect(page.getByTestId("incident-title")).toContainText(/^Scripted \(test\) cannot be reached since \d\d:\d\d/);
  await expect(page.getByTestId("incident-line")).toContainText("3 sessions: 3 wait", { timeout: 20_000 });
  await expect(page.getByTestId("incident-line")).toContainText("Keel holds the work");
  const [held] = (await incidents(request)).open.filter((i) => i.key === "provider:scripted");
  expect(held.held).toBe(true);
  expect(held.failed).toBe(0);

  // The details: each session it holds, a way to it, and that there is nothing to do.
  await page.getByTestId("incident-open").click();
  const popup = page.getByTestId("incident-popup");
  await expect(popup.getByTestId("incident-session")).toHaveCount(3);
  for (const id of ids) await expect(popup.locator(`[data-testid="incident-session"][data-session="${id}"]`)).toHaveAttribute("data-state", "waiting");
  await expect(popup.getByTestId("incident-you")).toHaveText(/^Nothing to do/);
  await both(page, "incidents-01-held");
  await page.keyboard.press("Escape");

  // A short wait held everything and failed nothing: no alert, for the incident or any session.
  expect(await outageAlerts(request, held.id)).toEqual([]);

  // It answers: the work goes on by itself, and the row says it cleared, then goes.
  await expect(band).toHaveAttribute("data-cleared", "", { timeout: 60_000 });
  await expect(page.getByTestId("incident-title")).toContainText(/cannot be reached: cleared at \d\d:\d\d/);
  const after = await incidents(request);
  expect(after.open.filter((i) => i.key === "provider:scripted")).toEqual([]);
  const done = after.cleared.find((i) => i.id === held.id);
  expect(done.cleared_how).toMatch(/^it answers again, after/);
  expect(done.touched.map((t: any) => t.state)).toEqual(["went_on", "went_on", "went_on"]);
  for (const id of ids) await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "turn_end").map((e: any) => e.data.reason), { timeout: 30_000 }).toEqual(["end_turn"]);
  await shoot(page, "incidents-02-cleared");
  await page.getByTestId("incident-dismiss").click();
  await expect(band).toHaveCount(0);
});

test("a credential refused in two sessions is one incident and one alert, and a turn that goes through clears it", async ({ page, request }) => {
  await page.setViewportSize(WIDE);
  await page.goto("/");
  const a = await open(request, "Credential: first");
  const b = await open(request, "Credential: second");
  await say(request, a, "script:auth");
  await say(request, b, "script:auth");

  const band = page.getByTestId("incident-band");
  await expect(band).toHaveAttribute("data-key", "account:scripted", { timeout: 20_000 });
  await expect(page.getByTestId("incident-title")).toContainText("Scripted (test) refuses its credential");
  await expect(page.getByTestId("incident-line")).toContainText("2 sessions: 2 turns failed");
  const [inc] = (await incidents(request)).open.filter((i) => i.key === "account:scripted");

  // One alert for the owner, for both sessions. The second session's own failure alert is the incident's to tell: filed silently.
  await expect.poll(async () => (await outageAlerts(request, inc.id)).length).toBe(1);
  const alerts = ((await (await request.get("/api/alerts")).json()).alerts as any[]);
  expect(alerts.find((x) => x.kind === "failed" && x.session_id === b)?.data?.in_incident).toBe(inc.id);

  // The Errors panel lists it, opened in place, with what to do.
  await page.getByTestId("incident-open").click();
  await expect(page.getByTestId("incident-popup").getByTestId("incident-you")).toContainText("Sign in again");
  await both(page, "incidents-03-credential");
  await page.getByTestId("incident-errors").click();
  const row = page.locator('[data-testid="errors-incident"][data-key="account:scripted"]').first();
  await expect(row).toBeVisible();
  await row.getByRole("button").click();
  await expect(row.getByTestId("incident-radius")).toHaveText("2 sessions: 2 turns failed");
  await both(page, "incidents-04-errors");
  await page.keyboard.press("Escape");

  // A turn on the provider goes through: it clears by itself, and its alert is read.
  const c = await open(request, "Credential: back");
  await say(request, c, "Hello again.");
  await expect(band).toHaveAttribute("data-cleared", "", { timeout: 30_000 });
  expect((await incidents(request)).cleared.find((i) => i.id === inc.id)?.cleared_how).toBe("a turn on it went through");
  await expect.poll(async () => (await outageAlerts(request, inc.id)).map((x) => x.read)).toEqual([true]);
});
