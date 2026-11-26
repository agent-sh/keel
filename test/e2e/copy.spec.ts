import { expect, test } from "./isolate.ts";
import { openFolds, shoot, WORKBENCH } from "./shots.ts";

// Feature: copy. One copy button (CopyButton.tsx) on every message (the raw
// markdown of a reply, the prompt as typed), every code block, a tool call's
// command, input, output, written content and path, with a Copied state. It
// copies also where the page has no async clipboard (plain http on a LAN or
// tailnet address): through a hidden text field.
const MODEL = "scripted:stand-in";
test.use({ storageState: WORKBENCH, viewport: { width: 1700, height: 980 } });

test("copy what a session shows, also without the async clipboard", async ({ page, context, request }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title: `Copy ${Date.now()}` } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  const file = `${s.workspace}/copy-note-${Date.now()}.txt`;
  const done = async (n: number) => expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(n);
  const prompt = `script:calls ${JSON.stringify([{ name: "Write", input: { file_path: file, content: "alpha\nbeta\n" } }, { name: "Bash", input: { command: "echo copied-output" } }])}`;
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: prompt } });
  await done(1);
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: "Show the parser. script:render" } });
  await done(2);

  await page.goto(`/s/${s.id}`);
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  const calls = page.getByTestId("tool-call");
  // (The calls are of the turn before the last message: its run is one line, opened here.)
  await openFolds(page);
  await expect(calls).toHaveCount(2);

  // A tool call: the command and its output, the path and the content written.
  await calls.nth(1).getByRole("button").first().click();
  await calls.nth(1).getByTestId("terminal").hover();
  await calls.nth(1).getByTestId("copy-command").click();
  expect(await clip()).toBe("echo copied-output");
  await expect(calls.nth(1).getByTestId("copy-command")).toHaveAttribute("data-copied", "true");
  await shoot(page, "copy-01-command-copied");
  await calls.nth(1).getByTestId("copy-output").click();
  expect((await clip()).trim()).toBe("copied-output");
  await calls.nth(0).getByRole("button").first().click();
  await calls.nth(0).getByTestId("copy-path").click();
  expect(await clip()).toBe(file);
  await calls.nth(0).getByTestId("copy-content").click();
  expect(await clip()).toBe("alpha\nbeta\n");

  // A code block, the reply as markdown, the prompt as typed.
  await page.locator(".code-block .code-copy").first().click();
  expect(await clip()).toContain("export function parse(input: string): string[] {");
  // The reply selected and copied as the browser copies it: the code block's words, not its head's
  // language and its Copy button.
  await page.evaluate(() => {
    const block = document.querySelector(".code-block")!.closest('[data-testid="assistant-text"]')!;
    getSelection()!.selectAllChildren(block);
  });
  await page.keyboard.press("Control+c");
  await expect.poll(clip).toContain("export function parse(input: string): string[] {");
  const drawn = await clip();
  expect(drawn).not.toMatch(/^\s*Cop(y|ied)\s*$/m);
  expect(drawn).not.toMatch(/^\s*ts\s*$/m);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await page.getByTestId("copy-reply").last().click();
  const reply = await clip();
  expect(reply).toContain("## The parser, moved");
  expect(reply).toContain("| File | Change |");
  await page.getByTestId("user-message").last().hover();
  await page.getByTestId("user-message").last().getByTestId("copy-message").click();
  expect(await clip()).toBe("Show the parser. script:render");
  await shoot(page, "copy-02-reply-and-message");

  // Without the async clipboard (as on a plain http address): the same buttons still copy.
  const bare = await context.newPage();
  await bare.addInitScript(() => Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined }));
  await bare.setViewportSize({ width: 1700, height: 980 });
  await bare.goto(`/s/${s.id}`);
  await bare.getByTestId("copy-reply").last().click();
  await expect(bare.getByTestId("copy-reply").last()).toHaveAttribute("data-copied", "true");
  expect(await clip()).toContain("## The parser, moved");
  await bare.locator(".code-block .code-copy").first().click();
  await expect(bare.locator(".code-block .code-copy").first()).toHaveAttribute("data-copied", "");
  expect(await clip()).toContain("export function parse");
  await bare.close();

  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
  await request.delete(`/api/sessions/${s.id}`);
});

// A copy the browser refuses both ways (no async clipboard, the hidden field
// refused too) says so on the button, in view and to assistive technology,
// never shows Copied, and is recorded once.
test("a failed copy says so", async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title: `Copy fails ${Date.now()}` } })).json()).session;
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: "Show the parser. script:render" } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);
  // The record of this failure counts how many times it happened.
  const recorded = async () => Number(((await (await request.get("/api/errors")).json()).errors as { message: string; count: number }[]).find((e) => /refused to copy/.test(e.message))?.count ?? 0);
  const before = await recorded();

  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
    document.execCommand = () => false;
    // Whatever the button said while it was pressed, for the "never Copied" check.
    (window as any).said = [];
    new MutationObserver((list) => {
      for (const m of list) {
        const el = m.target instanceof Element ? m.target : m.target.parentElement;
        const b = el?.closest("button");
        if (b) (window as any).said.push(`${b.getAttribute("aria-label")}|${b.getAttribute("title") ?? b.getAttribute("data-tip")}|${b.textContent}|${b.hasAttribute("data-copied")}`);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "title", "data-tip", "data-copied"] });
  });
  await page.goto(`/s/${s.id}`);
  const reply = page.getByTestId("copy-reply").last();
  await reply.focus();
  await page.keyboard.press("Enter");
  await expect(reply).toHaveAttribute("data-failed", "true");
  await expect(reply).toHaveAccessibleName("Copy failed");
  await expect(reply).not.toHaveAttribute("data-copied", /.*/);
  await expect(page.getByRole("tooltip")).toHaveText("Copy failed");
  await expect(page.getByRole("alert")).toHaveText("Copy failed: the browser refused the clipboard.");
  await shoot(page, "copy-03-failed");
  // Recorded once, and the button goes back to Copy.
  await expect.poll(recorded).toBe(before + 1);
  // A second failure before the first one's time is up: its words stay their whole time.
  await page.keyboard.press("Enter");
  await expect.poll(recorded).toBe(before + 2);
  await page.waitForTimeout(2000);
  await expect(reply).toHaveAttribute("data-failed", "true");
  await expect(page.getByRole("tooltip")).toHaveText("Copy failed");
  await expect(reply).toHaveAccessibleName("Copy the reply", { timeout: 6000 });
  await expect(reply).not.toHaveAttribute("data-failed", /.*/);

  // A code block's own button says it in its label.
  const code = page.locator(".code-block .code-copy").first();
  await code.focus();
  await page.keyboard.press("Enter");
  await expect(code).toHaveText("Copy failed");
  await expect(code).toHaveAttribute("data-failed", "");
  // Its glyph is the cross and its name the same words, as on the shared button.
  await expect(code).toHaveAccessibleName("Copy failed");
  await expect(code.locator("svg rect")).toHaveCount(0);
  await shoot(page, "copy-04-code-failed");
  await page.keyboard.press("Enter");
  await expect.poll(recorded).toBe(before + 4);
  await page.waitForTimeout(2000);
  await expect(code).toHaveText("Copy failed");
  await expect(code).toHaveText("Copy", { timeout: 6000 });
  await expect(code).toHaveAccessibleName("Copy code");
  await expect(code.locator("svg rect")).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(await recorded()).toBe(before + 4);

  // A copy with no failed state of its own to show says it too, in view and
  // to assistive technology: a menu item (gone by then) at the menu's button,
  // and a command with no control at all (the shortcut) under the top of the page.
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("", { timeout: 8000 });
  await page.getByTestId("session-menu").click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  await expect(page.getByRole("tooltip")).toHaveText("Copy failed");
  await expect(page.locator(".k-tip[data-free]")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("Copy failed: the browser refused the clipboard.");
  await expect.poll(recorded).toBe(before + 5);
  await shoot(page, "copy-05-menu-failed");
  await page.keyboard.press("ControlOrMeta+Shift+C");
  await expect(page.locator(".k-tip[data-free]")).toHaveText("Copy failed");
  await expect.poll(recorded).toBe(before + 6);
  await shoot(page, "copy-06-command-failed");
  expect(await page.evaluate(() => (window as any).said.filter((x: string) => /Copied|\|true$/.test(x)))).toEqual([]);
  await request.delete(`/api/sessions/${s.id}`);
});

// A code block whose fence carries a long unbroken label, on a small phone:
// only the label is cut short, Copy stays whole on the screen and copies the
// code, not the fence. The reply is the stand-in's, exported as a Keel file,
// given the long label and imported again.
test("code copy stays in view under a long fence label", async ({ page, context, request }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title: `Fence ${Date.now()}`, text: "Show the parser. script:render" } })).json()).session;
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);
  const LABEL = "typescript-with-a-very-long-unbroken-fence-label-that-keeps-going-and-going";
  const file = await (await request.get(`/api/sessions/${s.id}/export?format=jsonl`)).text();
  expect(file).toContain("```ts");
  const made = await (await request.post("/api/sessions/import", { data: file.replaceAll("```ts", "```" + LABEL), headers: { "content-type": "application/x-ndjson" } })).json();
  const id = made.session.id as string;

  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/s/${id}`);
  const block = page.locator(`[data-station="${id}"] .code-block`).first();
  const copy = block.locator(".code-copy");
  await block.scrollIntoViewIfNeeded();
  await expect(block).toContainText("export function parse");
  // Copy is whole inside its block and on the screen; the label is what gives way.
  await expect(copy).toBeInViewport({ ratio: 1 });
  const fit = await block.evaluate((el) => {
    const b = el.getBoundingClientRect(), c = el.querySelector(".code-copy")!.getBoundingClientRect(), l = el.querySelector(".code-head > span")!;
    const h = el.querySelector(".code-head")!.getBoundingClientRect(), lr = l.getBoundingClientRect();
    return { inside: c.left >= b.left && c.right <= b.right, right: b.right, spills: lr.top < h.top - 1 || lr.bottom > h.bottom + 1, cut: l.scrollWidth > l.clientWidth, label: l.textContent, title: l.getAttribute("title") };
  });
  expect(fit.inside).toBe(true);
  expect(fit.right).toBeLessThanOrEqual(320);
  // One line in the head: the label does not run on over the code under it.
  expect(fit.spills).toBe(false);
  expect(fit.cut).toBe(true);
  expect(fit.label).toBe(LABEL);
  expect(fit.title).toBe(LABEL);
  await copy.click();
  await expect(copy).toHaveAttribute("data-copied", "");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("export function parse(input: string): string[] {");
  expect(copied).not.toContain(LABEL);
  expect(copied).not.toContain("```");
  await shoot(page, "copy-03-long-fence-label-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });
  await expect(copy).toBeInViewport({ ratio: 1 });
  await shoot(page, "copy-04-long-fence-label");

  for (const x of [s.id, id]) await request.delete(`/api/sessions/${x}`);
});
