import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the message box's built-in commands that used to say "not
// available yet". /permissions sets a mode by name or opens the menu, /review
// asks the model to review the folder's uncommitted changes, /init has it
// write an AGENTS.md, /agents opens the board, /export opens the export sheet.
test("slash commands", async ({ page, request }) => {
  test.setTimeout(300_000);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `slash-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: ws });
  writeFileSync(join(ws, "math.ts"), "export const add = (a: number, b: number) => a - b;\n");
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  const box = page.getByTestId("composer");
  const run = async (cmd: string) => { await box.fill(cmd); await page.keyboard.press("Enter"); };

  // Nothing in the menu is a dead end.
  await box.fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(page.getByTestId("slash-menu")).not.toContainText("not available yet");
  await shoot(page, "slash-01-menu");
  await box.fill("");

  await run("/permissions full-auto");
  await expect(page.getByTestId("permission-mode")).toHaveText("Full auto");
  await run("/permissions");
  await expect(page.getByTestId("mode-read-only")).toBeVisible();
  await shoot(page, "slash-02-permissions");
  await page.keyboard.press("Escape");
  await run("/permissions nonsense");
  await expect(page.getByText('No mode "nonsense"')).toBeVisible();

  await run("/review");
  await expect(page.getByTestId("user-message").last()).toContainText("Review the uncommitted changes");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 150_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/subtract|minus|-|add/i);
  await shoot(page, "slash-03-review");

  await run("/init");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 150_000 });
  expect(existsSync(join(ws, "AGENTS.md"))).toBe(true);

  await run("/export");
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  await run("/agents");
  await expect(page).toHaveURL(/\/board$/);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
