import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: the helper's memory as keyed records. A big lookup file (mail
// labels) goes in once with helper__memory_import (first its shape, then
// templates), and later turns look facts up by key, alias or topic instead of
// reading the file. Mail shows label names from memory. A prompt that names
// a key gets that one record in its note, never the whole list; a topic it
// names comes as a hint with a count. The owner searches, edits, adds and
// deletes records in the panel. Scripted model, so the calls are exact.
test.use({ viewport: { width: 1920, height: 1040 } });
test.afterEach(async ({ request }) => { await request.put("/api/helper", { data: { on: false } }); });

const NAMES = ["Clients/Acme", "Clients/Birchwood", "Clients/Corvid", "Finance/Receipts", "Finance/Invoices", "Finance/Bank", "Travel/Bookings", "Travel/Visas", "Family/School", "Family/Health",
  "Projects/Garden", "Projects/Kitchen", "Newsletters/Tech", "Newsletters/Local", "Vendors/Hosting", "Vendors/Domains", "Hiring/Applicants", "Hiring/Offers", "Legal/Contracts", "Legal/Notices",
  "Insurance/Car", "Insurance/Home", "Events/Meetups", "Events/Conferences", "Archive/2025", "Archive/2026", "Tax/Annual", "Tax/Advance", "Shopping/Orders", "Shopping/Returns"];

test("helper memory: import a labels file once, look up by key and alias, recall only what a prompt names, edit in the panel", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.skip((await (await request.get("/api/helper")).json()).mail.id !== "standin", "the daemon reads real mail (no KEEL_MAIL_STANDIN)");
  test.setTimeout(120_000);
  const { state_dir } = await (await request.get("/api/daemon")).json();
  const dir = join(dirname(state_dir), "helper-memory");
  mkdirSync(dir, { recursive: true });
  const labels = join(dir, "labels.json");
  writeFileSync(labels, JSON.stringify({ labels: [
    { id: "INBOX", name: "INBOX", type: "system" },
    ...NAMES.map((name, i) => ({ id: `Label_${i + 1}`, name, type: "user", messageListVisibility: "show", labelListVisibility: "labelShow" })),
  ] }, null, 2));
  const mail = join(dirname(state_dir), "mail");
  mkdirSync(mail, { recursive: true });
  writeFileSync(join(mail, "inbox.json"), JSON.stringify([{ id: "m-receipt", thread_id: "m-receipt", from: "Shop <orders@example.com>", subject: "Your receipt", date: new Date().toUTCString(), snippet: "Thanks", labels: ["INBOX", "Label_4", "Label_29"], body: "Thanks for your order." }]));

  // A fresh helper with an empty memory.
  const was = await (await request.get("/api/helper")).json();
  if (was.session_id) await request.patch(`/api/sessions/${was.session_id}`, { data: { archived: true } });
  for (const m of (await (await request.get("/api/helper/memory")).json()).items) await request.delete(`/api/helper/memory/${encodeURIComponent(m.key)}`);
  await page.goto("/");
  await page.getByTestId("open-helper").click();
  await expect(page.getByTestId("helper-panel")).toBeVisible();
  const helper = await (await request.get("/api/helper")).json();
  await request.patch(`/api/sessions/${helper.session_id}`, { data: { model: "scripted:stand-in" } });
  await request.put(`/api/sessions/${helper.session_id}/permissions`, { data: { mode: "full-auto" } });

  // The import: the file's shape first, then templates; then lookups by topic, alias and key, and a mail with label names.
  const calls = [
    { name: "helper__memory_import", input: { path: labels } },
    { name: "helper__memory_import", input: { path: labels, items: "labels", key: "mail.label.{id}", value: "{name}", aliases: ["{name}"], topics: ["mail", "labels"] } },
    { name: "helper__memory_find", input: { query: "finance" } },
    { name: "helper__memory_get", input: { keys: ["Label_7", "Travel/Visas", "mail.label.label_99"] } },
    { name: "helper__memory_put", input: { records: [{ key: "person.dana-levi", value: "Dana Levi is the accountant; invoices go to her by the 5th", kind: "person", aliases: ["Dana", "dana@example.com"], topics: ["finance"] }] } },
    { name: "mail__read", input: { id: "m-receipt" } },
  ];
  await page.getByTestId("composer").fill(`Keep the labels. script:calls ${JSON.stringify(calls)}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 30_000 });
  const evs = (await (await request.get(`/api/sessions/${helper.session_id}`)).json()).events;
  const results = evs.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).map((r: any) => (typeof r.content === "string" ? r.content : r.content.map((b: any) => b.text).join("")));
  expect(results[0]).toContain('items "labels": 31 objects, fields id, name, type');
  expect(results[1]).toContain("Imported 31 records");
  expect(results[2]).toContain("mail.label.label_4: Finance/Receipts");
  expect(results[2]).toContain("mail.label.label_6: Finance/Bank");
  expect(results[2]).not.toContain("Clients/Acme");
  expect(results[3]).toContain("mail.label.label_7: Travel/Bookings");
  expect(results[3]).toContain("mail.label.label_8: Travel/Visas");
  expect(results[3]).toMatch(/mail\.label\.label_99: no record/);
  expect(results[4]).toContain("Kept 1: person.dana-levi");
  expect(results[5]).toContain("Labels: INBOX Label_4 (Finance/Receipts) Label_29 (Shopping/Orders)");
  // The file was never read into the conversation.
  expect(results.join("\n")).not.toContain("Hiring/Offers");
  await expect(page.getByTestId("memory-count")).toHaveText("32");

  // A prompt naming one label and a person: their records come with it, not the other thirty.
  await page.getByTestId("composer").fill("Move the receipt to Label_12 and tell Dana. Which labels are there?");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
  const after = (await (await request.get(`/api/sessions/${helper.session_id}`)).json()).events;
  const note = after.filter((e: any) => e.kind === "note" && e.data.helper).at(-1).data.text as string;
  expect(note).toContain("- mail.label.label_12: Projects/Kitchen");
  expect(note).toContain("- person.dana-levi (person): Dana Levi is the accountant");
  expect(note).toContain('topic "labels": 31 records');
  expect(note.match(/mail\.label\./g)?.length).toBe(1);
  await shoot(page, "helper-memory-01-imported");

  // The panel: search narrows hundreds to a few; edit aliases; add with a key; delete.
  const search = page.getByTestId("memory-search");
  await search.fill("finance");
  await expect(page.getByTestId("memory-found")).toHaveText("4");
  await expect(page.getByTestId("memory-item")).toHaveCount(4);
  const dana = page.locator('[data-testid="memory-item"][data-key="person.dana-levi"]');
  await expect(dana.getByTestId("memory-alias").filter({ hasText: "dana@example.com" })).toBeVisible();
  await expect(dana.getByTestId("memory-topic")).toHaveText("#finance");
  await shoot(page, "helper-memory-02-search");
  await dana.hover();
  await dana.getByTestId("memory-edit-button").click();
  await dana.getByTestId("memory-edit-aliases").fill("Dana, dana@example.com, accountant");
  await dana.getByTestId("memory-save").click();
  await expect(dana.getByTestId("memory-alias").filter({ hasText: "accountant" })).toBeVisible();
  await search.fill("");
  await page.getByTestId("memory-new-key").fill("Pref.Notifications");
  await page.getByTestId("memory-new").fill("Notify only when something needs the owner today");
  await page.getByTestId("memory-add").click();
  const pref = page.locator('[data-testid="memory-item"][data-key="pref.notifications"]');
  await expect(pref).toBeVisible();
  expect((await request.post("/api/helper/memory", { data: { key: "pref.notifications", value: "again" } })).status()).toBe(409);
  await pref.hover();
  await pref.getByTestId("memory-delete").click();
  await expect(pref).toHaveCount(0);
  const got = await (await request.get(`/api/helper/memory?q=${encodeURIComponent("accountant")}`)).json();
  expect(got.items.map((m: any) => m.key)).toEqual(["person.dana-levi"]);
  await search.fill("travel");
  await shoot(page, "helper-memory-03-edited");
});
