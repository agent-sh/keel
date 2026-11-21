import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: Settings > Storage measures what is on disk, lists archived
// sessions archived long ago and deletes them only after the list is
// confirmed (one changed in between is skipped), saves the archive policy,
// makes a checked backup, and lists what is past the retention before it goes.
test("storage, cleanup and backups", async ({ page, request }) => {
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { model: HAIKU, title } })).json()).session;
  const old1 = await mk("Old archived one");
  const old2 = await mk("Old archived two");
  for (const s of [old1, old2]) await request.patch(`/api/sessions/${s.id}`, { data: { archived: true } });
  // Archived forty days ago: written into the store the daemon reads.
  const { state_dir } = await (await request.get("/api/daemon")).json();
  const db = new DatabaseSync(join(state_dir, "keel.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const past = Date.now() - 40 * 86_400_000;
  db.prepare("UPDATE sessions SET updated = ? WHERE id IN (?, ?)").run(past, old1.id, old2.id);

  await page.goto("/settings/storage");
  const panel = page.getByTestId("storage-panel");
  await expect(panel.getByTestId("storage-total")).not.toBeEmpty();
  await expect(panel.getByTestId("storage-kinds")).toContainText("Conversations");
  await shoot(page, "storage-01");

  await panel.getByTestId("cleanup-days").fill("30");
  await panel.getByTestId("cleanup-find").click();
  const list = panel.getByTestId("cleanup-list");
  await expect(list).toContainText("Old archived one");
  await expect(list).toContainText("Old archived two");
  await shoot(page, "storage-02-cleanup-list");

  // One of them changes after the list was made: it is skipped, not deleted.
  db.prepare("UPDATE sessions SET updated = ? WHERE id = ?").run(past + 1, old2.id);
  db.close();
  await panel.getByTestId("cleanup-delete").click();
  await page.getByTestId("confirm").getByRole("button", { name: "Delete" }).click();
  await expect(panel.getByTestId("cleanup-done")).toContainText("1 skipped (changed since it was listed)");
  expect((await request.get(`/api/sessions/${old1.id}`)).status()).toBe(404);
  expect((await request.get(`/api/sessions/${old2.id}`)).status()).toBe(200);

  // The archive policy is saved as typed; a bad number is refused.
  await panel.getByTestId("archive-delete").fill("90");
  await panel.getByTestId("archive-delete").press("Enter");
  await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.archive.delete_archived_days).toBe(90);
  expect((await request.patch("/api/settings", { data: { archive: { delete_archived_days: 0 } } })).status()).toBe(400);

  const before = (await (await request.get("/api/backups")).json()).backups.length;
  await panel.getByTestId("backup-now").click();
  // Five are kept, and with them the full backup a kept one is read over.
  await expect(panel.getByTestId("backup-row")).toHaveCount(Math.min(before + 1, 6));
  await panel.getByTestId("backup-now").scrollIntoViewIfNeeded();
  await shoot(page, "storage-03-policy-backups");

  // A damaged manifest marks that one backup; the others stay listed.
  await panel.getByTestId("backup-now").click();
  await expect.poll(async () => (await (await request.get("/api/backups")).json()).backups.length).toBeGreaterThan(1);
  // The second holds only the pages that changed since the first, and its row says so.
  await expect(panel.getByTestId("backup-delta").first()).toHaveText("changes only");
  await panel.getByTestId("backup-delta").first().scrollIntoViewIfNeeded();
  await shoot(page, "storage-03a-backup-delta");
  const damaged = (await (await request.get("/api/backups")).json()).backups[0];
  writeFileSync(join(damaged.path, "manifest.json"), '{"created_ms": 1,');
  await page.reload();
  await expect(panel.getByTestId("backup-unreadable")).toHaveCount(1);
  expect(await panel.getByTestId("backup-row").count()).toBeGreaterThan(1);
  await panel.getByTestId("backup-unreadable").scrollIntoViewIfNeeded();
  await shoot(page, "storage-03b-backup-unreadable");
  rmSync(damaged.path, { recursive: true, force: true });

  // Retention. Nothing is removed until the owner sets one: the page proposes
  // 30 and 365 days and says what they would list. Accepted, the listing is
  // by session: one last used forty days ago, with a search result too long
  // to keep whole (its full output is a spilled file), a command's log, and a
  // file written today, which stays. Three usage records are over a year old.
  const kept = (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Has old output" } })).json()).session;
  await request.put(`/api/sessions/${kept.id}/permissions`, { data: { mode: "full-auto" } });
  const big = join(kept.workspace, `retention-${Date.now()}`);
  mkdirSync(big, { recursive: true });
  writeFileSync(join(big, "big.ts"), Array.from({ length: 4000 }, (_, i) => `export function parse(input: string): string[] { return input.split("\\n").filter(Boolean); } // row ${i}`).join("\n") + "\n");
  const ran = async (calls: unknown[], n: number) => {
    await request.post(`/api/sessions/${kept.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${kept.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(n);
    return (await (await request.get(`/api/sessions/${kept.id}`)).json()).events.filter((e: any) => e.kind === "tool_result").map((e: any) => e.data.results[0].content as string);
  };
  const results = await ran([{ name: "Grep", input: { pattern: "parse", path: big, output_mode: "content", head_limit: 5000 } }, { name: "Bash", input: { command: "echo from the command", run_in_background: true } }], 1);
  const oldOut = /saved to (\S+) \.\.\.\]/.exec(results[0]!)![1]!;
  const spill = join(state_dir, "spill", kept.id);
  const jobLog = join(spill, "jobs", readdirSync(join(spill, "jobs")).find((f) => f.endsWith(".log"))!);
  await expect.poll(() => readFileSync(jobLog, "utf8")).toContain("from the command");
  const newOut = join(spill, "2-bash-new.txt");
  writeFileSync(newOut, "y".repeat(100));
  for (const f of [oldOut, jobLog]) utimesSync(f, past / 1000, past / 1000);
  const ledger = new DatabaseSync(join(state_dir, "keel.db"));
  ledger.exec("PRAGMA busy_timeout = 5000");
  ledger.prepare("UPDATE sessions SET updated = ? WHERE id = ?").run(past, kept.id);
  for (let i = 0; i < 3; i++) ledger.prepare("INSERT INTO telemetry_calls (session_id, ts, model, outcome) VALUES (?, ?, 'p:m', 'ok')").run(kept.id, Date.now() - 400 * 86_400_000 - i);
  ledger.close();
  expect((await (await request.get("/api/settings")).json()).settings.retention).toEqual({ spill_days: 0, usage_days: 0 });
  await page.reload();
  const offer = panel.getByTestId("retention-proposed");
  await expect(offer).toContainText("Nothing is removed until you set these.");
  await expect(offer).toContainText("Past them now: 2 files of spilled output");
  await expect(offer).toContainText("in 1 session, 3 usage records");
  await offer.scrollIntoViewIfNeeded();
  await shoot(page, "storage-03c-retention-proposed");
  expect([existsSync(oldOut), existsSync(jobLog)]).toEqual([true, true]);
  await panel.getByTestId("retention-accept").click();
  await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.retention).toEqual({ spill_days: 30, usage_days: 365 });
  const dueNow = panel.getByTestId("retention-due");
  await expect(dueNow).toContainText("Past these now: 2 files of spilled output");
  await expect(dueNow).toContainText("3 usage records");
  await expect(dueNow).toContainText("The daily cleanup next runs");
  // A retention is saved as typed, and empty is never.
  await panel.getByTestId("retention-usage").fill("");
  await panel.getByTestId("retention-usage").press("Enter");
  await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.retention.usage_days).toBe(0);
  await expect(dueNow).toContainText("0 usage records");
  await panel.getByTestId("retention-usage").fill("365");
  await panel.getByTestId("retention-usage").press("Enter");
  await expect(dueNow).toContainText("3 usage records");
  await dueNow.scrollIntoViewIfNeeded();
  await shoot(page, "storage-03d-retention-due");
  await panel.getByTestId("retention-remove").click();
  await expect(page.getByTestId("confirm")).toContainText("2 files of spilled output");
  await page.getByTestId("confirm").getByRole("button", { name: "Remove" }).click();
  // The count is what went: three records, though each also changed the usage rollup.
  await expect(panel.getByTestId("retention-done")).toContainText("Removed 2 files");
  await expect(panel.getByTestId("retention-done")).toContainText("and 3 usage records");
  await expect(dueNow).toContainText("Nothing is past these now.");
  expect([existsSync(oldOut), existsSync(jobLog), existsSync(newOut)]).toEqual([false, false, true]);
  await dueNow.scrollIntoViewIfNeeded();
  await shoot(page, "storage-03e-retention-removed");
  // What became of the removed output is said where it is met again: the
  // command stays in the Terminal panel's list, the model that reads the
  // file is told to run the command again, and the transcript row says so.
  const term = (await (await request.get(`/api/sessions/${kept.id}/terminal`)).json()).commands.find((e: any) => e.job_id);
  expect(term).toMatchObject({ log_missing: true, log_removed: true });
  const again = await ran([{ name: "Read", input: { file_path: oldOut } }], 2);
  expect(again.at(-1)).toContain("was removed by the storage retention");
  expect(again.at(-1)).toContain("Run the command again to get its output.");
  await page.goto(`/s/${kept.id}`);
  const cutRow = page.getByTestId("tool-call").first();
  await cutRow.getByRole("button").first().click();
  await expect(cutRow.getByTestId("spill-removed")).toHaveText("The full output this result names was removed by the storage retention. Run the command again to get it.");
  await shoot(page, "storage-03f-output-removed");
  // The Terminal panel still lists the command, and says where its output went.
  await openPanel(page, "terminal");
  const termRow = page.getByTestId("terminal-panel").getByTestId("term-entry").filter({ hasText: "echo from the command" });
  await termRow.getByTestId("term-toggle").click();
  await expect(termRow.getByTestId("term-no-output")).toHaveText("The output was removed by the storage retention. Run the command again to get it.");
  await shoot(page, "storage-03g-terminal-removed");
  await request.patch("/api/settings", { data: { retention: null } });
  await page.goto("/settings/storage");

  // A session that wrote a file has checkpoints: its share is shown and dropping them frees the rewind data.
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const wsDir = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `storage-${Date.now()}`);
  mkdirSync(wsDir, { recursive: true });
  const w = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: wsDir, title: "Wrote a file", text: "Create the file notes-storage-check.txt with the text hello, using your file writing tool. Then reply done." } })).json()).session;
  await expect.poll(async () => (await (await request.get(`/api/sessions/${w.id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 120_000 }).toBe(true);
  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  expect((await (await request.get(`/api/sessions/${w.id}/checkpoints`)).json()).turns.length).toBeGreaterThan(0);
  await page.reload();
  // Any session's checkpoints can be dropped from its folder, however small the
  // session is next to the others (a busy daemon has many larger ones).
  const folder = panel.getByTestId("checkpoint-folder").filter({ has: page.getByTitle(w.workspace, { exact: true }) });
  await folder.getByRole("button").first().click();
  const row = folder.locator(`[data-testid="checkpoint-session"][data-id="${w.id}"]`);
  await row.scrollIntoViewIfNeeded();
  await shoot(page, "storage-04-checkpoint-sessions");
  await row.getByTestId("checkpoint-drop").click();
  await page.getByTestId("confirm").getByRole("button", { name: "Drop" }).click();
  await expect(panel.getByTestId("checkpoints-done")).toContainText("Dropped");
  expect((await (await request.get(`/api/sessions/${w.id}/checkpoints`)).json()).turns.length).toBe(0);
  await panel.getByTestId("checkpoints-done").scrollIntoViewIfNeeded();
  await shoot(page, "storage-05-checkpoints-dropped");

  await request.patch("/api/settings", { data: { archive: { delete_archived_days: null } } });
  for (const id of [old2.id, w.id]) await request.delete(`/api/sessions/${id}`);
});

// On a phone the head keeps the total, its measured-at note and Measure again
// apart, and every kind's size stays inside the card: the name and the size
// share a line and the bar runs under both.
test("the storage head and sizes fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/settings/storage");
  const panel = page.getByTestId("storage-panel");
  await expect(panel.getByTestId("storage-total")).not.toBeEmpty();
  const box = async (l: ReturnType<typeof panel.getByTestId>) => (await l.boundingBox())!;
  const apart = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
  // The words of the total, not its box: the box is as wide as its column.
  const total = await panel.getByTestId("storage-total").evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
  const note = (await panel.getByText(/^measured /).boundingBox())!, again = (await panel.getByRole("button", { name: "Measure again" }).boundingBox())!;
  expect(apart(total, note)).toBe(true);
  expect(apart(total, again)).toBe(true);
  expect(apart(note, again)).toBe(true);
  for (const b of [total, note, again]) { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(320); }
  // Each size is whole inside the list of kinds, with its bar under the name.
  const kinds = await box(panel.getByTestId("storage-kinds"));
  const sizes = await panel.getByTestId("storage-kinds").locator(":scope > div > span:last-child").all();
  expect(sizes.length).toBe(8);
  for (const s of sizes) { const b = (await s.boundingBox())!; expect(b.x + b.width).toBeLessThanOrEqual(kinds.x + kinds.width + 0.5); expect(b.x).toBeGreaterThanOrEqual(kinds.x); }
  const bar = (await panel.getByTestId("storage-kinds").locator(":scope > div > div").first().boundingBox())!;
  expect(bar.width).toBeGreaterThan(kinds.width * 0.9);
  expect(await page.getByTestId("settings-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await shoot(page, "storage-06-phone");
  // With room the three columns stand as before: the bar between the name and the size.
  await page.setViewportSize({ width: 1920, height: 1040 });
  const row = panel.getByTestId("storage-kinds").locator(":scope > div").first();
  const [name, track, size] = await Promise.all([row.locator("span").first(), row.locator("div").first(), row.locator("span").last()].map(async (l) => (await l.boundingBox())!));
  expect(track!.x).toBeGreaterThanOrEqual(name!.x + name!.width);
  expect(size!.x).toBeGreaterThanOrEqual(track!.x + track!.width);
  expect(Math.abs(track!.y + track!.height / 2 - (size!.y + size!.height / 2))).toBeLessThan(4);
  await shoot(page, "storage-07-wide");
});
