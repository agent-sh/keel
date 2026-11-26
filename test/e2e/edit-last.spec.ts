import { expect, test, type Page } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { shoot } from "./shots.ts";

// Feature: Up in an empty message box opens the last prompt in its edit box,
// while its reply has not started and after its turn ended or was stopped, and
// Enter there sends it as a new version (the edit path). The keyboard goes
// back to the message box. Up with words in the box, or once a running reply
// started, opens nothing. On the scripted stand-in.
const STAND_IN = "scripted:stand-in";
const WS = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/edit-last`;

const focused = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? "");

test("Up in an empty message box edits the last prompt", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: its replies wait on a file the spec writes");
  mkdirSync(WS, { recursive: true });
  const tag = `up${Date.now().toString(36)}`;
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Up edits ${tag}`, workspace: WS } })).json();
  const phase = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase as string;
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  const box = page.getByTestId("composer");
  const edit = page.getByTestId("edit-box");

  // A turn whose reply has not started: Up opens its prompt, and Enter stops the turn and sends the new words.
  const first = `script:silent ${WS}/never-${tag}`;
  await box.fill(first);
  await box.press("Enter");
  await expect.poll(phase, { timeout: 30_000 }).toBe("working");
  // The daemon can be working before this tab receives the prompt event.
  await expect(page.getByTestId("user-message").last()).toContainText(first);
  await expect(box).toHaveValue("");
  await box.press("ArrowUp");
  await expect(edit).toBeFocused();
  await expect(edit).toHaveValue(first);
  expect(await edit.evaluate((t: HTMLTextAreaElement) => [t.selectionStart, t.selectionEnd])).toEqual([first.length, first.length]);
  await expect(page.getByTestId("edit-note")).toHaveText("Stops the turn, then sends this as a new version.");
  await shoot(page, "edit-last-01-working");
  await edit.fill(`script:say Second version (${tag})`);
  await edit.press("Enter");
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2", { timeout: 30_000 });
  await expect(page.getByTestId("assistant-text").last()).toHaveText(`Second version (${tag})`, { timeout: 30_000 });
  await expect.poll(() => focused(page)).toBe("composer");

  // After a turn that ended: Up opens the prompt again; Escape closes it and the keyboard is back in the box.
  await expect.poll(phase, { timeout: 30_000 }).toBe("idle");
  await box.press("ArrowUp");
  await expect(edit).toHaveValue(`script:say Second version (${tag})`);
  await edit.press("Escape");
  await expect(edit).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe("composer");

  // Words in the box: Up is the box's own key.
  await box.fill("a draft");
  await box.press("ArrowUp");
  await expect(edit).toHaveCount(0);
  await box.fill("");

  // A running reply that started: Up opens nothing.
  await box.fill(`script:hold ${WS}/gate-${tag}`);
  await box.press("Enter");
  await expect(page.getByText("The first half, streamed before the hold.")).toBeVisible({ timeout: 30_000 });
  await box.press("ArrowUp");
  await expect(edit).toHaveCount(0);
  writeFileSync(`${WS}/gate-${tag}`, "");
  await expect.poll(phase, { timeout: 30_000 }).toBe("idle");

  // A turn the owner stopped: Up opens its prompt, Enter sends the new words as its second version.
  const stopped = `script:silent ${WS}/never-again-${tag}`;
  await box.fill(stopped);
  await box.press("Enter");
  await expect.poll(phase, { timeout: 30_000 }).toBe("working");
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("turn-reason").last()).toHaveText("Stopped by you", { timeout: 30_000 });
  await box.focus();
  await box.press("ArrowUp");
  await expect(edit).toHaveValue(stopped);
  await expect(page.getByTestId("edit-note")).toHaveText("Sends as a new version; the current one stays as a branch.");
  // The end of the words, where the caret is, is in view.
  expect(await edit.evaluate((t: HTMLTextAreaElement) => t.scrollHeight - t.scrollTop - t.clientHeight)).toBeLessThan(2);
  await shoot(page, "edit-last-02-stopped");
  await edit.fill(`script:say Third version (${tag})`);
  await edit.press("Enter");
  await expect(page.getByTestId("branch-pos").last()).toHaveText("2/2", { timeout: 30_000 });
  await expect(page.getByTestId("assistant-text").last()).toHaveText(`Third version (${tag})`, { timeout: 30_000 });

  // The key is on the shortcut sheet.
  await box.focus();
  await page.keyboard.press("ControlOrMeta+/");
  const row = page.getByTestId("shortcuts").getByTestId("shortcut-row").filter({ hasText: "Edit the last prompt, from an empty box" });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  await shoot(page, "edit-last-03-shortcuts");
});
