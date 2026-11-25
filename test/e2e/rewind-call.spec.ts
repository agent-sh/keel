import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, HAIKU, shoot } from "./shots.ts";

// Feature: "Revert from here" on a call of the transcript. A call that changed files has a quiet menu (right
// click on its line): it puts the files back to before that call, through the same preview, protection of
// outside edits and Undo as the by-turn list. A call that changed nothing says so and offers nothing. There
// is no button on any row.
test.skip(!SCRIPTED, "needs the scripted stand-in: it makes the calls");

test("revert from a call of the transcript, then undo; a call that changed nothing offers nothing", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `call-${Date.now().toString(36)}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "base.txt"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const calls = [
    { name: "Bash", input: { command: "echo 1 > f1.txt" } },
    { name: "Bash", input: { command: "echo 2 > f2.txt" } },
    { name: "Bash", input: { command: "echo 3 > f3.txt" } },
    { name: "Bash", input: { command: "cat base.txt" } },
  ];
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  await expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(1);

  await page.goto(`/s/${session.id}`);
  const rows = page.getByTestId("tool-call");
  await expect(rows).toHaveCount(4);
  // Nothing on a row says it: no button of its own.
  await expect(page.getByTestId("call-revert")).toHaveCount(0);

  await rows.nth(1).locator(".k-line").first().click({ button: "right" });
  const menu = page.getByTestId("call-menu");
  await expect(menu.getByTestId("call-revert")).toContainText("2 files");
  await shoot(page, "rewind-call-01-menu");
  await menu.getByTestId("call-revert").click();
  const dialog = page.getByTestId("call-revert-dialog");
  await expect(dialog.getByTestId("call-revert-files")).toContainText("f3.txt");
  await expect(dialog.getByTestId("call-revert-files")).not.toContainText("f1.txt");
  await shoot(page, "rewind-call-02-ask");
  await dialog.getByTestId("call-revert-go").click();
  await expect(dialog).toContainText("Reverted 2 files");
  expect(existsSync(join(ws, "f1.txt"))).toBe(true);
  expect(existsSync(join(ws, "f2.txt"))).toBe(false);
  expect(existsSync(join(ws, "f3.txt"))).toBe(false);
  await shoot(page, "rewind-call-03-done");
  // The chat is untouched.
  const r = await (await request.get(`/api/sessions/${session.id}`)).json();
  expect(r.events.filter((e: any) => e.kind === "turn_end")).toHaveLength(1);

  await dialog.getByTestId("call-revert-undo").click();
  await expect.poll(() => existsSync(join(ws, "f3.txt"))).toBe(true);
  expect(readFileSync(join(ws, "f2.txt"), "utf8")).toBe("2\n");

  // A call that changed no files: the menu says so.
  await rows.nth(3).locator(".k-line").first().click({ button: "right" });
  await expect(page.getByTestId("call-revert-none")).toContainText("changed no files");
  await expect(page.getByTestId("call-revert")).toHaveAttribute("aria-disabled", "true");
  await shoot(page, "rewind-call-04-none");
});
