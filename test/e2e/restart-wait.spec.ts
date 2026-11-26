import { expect, test, type APIRequestContext } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a restart that does not say it must go now waits while the owner is at a page, joins the
// restarts asked meanwhile into one, and says so in the band across the top. The band restarts at once
// or calls the wait off. (The page's own Restart goes at once: restart-ask.spec.ts.)
const daemon = async (request: APIRequestContext) => (await (await request.get("/api/daemon")).json()) as { pid: number; restart_waiting: { asks: number; until_ms: number } | null };
const restart = (request: APIRequestContext, reason: string, now = false) =>
  request.post("/api/drain", { data: { restart: true, timeout_seconds: 5, reason, ...(now ? { now: true } : {}) } }).then((r) => r.json());

test("a restart asked while you are at a page waits for you, joined into one, and the band restarts it or calls it off", async ({ page, request }) => {
  await page.goto("/");
  // The page says the owner just did something in it: the owner is here.
  await request.post("/api/presence", { data: { session_id: null, focused: true, idle_ms: 0 } });
  const before = (await daemon(request)).pid;

  const first = await restart(request, "a landing");
  expect(first.waiting).toMatchObject({ asks: 1, reasons: ["a landing"] });
  const again = await restart(request, "another landing");
  expect(again.waiting).toMatchObject({ asks: 2, reasons: ["a landing", "another landing"], until_ms: first.waiting.until_ms });
  expect((await daemon(request)).pid).toBe(before);

  const band = page.getByTestId("restart-waiting");
  await expect(band).toContainText("A restart waits until you step away, by ");
  await expect(band).toContainText("2 restarts joined into one");
  await shoot(page, "restart-wait-01-band");

  // Not now: the wait is called off, and nothing restarts.
  await band.getByTestId("restart-waiting-off").click();
  await expect(band).toHaveCount(0);
  expect((await daemon(request)).restart_waiting).toBeNull();

  // Asked again, then Restart now from the band: the daemon restarts at once.
  await restart(request, "a third landing");
  await expect(band).toBeVisible();
  await band.getByTestId("restart-waiting-now").click();
  await expect.poll(async () => { const d = await daemon(request).catch(() => null); return d && d.pid !== before ? d.pid : 0; }, { timeout: 120_000, intervals: [1000] }).toBeGreaterThan(0);
  expect((await daemon(request)).restart_waiting).toBeNull();
});
