import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

// Feature: moving a session between its main checkout and a worktree, with
// its uncommitted work, and pruning the worktrees of archived sessions (each
// with its working state saved).
test("handoff and worktree pruning", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `handoff-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "first\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

  // An older worktree session that the owner archives, with unsaved work in it.
  const old = (await (await request.post("/api/worktrees", { data: { workspace: repo, model: HAIKU, title: "old work" } })).json());
  writeFileSync(join(old.worktree.path, "draft.md"), "unsaved\n");
  await request.patch(`/api/sessions/${old.session.id}`, { data: { archived: true } });

  // A session in the main checkout with uncommitted work moves to a worktree.
  const { session } = await (await request.post("/api/sessions", { data: { workspace: repo, model: HAIKU, title: "handoff" } })).json();
  writeFileSync(join(repo, "notes.md"), "first\nsecond\n");
  writeFileSync(join(repo, "new.md"), "new\n");
  await page.goto(`/s/${session.id}`);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Move this session to a new worktree");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("confirm")).toBeVisible();
  await shoot(page, "handoff-01-confirm");
  await page.getByTestId("confirm").getByRole("button", { name: "Move" }).click();
  await expect(page.getByTestId("worktree-chip")).toBeVisible();
  const wt = (await (await request.get(`/api/sessions/${session.id}/worktree`)).json()).worktree;
  expect(wt.dirty).toBe(2);
  expect(readFileSync(join(wt.path, "notes.md"), "utf8")).toBe("first\nsecond\n");
  expect(existsSync(join(wt.path, "new.md"))).toBe(true);
  expect(git(repo, "status", "--porcelain")).toBe(""); // the main checkout is back at its last commit
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.workspace).toBe(wt.path);

  // And back: the main checkout takes the branch and the work.
  await page.getByTestId("worktree-chip").click();
  await shoot(page, "handoff-02-chip");
  await page.getByTestId("handoff-main").click();
  await expect(page.getByTestId("worktree-chip")).toHaveCount(0);
  expect(git(repo, "branch", "--show-current").trim()).toBe(wt.branch);
  expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("first\nsecond\n");
  expect(existsSync(join(repo, "new.md"))).toBe(true);
  expect(existsSync(wt.path)).toBe(false);
  await expect(page.getByText("Moved to the main checkout")).toBeVisible();

  // Pruning in Settings removes the archived session's worktree and saves its work.
  await page.goto("/settings/safety");
  const keep = page.getByTestId("worktree-keep");
  await expect(keep).not.toHaveValue("");
  const before = await keep.inputValue();
  await keep.fill("0");
  await keep.blur();
  await expect.poll(async () => (await (await request.get("/api/worktrees/settings")).json()).keep).toBe(0);
  await page.getByTestId("worktree-prune").click();
  await expect(page.getByTestId("worktree-prune-note")).toContainText("Removed");
  await shoot(page, "handoff-03-prune");
  const pruned = (await (await request.get(`/api/sessions/${old.session.id}/worktree`)).json()).worktree;
  expect(pruned.state).toBe("removed");
  expect(pruned.snapshot_ref).toBeTruthy();
  expect(existsSync(old.worktree.path)).toBe(false);
  await request.put("/api/worktrees/settings", { data: { keep: Number(before) } });

  // Its work comes back on restore.
  await request.post(`/api/sessions/${old.session.id}/worktree/restore`);
  expect(readFileSync(join(old.worktree.path, "draft.md"), "utf8")).toBe("unsaved\n");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
