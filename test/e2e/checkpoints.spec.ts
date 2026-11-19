import { expect, test, type APIRequestContext } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, openPanel } from "./shots.ts";

const turnsDone = async (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);

// Feature: file checkpoints. Each turn that changes files is snapshotted; the
// Changes panel shows the session's diff and each turn's; one file reverts;
// a rewind puts files back as before a turn, keeps a file the owner edited
// outside the session, and can be undone.
test("checkpoints and rewind", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `ckpt-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "a.txt"), "one\n");
  writeFileSync(join(ws, "keep.txt"), "base\n");
  writeFileSync(join(ws, "long.txt"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const say = (text: string) => request.post(`/api/sessions/${session.id}/messages`, { data: { text } });

  await say("Run exactly this one Bash command and nothing else: echo two >> a.txt && echo new > b.txt && sed -i '1s/.*/FIRST/;30s/.*/LAST/' long.txt\nThen reply ok.");
  await turnsDone(request, session.id, 1);
  await say("Run exactly this one Bash command and nothing else: echo three >> a.txt\nThen reply ok.");
  await turnsDone(request, session.id, 2);
  appendFileSync(join(ws, "keep.txt"), "owner edit\n"); // the owner, outside the session
  expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");

  await page.goto(`/s/${session.id}`);
  await openPanel(page, "changes");
  const panel = page.getByTestId("changes-panel");
  await expect(panel.getByTestId("diff-file")).toHaveCount(4);
  await expect(panel.locator('[data-path="keep.txt"]')).toContainText("outside");
  await shoot(page, "ckpt-01-session");

  await panel.getByTestId("tab-turns").click();
  await expect(panel.getByTestId("turn-checkpoint")).toHaveCount(2);
  await panel.getByTestId("turn-checkpoint").last().locator("summary").click();
  await expect(panel.getByTestId("turn-checkpoint").last().getByTestId("diff-file")).toHaveCount(3);
  await shoot(page, "ckpt-02-turns");

  // Revert one hunk of long.txt: its first line comes back, its last stays changed.
  await panel.getByTestId("tab-session").click();
  const long = panel.locator('[data-path="long.txt"]');
  await expect(long.getByTestId("revert-hunk")).toHaveCount(2);
  await long.getByTestId("revert-hunk").first().click();
  await expect(panel.getByTestId("rewind-done")).toContainText("Restored 1 file");
  expect(readFileSync(join(ws, "long.txt"), "utf8")).toMatch(/^line 1\n[\s\S]*\nLAST\n$/);

  // Revert one file (b.txt, created by the session).
  await panel.getByTestId("tab-session").click();
  await panel.locator('[data-path="b.txt"]').getByTestId("revert-file").click();
  await expect(page.getByTestId("rewind-confirm")).toContainText("b.txt");
  await page.getByTestId("rewind-go").click();
  await expect(panel.getByTestId("rewind-done")).toContainText("Restored 1 file");
  expect(existsSync(join(ws, "b.txt"))).toBe(false);

  // Rewind to before turn 2.
  await panel.getByTestId("tab-turns").click();
  await panel.getByTestId("turn-checkpoint").first().getByTestId("rewind-turn").click();
  await page.getByTestId("rewind-go").click();
  // a.txt loses turn 2's line; b.txt (reverted above, there before turn 2) comes back.
  await expect(panel.getByTestId("rewind-done")).toContainText("Restored 3 files, kept 1");
  expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("one\ntwo\n");
  expect(existsSync(join(ws, "b.txt"))).toBe(true);

  // Rewind to before turn 1: the owner's keep.txt is kept by default.
  await panel.getByTestId("turn-checkpoint").last().getByTestId("rewind-turn").click();
  const confirm = page.getByTestId("rewind-confirm");
  await expect(confirm).toContainText("keep.txt");
  await expect(page.getByTestId("include-outside")).not.toBeChecked();
  await shoot(page, "ckpt-03-confirm");
  await page.getByTestId("rewind-go").click();
  await expect(panel.getByTestId("rewind-done")).toContainText("kept 1 changed outside");
  expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("one\n");
  expect(existsSync(join(ws, "b.txt"))).toBe(false);
  expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("base\nowner edit\n");
  await shoot(page, "ckpt-04-rewound");

  // The owner edits a.txt by hand after the rewind; undoing the rewind brings
  // b.txt back and keeps the hand edit (it is outside work since the rewind).
  writeFileSync(join(ws, "a.txt"), "hand\n");
  await panel.getByTestId("rewind-undo").click();
  await expect.poll(() => existsSync(join(ws, "b.txt"))).toBe(true);
  await expect(panel.getByTestId("rewind-done")).toContainText("kept 1 changed outside");
  expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("hand\n");
  expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("base\nowner edit\n");

  // Opting in to restore outside edits covers what the preview showed, not a
  // file that changed after it: late.txt, made while the dialog is open, stays.
  await panel.getByTestId("turn-checkpoint").last().getByTestId("rewind-turn").click();
  await expect(confirm.getByTestId("rewind-list")).toContainText("removed: not there before");
  await page.getByTestId("include-outside").check();
  writeFileSync(join(ws, "late.txt"), "late\n");
  await page.getByTestId("rewind-go").click();
  await expect(panel.getByTestId("rewind-done")).toContainText("Restored");
  expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("base\n");
  expect(readFileSync(join(ws, "late.txt"), "utf8")).toBe("late\n");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
