import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: the owner's helper. One conversation kept above the sessions
// (the list's Helper entry, Ctrl J), with its side panel: the memory the
// helper writes and they edit (keyed records: helper-memory.spec.ts), what it was told about lately, and
// its mail. Sending a mail always waits for their card, even in full auto. A
// failure in another session and important new mail arrive in one digest
// wake. The mail is the stand-in folder scripts/dev.sh sets; the model is
// the scripted stand-in, so the calls are exact.
test.use({ viewport: { width: 1700, height: 980 } });
// The helper is daemon-wide: off again after the spec, so other specs' sessions never wake it.
test.afterEach(async ({ request }) => { await request.put("/api/helper", { data: { on: false } }); });

test("helper: remembered list, send-mail card, digest of sessions and mail", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(240_000);
  const { state_dir } = await (await request.get("/api/daemon")).json();
  const mail = join(dirname(state_dir), "mail");
  test.skip((await (await request.get("/api/helper")).json()).mail.id !== "standin", "the daemon reads real mail (no KEEL_MAIL_STANDIN)");
  mkdirSync(mail, { recursive: true });
  const msg = (id: string, from: string, subject: string, labels: string[]) => ({ id, thread_id: id, from, subject, date: new Date().toUTCString(), snippet: subject, labels, body: `${subject}.` });
  writeFileSync(join(mail, "inbox.json"), JSON.stringify([msg(`old-${Date.now()}`, "Old <old@example.com>", "A backlog message", ["INBOX", "UNREAD"])]));
  const outbox = join(mail, "outbox.jsonl");
  const sentBefore = existsSync(outbox) ? readFileSync(outbox, "utf8").trim().split("\n").filter(Boolean).length : 0;

  // A fresh helper on this scratch daemon: an earlier run's conversation archived, its memory emptied.
  const was = await (await request.get("/api/helper")).json();
  if (was.session_id) await request.patch(`/api/sessions/${was.session_id}`, { data: { archived: true } });
  for (const m of (await (await request.get("/api/helper/memory")).json()).items) await request.delete(`/api/helper/memory/${encodeURIComponent(m.key)}`);

  // Opening it the first time turns it on; it leaves the session list.
  await page.goto("/");
  await page.getByTestId("open-helper").click();
  await expect(page.getByTestId("helper-panel")).toBeVisible();
  const helper = await (await request.get("/api/helper")).json();
  expect(helper.on).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/s/${helper.session_id}`));
  await expect(page.getByTestId("session-list").locator(`[data-session="${helper.session_id}"]`)).toHaveCount(0);
  await request.patch(`/api/sessions/${helper.session_id}`, { data: { model: "scripted:stand-in" } });
  // Full auto: the mail card must come anyway.
  await request.put(`/api/sessions/${helper.session_id}/permissions`, { data: { mode: "full-auto" } });
  await request.post("/api/helper/check"); // the first look notes the backlog, no news
  await shoot(page, "helper-01-open");

  // The helper keeps a fact, reads the sessions, and drafts a mail; the mail waits for the card.
  const calls = [
    { name: "helper__memory_put", input: { records: [{ key: "person.dana", value: "Dana is the accountant; invoices go to her", kind: "person", aliases: ["dana@example.com"] }] } },
    { name: "helper__sessions", input: {} },
    { name: "mail__send", input: { to: "dana@example.com", subject: "Invoice 1042", body: "Hi Dana,\n\nThe invoice is paid.\n\nAvi" } },
  ];
  await page.getByTestId("composer").fill(`Remember Dana and mail her. script:calls ${JSON.stringify(calls)}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("memory-item").filter({ hasText: "Dana is the accountant" })).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("approval-summary")).toContainText("To: dana@example.com");
  await expect(card.getByTestId("approval-summary")).toContainText("The invoice is paid.");
  await shoot(page, "helper-02-send-card");
  await card.getByTestId("allow-once").click();
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(outbox, "utf8").trim().split("\n").filter(Boolean).length).toBe(sentBefore + 1);

  // They edit what it kept, adds their own item, and forgets one.
  const item = page.getByTestId("memory-item").filter({ hasText: "Dana is the accountant" });
  await item.hover();
  await item.getByTestId("memory-edit-button").click();
  await item.getByTestId("memory-edit").fill("Dana is the accountant; invoices go to her by the 5th");
  await item.getByTestId("memory-save").click();
  await expect(page.getByTestId("memory-item").filter({ hasText: "by the 5th" })).toBeVisible();
  await page.getByTestId("memory-new").fill("Prefers short replies");
  await page.getByTestId("memory-add").click();
  await expect(page.getByTestId("memory-item").filter({ hasText: "Prefers short replies" })).toBeVisible();
  await page.getByTestId("memory-new").fill("A note to drop");
  await page.getByTestId("memory-add").click();
  const drop = page.getByTestId("memory-item").filter({ hasText: "A note to drop" });
  await drop.hover();
  await drop.getByTestId("memory-delete").click();
  await expect(drop).toHaveCount(0);
  // A secret is never kept.
  const secret = await request.post("/api/helper/memory", { data: { value: "The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789", kind: "fact" } });
  expect(secret.status()).toBe(400);

  // Another session fails and important mail comes in: one wake tells both.
  const { session: other } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Billing run" } })).json();
  await request.post(`/api/sessions/${other.id}/messages`, { data: { text: "script:billing" } });
  writeFileSync(join(mail, "inbox.json"), JSON.stringify([
    msg(`dana-${Date.now()}`, "Dana <dana@example.com>", "The auditor needs the March invoices today", ["INBOX", "UNREAD", "IMPORTANT"]),
    msg(`promo-${Date.now()}`, "Shop <deals@example.com>", "50% off everything", ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]),
  ]));
  expect((await (await request.post("/api/helper/check")).json()).important).toBe(1);
  const events = page.getByTestId("helper-event");
  await expect(events.filter({ hasText: "auditor" })).toBeVisible();
  await expect(events.filter({ hasText: "Billing run" })).toBeVisible({ timeout: 30_000 });
  await expect(events.filter({ hasText: "50% off" })).toHaveCount(0);
  // The wake: one digest after the burst gathers (a minute), answered by the helper.
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 120_000 });
  const evs = (await (await request.get(`/api/sessions/${helper.session_id}`)).json()).events;
  const digest = evs.filter((e: any) => e.kind === "user" && e.data.kind === "helper_digest");
  expect(digest.length).toBe(1);
  expect(digest[0].data.text).toContain("auditor");
  expect(digest[0].data.text).toContain("Billing run");
  await shoot(page, "helper-03-digest");

  // Their next message brings the remembered items it calls up, within the budget.
  await page.getByTestId("composer").fill("When do the invoices go to the accountant?");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 30_000 });
  const after = (await (await request.get(`/api/sessions/${helper.session_id}`)).json()).events;
  const note = after.filter((e: any) => e.kind === "note" && e.data.helper).at(-1);
  expect(note.data.text).toContain("by the 5th");

  // Settings: on, the mail source, the check and wake cadence.
  await page.goto("/settings/helper");
  await expect(page.getByTestId("helper-settings")).toBeVisible();
  await expect(page.getByTestId("helper-on")).toHaveAttribute("aria-checked", "true");
  await shoot(page, "helper-04-settings");
});
