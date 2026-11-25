import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: a restore point inside a turn. Every call of a turn that changed files keeps the files as it found
// them; the by-turn list opens a turn into those steps, and "Revert from here" on one puts the files back to
// before that call, through the same preview, protection of outside edits and Undo as a whole turn.
test.skip(!SCRIPTED, "needs the scripted stand-in: it makes the twelve calls");

test("revert from one step of a twelve-step turn, then undo", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `step-${Date.now().toString(36)}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "base.txt"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const calls = Array.from({ length: 12 }, (_, i) => ({ name: "Bash", input: { command: `echo ${i + 1} > f${i + 1}.txt` } }));
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  await expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(1);

  await page.goto(`/s/${session.id}`);
  await openPanel(page, "changes");
  const panel = page.getByTestId("changes-panel");
  await panel.getByTestId("tab-turns").click();
  await panel.getByTestId("turn-checkpoint").locator("summary").click();
  const steps = panel.getByTestId("turn-step");
  await expect(steps).toHaveCount(12);
  await expect(steps.nth(6)).toContainText("echo 7 > f7.txt");
  await shoot(page, "rewind-step-01-steps");

  await steps.nth(6).getByTestId("rewind-step").click();
  const confirm = page.getByTestId("rewind-confirm");
  await expect(confirm).toContainText("before step 7");
  await expect(confirm.getByTestId("rewind-list")).toContainText("f12.txt");
  await expect(confirm.getByTestId("rewind-list")).not.toContainText("f6.txt");
  await shoot(page, "rewind-step-02-confirm");
  await page.getByTestId("rewind-go").click();
  await expect(panel.getByTestId("rewind-done")).toContainText("Reverted 6 files");
  for (let i = 1; i <= 12; i++) expect(existsSync(join(ws, `f${i}.txt`))).toBe(i <= 6);
  expect(readFileSync(join(ws, "base.txt"), "utf8")).toBe("base\n");
  await shoot(page, "rewind-step-03-reverted");

  // The chat is untouched, and the model is told which call the files went back to.
  const r = await (await request.get(`/api/sessions/${session.id}`)).json();
  expect(r.events.filter((e: any) => e.kind === "turn_end")).toHaveLength(1);
  expect(r.events.findLast((e: any) => e.kind === "note" && e.data.kind === "rewind").data.text).toContain("before the call \"Bash echo 7 > f7.txt\"");
  // A step is not a prompt: the chat cannot be taken back to it.
  const step = (await (await request.get(`/api/sessions/${session.id}/checkpoints`)).json()).turns[0].steps[6].id;
  const refused = await request.post(`/api/sessions/${session.id}/rewind`, { data: { step, mode: "both", preview: true } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toContain("a step is not a prompt");

  await panel.getByTestId("rewind-undo").click();
  await expect.poll(() => existsSync(join(ws, "f12.txt"))).toBe(true);
  for (let i = 1; i <= 12; i++) expect(readFileSync(join(ws, `f${i}.txt`), "utf8")).toBe(`${i}\n`);
});
