import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: copy. One copy button (CopyButton.tsx) on every message (the raw
// markdown of a reply, the prompt as typed), every code block, a tool call's
// command, input, output, written content and path, with a Copied state. It
// copies also where the page has no async clipboard (plain http on a LAN or
// tailnet address): through a hidden text field.
const MODEL = "scripted:stand-in";
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1700, height: 980 } });

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
  await expect(reply).toHaveAccessibleName("Copy the reply", { timeout: 6000 });
  await expect(reply).not.toHaveAttribute("data-failed", /.*/);

  // A code block's own button says it in its label.
  const code = page.locator(".code-block .code-copy").first();
  await code.focus();
  await page.keyboard.press("Enter");
  await expect(code).toHaveText("Copy failed");
  await expect(code).toHaveAttribute("data-failed", "");
  await shoot(page, "copy-04-code-failed");
  await expect(code).toHaveText("Copy", { timeout: 6000 });
  await expect.poll(recorded).toBe(before + 2);
  await page.waitForTimeout(500);
  expect(await recorded()).toBe(before + 2);
  expect(await page.evaluate(() => (window as any).said.filter((x: string) => /Copied|\|true$/.test(x)))).toEqual([]);
  await request.delete(`/api/sessions/${s.id}`);
});
