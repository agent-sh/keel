import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: a change reads as one diff block wherever it is shown. In Changes
// its lines carry the file's own line numbers and the colors of the file's
// language, as a file does in Files.
test("a diff in Changes is numbered and colored as its file's language", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `diff-${Date.now()}`);
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src/limits.ts"), Array.from({ length: 12 }, (_, i) => `export const limit${i + 1} = ${i + 1};`).join("\n") + "\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const command = "sed -i '5s/= 5;/= 50;/' src/limits.ts";
  await request.post(`/api/sessions/${session.id}/messages`, {
    data: { text: HAIKU.startsWith("scripted:") ? `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}` : `Run exactly this one Bash command and nothing else: ${command}\nThen reply ok.` },
  });
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await openPanel(page, "changes");
  const file = page.getByTestId("side-panel").locator('[data-testid="diff-file"][data-path="src/limits.ts"]').first();
  await expect(file).toBeVisible({ timeout: 30_000 });
  // The removed line is line 5 of the old file, the added one line 5 of the new.
  await expect(file.locator('tr[data-kind="del"] .k-diff-no').first()).toHaveText("5");
  await expect(file.locator('tr[data-kind="add"] .k-diff-no').nth(1)).toHaveText("5");
  // Colored as TypeScript: a keyword and a number are told apart on the changed line.
  const added = file.locator('tr[data-kind="add"]');
  await expect(added.locator(".th-keyword").first()).toHaveText("export", { timeout: 15_000 });
  const keyword = await added.locator(".th-keyword").first().evaluate((el) => getComputedStyle(el).color);
  const number = await added.locator(".th-number").first().evaluate((el) => getComputedStyle(el).color);
  expect(keyword).not.toBe(number);
  await expect(added).toContainText("export const limit5 = 50;");
  await shoot(page, "diff-block-01-changes");
});
