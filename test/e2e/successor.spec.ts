import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: an agent whose context is lost (here the model declines after some
// work) is taken up by a fresh context of the same agent, in the same
// worktree, from a capsule the harness writes: its task and the facts of its
// work, no word of the declined reply. The parent hears one line a successor.
// A second refusal moves the work to a model of another family; a third tells
// the parent, whose report says so.
const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-successor`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const PARENT = "scripted:stand-in";
const WORKER = "scripted:gpt-stand-in";
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;

test("a declined agent goes on in a fresh context, moves family after a second refusal, and the third tells the parent", async ({ page, request }) => {
  test.setTimeout(150_000);
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => (await request.fetch(path, { method, ...(body === undefined ? {} : { data: body }) })).json();
  const models = (await api("/api/models")).models as { id: string }[];
  test.skip(!models.some((m) => m.id === WORKER), "needs the scripted GPT stand-in: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const repo = join(DEV, `repo-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# successor\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first");

  const { session } = await api("/api/sessions", { model: PARENT, title: "Successor", workspace: repo });
  await api(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
  // The worker writes and commits a file, then declines.
  const work = { name: "Bash", input: { command: "echo done > done.txt && git add done.txt && git -c user.name=t -c user.email=t@t commit -qm 'Add done' || true" } };
  const task = `Write done.txt\n${calls([work])}\nscript:then-refuse`;
  await api(`/api/sessions/${session.id}/messages`, { text: calls([{ name: "spawn_agent", input: { message: task, model: WORKER } }]) });
  const agent = async () => (await api(`/api/sessions/${session.id}/agents`)).agents[0];
  await expect.poll(async () => (await agent())?.status, { timeout: 120_000 }).toBe("incomplete");
  const a = await agent();

  // Three contexts: two lost and taken up, the third declined and reported.
  expect(a.end_reason).toBe("refusal");
  expect(a.lost).toHaveLength(2);
  expect(a.lost.map((l: any) => [l.kind, l.model])).toEqual([["refusal", WORKER], ["refusal", WORKER]]);
  // The second refusal moved the work to the parent's model, of another family.
  expect(a.model).toBe(PARENT);
  const sessions = [a.lost[0].session, a.lost[1].session, a.session_id];
  expect(new Set(sessions).size).toBe(3);
  // The same worktree all along, held by the newest session.
  expect(a.worktree).toBeTruthy();
  expect((await api(`/api/sessions/${a.session_id}`)).session.workspace).toBe(a.worktree);

  // Each successor's brief is the capsule: the facts of the work, and no word of a declined reply.
  for (const sid of sessions.slice(1)) {
    const first = ((await api(`/api/sessions/${sid}`)).events as any[]).find((e) => e.kind === "user");
    const brief = String(first.data.text);
    expect(brief).toContain("with a fresh context");
    expect(brief).toContain("the model declined to go on (category: cyber)");
    expect(brief).toContain("done.txt");
    expect(brief).toContain("Add done");
    expect(brief).toContain(`same git worktree at ${a.worktree}`);
    expect(brief).not.toContain("I will not");
  }
  // The lost context's declined reply stays in its own session.
  const lostEvents = (await api(`/api/sessions/${a.lost[0].session}`)).events as any[];
  expect(lostEvents.some((e) => e.kind === "assistant" && e.data.stop === "refusal")).toBe(true);

  // The parent heard one line a successor, with the report after the third, and its turn on them ended.
  const heard = async () => ((await api(`/api/sessions/${session.id}`)).events as any[]).filter((e) => e.kind === "user").map((e) => String(e.data.text ?? "")).join("\n");
  await expect.poll(heard, { timeout: 30_000 }).toContain('status="incomplete"');
  const idle = async () => { const d = await api(`/api/sessions/${session.id}`); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
  await expect.poll(idle, { timeout: 30_000 }).toBe(true);
  const said = await heard();
  expect(said.match(/lost its context: the model declined to go on/g)).toHaveLength(2);
  expect(said).toContain("a model of another family");
  expect(said).toContain('status="incomplete"');
  expect(said).toContain("Keel started no fresh context for it: 2 successors were started");
  expect(said).not.toContain("I will not go on");

  // The card says it lost two contexts, and lists them.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  const card = page.getByTestId("agent-call").first();
  await expect(card.getByTestId("agent-call-successor")).toHaveText("2 fresh contexts");
  await shoot(page, "successor-01-card");
  await card.locator("button.k-line").first().click();
  await expect(card.getByTestId("agent-lost-row")).toHaveCount(2);
  await card.getByTestId("agent-lost").scrollIntoViewIfNeeded();
  await shoot(page, "successor-02-lost");
});
