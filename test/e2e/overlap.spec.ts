import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, openPanel, scriptBash, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

// Feature: the overlap forecast. Two sessions in two worktrees of one
// repository commit changes to the same line. Keel merges the two tips in
// memory, tells each session once (naming the other branch, its session, the
// file and the lines), and marks the conflict on the worktree chip and in the
// Branches panel. A later commit that adds nothing to the conflict tells
// nobody again. A rebase of one branch onto the other clears it: the mark
// goes and the session told of it hears it is gone. The repository's main
// checkout, its refs and its index are never written.
test("two worktrees that would conflict are told once, and a rebase clears it", async ({ page, request }) => {
  test.setTimeout(240_000);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `overlap-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const mainHead = git(repo, "rev-parse", "HEAD").trim();

  const run = (command: string) => ask(`Run exactly this one Bash command and nothing else: ${command}\nThen reply ok.`, scriptBash(command));
  const commit = (sed: string, msg: string) => `sed -i '${sed}' notes.md && git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;
  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const start = async (title: string, command: string) => {
    const r = await request.post("/api/worktrees", { data: { workspace: repo, model: HAIKU, title, text: run(command) } });
    expect(r.status()).toBe(201);
    const { session, worktree } = await r.json();
    return { id: session.id as string, branch: worktree.branch as string };
  };
  const a = await start("Lane alpha", commit("s/^line 3$/line three, as alpha has it/", "alpha"));
  const b = await start("Lane beta", commit("s/^line 3$/line 3, as beta has it/", "beta"));
  await idle(a.id);
  await idle(b.id);

  const view = async (id: string) => (await request.get(`/api/sessions/${id}/overlap`)).json();
  const between = (v: any) => v.pairs.filter((p: any) => p.conflict && !p.base);
  await expect.poll(async () => between(await view(a.id)).length, { timeout: 30_000 }).toBe(1);
  const pair = between(await view(a.id))[0];
  expect(pair.files).toEqual([{ path: "notes.md", clashes: [{ a: [3, 3], b: [3, 3] }] }]);
  // With the base, both merge clean: main did not move.
  expect((await view(a.id)).pairs.filter((p: any) => p.base)).toEqual([]);

  // Each is told at its next turn, once: the other branch, its session and the file (the lines are the view's).
  const notes = async (id: string, words = "would conflict") => {
    const d = await (await request.get(`/api/sessions/${id}`)).json();
    return d.events.filter((e: any) => e.kind === "note" && e.data.kind === "overlap" && e.data.model && String(e.data.text).includes(words)).map((e: any) => String(e.data.text));
  };
  const say = async (id: string) => {
    await request.post(`/api/sessions/${id}/messages`, { data: { text: ask("Reply with the single word ok.", "script:say ok") } });
    await idle(id);
  };
  await say(a.id);
  await say(b.id);
  const told = await notes(a.id);
  expect(told).toHaveLength(1);
  expect(told[0]).toContain(`- Your branch ${a.branch} would conflict with ${b.branch} (session "Lane beta" ${b.id}): notes.md.`);
  expect(told[0]).not.toContain("line 3");
  expect(await notes(b.id)).toHaveLength(1);
  expect((await notes(b.id))[0]).toContain(`"Lane alpha" ${a.id}`);

  // The chip shows it, and its popup says with what and where.
  await page.goto(`/s/${a.id}`);
  const mark = page.getByTestId("worktree-chip").getByTestId("overlap-mark");
  await expect(mark).toHaveAttribute("data-count", "1");
  await page.getByTestId("worktree-chip").click();
  const popup = page.getByTestId("overlap-popup");
  await expect(popup.getByTestId("overlap-pair")).toHaveCount(1);
  await expect(popup.getByTestId("overlap-session")).toHaveText("Lane beta");
  await expect(popup.getByTestId("overlap-lines")).toHaveText("yours 3 · theirs 3");
  await shoot(page, "overlap-01-chip");
  await page.keyboard.press("Escape");

  // The Branches panel: both live branches, the pair and its file.
  await openPanel(page, "branches");
  const panel = page.getByTestId("branches-panel");
  await expect(panel.getByTestId("overlap-branch")).toHaveCount(2);
  await expect(panel.getByTestId("overlap-pair")).toHaveCount(1);
  await expect(panel.getByTestId("overlap-file")).toHaveAttribute("data-path", "notes.md");
  await shoot(page, "overlap-02-branches");

  // A commit that adds nothing to the conflict tells nobody again.
  await request.post(`/api/sessions/${a.id}/messages`, { data: { text: run(commit("s/^line 10$/line ten/", "alpha 2")) } });
  await idle(a.id);
  await expect.poll(async () => between(await view(a.id))[0]?.a_tip === pair.a_tip && between(await view(a.id))[0]?.b_tip === pair.b_tip, { timeout: 30_000 }).toBe(false);
  await say(b.id);
  expect(await notes(a.id)).toHaveLength(1);
  expect(await notes(b.id)).toHaveLength(1);

  // Beta rebases onto alpha, keeping its own line: the conflict goes.
  await request.post(`/api/sessions/${b.id}/messages`, { data: { text: run(`git -c user.name=k -c user.email=k@k rebase -q -X theirs ${a.branch}`) } });
  await idle(b.id);
  await expect.poll(async () => between(await view(a.id)).length, { timeout: 30_000 }).toBe(0);
  await expect(mark).toHaveCount(0);
  await expect(panel.getByTestId("overlap-none")).toBeVisible();
  await shoot(page, "overlap-03-cleared");
  // Alpha, told of the conflict, hears once that it is gone.
  await say(a.id);
  const gone = await notes(a.id, "No longer conflicting");
  expect(gone).toHaveLength(1);
  expect(gone[0]).toContain(`No longer conflicting: ${a.branch} with ${b.branch}.`);
  expect(await notes(a.id)).toHaveLength(1);

  // The main checkout never moved and holds no change.
  expect(git(repo, "rev-parse", "HEAD").trim()).toBe(mainHead);
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});
