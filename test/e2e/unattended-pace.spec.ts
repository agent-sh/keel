import { expect, test } from "./isolate.ts";
import { shoot, SCRIPTED } from "./shots.ts";

// Feature: the pace of a session's unattended turns. An input nobody sent (here a wait that came true) that comes
// within the pace of the last unattended turn's end waits, shown as one quiet line in the dock, and goes as one
// input with whatever else waited when the pace is up. The pace is in the session's menu, with the session's own
// day of turns by what started them. The rule is src/automation/pace-rules.test.ts; what one input holds and what
// goes at once is src/automation/pace.test.ts.
test("an unattended input waits for the session's pace, the dock says until when, and the menu sets the pace", async ({ page, request }) => {
  test.skip(!SCRIPTED, "needs the scripted stand-in: the session's turns are scripted");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in-strict", title: "Paced session" } })).json();
  const id = session.id as string;
  const turns = async () => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "turn_end").length;
  const idle = async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
  try {
    await request.patch(`/api/sessions/${id}`, { data: { settings: { pace_min: 5 } } });
    // A timer that is up goes at once: an unattended turn, whose end starts the pace.
    expect((await request.post("/api/waits", { data: { session_id: id, spec: { kind: "timer", seconds: 1 } } })).status()).toBe(201);
    await expect.poll(async () => (await turns()) === 1 && (await idle()), { timeout: 60_000 }).toBe(true);
    // A condition that came true within the pace waits for it.
    expect((await request.post("/api/waits", { data: { session_id: id, spec: { kind: "file", path: "." }, timeout_seconds: 3600 } })).status()).toBe(201);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/pace?day=0`)).json()).waiting, { timeout: 30_000 }).toBe(1);
    expect(await turns()).toBe(1);

    await page.goto(`/s/${id}`);
    const line = page.getByTestId("dock-pace");
    await expect(line).toContainText(/^One input waits until \d\d:\d\d$/);
    // In the faint ink: it comes after nearly every report of a busy tree and asks nothing of the owner.
    expect(await line.evaluate((el) => { const p = document.createElement("i"); p.style.color = "var(--faint)"; document.body.append(p); const faint = getComputedStyle(p).color; p.remove(); return getComputedStyle(el).color === faint; })).toBe(true);
    await shoot(page, "unattended-pace-01-waits");

    await line.click();
    const dialog = page.getByTestId("pace-dialog");
    await expect(dialog).toContainText("what waits goes right after your turn");
    await expect(dialog.getByTestId("pace-now")).toContainText("One input waits for the pace");
    await expect(dialog.getByTestId("pace-day")).toContainText("Nobody's");
    await shoot(page, "unattended-pace-02-dialog");

    // Off: what waited goes now, and the line goes with it.
    await dialog.getByTestId("seg-0").click();
    await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).session.settings.pace_min).toBe(0);
    await expect.poll(turns, { timeout: 60_000 }).toBe(2);
    await expect(dialog.getByTestId("pace-now")).toContainText("Off");
    await dialog.getByTestId("pace-close").click();
    await expect(line).toHaveCount(0);
    await page.getByTestId("session-menu").click();
    await expect(page.getByTestId("menu-pace")).toHaveText("Unattended pace: off");
    await page.keyboard.press("Escape");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});
