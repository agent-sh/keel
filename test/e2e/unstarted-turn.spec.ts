import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const MODEL = "scripted:stand-in";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A bare remote and a work tree with one commit, for a push to try.
function repo(prefix: string) {
  const scratch = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, prefix));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  mkdirSync(work);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(work, "init", "-q", "-b", "main");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one");
  git(work, "remote", "add", "origin", remote);
  const remoteHas = (branch: string) => { try { git(remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`); return true; } catch { return false; } };
  const push = (branch: string) => `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `git push --force origin main:refs/heads/${branch}` } }])}`;
  return { work, remoteHas, push };
}

// Feature: a turn nobody started (a loop run) does not force-push, merge or approve, even in Full auto; the same
// command runs once the owner has sent a message to that session.
test("a loop run is refused a force push in Full auto, and the same command runs after the owner's message", async ({ page, request }) => {
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === MODEL), "requires the scripted provider");
  const { work, remoteHas, push } = repo("unstarted-");

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

// Feature: the owner's message typed on an agent's card is the owner's word, whatever the idle parent's turn was.
test("an agent a loop run started is refused a force push, and the owner's message on its card lets it run", async ({ request }) => {
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === MODEL), "requires the scripted provider");
  const { work, remoteHas, push } = repo("unstarted-agent-");
  const spawn = `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: `Pusher\n${push("by-task")}`, isolation: "none" } }])}`;
  const loop = await (await request.post("/api/loops", { data: { name: "Starts an agent", schedule: "every day at 09:30", prompt: spawn, cwd: work, mode: "full-auto", model: MODEL } })).json();
  const agent = async () => (await (await request.get(`/api/sessions/${loop.session_id}/agents`)).json()).agents[0];
  const ends = async (id: string) => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "turn_end").length;
  const results = async (id: string) => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data)).join("\n");

  expect((await request.post(`/api/loops/${loop.id}/run`)).ok()).toBe(true);
  await expect.poll(async () => (await agent())?.session_id, { timeout: 60_000 }).toBeTruthy();
  const child = (await agent()).session_id as string;
  await expect.poll(() => ends(child), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => ends(loop.session_id), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  expect(await results(child)).toContain("no message of the owner's is in this turn");
  expect(remoteHas("by-task")).toBe(false);

  // The owner's message on the agent's card, while the parent idles on a turn nobody started.
  const before = await ends(child);
  expect((await request.post(`/api/sessions/${loop.session_id}/agents/${(await agent()).id}/message`, { data: { message: push("by-card") } })).ok()).toBe(true);
  await expect.poll(() => ends(child), { timeout: 60_000 }).toBeGreaterThan(before);
  expect(remoteHas("by-card")).toBe(true);
  expect(remoteHas("by-task")).toBe(false);

  await request.delete(`/api/loops/${loop.id}`);
});
