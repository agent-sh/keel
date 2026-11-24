import { expect, test } from "./isolate.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { HAIKU, shoot } from "./shots.ts";
import { isScratch } from "./scratch.ts";

// Feature: the folder a new session works in, found by name. A name typed in
// the folder picker matches the folders in the home and beside the folders
// sessions used, repositories a little ahead; Enter takes the top match, even
// before the list has shown; a path that cannot open, and a name nothing has,
// say why in the picker.
test("the folder picker finds a folder by name, Enter takes it, and what cannot open says why", async ({ page, request }) => {
  const word = `fp${Date.now().toString(36)}`;
  const { home, default: deflt } = (await (await request.get("/api/workspaces")).json()) as { home: string; default: string };
  // The folders are made where the picker looks and nothing of the owner's is: in a home of the
  // run's own (scripts/smoke.sh and the scratch daemons make one under a cache folder), else beside
  // the daemon's default folder, which is a repo root. Not under a dot-folder: no root is there.
  const own = home.includes("/.cache/");
  test.skip(!own && relative(home, dirname(deflt)).startsWith(".."), "needs a home of the run's own or a default folder inside the home: the folders it makes must not land in the owner's home");
  const root = own ? join(home, "keel-e2e", word) : join(dirname(deflt), word);
  const used = join(root, "base"), repo = join(root, `${word}-api`), plain = join(root, `${word}-notes`);
  for (const d of [used, repo, plain]) mkdirSync(d, { recursive: true });
  expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
  // A session worked in `base`: its neighbours are where the picker looks.
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Picker ${word}`, workspace: used } })).json();
  try {
    await page.goto("/");
    const picker = page.getByTestId("workspace-picker");
    // The picker's field (the one input it has, then as now).
    const field = page.getByTestId("workspace-popup").locator("input");
    const matches = page.getByTestId("folder-match");

    // Part of a name and Enter at once, before the list has shown: the top match is the folder.
    await picker.click();
    await field.fill(`${word}-ap`);
    await field.press("Enter");
    await expect(page.getByTestId("workspace-popup")).toHaveCount(0);
    await expect(picker).toContainText(`${word}-api`);

    // The name finds both folders, the repository first, and the used folder whose path holds it after them.
    await picker.click();
    await field.fill(word);
    await expect(matches).toHaveCount(3);
    await expect(matches.nth(0)).toContainText(`${word}-api`);
    await expect(matches.nth(1)).toContainText(`${word}-notes`);
    await expect(matches.nth(2)).toContainText("base");
    await shoot(page, "folder-picker-01-matches");
    await field.fill(`${word}-no`);
    await expect(matches).toHaveCount(1);
    await expect(matches.first()).toContainText(`${word}-notes`);
    // Down picks the next match.
    await field.fill(word);
    await expect(matches).toHaveCount(3);
    await field.press("ArrowDown");
    await expect(matches.nth(1)).toHaveAttribute("aria-selected", "true");
    await field.press("Enter");
    await expect(picker).toContainText(`${word}-notes`);

    // A path outside the home, a path where nothing is, and a name nothing has: each says why, and the picker stays.
    await picker.click();
    await field.fill("/etc");
    await field.press("Enter");
    await expect(page.getByTestId("folder-error")).toContainText("/etc is outside your home folder");
    await expect(page.getByTestId("workspace-popup")).toBeVisible();
    await expect(field).toHaveValue("/etc");
    await shoot(page, "folder-picker-02-outside");
    await field.fill(`~/no-such-${word}`);
    await expect(page.getByTestId("folder-error")).toHaveCount(0);
    await field.press("Enter");
    await expect(page.getByTestId("folder-error")).toContainText(`No folder at ~/no-such-${word}`);
    await field.fill(`zq${word}x`);
    await field.press("Enter");
    await expect(page.getByTestId("folder-error")).toContainText(`No folder named \u201czq${word}x\u201d`);
    await page.keyboard.press("Escape");
    await expect(picker).toContainText(`${word}-notes`);

    // A session that worked under a dot-folder of the home lists that folder, not the names beside it.
    if (own) {
      const dot = join(home, ".keel-e2e", word), there = join(dot, "tool"), beside = join(dot, `${word}-hidden`);
      for (const d of [there, beside]) mkdirSync(d, { recursive: true });
      const { session: s2 } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Dot ${word}`, workspace: there } })).json();
      try {
        await picker.click();
        await field.fill(`${word}-hid`);
        await field.press("Enter");
        await expect(page.getByTestId("folder-error")).toContainText(`No folder named`);
        await page.keyboard.press("Escape");
      } finally {
        await request.delete(`/api/sessions/${s2.id}`);
        rmSync(dot, { recursive: true, force: true });
      }
    }

    // On a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await picker.click();
    await field.fill(word);
    await expect(matches).toHaveCount(3);
    await shoot(page, "folder-picker-03-phone");
    await page.keyboard.press("Escape");
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
    rmSync(root, { recursive: true, force: true });
  }
});

// Feature: a new session does not start in an agent's worktree. The folders a session worked in are
// offered newest first, and the worktrees Keel makes for its agents are the newest of all while agents
// work: the box would start in a branch of an agent. They are left out; the folder they came from stays.
test("the recent folders leave out the worktrees Keel makes for its agents", async ({ page, request }) => {
  const daemon = await (await request.get("/api/daemon")).json();
  const facts = { ...daemon, home: (await (await request.get("/api/workspaces")).json()).home, providers: (await (await request.get("/api/providers")).json()).providers.filter((p: any) => p.available).map((p: any) => p.id) };
  test.skip(!isScratch(facts), "needs a scratch daemon: it makes a folder in the daemon's state folder");
  const word = `wt${Date.now().toString(36)}`;
  const { home } = facts;
  const managed = join(daemon.state_dir, "worktrees", `${word}-agent`);
  const repo = join(home, ".keel-e2e", word, `${word}-repo`);
  mkdirSync(managed, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const made: string[] = [];
  try {
    // The repository's session is the older one: the agent's worktree is newer than it.
    for (const [title, workspace] of [["Repository", repo], ["Agent worktree", managed]]) {
      const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: `${title} ${word}`, workspace } })).json();
      made.push(session.id);
    }
    const recent = ((await (await request.get("/api/workspaces")).json()).recent as { path: string }[]).map((r) => r.path);
    expect(recent).toContain(repo);
    expect(recent.filter((p) => p.includes(`${word}-agent`))).toEqual([]);
    await page.goto("/");
    await page.getByTestId("workspace-picker").click();
    await expect(page.getByTestId("workspace-popup")).toContainText(`${word}-repo`);
    await expect(page.getByTestId("workspace-popup")).not.toContainText(`${word}-agent`);
    await shoot(page, "folder-picker-04-no-worktrees");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
    rmSync(managed, { recursive: true, force: true });
    rmSync(join(home, ".keel-e2e", word), { recursive: true, force: true });
  }
});
