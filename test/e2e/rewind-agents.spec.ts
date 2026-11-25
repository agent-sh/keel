import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, shoot } from "./shots.ts";

// Feature: a rewind knows the agents the rewound turns started. The dialog lists each (its state, its branch,
// whether it landed) and the owner leaves them or stops the ones that still work; a stop settles what they leave
// behind as every stop does, so the finished agent's branch with its commit stays, and so does a worktree with
// work in it. Nothing is removed that held an unlanded commit.
test.skip(!SCRIPTED, "needs the scripted stand-in: it runs the agents' calls");

const sizes = [{ width: 1920, height: 1040 }, { width: 390, height: 844 }];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const calls = (l: unknown[]) => `script:calls ${JSON.stringify(l)}`;

test("a rewind lists the agents its turns started, and stopping ends the one that works and keeps the finished one's branch", async ({ page, request }) => {
  test.setTimeout(240_000);
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `agents-${Date.now().toString(36)}`);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# agents\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "First commit");

  const { session } = await (await request.post("/api/sessions", { data: { workspace: repo, model: "scripted:stand-in-strict", title: "Coordinator" } })).json();
  const id = session.id as string;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
  type Agent = { id: string; title: string; status: string; branch?: string };
  const tree = async () => (await (await request.get(`/api/sessions/${id}/agents`)).json()).tree as Agent[];
  const states = async () => Object.fromEntries((await tree()).map((a) => [a.title, a.status]));
  const ended = async (n: number) => expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length >= n;
  }, { timeout: 60_000 }).toBe(true);

  await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say first" } });
  await ended(1);
  // The second turn starts two agents, each in a worktree of its own: one commits and finishes, one writes and goes on.
  const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "worktree" } });
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"].join(" ");
  const batch = [
    spawn(`Finisher\n${calls([{ name: "Write", input: { file_path: "notes.md", content: "# notes\n" } }, { name: "Bash", input: { command: `git add -A && git ${identity} commit -q -m notes` } }])}`),
    spawn(`Writer\n${calls([{ name: "Write", input: { file_path: "wip.txt", content: "half\n" } }, { name: "Bash", input: { command: "sleep 150; echo done" } }])}`),
  ];
  await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify(batch)}` } });
  await expect.poll(states, { timeout: 60_000 }).toEqual({ Finisher: "completed", Writer: "running" });
  const before = await tree();
  const finisher = before.find((a) => a.title === "Finisher")!.branch!;
  expect(finisher).toContain("keel/");

  await page.goto(`/s/${id}`);
  await page.setViewportSize(sizes[0]!);
  await page.getByTestId("composer").fill("/rewind");
  await page.getByTestId("composer").press("Enter");
  const dialog = page.getByTestId("rewind-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("rewind-prompt").last().click();

  // Both are named, with where each stands.
  const box = dialog.getByTestId("rewind-agents");
  await expect(box.getByTestId("rewind-agent")).toHaveCount(2);
  const row = (t: string) => box.getByTestId("rewind-agent").filter({ hasText: t });
  await expect(row("Finisher")).toHaveAttribute("data-status", "completed");
  await expect(row("Finisher")).toHaveAttribute("data-landed", "no");
  await expect(row("Finisher").getByTestId("rewind-agent-state")).toHaveText("Done");
  await expect(row("Finisher").getByTestId("rewind-agent-work")).toContainText(finisher);
  await expect(row("Finisher").getByTestId("rewind-agent-work")).toContainText("not landed");
  await expect(row("Writer")).toHaveAttribute("data-status", "running");
  await expect(row("Writer").getByTestId("rewind-agent-state")).toHaveText("Working");
  for (const s of sizes) { await page.setViewportSize(s); await shoot(page, `rewind-agents-01-dialog-${s.width}`); }
  await page.setViewportSize(sizes[0]!);

  // Leaving them: nothing of theirs moves, and the note says so.
  await dialog.getByTestId("rewind-prompt-go").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("rewound")).toContainText("2 agents it had started were left as they were: Finisher, Writer.");
  expect(await states()).toEqual({ Finisher: "completed", Writer: "running" });
  for (const s of sizes) { await page.setViewportSize(s); await shoot(page, `rewind-agents-02-left-${s.width}`); }
  await page.setViewportSize(sizes[0]!);

  // The rewind taken back, then again with a stop: the one that works ends, the finished one is as it was.
  await page.getByTestId("undo-rewind").click();
  await expect(page.getByTestId("user-message")).toHaveCount(2);
  await page.getByTestId("composer").fill("/rewind");
  await page.getByTestId("composer").press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("rewind-prompt").last().click();
  await expect(box.getByTestId("rewind-agent")).toHaveCount(2);
  await box.getByTestId("rewind-agents-stop").click();
  await expect(box.getByTestId("rewind-agents-stop")).toBeChecked();
  for (const s of sizes) { await page.setViewportSize(s); await shoot(page, `rewind-agents-03-stop-${s.width}`); }
  await page.setViewportSize(sizes[0]!);
  await dialog.getByTestId("rewind-prompt-go").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("rewound").last()).toContainText("2 agents it had started: 1 stopped, 1 left as they were: Finisher, Writer.");
  await expect.poll(states, { timeout: 60_000 }).toEqual({ Finisher: "completed", Writer: "stopped" });

  // Nothing that held work was removed: the finished agent's branch keeps its commit, and the stopped one's
  // worktree keeps the file it had written (a stop settles what an agent leaves as every stop does).
  expect(git(repo, "log", "--format=%s", finisher, "-1")).toBe("notes");
  const writer = (await tree()).find((a) => a.title === "Writer") as Agent & { worktree: string };
  expect(writer.worktree).toContain("keel");
  expect(existsSync(join(writer.worktree, "wip.txt"))).toBe(true);
  expect(git(repo, "worktree", "list")).toContain(writer.worktree);
  // Both worktrees are listed in Settings > Leftovers as the owner's to remove, the unfinished one held back by its edit.
  const left = await (await request.get("/api/leftovers")).json() as { worktrees: { branch?: string; ahead?: number; dirty?: number; removable: boolean; by?: { title: string } }[] };
  const listed = (branch: string) => left.worktrees.find((w) => w.branch === branch);
  expect(listed(finisher)).toMatchObject({ ahead: 1, by: { title: "Finisher" } });
  expect(listed(writer.branch!)).toMatchObject({ dirty: 1, removable: false, by: { title: "Writer" } });
  await shoot(page, "rewind-agents-04-stopped");
});
