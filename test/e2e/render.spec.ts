import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { shoot } from "./shots.ts";

// Feature: how a reply reads. While it streams, its finished blocks stay put
// and their code is colored before the reply ends; TeX becomes math (prices
// and $HOME stay text); a file the reply names in inline code links to the
// Files panel at its line, only when the file is in the session's folder; a
// command's output keeps its colors on the tool card; the tab's title counts
// what needs the owner.
const STAND_IN = "scripted:stand-in";

test("render: streaming blocks, math, file links, colored output", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/render-${Date.now().toString(36)}`;
  mkdirSync(`${ws}/notes`, { recursive: true });
  writeFileSync(`${ws}/notes/plan.md`, "# Plan\nMove the parser.\nKeep the surface.\n");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Render", workspace: ws } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });

  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill("script:render");
  await page.keyboard.press("Enter");

  // Streaming: the code block finished first is colored while the reply goes on.
  const draft = page.getByTestId("draft");
  await expect(draft.locator(".code-block code[data-hl] .th-keyword").first()).toBeVisible({ timeout: 15_000 });
  await expect(draft.locator(".prose-keel")).toHaveAttribute("aria-busy", "true");
  expect(await draft.locator(".prose-keel").textContent()).not.toContain("```");
  await shoot(page, "render-01-streaming");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });

  const reply = page.getByTestId("assistant-text").last();
  // Math: inline and display become MathML; dollars that are not math stay text.
  await expect(reply.locator(".math[data-done] math")).toHaveCount(2);
  await expect(reply.locator('div.math math[display="block"]')).toHaveCount(1);
  await expect(reply).toContainText("$5 and $10, and so does $HOME");
  await expect(reply.locator("table tr")).toHaveCount(3);

  // File links: the file that exists links, the ones that do not stay code.
  const link = reply.locator('code.k-fileref[data-rel="notes/plan.md"]');
  await expect(link).toHaveAttribute("role", "link");
  await expect(reply.locator('code.k-fileref[data-path="src/parse.ts"]')).toHaveAttribute("data-checked", "1");
  await expect(reply.locator('code.k-fileref[data-path="src/parse.ts"]')).not.toHaveAttribute("data-rel", /.*/);
  await shoot(page, "render-02-reply");
  await link.click();
  const view = page.getByTestId("file-view");
  await expect(view).toContainText("notes/plan.md");
  await expect(view.getByTestId("file-line")).toBeVisible();
  await shoot(page, "render-03-file-at-line");

  // A command's colors on its card.
  const calls = [{ name: "Bash", input: { command: "printf '\\033[31mFAIL\\033[0m one\\n\\033[32mok\\033[0m two\\n'" } }];
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify(calls)}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
  const card = page.getByTestId("tool-call").last();
  await card.locator("button").first().click();
  const red = card.getByTestId("terminal").locator("span", { hasText: "FAIL" });
  await expect(red).toBeVisible();
  const color = await red.evaluate((el) => getComputedStyle(el).color);
  const plain = await card.getByTestId("terminal").locator("pre").last().evaluate((el) => getComputedStyle(el).color);
  expect(color).not.toBe(plain);
  const out = card.getByTestId("terminal").locator("pre").last();
  await expect(out).toContainText("FAIL one\nok two");
  expect(await out.textContent()).not.toContain("\x1b");
  await shoot(page, "render-04-colored-output");

  // The tab says what needs the owner: an approval waiting puts a count in front of the title.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  const ask = [{ name: "Bash", input: { command: "echo export A=1 > .envrc" } }];
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify(ask)}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("approval")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveTitle(/^\(\d+\) Render - Keel$/);
  await expect(page.locator('link[rel="icon"][data-keel]')).toHaveAttribute("data-state", "need");
  await page.getByTestId("approval").getByRole("button", { name: /Allow once/i }).click();
  await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 30_000 });
  await expect(page).toHaveTitle("Render - Keel");

  await request.delete(`/api/sessions/${session.id}`);
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
