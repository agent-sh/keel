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
  // One command a turn: a real model is asked for it in words, the scripted stand-in is handed the call.
  const run = (command: string) => request.post(`/api/sessions/${session.id}/messages`, {
    data: { text: HAIKU.startsWith("scripted:") ? `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}` : `Run exactly this one Bash command and nothing else: ${command}\nThen reply ok.` },
  });

  await run("echo two >> a.txt && echo new > b.txt && sed -i '1s/.*/FIRST/;30s/.*/LAST/' long.txt");
  await turnsDone(request, session.id, 1);
  await run("echo three >> a.txt");
  await turnsDone(request, session.id, 2);
  appendFileSync(join(ws, "keep.txt"), "owner edit\n"); // the owner, outside the session
  expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");

  await page.goto(`/s/${session.id}`);
  await openPanel(page, "changes");
  const panel = page.getByTestId("changes-panel");
  await expect(panel.getByTestId("diff-file")).toHaveCount(4);
  await expect(panel.locator('[data-testid="diff-file"][data-path="keep.txt"]')).toContainText("outside");
  // A list of the changed files stands above the diffs: a path jumps to its diff, each row has its own Revert.
  const list = panel.getByTestId("changes-files");
  await expect(list.getByTestId("changes-file")).toHaveCount(4);
  await expect(list.getByRole("button", { name: /^Revert / })).toHaveCount(4);
  await expect(list.getByRole("button", { name: "Revert long.txt", exact: true })).toHaveText("Revert");
  await shoot(page, "ckpt-01-session");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list).toBeInViewport();
  await shoot(page, "ckpt-01-session-phone");
  // On a short window the last file's diff is below the fold until its path in the list is clicked.
  await page.setViewportSize({ width: 1920, height: 560 });
  const longHead = panel.locator('[data-testid="diff-file"][data-path="long.txt"] header');
  await expect(longHead).not.toBeInViewport();
  await list.getByRole("button", { name: "Show the diff of long.txt" }).click();
  await expect(longHead).toBeInViewport();
  await page.setViewportSize({ width: 1920, height: 1040 });

  await panel.getByTestId("tab-turns").click();
  await expect(panel.getByTestId("turn-checkpoint")).toHaveCount(2);
  await panel.getByTestId("turn-checkpoint").last().locator("summary").click();
  await expect(panel.getByTestId("turn-checkpoint").last().getByTestId("diff-file")).toHaveCount(3);
  await shoot(page, "ckpt-02-turns");

  // Revert one hunk of long.txt: its first line comes back, its last stays changed.
  await panel.getByTestId("tab-session").click();
  const long = panel.locator('[data-testid="diff-file"][data-path="long.txt"]');
  await expect(long.getByTestId("revert-hunk")).toHaveCount(2);
  await long.getByTestId("revert-hunk").first().click();
  await expect(panel.getByTestId("rewind-done")).toContainText("Reverted 1 file");
  expect(readFileSync(join(ws, "long.txt"), "utf8")).toMatch(/^line 1\n[\s\S]*\nLAST\n$/);

  // Revert one file (b.txt, created by the session) while another session's
  // background command still runs in the folder: its late write would undo
  // the restore, so the owner is asked to stop it first.
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  let other: string | undefined;
  if (models.some((m) => m.id === "scripted:stand-in")) {
    other = (await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in", title: "Writer" } })).json()).session.id;
    await request.put(`/api/sessions/${other}/permissions`, { data: { mode: "full-auto" } });
    await request.post(`/api/sessions/${other}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "sleep 120; echo late > b.txt", run_in_background: true } }])}` } });
    await turnsDone(request, other!, 1);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${other}/jobs`)).json()).jobs.filter((j: any) => j.state === "running" || j.running).length).toBe(1);
  }
  await panel.getByTestId("tab-session").click();
  await panel.getByTestId("changes-files").getByRole("button", { name: "Revert b.txt", exact: true }).click();
  // One verb, Revert: the dialog asks it and its button says it, and no file is called restored before anything happened.
  const asked = page.getByTestId("rewind-confirm");
  await expect(asked.getByRole("heading")).toHaveText("Revert b.txt?");
  await expect(asked.getByTestId("rewind-list")).toContainText("b.txt");
  await expect(asked).not.toContainText(/restor/i);
  await shoot(page, "ckpt-01b-revert-file");
  await asked.getByRole("button", { name: "Revert", exact: true }).click();
  if (other) {
    const stop = page.getByTestId("confirm");
    await expect(stop).toContainText("sleep 120");
    expect(existsSync(join(ws, "b.txt"))).toBe(true);
    await shoot(page, "ckpt-02b-stop-commands");
    await stop.getByRole("button", { name: "Stop and revert" }).click();
  }
  await expect(panel.getByTestId("rewind-done")).toContainText("Reverted 1 file");
  expect(existsSync(join(ws, "b.txt"))).toBe(false);
  if (other) await request.delete(`/api/sessions/${other}`);

  // Revert the files to before turn 2.
  await panel.getByTestId("tab-turns").click();
  await panel.getByTestId("turn-checkpoint").first().getByRole("button", { name: "Revert from here", exact: true }).click();
  const confirm = page.getByTestId("rewind-confirm");
  await expect(confirm).toHaveAccessibleDescription(/This does not rewind chat history for this session or its child sessions\./);
  await confirm.getByRole("button", { name: "Revert", exact: true }).click();
  // a.txt loses turn 2's line; b.txt (reverted above, there before turn 2) comes back.
  await expect(panel.getByTestId("rewind-done")).toContainText("Reverted 3 files, kept 1");
  expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("one\ntwo\n");
  expect(existsSync(join(ws, "b.txt"))).toBe(true);
  await expect(page.getByTestId("turn-end")).toHaveCount(2);

  // Rewind to before turn 1: the owner's keep.txt is kept by default, and
  // long.txt, which the owner edited elsewhere since, loses only the turn's
  // change (a three-way merge keeps the owner's line).
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(ws, "long.txt"), readFileSync(join(ws, "long.txt"), "utf8").replace("line 15\n", "owner 15\n"));
  await panel.getByTestId("turn-checkpoint").last().getByTestId("rewind-turn").click();
  await expect(confirm).toContainText("keep.txt");
  await expect(confirm.getByTestId("rewind-list")).toContainText("the turn's change taken back, the later edit kept");
  await expect(page.getByTestId("include-outside")).not.toBeChecked();
  await shoot(page, "ckpt-03-confirm");
  await page.getByTestId("rewind-go").click();
  await expect(panel.getByTestId("rewind-done")).toContainText("kept 1 changed outside");
  expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("one\n");
  expect(existsSync(join(ws, "b.txt"))).toBe(false);
  expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("base\nowner edit\n");
  expect(readFileSync(join(ws, "long.txt"), "utf8")).toBe(original.map((l) => (l === "line 15" ? "owner 15" : l)).join("\n") + "\n");
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
  await expect(confirm.getByTestId("rewind-list")).toContainText("deleted: not there before");
  await page.getByTestId("include-outside").check();
  writeFileSync(join(ws, "late.txt"), "late\n");
  await page.getByTestId("rewind-go").click();
  await expect(panel.getByTestId("rewind-done")).toContainText("Reverted");
  expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("base\n");
  expect(readFileSync(join(ws, "late.txt"), "utf8")).toBe("late\n");

  // The session moves to another folder: its turns still read, each named by
  // the folder it ran in, and none is rewound into the new folder.
  const moved = `${ws}-moved`;
  mkdirSync(moved);
  expect((await request.post(`/api/sessions/${session.id}/folder`, { data: { cwd: moved, copy_files: true } })).status()).toBe(200);
  await page.reload();
  await openPanel(page, "changes");
  await panel.getByTestId("tab-turns").click();
  await expect(panel.getByTestId("turn-checkpoint")).toHaveCount(2);
  await expect(panel.getByTestId("turn-elsewhere")).toHaveCount(2);
  await expect(panel.getByTestId("rewind-turn")).toHaveCount(0);
  await panel.getByTestId("turn-checkpoint").first().locator("summary").click();
  await expect(panel.getByTestId("turn-checkpoint").first().getByTestId("diff-file")).toHaveCount(1);
  await shoot(page, "ckpt-05-moved");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
