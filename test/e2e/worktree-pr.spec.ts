import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

// Feature: the start box starts a session at a pull request's head. The field takes the number (or
// the address); the head is fetched from origin by name (refs/pull/N/head), the worktree is made at
// that commit, and an origin that has no such ref gives an error that names the ref and the origin. A head whose
// author cannot be read is held: the session's chip says its instructions are not loaded, and Trust loads them.
// The origin is a bare repository on this machine, never a real remote.
test("a session starts at a pull request's head, and a missing one is named", async ({ browser, request, baseURL }) => {
  const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `wtpr-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(root, "repo");
  git(root, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "notes.md"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "origin", "HEAD:main");
  // The request's head: a commit the origin keeps under refs/pull/7/head and on no branch.
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "feature.md"), "from the pull request\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "the request");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-q", "-D", "feature");
  expect(git(repo, "branch", "--list", "feature")).toBe("");

  for (const [name, viewport] of [["desk", { width: 1920, height: 1040 }], ["phone", { width: 390, height: 844 }]] as const) {
    const ctx = await browser.newContext({ baseURL, viewport });
    const page = await ctx.newPage();
    await page.addInitScript((ws) => {
      localStorage.setItem("keel.newWorkspace", JSON.stringify(ws));
      localStorage.setItem("keel.startInWorktree", "0");
      localStorage.setItem("keel.workbench", "true");
    }, repo);
    await page.goto("/");
    await page.getByTestId("start-in-worktree").click();
    const field = page.getByTestId("worktree-pr-input");
    // With a request named, the branch the worktree starts from is not asked.
    await expect(page.getByTestId("worktree-base")).toBeVisible();
    await field.fill("9");
    await expect(page.getByTestId("worktree-base")).toHaveCount(0);

    // An origin that holds no such request: the start is refused, says why, and keeps the box.
    const composer = page.getByTestId("new-composer").getByTestId("composer");
    await composer.fill("Reply with ok.");
    await composer.press("Enter");
    const said = page.getByText(/could not fetch refs\/pull\/9\/head from origin/);
    await expect(said.first()).toBeVisible();
    await expect(said.first()).toContainText("origin.git");
    await expect(page).not.toHaveURL(/\/s\//);
    await shoot(page, `wt-pr-${name}-refused`);

    await field.fill("7");
    await shoot(page, `wt-pr-${name}`);
    await composer.fill("Reply with ok.");
    await composer.press("Enter");
    await expect(page).toHaveURL(/\/s\//);
    const id = page.url().split("/s/")[1]!;
    const { worktree } = await (await request.get(`/api/sessions/${id}/worktree`)).json();
    expect(git(worktree.path, "rev-parse", "HEAD")).toBe(head);
    expect(worktree.branch).toMatch(/^keel\/pr-7-/);
    expect(existsSync(join(worktree.path, "feature.md"))).toBe(true);
    // Nobody could say who wrote the head (origin is a folder here, no code host): its own files are not loaded,
    // and the chip says so until the owner trusts the head.
    const held = page.getByTestId("head-held");
    await expect(held).toContainText("PR from a fork: its instructions are not loaded");
    // (On a phone the header folds it into the session menu.)
    if (name === "phone") await page.getByTestId("session-menu").click();
    await expect(page.getByTestId("head-trust")).toBeVisible();
    await shoot(page, `wt-pr-${name}-held`);
    await page.getByTestId("head-trust").click();
    await expect(held).toHaveCount(0);
    expect((await (await request.get(`/api/sessions/${id}/worktree`)).json()).head).toMatchObject({ held: false, state: "owner" });
    // Nothing of the fetch is left in the repository's own refs.
    expect(git(repo, "for-each-ref", "refs/keel")).toBe("");
    await ctx.close();
  }

  // The same through the route: a named ref that is missing is a 409 that names it.
  const miss = await request.post("/api/worktrees", { data: { workspace: repo, pr: "12" } });
  expect(miss.status()).toBe(409);
  expect((await miss.json()).error).toContain("refs/pull/12/head");
  expect((await request.post("/api/worktrees", { data: { workspace: repo, pr: "not a request" } })).status()).toBe(400);
});
