import { expect, test } from "./isolate.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, openPanel, remoteHeaders, shoot } from "./shots.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// Feature: where a session works. Move it to another folder with its files
// (the conversation goes on there and the model is told), make that folder a
// repository, clone the session into a worktree of its own, an image of the
// folder shown in a reply and in the Files panel, the repositories in the
// folder picker, and /api/open's refusals (opening starts a program on the
// desktop, so the spec checks only what it refuses).
test("move to a folder, clone into a worktree, images, repositories, open", async ({ page, request }) => {
  const word = `pl${Date.now().toString(36)}`;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const root = join((await (await request.get("/api/workspaces")).json()).default, word);
  const a = join(root, "first");
  const b = join(root, "second");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, "dot.png"), PNG);
  writeFileSync(join(a, "notes.md"), "notes\n");
  // A repository two levels under the repo root (the parent of the default folder).
  const repo = join(root, "..", `${word}-repo`);
  mkdirSync(repo, { recursive: true });
  expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
  writeFileSync(join(b, "AGENTS.md"), `When asked for the folder word, answer ${word.toUpperCase()}.\n`);
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Places ${word}`, workspace: a } })).json();
  const get = async () => (await (await request.get(`/api/sessions/${session.id}`)).json());
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  const send = async (text: string, turns: number) => {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(turns, { timeout: 90_000 });
  };

  // An image of the folder in a reply.
  await send("Reply with exactly this markdown and nothing else: ![a dot](dot.png)", 1);
  const img = page.getByTestId("assistant-text").last().locator("img");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  const raw = await request.get(`/api/sessions/${session.id}/file?raw=1&path=dot.png`);
  expect(raw.headers()["content-type"]).toBe("image/png");
  expect(raw.headers()["content-security-policy"]).toContain("sandbox");
  expect((await request.get(`/api/sessions/${session.id}/file?raw=1&path=notes.md`)).status()).toBe(400);
  expect((await request.get(`/api/sessions/${session.id}/file?raw=1&path=../../${word}`)).status()).toBe(403);

  // Move it, with its files, and make the new folder a repository.
  await openPanel(page, "session");
  await page.getByTestId("place").getByTestId("workspace-picker").click();
  await page.getByPlaceholder(/Type a path/).fill(b);
  await page.getByPlaceholder(/Type a path/).press("Enter");
  await page.getByTestId("use-folder").click();
  await page.getByTestId("move-copy").check();
  await page.getByTestId("move-git").check();
  await shoot(page, "places-01-move");
  await page.getByTestId("move-session").click();
  await expect(page.getByTestId("place-said")).toHaveText("Moved, 2 files copied.");
  const moved = await get();
  expect(moved.session.workspace).toBe(b);
  expect(existsSync(join(b, "dot.png")) && existsSync(join(b, ".git"))).toBe(true);
  expect(moved.events.findLast((e: any) => e.kind === "note")).toMatchObject({ data: { kind: "folder", model: true, from: a, to: b } });
  // The model works in the new folder and read its instruction file.
  await send("What is the folder word? Reply with only the word.", 2);
  await expect(page.getByTestId("assistant-text").last()).toContainText(word.toUpperCase());
  await send("Run pwd with your shell tool and reply with only its output.", 3);
  await expect(page.getByTestId("assistant-text").last()).toContainText(b);

  // The repositories the folder picker offers include the new one.
  expect((await (await request.get(`/api/fs/repos?root=${encodeURIComponent(root)}`)).json()).repos.map((r: any) => r.path)).toEqual([b]);
  await page.getByTestId("place").getByTestId("workspace-picker").click();
  await page.getByPlaceholder(/Type a path/).fill(word);
  await expect(page.getByTestId("repo-list")).toContainText(`${word}-repo`);
  await shoot(page, "places-02-repos");
  await page.keyboard.press("Escape");

  // The Files panel shows the image.
  await openPanel(page, "files");
  await page.getByTestId("files-panel").getByText("dot.png").click();
  await expect.poll(() => page.getByTestId("file-image").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  await shoot(page, "places-03-image");

  // /api/open refuses what it must; a real open would start a program on the desktop.
  expect((await request.post("/api/open", { data: { session_id: session.id, path: "missing.txt" } })).status()).toBe(404);
  expect((await request.post("/api/open", { data: { session_id: session.id, path: "../first/notes.md" } })).status()).toBe(403);
  expect((await request.post("/api/open", { data: { session_id: session.id, path: "dot.png" }, headers: await remoteHeaders(request) })).status()).toBe(403);

  // Clone into a worktree of its own: a commit to branch from first.
  for (const args of [["add", "-A"], ["commit", "-qm", "first"]]) expect(spawnSync("git", args, { cwd: b }).status).toBe(0);
  await openPanel(page, "session");
  await page.getByTestId("clone-worktree").check();
  await page.getByTestId("clone-session").click();
  await expect(page).not.toHaveURL(new RegExp(session.id));
  const cloneId = page.url().split("/s/")[1]!;
  const clone = await (await request.get(`/api/sessions/${cloneId}`)).json();
  expect(clone.session.title).toBe(`Places ${word} (clone)`);
  expect(clone.session.workspace).not.toBe(b);
  expect(clone.events.filter((e: any) => e.kind === "user")).toHaveLength(3);
  expect((await (await request.get(`/api/sessions/${cloneId}/worktree`)).json()).worktree).toBeTruthy();
  await shoot(page, "places-04-clone");

  await request.delete(`/api/sessions/${cloneId}`);
  await request.delete(`/api/sessions/${session.id}`);
  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
});
