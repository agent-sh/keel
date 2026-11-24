import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "./isolate.ts";
import { openPanel, scriptBash, shoot } from "./shots.ts";

// Feature: words selected in the conversation offer Quote and Comment. Quote puts them in the message
// box as a quote block. Comment takes one line and sends "On <where>:", the quote and the line as the
// owner's own message: Enter sends it (it steers a turn that works), the queue key queues it. Alt+Q and
// Alt+C do the same from the keyboard after a selection. A selection in a diff names its file and lines.
const STAND_IN = "scripted:stand-in";
const SAID = "The cache is warmed before the first request. Then the loop starts.";

// What the page selected: its words, by a triple click on the paragraph (the pointer the owner uses).
const pick = (page: Page) => page.getByTestId("assistant-text").first().locator("p").first().click({ clickCount: 3 });

test("a selection is quoted or commented, and a comment steers or queues like a typed message", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `selection-${Date.now()}`);
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src/limits.ts"), Array.from({ length: 12 }, (_, i) => `export const limit${i + 1} = ${i + 1};`).join("\n") + "\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: its replies are the spec's own words");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, workspace: ws } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const events = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events as { kind: string; data: any }[];
  const phase = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase as string;
  const prompts = async (words: string) => (await events()).filter((e) => e.kind === "user" && String(e.data.text).includes(words));
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  const box = page.getByTestId("composer");
  const bar = page.getByTestId("selection-bar");

  await box.fill(`script:say ${SAID}`);
  await box.press("Enter");
  await expect(page.getByTestId("assistant-text").first()).toHaveText(SAID, { timeout: 30_000 });
  await expect.poll(phase, { timeout: 30_000 }).toBe("idle");
  // Nothing selected, nothing offered.
  await expect(bar).toHaveCount(0);

  // Quote: the words go in the box as a quote block, the box has the keyboard.
  await pick(page);
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-mode", "pick");
  await shoot(page, "selection-01-offer");
  await page.getByTestId("selection-quote").click();
  await expect(box).toHaveValue(`> ${SAID}\n\n`);
  await expect(box).toBeFocused();
  await expect(bar).toHaveCount(0);
  await box.fill("");

  // A turn that works: its command is slow.
  await box.fill(scriptBash("sleep 8; echo slow-done"));
  await box.press("Enter");
  await expect.poll(phase, { timeout: 30_000 }).toBe("working");

  // Comment from the keyboard (Alt+C after the selection), queued with the queue key.
  await pick(page);
  await expect(bar).toBeVisible();
  await page.keyboard.press("Alt+c");
  const line = page.getByTestId("selection-comment");
  await expect(line).toBeFocused();
  await expect(line).toHaveAttribute("placeholder", "Comment on the reply");
  await line.fill("Is this the order the code runs in? (queued)");
  await shoot(page, "selection-02-comment");
  await line.press("Control+Shift+Enter");
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId("queue-item")).toHaveCount(1);
  await expect(page.getByTestId("queue-item")).toContainText("queued");

  // Comment with Enter while the turn works: it steers, as a typed message does.
  await pick(page);
  await page.getByTestId("selection-comment-open").click();
  await expect(page.getByTestId("selection-send")).toHaveText("Send now");
  await page.getByTestId("selection-comment").fill("Why before the first request? (steer)");
  await page.getByTestId("selection-comment").press("Enter");
  await expect(bar).toHaveCount(0);

  // The messages the model gets are ordinary messages of the owner's: where, quote, comment.
  const message = (c: string) => `On the reply:\n> ${SAID}\n\n${c}`;
  await expect.poll(async () => (await prompts("(steer)")).length, { timeout: 30_000 }).toBe(1);
  expect((await prompts("(steer)"))[0]!.data.text).toBe(message("Why before the first request? (steer)"));
  await expect(page.getByTestId("origin-steer")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("origin-queued")).toBeVisible({ timeout: 90_000 });
  expect((await prompts("(queued)"))[0]!.data.text).toBe(message("Is this the order the code runs in? (queued)"));
  await expect.poll(phase, { timeout: 90_000 }).toBe("idle");
  await shoot(page, "selection-03-sent");

  // A diff: the selection names the file and its lines.
  const turns = async () => (await events()).filter((e) => e.kind === "turn_end").length;
  const before = await turns();
  const sed = "sed -i '5s/= 5;/= 50;/' src/limits.ts";
  await box.fill(scriptBash(sed));
  await box.press("Enter");
  await expect.poll(turns, { timeout: 60_000 }).toBe(before + 1);
  await openPanel(page, "changes");
  const added = page.getByTestId("side-panel").locator('tr[data-kind="add"]').first();
  await expect(added).toBeVisible({ timeout: 30_000 });
  await added.locator("td").last().click({ clickCount: 3 });
  await expect(bar).toBeVisible();
  await page.getByTestId("selection-comment-open").click();
  await expect(page.getByTestId("selection-comment")).toHaveAttribute("placeholder", /^Comment on src\/limits\.ts, (lines? 5|line 5 to \d+)/);
  await shoot(page, "selection-04-diff");
  await page.getByTestId("selection-comment").press("Escape");
  await expect(bar).toHaveCount(0);

  // A phone: the offer is under the words, inside the window.
  await page.getByLabel("Close the panel").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await pick(page);
  await expect(bar).toBeVisible();
  const [b, w] = await Promise.all([bar.boundingBox(), page.getByTestId("assistant-text").first().boundingBox()]);
  expect(b!.x).toBeGreaterThanOrEqual(0);
  expect(b!.x + b!.width).toBeLessThanOrEqual(390);
  expect(b!.y).toBeGreaterThanOrEqual(w!.y + w!.height - 2);
  await shoot(page, "selection-05-phone");
  await page.getByTestId("selection-comment-open").click();
  await shoot(page, "selection-06-phone-comment");
});
