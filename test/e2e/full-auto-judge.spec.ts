import { expect, test, type APIRequestContext } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { choose, HAIKU, shoot } from "./shots.ts";

// Feature: full auto never waits on the owner. A high-risk call the rules can
// settle runs at once; one that goes to the judge runs or is refused at once,
// with the reason in the transcript and in the list above the composer; the
// owner lets one retry through; no approval card ever opens.
const MODEL = "scripted:stand-in";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

function repo() {
  const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `full-auto-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(root, "init", "-q", "-b", "main", "seed");
  const seed = join(root, "seed");
  writeFileSync(join(seed, "notes.md"), "first\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "first");
  git(seed, "remote", "add", "origin", join(root, "remote.git"));
  git(seed, "push", "-q", "origin", "main");
  git(seed, "checkout", "-q", "-b", "old-topic");
  git(seed, "commit", "-q", "--allow-empty", "-m", "an abandoned try");
  git(seed, "push", "-q", "origin", "old-topic");
  git(root, "clone", "-q", join(root, "remote.git"), "work");
  const work = join(root, "work");
  git(work, "checkout", "-q", "-b", "topic");
  git(work, "commit", "-q", "--allow-empty", "-m", "topic work");
  git(work, "push", "-q", "-u", "origin", "topic");
  return { remote: join(root, "remote.git"), work };
}

const calls = (list: string[]) => `script:calls ${JSON.stringify(list.map((command) => ({ name: "Bash", input: { command } })))}`;

test("full auto settles high-risk calls without the owner", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { remote, work } = repo();
  // The judge: a real model, kept short; the working model is scripted.
  await request.put("/api/permissions/settings", { data: { reviewer_model: HAIKU } });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: work, model: MODEL, title: `Full auto ${Date.now()}` } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const noCards = async () => expect((await (await request.get(`/api/sessions/${session.id}/approvals?all`)).json()).approvals).toEqual([]);
  const turnsDone = (n: number) => expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);

  // Settings say what full auto does with a high-risk call.
  await page.goto("/settings/safety");
  await choose(page.getByTestId("default-mode"), { label: "Full auto" });
  await expect(page.getByText("goes to the judge model")).toBeVisible();
  await shoot(page, "full-auto-01-settings");

  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("permission-mode")).toHaveText("Full auto");
  const before = git(remote, "rev-parse", "main");
  await page.getByTestId("composer").fill([
    "Amend the topic commit and force-push topic. Delete the remote branch old-topic, I abandoned it. Leave main alone.",
    calls([
      "git commit -q --amend --allow-empty -m 'topic work, amended' && git push -q -f origin topic",
      "git push -q origin --delete old-topic",
      "git push -q -f origin topic:main",
    ]),
  ].join("\n"));
  await page.keyboard.press("Enter");
  await turnsDone(1);
  await noCards();

  // The force-push of the session's own branch ran by a rule, and the delete the owner asked for by the judge.
  expect(git(remote, "rev-parse", "topic")).toBe(git(work, "rev-parse", "topic"));
  expect(git(remote, "branch", "--list", "old-topic")).toBe("");
  // The force-push over main was refused at once: main is as it was, and the refusal is listed with its reason.
  expect(git(remote, "rev-parse", "main")).toBe(before);
  const refused = page.locator('[data-testid="tool-call"][data-state="refused"]');
  await expect(refused).toHaveCount(1);
  await expect(refused.getByTestId("tool-refusal")).toContainText("The judge refused a call");
  await expect(page.locator('[data-testid="tool-call"][data-state="ok"]')).toHaveCount(2);
  const card = page.getByTestId("blocked");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("blocked-reason")).not.toBeEmpty();
  const { blocked } = await (await request.get(`/api/sessions/${session.id}/blocked`)).json();
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toMatchObject({ by: "judge", summary: "git push -q -f origin topic:main" });
  // The activity list keeps how each high-risk call was settled.
  const { items } = await (await request.get(`/api/activity?kind=approval&session_id=${session.id}&limit=50`)).json();
  const mine = (items as any[]).map((a) => a.sub);
  expect(mine).toEqual(expect.arrayContaining(["allowed by a rule", "allowed by the judge", "refused"]));
  await refused.scrollIntoViewIfNeeded();
  await shoot(page, "full-auto-02-refused");

  // The owner lets one retry through from the transcript: the same call runs once.
  await refused.getByTestId("tool-retry").click();
  await expect(refused.getByTestId("tool-retry-allowed")).toBeVisible();
  await expect(card).toHaveCount(0);
  await turnsDone(2);
  await page.getByTestId("composer").fill(calls(["git push -q -f origin topic:main"]));
  await page.keyboard.press("Enter");
  await turnsDone(3);
  expect(git(remote, "rev-parse", "main")).toBe(git(work, "rev-parse", "topic"));
  await noCards();
  await shoot(page, "full-auto-03-retried");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
