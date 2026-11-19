import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: while a turn works, Enter steers (the text joins the turn after the
// running tool), Tab queues for after it; Stop cuts the running tool at once
// and holds the queue; a queued prompt can be sent now.
test("steer, queue, stop and send now", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const r = await request.post("/api/sessions", { data: { model: HAIKU } });
  const { session } = await r.json();
  // Commands run without an approval card here; approvals have their own e2e.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);

  const composer = page.getByTestId("composer");
  await composer.fill("Run `sleep 6; echo first-done` with Bash, then reply in one short sentence.");
  await composer.press("Enter");
  await expect(page.getByTestId("tool-call").first()).toBeVisible({ timeout: 60_000 });

  // Steer while the tool runs, and queue a follow-up.
  await composer.fill("Also tell me what 2+2 is, in the same reply.");
  await composer.press("Enter");
  await composer.fill("Now reply with only the word queued-ok.");
  await composer.press("Tab");
  await expect(page.getByTestId("queue-item")).toHaveCount(2);
  await shoot(page, "turn-01-steer-and-queue");

  // The steer lands in the same turn; the queued prompt runs as the next turn.
  await expect(page.getByTestId("origin-steer")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("origin-queued")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/queued-ok/i);
  await expect(page.getByTestId("queue-item")).toHaveCount(0);
  await shoot(page, "turn-02-steered-then-queued");

  // Stop during a long tool: it returns at once, the queue is held.
  await composer.fill("Run `sleep 60` with Bash.");
  await composer.press("Enter");
  await expect(page.getByTestId("tool-call")).toHaveCount(2, { timeout: 60_000 });
  await page.waitForTimeout(2_000); // the call is stored and its command runs
  await composer.fill("Reply with only the word after-stop.");
  await composer.press("Tab");
  const t0 = Date.now();
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("turn-end").last()).toContainText("Stopped", { timeout: 10_000 });
  expect(Date.now() - t0).toBeLessThan(8_000);
  await expect(page.getByTestId("queue-held")).toBeVisible();
  await expect(page.getByTestId("resume")).toBeVisible();
  await shoot(page, "turn-03-stopped-queue-held");

  await page.getByTestId("queue-send-now").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(4, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/after-stop/i);
  await expect(page.getByTestId("queue")).toHaveCount(0);
  await expect(page.getByTestId("turn-end").last()).toContainText("$");
  await expect(page.getByTestId("session-usage")).toContainText("cached");
  await shoot(page, "turn-04-sent-now");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// Feature: the queue under races and edge cases, on the scripted stand-in (a
// `script:slow` turn keeps the stop pending 3 s): one Send now wins and a second
// one or a Remove meanwhile is told it is already sending; a screenshot alone
// queues by Tab and by the button and can lose its caption; Move up moves one
// place; a correction to a prompt sent meanwhile lands in the box, unsent; a
// prompt queued on one branch waits for a choice when the chat shows another.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("queue races, screenshots, order, late edits and branches", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in" } })).json();
  const sid = session.id;
  const msg = (text: string, mode = "send") => request.post(`/api/sessions/${sid}/messages`, { data: { text, mode } }).then((r) => r.json());
  const queue = async () => (await (await request.get(`/api/sessions/${sid}/queue`)).json()) as { queue: any[]; held: boolean };
  const events = async () => (await (await request.get(`/api/sessions/${sid}`)).json()).events as any[];
  const ends = async () => (await events()).filter((e) => e.kind === "turn_end").length;
  await page.goto(`/s/${sid}`);
  const composer = page.getByTestId("composer");

  // Two Send nows and a Remove for one queued prompt while the stop is pending.
  await msg("script:slow");
  const twin = (await msg("same words", "queue")).queued;
  const other = (await msg("same words", "queue")).queued;
  expect(other.id).not.toBe(twin.id); // identical text, two prompts
  // The first one takes the row at once and waits for the stop; the others come meanwhile.
  const first = request.post(`/api/sessions/${sid}/queue/${twin.id}/send`);
  await expect.poll(async () => (await queue()).queue.map((x) => x.id)).toEqual([other.id]);
  const [b, rm] = await Promise.all([
    request.post(`/api/sessions/${sid}/queue/${twin.id}/send`),
    request.delete(`/api/sessions/${sid}/queue/${twin.id}`),
  ]);
  expect(b.status()).toBe(409);
  expect((await first).status()).toBe(200);
  expect(rm.status()).toBe(409);
  expect((await rm.json()).error).toContain("already sending");
  await expect.poll(ends, { timeout: 30_000 }).toBe(3); // stopped, the twin, then the other
  const sent = (await events()).filter((e) => e.kind === "user" && e.data.text === "same words");
  expect(sent.map((e) => e.data.queue_id)).toEqual([twin.id, other.id]);

  // A screenshot alone queues by Tab and by the button; then text prompts; Stop holds them.
  await composer.fill("script:slow");
  await composer.press("Enter");
  await expect(page.getByTestId("stop")).toBeVisible();
  for (const how of ["tab", "button"]) {
    await page.getByTestId("attach-input").setInputFiles([{ name: `${how}.png`, mimeType: "image/png", buffer: PNG }]);
    await expect(page.getByTestId("attachments")).toBeVisible();
    if (how === "tab") await composer.press("Tab");
    else await page.getByTestId("queue-button").click();
  }
  for (const t of ["alpha", "bravo", "charlie"]) { await composer.fill(t); await composer.press("Tab"); }
  await expect(page.getByTestId("queue-item")).toHaveCount(5);
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("queue-held")).toBeVisible({ timeout: 10_000 });
  let q = await queue();
  expect(q.held).toBe(true);
  expect(q.queue.map((x) => [x.text, x.steer, x.images?.length ?? 0])).toEqual([["(image)", false, 1], ["(image)", false, 1], ["alpha", false, 0], ["bravo", false, 0], ["charlie", false, 0]]);
  const bytes = q.queue[0].images[0].data;

  // Move up is one place: charlie goes above bravo, nothing runs.
  await page.getByTestId("queue-item").filter({ hasText: "charlie" }).hover();
  await page.getByTestId("queue-item").filter({ hasText: "charlie" }).getByTestId("queue-move-up").click();
  await expect.poll(async () => (await queue()).queue.map((x) => x.text)).toEqual(["(image)", "(image)", "alpha", "charlie", "bravo"]);
  expect((await queue()).held).toBe(true);
  await shoot(page, "turn-05-queue-held-screenshots");

  // A captioned screenshot can lose its caption; a text prompt cannot be emptied.
  const cap = q.queue[1];
  await request.patch(`/api/sessions/${sid}/queue/${cap.id}`, { data: { text: "see this" } });
  const cleared = await request.patch(`/api/sessions/${sid}/queue/${cap.id}`, { data: { text: "" } });
  expect(cleared.status()).toBe(200);
  const after = (await cleared.json()).queue.find((x: any) => x.id === cap.id);
  expect([after.text, after.images[0].data]).toEqual(["(image)", bytes]);
  const alpha = q.queue[2];
  expect((await request.patch(`/api/sessions/${sid}/queue/${alpha.id}`, { data: { text: " " } })).status()).toBe(400);

  // A correction typed while the prompt is sent elsewhere goes to the box, unsent.
  const row = page.getByTestId("queue-item").nth(2); // alpha (its text leaves the row while it is edited)
  await expect(row).toContainText("alpha");
  await row.hover();
  await row.getByRole("button", { name: "Edit" }).click();
  await row.locator("input").fill("alpha, corrected");
  const n = await ends();
  await request.post(`/api/sessions/${sid}/queue/${alpha.id}/send`);
  await expect(composer).toHaveValue("alpha, corrected");
  await expect(page.getByTestId("composer-notice")).toContainText("already sent");
  expect((await request.patch(`/api/sessions/${sid}/queue/${alpha.id}`, { data: { text: "too late" } })).status()).toBe(404);
  await composer.fill("");
  // The rest drains after alpha's turn (the send released the hold).
  await expect.poll(ends, { timeout: 30_000 }).toBe(n + 5);
  expect((await events()).filter((e) => e.kind === "user" && e.data.origin === "queued").map((e) => e.data.text).slice(-5)).toEqual(["alpha", "(image)", "(image)", "charlie", "bravo"]);

  // A held follow-up written on one branch, with the chat moved back to an earlier one.
  const firstEnd = (await events()).filter((e) => e.kind === "turn_end").at(-1);
  await msg("on branch B");
  await expect.poll(ends, { timeout: 30_000 }).toBe(n + 6);
  await msg("script:slow");
  const follow = (await msg("follow-up for B", "queue")).queued;
  await request.post(`/api/sessions/${sid}/interrupt`);
  await expect.poll(ends, { timeout: 30_000 }).toBe(n + 7);
  await request.post(`/api/sessions/${sid}/head`, { data: { head_event_id: firstEnd.id, leaf: false } });
  const off = page.getByTestId("queue-item").filter({ hasText: "follow-up for B" });
  await expect(off.getByTestId("queue-off-branch")).toBeVisible();
  await expect(page.getByTestId("queue-held")).toContainText("another branch");
  expect((await request.post(`/api/sessions/${sid}/queue/resume`)).status()).toBe(409);
  expect((await request.post(`/api/sessions/${sid}/queue/${follow.id}/send`)).status()).toBe(409);
  await shoot(page, "turn-06-queued-on-another-branch");
  // Back to its branch: nothing sent, the mark goes.
  await off.hover();
  await off.getByTestId("queue-back-to-branch").click();
  await expect(off.getByTestId("queue-off-branch")).toHaveCount(0);
  expect(await ends()).toBe(n + 7);
  // Moved back again, Send here puts it on the branch shown, with its text unchanged.
  await request.post(`/api/sessions/${sid}/head`, { data: { head_event_id: firstEnd.id, leaf: false } });
  await off.hover();
  await off.getByTestId("queue-send-here").click();
  await expect.poll(ends, { timeout: 30_000 }).toBe(n + 8);
  const all = await events();
  const placed = all.find((e) => e.kind === "user" && e.data.queue_id === follow.id);
  expect(placed.data.text).toBe("follow-up for B");
  const byId = new Map(all.map((e) => [e.id, e]));
  const chain: string[] = [];
  for (let e = placed; e; e = byId.get(e.parent)) chain.push(e.data?.text ?? e.kind);
  expect(placed.parent).toBe(firstEnd.id);
  expect(chain).not.toContain("on branch B");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
