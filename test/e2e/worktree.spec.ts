import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, openPanel } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

// Feature: a session in a fresh worktree. The start box starts it on its own
// branch; the model's commit shows in the branch review; a line comment goes
// back to the model as a message; park removes the folder and keeps the work,
// restore brings it back; the main checkout never changes.
test("worktree session and branch review", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `wt-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "# Notes\n\nfirst line\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

  await page.addInitScript(([ws, model]) => {
    localStorage.setItem("keel.newWorkspace", JSON.stringify(ws));
    localStorage.setItem("keel.startInWorktree", "0");
    void model;
  }, [repo, HAIKU]);
  await page.goto("/");
  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("haiku 5.5");
  await page.getByRole("option").first().click();
  await page.getByTestId("start-in-worktree").click();
  await expect(page.getByTestId("start-in-worktree")).toHaveAttribute("aria-checked", "true");
  await shoot(page, "wt-01-start");

  await page.getByTestId("composer").fill(
    "Run exactly this one Bash command and nothing else: echo 'second line' >> notes.md && git add notes.md && git -c user.name=k -c user.email=k@k commit -qm 'Add a line'\nThen reply ok.",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/s\//);
  const id = page.url().split("/s/")[1]!;
  // The session asks before running a command that writes; allow it once.
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByTestId("allow-once").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });

  const { worktree } = await (await request.get(`/api/sessions/${id}/worktree`)).json();
  expect(worktree.branch).toMatch(/^keel\//);
  expect(worktree.commits_ahead).toBe(1);
  expect(readFileSync(join(repo, "notes.md"), "utf8")).not.toContain("second line"); // the main checkout is untouched
  expect(git(repo, "status", "--porcelain")).toBe("");

  // The header shows the branch; its popup offers park, PR and remove.
  await page.getByTestId("worktree-chip").click();
  await expect(page.getByTestId("worktree-popup")).toContainText("1 commit ahead");
  await expect(page.getByTestId("pr-unavailable")).toBeVisible();
  await shoot(page, "wt-02-chip");
  await page.keyboard.press("Escape");

  // Branch review: comment on the new line and send it to the model.
  await openPanel(page, "review");
  const file = page.getByTestId("branch-review").getByTestId("diff-file").filter({ hasText: "notes.md" });
  await expect(file).toBeVisible();
  const added = file.locator("tr").filter({ hasText: "second line" });
  await added.hover();
  await added.getByTestId("comment-line").click();
  await page.getByTestId("comment-input").fill("Say this line in Hebrew instead.");
  await page.getByTestId("comment-add").click();
  await expect(page.getByTestId("line-comment")).toHaveText("Say this line in Hebrew instead.");
  await shoot(page, "wt-03-review");
  await page.getByTestId("review-send").click();
  await expect(page.getByTestId("line-comment")).toHaveCount(0);
  await expect(page.getByTestId("user-message").last()).toContainText("notes.md:4: Say this line in Hebrew instead.");
  await page.getByTestId("stop").click().catch(() => {});
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).running, { timeout: 60_000 }).toBe(false);

  // Park: the folder goes, the work stays on a ref; restore brings it back.
  await page.getByTestId("worktree-chip").click();
  await page.getByTestId("worktree-park").click();
  await expect(page.getByTestId("worktree-chip")).toContainText("parked");
  expect(existsSync(worktree.path)).toBe(false);
  await shoot(page, "wt-04-parked");
  await page.getByTestId("worktree-restore").click();
  await expect(page.getByTestId("worktree-chip")).not.toContainText("parked");
  expect(readFileSync(join(worktree.path, "notes.md"), "utf8")).toContain("second line");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
