import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, openPanel, tabInto } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

// Feature: a session in a fresh worktree. The start box starts it on its own
// branch; the model's commit shows in the branch review; a line comment goes
// back to the model as a message; park removes the folder and keeps the work,
// restore brings it back; the main checkout never changes.
test("worktree session and branch review", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  // This spec needs the gate to ask: set it, whatever an earlier spec left behind.
  const prevMode = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "ask" } });
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
    "Run exactly this one Bash command and nothing else: sed -i 's/first line/the first line/' notes.md && echo 'second line' >> notes.md && git add notes.md && git -c user.name=k -c user.email=k@k commit -qm 'Add a line'\nThen reply ok.",
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
  // Opening another line keeps what was typed on this one; the removed
  // line takes a comment of its own (the old file's side).
  const removed = file.locator("tr[data-old]").filter({ hasText: "first line" });
  await removed.hover();
  await removed.getByTestId("comment-line").click();
  await expect(page.getByTestId("comment-input")).toHaveCount(2);
  await expect(page.getByTestId("comment-input").last()).toHaveValue("Say this line in Hebrew instead.");
  await page.getByTestId("comment-input").last().press("Enter");
  await page.getByTestId("comment-input").fill("Keep the old wording.");
  await page.getByTestId("comment-add").click();
  await expect(page.getByTestId("line-comment")).toHaveCount(2);
  await expect(file.locator('[data-testid="line-comment"][data-side="old"]')).toHaveText("Keep the old wording.");
  // Unsent feedback survives a switch to Changes and back, marked as a draft.
  await page.getByTestId("review-note").fill("Two small things.");
  await openPanel(page, "changes");
  await openPanel(page, "review");
  await expect(page.getByTestId("review-draft")).toBeVisible();
  await expect(page.getByTestId("review-comments").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("review-note")).toHaveValue("Two small things.");
  // A page reload keeps the draft too, as the message box keeps its text.
  await page.reload();
  await openPanel(page, "review");
  await expect(page.getByTestId("review-comments").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("review-note")).toHaveValue("Two small things.");
  // An edit made outside Keel shows on Refresh, with no turn.
  writeFileSync(join(worktree.path, "todo.md"), "outside\n");
  await page.getByTestId("branch-refresh").click();
  await expect(page.getByTestId("branch-review").getByTestId("diff-file").filter({ hasText: "todo.md" })).toBeVisible();
  await shoot(page, "wt-03-review");
  await page.getByTestId("review-send").click();
  await expect(page.getByTestId("line-comment")).toHaveCount(0);
  await expect(page.getByTestId("review-draft")).toHaveCount(0);
  const sent = page.getByTestId("user-message").last();
  await expect(sent).toContainText("notes.md:4: Say this line in Hebrew instead.");
  await expect(sent).toContainText("notes.md, removed line 3 (old file): Keep the old wording.");
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

  await request.put("/api/permissions/settings", { data: { default_mode: prevMode } });
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// Line comments by keyboard, on the scripted stand-in (no model turn: the
// branch review reads the folder's uncommitted work). One Tab stop a file; the
// arrows move between lines and Page Down or Page Up between hunks; the
// comment button names the file, the side and the line; Add and Discard give
// the focus back to the line.
test("line comments on a diff by keyboard", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `wt-keys-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(repo, "notes.md"), lines.join("\n") + "\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  // Two hunks far apart: the third line reworded, a line added near the end.
  lines[2] = "the third line";
  lines.splice(26, 0, "a new line");
  writeFileSync(join(repo, "notes.md"), lines.join("\n") + "\n");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", workspace: repo } })).json();

  await page.goto(`/s/${session.id}`);
  await openPanel(page, "review");
  const file = page.getByTestId("branch-review").getByTestId("diff-file").filter({ hasText: "notes.md" });
  const table = file.locator("table");
  const line = (name: string) => file.getByRole("button", { name: `Comment on notes.md, ${name}`, exact: true });
  const key = (k: string) => page.keyboard.press(k);
  await expect(file.locator("tr").filter({ hasText: "@@" })).toHaveCount(2);

  // One Tab stop among the file's lines: its first changed line. The next Tab leaves them.
  await expect(table.locator('[data-testid="comment-line"][tabindex="0"]')).toHaveCount(1);
  await tabInto(page, table);
  await expect(line("old line 3 (removed)")).toBeFocused();
  await key("Tab");
  await expect(table.locator(":focus")).toHaveCount(0);
  await key("Shift+Tab");
  await expect(line("old line 3 (removed)")).toBeFocused();
  // Down a line, then to the next hunk: its added line, with no stop on the lines between.
  await key("ArrowDown");
  await expect(line("new line 3 (added)")).toBeFocused();
  await key("ArrowDown");
  await expect(line("new line 4")).toBeFocused();
  await key("PageDown");
  await expect(line("new line 27 (added)")).toBeFocused();
  await shoot(page, "wt-05-comment-line-by-keyboard");

  // A comment on the added line: Enter opens the box, Enter adds, the focus is back on the line.
  await key("Enter");
  const box = page.getByTestId("comment-input");
  await expect(box).toBeFocused();
  await expect(box).toHaveAccessibleName("Comment on notes.md, new line 27 (added)");
  await page.keyboard.type("Why this line?");
  await key("Enter");
  await expect(page.getByTestId("line-comment")).toHaveText("Why this line?");
  await expect(line("new line 27 (added)")).toBeFocused();
  // Back to the first hunk and its removed line: added with the Add button.
  await key("PageUp");
  await expect(line("old line 3 (removed)")).toBeFocused();
  await key("Enter");
  await page.keyboard.type("Keep the old wording.");
  await key("Tab");
  await expect(page.getByTestId("comment-add")).toBeFocused();
  await key("Enter");
  await expect(file.locator('[data-testid="line-comment"][data-side="old"]')).toHaveText("Keep the old wording.");
  await expect(line("old line 3 (removed)")).toBeFocused();
  // Discarded: nothing is added and the focus is back on the line.
  await key("ArrowDown");
  await key("Enter");
  await page.keyboard.type("never mind");
  await key("Tab");
  await key("Tab");
  await expect(page.getByTestId("comment-discard")).toBeFocused();
  await key("Enter");
  await expect(box).toHaveCount(0);
  await expect(line("new line 3 (added)")).toBeFocused();
  await expect(page.getByTestId("line-comment")).toHaveCount(2);
  await shoot(page, "wt-06-comments-by-keyboard");

  // Each comment is on the side and the line it was made on.
  const draft = await page.evaluate((id) => JSON.parse(localStorage.getItem(`keel.review-draft.${id}`)!), session.id);
  expect(draft.comments.map((c: any) => [c.path, c.side, c.line, c.quote, c.text])).toEqual([
    ["notes.md", "new", 27, "a new line", "Why this line?"],
    ["notes.md", "old", 3, "line 3", "Keep the old wording."],
  ]);
  await request.delete(`/api/sessions/${session.id}`);
});
