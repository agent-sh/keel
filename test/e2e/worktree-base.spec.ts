import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// (`day`: the commit's date, so the branches' recency is not left to the clock.)
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...(day ? { GIT_COMMITTER_DATE: day, GIT_AUTHOR_DATE: day } : {}) } }).trim();
let day = "";

// Feature: the start box says which branch a new worktree starts from ("from main"), lists the local
// branches by recency and then the remote ones, names the session that has a branch out, and the
// worktree is made from the branch picked.
test("a new worktree starts from the branch picked", async ({ browser, request, baseURL }) => {
  const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `wtbase-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  day = "2026-01-01T00:00:00Z";
  writeFileSync(join(repo, "notes.md"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  for (const name of ["old", "dev"]) {
    day = name === "old" ? "2026-01-02T00:00:00Z" : "2026-01-03T00:00:00Z";
    git(repo, "checkout", "-q", "-b", name, "main");
    writeFileSync(join(repo, `${name}.md`), `${name}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", name);
  }
  day = "";
  git(repo, "checkout", "-q", "main");
  git(repo, "update-ref", "refs/remotes/origin/main", "main");
  git(repo, "update-ref", "refs/remotes/origin/feature", "old");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  // Another session works with dev checked out, in a checkout of its own.
  const other = join(root, "dev-checkout");
  git(repo, "worktree", "add", "-q", other, "dev");
  const guest = await (await request.post("/api/sessions", { data: { workspace: other, model: HAIKU, title: "Dev work" } })).json();
  expect(guest.session?.id ?? guest.id).toBeTruthy();

  for (const [name, viewport] of [["desk", { width: 1920, height: 1040 }], ["phone", { width: 390, height: 844 }]] as const) {
    const ctx = await browser.newContext({ baseURL, viewport });
    const page = await ctx.newPage();
    await page.addInitScript((ws) => {
      localStorage.setItem("keel.newWorkspace", JSON.stringify(ws));
      localStorage.setItem("keel.startInWorktree", "0");
    }, repo);
    await page.goto("/");
    await page.getByTestId("start-in-worktree").click();
    // It says where it starts from: the repository's default branch.
    const from = page.getByTestId("worktree-base");
    await expect(from).toContainText("from");
    const trigger = page.getByTestId("worktree-base-select");
    await expect(trigger).toHaveAttribute("data-value", "main");
    await trigger.click();
    const list = page.getByRole("listbox");
    const rows = await list.getByRole("option").allInnerTexts();
    expect(rows.map((t) => t.split(" · ")[0]!).filter((n) => !n.startsWith("keel/"))).toEqual(["dev", "old", "main", "origin/feature"]);
    // The first round's worktree branch is there in the second, with the session that works on it.
    if (name === "phone") expect(rows.find((t) => t.startsWith("keel/"))).toContain("Reply with ok.");
    await expect(list.locator('[role="option"][data-value="dev"]')).toContainText("Dev work");
    await shoot(page, `wt-base-${name}-open`);
    await list.locator('[role="option"][data-value="dev"]').click();
    await expect(trigger).toHaveAttribute("data-value", "dev");
    await expect(trigger).toContainText("dev");
    await shoot(page, `wt-base-${name}`);

    await page.getByTestId("new-composer").getByTestId("composer").fill("Reply with ok.");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/s\//);
    const id = page.url().split("/s/")[1]!;
    const { worktree } = await (await request.get(`/api/sessions/${id}/worktree`)).json();
    expect(worktree.base).toBe("dev");
    // Its folder holds dev's files.
    expect(git(worktree.path, "ls-files")).toContain("dev.md");
    await ctx.close();
  }

  // A folder outside a repository has no such choice.
  expect((await request.get(`/api/worktrees/branches?workspace=${encodeURIComponent(root)}`)).status()).toBe(400);
});
