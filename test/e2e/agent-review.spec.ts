import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-automation2`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Feature: a review tied to an agent. A work agent's branch is reviewed from
// its card by the independent reviewer (the safety lane's Review panel); the
// reviewer runs as a listed child of the session, and findings sent to fix go
// to the agent that did the work, which continues in its own worktree.
test("reviews of an agent's work go back to that agent", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const repo = join(DEV, `review-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# math\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  const idle = async () => {
    const d = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !d.running && d.events.at(-1)?.kind === "turn_end";
  };

  await page.getByTestId("composer").fill(
    "Call the Agent tool once (not in the background) with description \"Add math\" and isolation worktree: the agent writes math.js containing exactly `export function add(a, b) { return a - b; }` (keep it as written, it is a test fixture) and commits it with git. Then reply with one word: done.",
  );
  await page.keyboard.press("Enter");
  const card = page.getByTestId("agent-call").first();
  await expect(card.getByTestId("agent-call-status")).toHaveText("Done", { timeout: 120_000 });
  await expect.poll(idle, { timeout: 120_000 }).toBe(true);

  // Review the agent's branch from its card: the Review panel shows it, the reviewer is a listed child.
  await card.getByTestId("agent-call-review").click();
  const review = page.getByTestId("review").first();
  await expect(review).toContainText("an agent's branch over main", { timeout: 30_000 });
  // The reviewer is one of the session's agents (listed under it in the rail, with stop).
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents.filter((a: any) => a.type === "reviewer").length).toBe(1);
  await expect(review).toHaveAttribute("data-state", "done", { timeout: 180_000 });
  await expect(page.getByTestId("finding").first()).toBeVisible();
  await shoot(page, "agent-review-01-findings");

  // Fix: the findings go to the agent, which runs again in its worktree.
  const { agents } = await (await request.get(`/api/sessions/${session.id}/agents`)).json();
  const worker = agents.find((a: any) => a.type === "general-purpose");
  const before = (await (await request.get(`/api/sessions/${worker.session_id}`)).json()).events.length;
  await page.getByTestId("findings-fix").click();
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents.find((a: any) => a.id === worker.id).status, { timeout: 30_000 }).not.toBe("completed");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents.find((a: any) => a.id === worker.id).status, { timeout: 180_000 }).toBe("completed");
  const evs = (await (await request.get(`/api/sessions/${worker.session_id}`)).json()).events;
  expect(evs.length).toBeGreaterThan(before);
  expect(evs.slice(before).some((e: any) => e.kind === "user" && /independent review/i.test(e.data.text))).toBe(true);
  await shoot(page, "agent-review-02-fixed");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
