import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: Settings > Storage measures what is on disk, lists archived
// sessions archived long ago and deletes them only after the list is
// confirmed (one changed in between is skipped), saves the archive policy and
// makes a checked backup.
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
  await expect(panel.getByTestId("backup-row")).toHaveCount(Math.min(before + 1, 5));
  await panel.getByTestId("backup-now").scrollIntoViewIfNeeded();
  await shoot(page, "storage-03-policy-backups");

  // A session that wrote a file has checkpoints: its share is shown and dropping them frees the rewind data.
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const w = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Wrote a file", text: "Create the file notes-storage-check.txt with the text hello, using your file writing tool. Then reply done." } })).json()).session;
  await expect.poll(async () => (await (await request.get(`/api/sessions/${w.id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 120_000 }).toBe(true);
  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  expect((await (await request.get(`/api/sessions/${w.id}/checkpoints`)).json()).turns.length).toBeGreaterThan(0);
  await page.reload();
  await expect(panel.getByTestId("checkpoint-folder").first()).toBeVisible();
  const row = panel.getByTestId("storage-session").filter({ hasText: "Wrote a file" });
  await row.getByTestId("session-checkpoints").click();
  await page.getByTestId("confirm").getByRole("button", { name: "Drop" }).click();
  await expect(panel.getByTestId("checkpoints-done")).toContainText("Dropped");
  expect((await (await request.get(`/api/sessions/${w.id}/checkpoints`)).json()).turns.length).toBe(0);
  await panel.getByTestId("checkpoints-done").scrollIntoViewIfNeeded();
  await shoot(page, "storage-04-checkpoints");

  await request.patch("/api/settings", { data: { archive: { delete_archived_days: null } } });
  for (const id of [old2.id, w.id]) await request.delete(`/api/sessions/${id}`);
});
