import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, ask, scriptBash } from "./shots.ts";

// Feature: the command sandbox. In auto-edits mode with the workspace-write
// profile and the network off, a command runs without asking, can write the
// workspace, cannot write outside it and cannot reach the network.
test("command sandbox", async ({ page, request }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `sandbox unavailable: ${settings.sandbox.reason}`);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  const ws = join(root, `sandbox-${Date.now()}`);
  const outside = `${ws}-outside.txt`;
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);

  // Turn the sandbox on from the menu.
  await page.getByTestId("permission-menu").click();
  await page.getByTestId("mode-auto-edits").click();
  await page.getByTestId("sandbox-workspace-write").click();
  await page.getByTestId("sandbox-network").click();
  await expect(page.getByTestId("sandbox-network")).not.toHaveAttribute("data-checked");
  await shoot(page, "sandbox-01-menu");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("permission-menu")).toContainText("sandbox");

  const cmd = `touch inside.txt; touch ${outside}; getent hosts example.com || echo no-network`;
  await page.getByTestId("composer").fill(ask(`Run exactly this one Bash command, once, and nothing else: ${cmd}\nThen reply with one word: done.`, scriptBash(cmd)));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("approval")).toHaveCount(0);

  expect(existsSync(join(ws, "inside.txt"))).toBe(true);
  expect(existsSync(outside)).toBe(false);
  const tool = page.getByTestId("tool-call").first();
  await tool.click();
  await expect(tool).toContainText("Read-only file system");
  await expect(tool).toContainText("no-network");
  await shoot(page, "sandbox-02-result");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A session in a linked worktree commits with the sandbox on. git keeps a
// linked worktree's index and the repository's objects and refs outside the
// folder: those are writable, and nothing wider. The repository's hooks, the
// main checkout's own files and the folder next door stay read-only.
test("a sandboxed session commits in its worktree", async ({ page, request }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `sandbox unavailable: ${settings.sandbox.reason}`);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `sandbox-wt-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# test repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  // A second worktree of the same repository: its files are not this session's.
  git(repo, "worktree", "add", "-q", "-b", "other", `${repo}-other`);
  const mainHead = readFileSync(join(repo, ".git/HEAD"), "utf8");
  const otherHead = readFileSync(join(repo, ".git/worktrees", `${repo.split("/").pop()}-other`, "HEAD"), "utf8");

  const made = await (await request.post("/api/worktrees", { data: { workspace: repo, model: HAIKU, title: "sandboxed commit" } })).json();
  const id = made.session.id as string;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "workspace-write", network: false } });
  const outside = `${repo}-outside.txt`;
  const tries = [
    `touch ${outside}`,
    `touch ${repo}/README.new`,
    `echo evil > ${repo}/.git/hooks/pre-commit`,
    `echo x >> ${repo}/.git/config`,
    `echo ref: refs/heads/x > ${repo}/.git/HEAD`,
    `echo ref: refs/heads/x > ${repo}/.git/worktrees/${repo.split("/").pop()}-other/HEAD`,
  ];
  const command = `echo hello > NOTES.md && git add NOTES.md && git -c user.name=k -c user.email=k@k commit -qm notes && echo com""mitted; ${tries.map((t, i) => `(${t}) 2>&1 || echo re""fused-${i}`).join("; ")}`;
  await page.goto(`/s/${id}`);
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("approval")).toHaveCount(0);

  const tool = page.getByTestId("tool-call").first();
  await tool.click();
  await expect(tool).toContainText("committed");
  for (let i = 0; i < tries.length; i++) await expect(tool).toContainText(`refused-${i}`);
  await shoot(page, "sandbox-03-worktree-commit");

  const { worktree } = await (await request.get(`/api/sessions/${id}/worktree`)).json();
  expect(worktree.commits_ahead).toBe(1);
  expect(git(repo, "show", `${worktree.branch}:NOTES.md`)).toBe("hello");
  expect(existsSync(outside)).toBe(false);
  expect(existsSync(join(repo, "README.new"))).toBe(false);
  expect(existsSync(join(repo, ".git/hooks/pre-commit"))).toBe(false);
  expect(readFileSync(join(repo, ".git/HEAD"), "utf8")).toBe(mainHead);
  expect(readFileSync(join(repo, ".git/worktrees", `${repo.split("/").pop()}-other`, "HEAD"), "utf8")).toBe(otherHead);
  expect(git(repo, "config", "--get", "core.bare")).toBe("false");

  // The same for an agent: a sandboxed session's work agent commits in the
  // worktree it was given, and its report counts the commit.
  const { session: parent } = await (await request.post("/api/sessions", { data: { workspace: repo, model: HAIKU, title: "sandboxed agent" } })).json();
  await request.put(`/api/sessions/${parent.id}/permissions`, { data: { mode: "full-auto", sandbox: "workspace-write", network: false } });
  const work = [{ name: "Bash", input: { command: "echo hi > AGENT.md && git add AGENT.md && git -c user.name=k -c user.email=k@k commit -qm agent" } }];
  await request.post(`/api/sessions/${parent.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: `Add a note\nscript:calls ${JSON.stringify(work)}` } }])}` } });
  await page.goto(`/s/${parent.id}`);
  await expect(page.getByTestId("agent-report")).toHaveCount(1, { timeout: 90_000 });
  const report = async () => JSON.stringify((await (await request.get(`/api/sessions/${parent.id}`)).json()).events.filter((e: any) => e.kind === "user"));
  await expect.poll(report, { timeout: 30_000 }).toContain("1 commit over main");
  await shoot(page, "sandbox-04-agent-commit");
});
