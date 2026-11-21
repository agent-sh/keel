import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, SCRIPTED } from "./shots.ts";

// Feature: the permission gate. A command that changes things asks; "always
// allow" stores a grant that covers the next one; a grant is revoked from the
// grants panel; read-only mode refuses; a denial's reason reaches the model.
test("permission gate", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: it has to try the gated tool calls a plain prompt leads to");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `perm-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("permission-mode")).toHaveText("Ask");

  const say = async (text: string) => {
    await page.getByTestId("composer").fill(text);
    await page.keyboard.press("Enter");
  };
  const turns = () => page.getByTestId("turn-end");

  // 1. A command that writes asks first; the turn waits.
  await say("Run exactly this Bash command and nothing else: touch alpha.txt. Then reply with one word: ok.");
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId("approval-summary")).toContainText("touch alpha.txt");
  // The session list marks who waits on the owner (a "need" mark in the session rail).
  await expect(page.locator(`[data-testid="session-row"][data-session="${session.id}"]`).first()).toHaveAttribute("data-watch", "need");
  await shoot(page, "perm-01-card");

  // 2. Always allow, with the suggested rule.
  await card.getByTestId("allow-always").click();
  await expect(page.getByTestId("grant-pattern")).toHaveValue("touch *");
  await shoot(page, "perm-02-always");
  await page.getByTestId("grant-always").click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(`[data-testid="session-row"][data-session="${session.id}"]`).first()).not.toHaveAttribute("data-watch", "need");
  await expect(turns()).toHaveCount(1, { timeout: 120_000 });
  expect(existsSync(join(ws, "alpha.txt"))).toBe(true);

  // 3. The grant covers the next touch: no card.
  await say("Run exactly this Bash command and nothing else: touch beta.txt. Then reply with one word: ok.");
  await expect(turns()).toHaveCount(2, { timeout: 120_000 });
  await expect(card).toHaveCount(0);
  expect(existsSync(join(ws, "beta.txt"))).toBe(true);

  // 4. The grants panel lists it; revoke it.
  await page.getByTestId("permission-menu").click();
  await shoot(page, "perm-03-menu");
  await page.getByTestId("open-grants").click();
  const grant = page.getByTestId("grant").filter({ hasText: "touch *" });
  await expect(grant).toBeVisible();
  await shoot(page, "perm-04-grants");
  await grant.hover();
  await grant.getByTestId("revoke-grant").click();
  await expect(grant).toHaveCount(0);
  // Undo puts that exact grant back once; revoke it again for what follows.
  await page.getByTestId("grant-undo").getByRole("button", { name: "Undo" }).click();
  await expect(grant).toBeVisible();
  await grant.hover();
  await grant.getByTestId("revoke-grant").click();
  await expect(grant).toHaveCount(0);
  await page.keyboard.press("Escape");

  // 5. Read-only mode refuses without asking.
  await page.getByTestId("permission-menu").click();
  await page.getByTestId("mode-read-only").click();
  await expect(page.getByTestId("permission-mode")).toHaveText("Read only");
  await page.keyboard.press("Escape");
  await say("Run exactly this Bash command once and nothing else: touch gamma.txt. If it fails, do not retry; reply with one word: refused.");
  await expect(turns()).toHaveCount(3, { timeout: 120_000 });
  await expect(card).toHaveCount(0);
  expect(existsSync(join(ws, "gamma.txt"))).toBe(false);
  await expect(page.getByTestId("tool-call").last()).toContainText("failed");

  // 6. Deny with a reason: the model sees it.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
  await expect(page.getByTestId("permission-mode")).toHaveText("Ask");
  await say("Run exactly this Bash command once and nothing else: rm alpha.txt. If it is denied, do not retry; quote the reason you were given.");
  await expect(card).toBeVisible({ timeout: 60_000 });
  // The card is a named group: what it asks, with its command as the description.
  await expect(page.getByRole("group", { name: /Run this command\?/ })).toHaveAccessibleDescription(/rm alpha\.txt/);
  await expect(card).toContainText("Esc to deny with a reason");
  // Escape opens the reason, Escape again goes back: the card stays open, nothing is sent.
  await card.getByTestId("allow-once").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("deny-reason")).toHaveCount(0);
  await expect(card).toHaveCount(1);
  const pending = (await (await request.get(`/api/sessions/${session.id}/approvals`)).json()).approvals;
  expect(pending).toHaveLength(1);
  await card.getByTestId("deny").click();
  await page.getByTestId("deny-reason").fill("keep alpha, it is the fixture");
  await shoot(page, "perm-05-deny");
  await page.getByTestId("deny-send").click();
  await expect(turns()).toHaveCount(4, { timeout: 120_000 });
  // A stale answer after the denial is refused with how the card ended.
  const stale = await request.post(`/api/sessions/${session.id}/approvals/${pending[0].id}`, { data: { choice: "once" } });
  expect(stale.status()).toBe(409);
  const said = await stale.json();
  expect(said.error).toMatch(/already denied: keep alpha/);
  expect(said.approval.state).toBe("denied");
  expect(existsSync(join(ws, "alpha.txt"))).toBe(true);
  await expect(page.getByTestId("assistant-text").last()).toContainText(/fixture/i);
  await shoot(page, "perm-06-denied");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A permissions read held back past a newer change (a slow reconnect) never
// puts the older mode back on screen, whichever way the change went.
test("a late permissions read never brings back an older mode", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `perm-late-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  const label: Record<string, string> = { "full-auto": "Full auto", "read-only": "Read only" };
  for (const [from, to] of [["full-auto", "read-only"], ["read-only", "full-auto"]] as const) {
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: from } });
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let read = () => {};
    const readDone = new Promise<void>((r) => (read = r));
    await page.route(`**/api/sessions/${session.id}/permissions`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const stale = await route.fetch(); // read now, delivered after the change
      read();
      await held;
      await route.fulfill({ response: stale });
    });
    await page.goto(`/s/${session.id}`);
    await readDone;
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: to } });
    await expect(page.getByTestId("permission-mode")).toHaveText(label[to]!);
    release();
    await page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${session.id}/permissions`));
    await page.waitForTimeout(300);
    await expect(page.getByTestId("permission-mode")).toHaveText(label[to]!);
    await page.unroute(`**/api/sessions/${session.id}/permissions`);
  }
  await request.delete(`/api/sessions/${session.id}`);
});

// On a narrow card at a large text size the three answers wrap and none is
// cut: Allow once, Always allow and Deny, in that order for the Tab key. Deny
// still opens its reason form, and the answers mean what they did.
test("permission card answers wrap on a narrow screen", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `perm-narrow-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in", title: "Narrow permission card" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "touch alpha.txt" } }])}` } });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`/s/${session.id}`);
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
  await page.reload();
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeCloseTo(25.5, 1);
  const card = page.locator(`[data-station="${session.id}"]`).getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 30_000 });
  const once = card.getByTestId("allow-once"), always = card.getByTestId("allow-always"), deny = card.getByTestId("deny");
  // Each answer is whole: inside the card and the screen, with all of its words, and the card has nothing to pan to.
  const whole = async (l: typeof once, words: string) => {
    await expect(l).toHaveText(words);
    const b = (await l.boundingBox())!, c = (await card.boundingBox())!;
    expect(b.x, words).toBeGreaterThanOrEqual(c.x);
    expect(b.x + b.width, words).toBeLessThanOrEqual(Math.min(320, c.x + c.width) + 0.5);
    expect(await l.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), words).toBe(true);
  };
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollLeft === 0)).toBe(true);
  await whole(once, "Allow once");
  await whole(always, "Always allow");
  await whole(deny, "Deny");
  expect(await card.evaluate((el) => el.scrollLeft)).toBe(0);
  await shoot(page, "perm-07-card-narrow");
  // The Tab key goes through them in that order.
  await once.focus();
  await page.keyboard.press("Tab");
  await expect(always).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(deny).toBeFocused();
  // Deny opens the reason form, whole too; Esc goes back to the three answers.
  await page.keyboard.press("Enter");
  const reason = card.getByTestId("deny-reason");
  await expect(reason).toBeFocused();
  const send = (await card.getByTestId("deny-send").boundingBox())!;
  expect(send.x + send.width).toBeLessThanOrEqual(320);
  // The reason has a line of its own to type in, not what the buttons leave.
  expect((await reason.boundingBox())!.width).toBeGreaterThan(0.7 * (await card.boundingBox())!.width);
  await shoot(page, "perm-08-deny-narrow");
  await page.keyboard.press("Escape");
  await expect(once).toBeVisible();
  // Always allow still offers the suggested rule, and Allow once still runs the command.
  // (An answer acts once it has stood in view for a moment. The card is taller than the
  // region that shows it here: the keyboard brings each answer into view, the page gets
  // two frames to mark it as waiting, and Enter presses it when it no longer waits.)
  const press = async (l: typeof once) => {
    await l.focus();
    await l.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
    await expect(l).toBeEnabled();
    await page.keyboard.press("Enter");
  };
  await press(always);
  await expect(page.getByTestId("grant-pattern")).toHaveValue("touch *");
  await page.keyboard.press("Escape");
  await press(once);
  await expect(card).toHaveCount(0);
  await expect.poll(() => existsSync(join(ws, "alpha.txt")), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1"));

  // A wide card keeps the answers on one line.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "touch beta.txt" } }])}` } });
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.reload();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const ys = await Promise.all([once, always, deny].map(async (l) => (await l.boundingBox())!.y));
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2);
  await shoot(page, "perm-09-card-wide");
  await deny.click();
  await card.getByTestId("deny-send").click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).running, { timeout: 30_000 }).toBe(false);
  expect(existsSync(join(ws, "beta.txt"))).toBe(false);
  await request.delete(`/api/sessions/${session.id}`);
});

// A redirect after a group, after a loop or with no command before it writes a
// file like any other: a Read only session refuses it with the reason, and Ask
// asks before it runs. Reads beside them still run.
test("a write through a redirect on a group, a loop or nothing is never run as a read", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `perm-redirect-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in", title: "Redirects are writes" } })).json();
  const run = (commands: string[]) => request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(commands.map((command) => ({ name: "Bash", input: { command } })))}` } });

  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "read-only", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("permission-mode")).toHaveText("Read only");
  await run(["ls > /dev/null 2>&1; { pwd; }", "> bare.txt", "{ echo a; echo b; } > grouped.txt", "echo x >&copied.txt", "for f in a b; do echo $f; done > looped.txt"]);
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  // The last call's refusal reaches the model, and no file was written.
  const told = page.getByText(/Done with 5 calls\. Last result: This session is read-only: only read-only commands run/);
  await expect(told).toContainText("done > looped.txt");
  await expect(told).toContainText("is not one.");
  for (const f of ["bare.txt", "grouped.txt", "copied.txt", "looped.txt"]) expect(existsSync(join(ws, f)), f).toBe(false);
  await expect(page.getByTestId("approval")).toHaveCount(0);
  await shoot(page, "perm-10-redirect-refused");

  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await run(["{ echo a; echo b; } > grouped.txt"]);
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("approval-summary")).toContainText("{ echo a; echo b; } > grouped.txt");
  expect(existsSync(join(ws, "grouped.txt"))).toBe(false);
  await shoot(page, "perm-11-redirect-asked");
  await card.getByTestId("allow-once").click();
  await expect.poll(() => existsSync(join(ws, "grouped.txt")), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
  await request.delete(`/api/sessions/${session.id}`);
});
