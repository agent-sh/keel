import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the permission gate. A command that changes things asks; "always
// allow" stores a grant that covers the next one; a grant is revoked from the
// grants panel; read-only mode refuses; a denial's reason reaches the model.
test("permission gate", async ({ page, request }) => {
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
