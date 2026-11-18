import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the board. Sessions sit in columns by what they need: one waiting
// on an approval under Needs you (answered from the peek without leaving the
// board), one running under Working, finished ones under Done with a mark
// until opened. Arrows move, Space peeks, Enter opens; a task typed at the
// top starts a session in place.
test("board", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `board-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const start = async (title: string, mode: string, text: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU, title } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, sandbox: "off" } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    return session.id as string;
  };
  const done = await start("Board: a finished one", "ask", "Reply with exactly the word finished.");
  const asks = await start("Board: asks first", "ask", "Run exactly this Bash command and nothing else: touch board-a.txt. Then reply ok.");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${done}`)).json()).session.phase, { timeout: 90_000 }).toBe("idle");
  const busy = await start("Board: working", "full-auto", "Run the Bash command `sleep 12` and then reply with the word slept.");

  await page.goto("/");
  await page.getByTestId("open-board").click();
  await expect(page).toHaveURL(/\/board$/);
  const col = (id: string) => page.getByTestId(`board-col-${id}`);
  const card = (id: string) => page.locator(`[data-card="${id}"]`);
  await expect(col("needs").locator(`[data-card="${asks}"]`)).toBeVisible({ timeout: 60_000 });
  await expect(card(asks).getByTestId("board-line")).toContainText("touch board-a.txt");
  await expect(col("working").locator(`[data-card="${busy}"]`)).toBeVisible({ timeout: 60_000 });
  await expect(col("done").locator(`[data-card="${done}"]`)).toBeVisible();
  await expect(card(done).getByTestId("board-unseen")).toBeVisible();
  await expect(page.getByTestId("open-board")).toContainText("1");
  await shoot(page, "board-01-columns");

  // Keyboard: the first card of Needs you is selected; Space peeks.
  await card(asks).focus();
  await page.keyboard.press("Space");
  const peek = page.getByTestId("board-peek-panel");
  await expect(peek.getByTestId("approval")).toBeVisible();
  await shoot(page, "board-02-peek-approval");
  await peek.getByTestId("allow-once").click();
  await expect(col("needs").locator(`[data-card="${asks}"]`)).toHaveCount(0, { timeout: 60_000 });

  // Reply to the finished one from its peek.
  await card(done).getByTestId("board-peek").click();
  await peek.getByTestId("peek-reply").fill("Now reply with exactly the word again.");
  await page.keyboard.press("Enter");
  await expect(peek).toContainText("Sent.");
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);

  // Dispatch a task from the board: it shows up without leaving.
  const tag = `dispatched${Date.now()}`;
  await page.getByTestId("board-dispatch").fill(`Reply with exactly the word ${tag}.`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("board-card").filter({ hasText: tag }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/board$/);

  // Phone: one column after another.
  await page.setViewportSize({ width: 390, height: 844 });
  await shoot(page, "board-03-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });

  // Enter opens the selected card; the "new" mark is gone after.
  await expect(col("done").locator(`[data-card="${busy}"]`)).toBeVisible({ timeout: 90_000 });
  await card(busy).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/s/${busy}$`));
  await page.goBack();
  await expect(card(busy).getByTestId("board-unseen")).toHaveCount(0);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
