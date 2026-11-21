import { expect, test, type APIRequestContext } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, openPanel, SCRIPTED } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const events = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
const turnsDone = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 150_000 }).toBe(n);

function repo(name: string) {
  const dir = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "calc.py"), "def div(a, b):\n    return a / b\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}

// Feature: the independent reviewer. A read-only child session on the
// reviewer model reads the uncommitted change and answers with findings in
// the Review panel; the owner sends one back to the working model and
// dismisses another.
test("independent review with findings", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: the reviewer has to read the change and write findings");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = repo("review");
  writeFileSync(join(ws, "calc.py"), "def div(a, b):\n    return a // b\n\ndef avg(xs):\n    return sum(xs) / len(xs) + 1\n");
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "read-only" } });

  await page.goto(`/s/${session.id}`);
  await openPanel(page, "review");
  const reviewer = page.getByTestId("reviewer");
  await expect(reviewer).toBeVisible();
  await shoot(page, "review-01-start");
  await reviewer.getByTestId("review-start").click();
  const card = reviewer.getByTestId("review").first();
  await expect(card).toHaveAttribute("data-state", "running");
  await expect(card).toHaveAttribute("data-state", "done", { timeout: 150_000 });
  const findings = card.getByTestId("finding");
  await expect(findings.first()).toBeVisible();
  expect(await findings.count()).toBeGreaterThan(0);
  await shoot(page, "review-02-findings");

  // The review ran in a child session the reviewer could not change files in.
  const { reviews } = await (await request.get(`/api/sessions/${session.id}/reviews`)).json();
  const child = (await (await request.get(`/api/sessions/${reviews[0].child_id}/permissions`)).json()).perm;
  expect(child.mode).toBe("read-only");
  expect(git(ws, "status", "--porcelain")).toBe(" M calc.py\n");

  // Pick the first finding only and send it to the working model.
  const n = await findings.count();
  for (let i = 1; i < n; i++) await findings.nth(i).locator("input[type=checkbox]").uncheck();
  await card.getByTestId("findings-fix").click();
  await expect(findings.first()).toHaveAttribute("data-state", "fix_requested");
  await expect.poll(async () => (await events(request, session.id)).some((e) => e.kind === "user" && /independent review/.test(e.data.text))).toBe(true);
  if (n > 1) {
    // Two sends of the same finding at once queue it once.
    const url = `/api/sessions/${session.id}/reviews/${reviews[0].id}/findings`;
    const both = await Promise.all([0, 1].map(() => request.post(url, { data: { action: "fix", ids: [2] } })));
    expect(both.map((r) => r.status()).sort()).toEqual([200, 409]);
    await request.post(url, { data: { action: "reopen", ids: [2] } });
    await expect(findings.nth(1)).toHaveAttribute("data-state", "open");
    // Dismissing the one picked finding leaves nothing picked: the unchecked
    // ones are not checked again behind the owner's back.
    await findings.nth(1).locator("input[type=checkbox]").check();
    await card.getByTestId("findings-dismiss").click();
    await expect(findings.nth(1)).toHaveAttribute("data-state", "dismissed");
    if (n > 2) await expect(card.getByTestId("findings-fix")).toBeDisabled();
  }
  await turnsDone(request, session.id, n > 1 ? 2 : 1);
  await shoot(page, "review-03-sent");

  // The same change again on the same reviewer is not reviewed twice.
  const again = await (await request.post(`/api/sessions/${session.id}/reviews`, { data: {} })).json();
  expect(again.skipped).toBe(true);
  // A review the owner stops is stopped, not failed.
  const other = await (await request.post(`/api/sessions/${session.id}/reviews`, { data: { focus: "error handling only" } })).json();
  expect(other.skipped).toBe(false);
  await request.delete(`/api/sessions/${session.id}/reviews/${other.review.id}`);
  await expect(reviewer.getByTestId("review").first()).toHaveAttribute("data-state", "stopped");
  await expect(reviewer.getByTestId("review-stopped")).toBeVisible();

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// Feature: reviewer mode. A call the rules would ask about goes to the
// reviewer model with the owner's own policy: a plain one runs without a
// card, one the policy forbids is refused and listed; the owner lets one
// retry through.
test("reviewer mode judges calls", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: the reviewer has to judge calls against the owner's policy");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = repo("reviewer-mode");
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();

  // The owner's policy, written in Settings > Safety.
  await page.goto("/settings/safety");
  await page.getByTestId("reviewer-policy").fill("Deny every command that creates or touches a file named forbidden.txt. Allow other work inside the workspace.");
  await page.getByTestId("reviewer-policy-save").click();
  await expect(page.getByTestId("reviewer-policy-save")).toBeDisabled();
  await shoot(page, "review-04-settings");

  await page.goto(`/s/${session.id}`);
  await page.getByTestId("permission-menu").click();
  await page.getByTestId("mode-reviewer").click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/permissions`)).json()).perm.mode).toBe("reviewer");

  try {
    await page.getByTestId("composer").fill("Run exactly this one Bash command and nothing else: touch notes.txt\nThen reply ok.");
    await page.keyboard.press("Enter");
    await turnsDone(request, session.id, 1);
    expect(existsSync(join(ws, "notes.txt"))).toBe(true);
    await expect(page.getByTestId("approval")).toHaveCount(0);

    await page.getByTestId("composer").fill("Run exactly this one Bash command and nothing else, once: touch forbidden.txt\nIf it is refused, reply refused and stop; do not try another way.");
    await page.keyboard.press("Enter");
    const blocked = page.getByTestId("blocked");
    await expect(blocked).toBeVisible({ timeout: 120_000 });
    await expect(blocked.getByTestId("blocked-reason")).not.toBeEmpty();
    await turnsDone(request, session.id, 2);
    expect(existsSync(join(ws, "forbidden.txt"))).toBe(false);
    await shoot(page, "review-05-blocked");

    // One retry: the owner's click lets exactly that call through once.
    await blocked.getByTestId("blocked-retry").click();
    await expect(blocked).toHaveCount(0);
    await turnsDone(request, session.id, 3);
    expect(existsSync(join(ws, "forbidden.txt"))).toBe(true);
  } finally {
    await request.put("/api/permissions/settings", { data: { reviewer_policy: "" } });
  }

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
