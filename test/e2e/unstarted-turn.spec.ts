import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const MODEL = "scripted:stand-in";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Feature: a turn nobody started (a loop run) does not force-push, merge or approve, even in Full auto; the same
// command runs once the owner has sent a message to that session.
test("a loop run is refused a force push in Full auto, and the same command runs after the owner's message", async ({ page, request }) => {
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === MODEL), "requires the scripted provider");
  const scratch = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "unstarted-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  mkdirSync(work);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(work, "init", "-q", "-b", "main");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one");
  git(work, "remote", "add", "origin", remote);
  const remoteHas = (branch: string) => { try { git(remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`); return true; } catch { return false; } };
  const push = (branch: string) => `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `git push --force origin main:refs/heads/${branch}` } }])}`;

  const loop = await (await request.post("/api/loops", { data: { name: "Forced push", schedule: "every day at 09:30", prompt: push("by-loop"), cwd: work, mode: "full-auto", model: MODEL } })).json();
  const events = async () => (await (await request.get(`/api/sessions/${loop.session_id}`)).json()).events as any[];
  const ends = async () => (await events()).filter((e) => e.kind === "turn_end").length;
  const results = async () => (await events()).filter((e) => e.kind === "tool_result").flatMap((e) => JSON.stringify(e.data));

  expect((await request.post(`/api/loops/${loop.id}/run`)).ok()).toBe(true);
  await expect.poll(ends, { timeout: 60_000 }).toBe(1);
  // Refused with the reason the model reads, and nothing reached the remote.
  expect((await results()).join("\n")).toContain("no message of the owner's is in this turn");
  expect(remoteHas("by-loop")).toBe(false);

  // The owner's message to the same session: the same command runs in Full auto.
  await page.goto(`/s/${loop.session_id}`);
  await page.getByTestId("composer").fill(push("by-owner"));
  await page.getByTestId("composer").press("Enter");
  await expect.poll(ends, { timeout: 60_000 }).toBe(2);
  expect(remoteHas("by-owner")).toBe(true);
  expect(remoteHas("by-loop")).toBe(false);
  await shoot(page, "unstarted-turn-01-owner-message");

  await request.delete(`/api/loops/${loop.id}`);
});
