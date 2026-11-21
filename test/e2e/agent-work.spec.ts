import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, SCRIPTED } from "./shots.ts";

const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-automation2`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Feature: an agent that edits works in its own git worktree on its own branch
// and the parent's checkout stays as it was; an agent given an output schema
// reports one JSON value that matches it; agents started together on a model
// the parent has not warmed start behind the first one's answer and read its cache.
test("agents: own worktree, structured reports, staggered starts", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: it has to start agents that commit in their worktrees and report");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const repo = join(DEV, `repo-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# test repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");

  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  const idle = async () => {
    const d = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !d.running && d.events.at(-1)?.kind === "turn_end";
  };

  // 1. A work agent: its edit and commit land on its own branch.
  await page.getByTestId("composer").fill(
    "Call the Agent tool once (not in the background) with description \"Add notes\": the agent writes a file NOTES.md containing the word hello in its working directory, then commits it with git (git add NOTES.md && git commit -m notes). After the report, answer with only the branch name the report gives.",
  );
  await page.keyboard.press("Enter");
  const card = page.getByTestId("agent-call").first();
  await expect(card.getByTestId("agent-call-branch")).toContainText("keel/", { timeout: 60_000 });
  await expect(card.getByTestId("agent-call-status")).toHaveText("Done", { timeout: 120_000 });
  await expect.poll(idle, { timeout: 120_000 }).toBe(true);
  const branch = (await card.getByTestId("agent-call-branch").textContent())!.trim();
  expect(existsSync(join(repo, "NOTES.md"))).toBe(false); // the parent's checkout is untouched
  expect(git(repo, "show", `${branch}:NOTES.md`)).toContain("hello");
  await card.getByLabel("Details").click();
  await expect(card).toContainText(`git merge ${branch}`);
  await shoot(page, "agent-work-01-worktree");

  // 2. A structured report.
  await page.getByTestId("composer").fill(
    'Call the Agent tool once (not in the background), subagent_type Explore, description "Count files", with output_schema {"type":"object","required":["count"],"properties":{"count":{"type":"integer"}},"additionalProperties":false}: the agent counts the files in the working directory with ls. Then answer with only the count.',
  );
  await page.keyboard.press("Enter");
  const card2 = page.getByTestId("agent-call").nth(1);
  await expect(card2.getByTestId("agent-call-structured")).toBeVisible({ timeout: 60_000 });
  await expect(card2.getByTestId("agent-call-status")).toHaveText("Done", { timeout: 120_000 });
  await expect.poll(idle, { timeout: 120_000 }).toBe(true);
  await card2.getByLabel("Details").click();
  const json = JSON.parse((await card2.getByTestId("agent-call-json").textContent())!);
  expect(Number.isInteger(json.count)).toBe(true);
  await shoot(page, "agent-work-02-structured");

  // 3. Two agents on another model: the second starts behind the first's answer and reads its cache.
  await page.getByTestId("composer").fill(
    "Call the Agent tool twice in one message, both with run_in_background true, model sonnet and subagent_type Explore: each agent replies with only the word ok and uses no tools. Then end your turn with one short line.",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("agent-report")).toHaveCount(2, { timeout: 120_000 });
  await expect.poll(idle, { timeout: 120_000 }).toBe(true);
  const act = (await (await request.get(`/api/activity?kind=agent&session_id=${session.id}`)).json()).items;
  expect(act.some((a: any) => a.sub === "staggered")).toBe(true);
  const { agents } = await (await request.get(`/api/sessions/${session.id}/agents`)).json();
  const late = agents.filter((a: any) => a.model !== session.model).at(-1);
  const evs = (await (await request.get(`/api/sessions/${late.session_id}`)).json()).events;
  const first = evs.find((e: any) => e.kind === "assistant");
  expect(first.data.usage.cache_read).toBeGreaterThan(0);
  await shoot(page, "agent-work-03-staggered");

  // 4. A fork: it starts with this conversation, and though it works in a
  // worktree of its own it runs on the parent's system prompt, so its first
  // request reads the parent's cached prefix instead of writing a copy.
  await page.getByTestId("composer").fill("Remember this word for later: cobalt. Reply with only: noted.");
  await page.keyboard.press("Enter");
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);
  await page.getByTestId("composer").fill(
    'Call the Agent tool once (not in the background) with subagent_type fork and description "Recall": the fork replies with only the word I asked you to remember and uses no tools. Then answer with only that word.',
  );
  await page.keyboard.press("Enter");
  const card4 = page.getByTestId("agent-call").nth(4);
  await expect(card4.getByTestId("agent-call-status")).toHaveText("Done", { timeout: 120_000 });
  await expect.poll(idle, { timeout: 120_000 }).toBe(true);
  const fork = (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents.find((a: any) => a.title === "Recall");
  expect(fork.result.toLowerCase()).toContain("cobalt");
  // Its own first request: the events before its turn are the parent's, copied.
  const forkEvents = (await (await request.get(`/api/sessions/${fork.session_id}`)).json()).events;
  const forkFirst = forkEvents.slice(forkEvents.findIndex((e: any) => e.kind === "turn_start")).find((e: any) => e.kind === "assistant");
  expect(forkFirst.data.usage.cache_read).toBeGreaterThan(4 * forkFirst.data.usage.cache_write);
  await card4.getByLabel("Details").click();
  await shoot(page, "agent-work-04-fork");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
