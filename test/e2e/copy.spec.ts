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
