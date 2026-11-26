import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeBoxTools, boxTools, choose, shoot } from "./shots.ts";

// Feature: a plan approved to start fresh. The owner approves the plan, edited, to be carried out in a new
// session of the same folder and worktree: its first prompt is the plan as he left it, with a link back; the
// planning session keeps its transcript, stays in plan mode, ends its turn with no step more and names the
// new session. One session works on the plan.
test("approve a plan and start it in a fresh session", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "needs the scripted provider: the planning session's turn is scripted");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `plan-fresh-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "base\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  const made = await (await request.post("/api/worktrees", { data: { workspace: repo, model: "scripted:stand-in", title: "Plan the greeting" } })).json();
  const planning = made.session as { id: string; workspace: string };
  const wt = (await (await request.get(`/api/sessions/${planning.id}/worktree`)).json()).worktree;
  expect(wt?.path).toBeTruthy();
  await request.put(`/api/sessions/${planning.id}/permissions`, { data: { mode: "plan" } });
  await page.goto(`/s/${planning.id}`);

  const plan = "1. Create hello.txt with the line hi.\n2. The file ends with a newline.";
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "present_plan", input: { plan, title: "Greeting file" } }])}`);
  await page.keyboard.press("Enter");
  const card = page.getByTestId("plan-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("plan-fresh")).toHaveText("Approve and start fresh");
  await shoot(page, "plan-fresh-01-card");
  // The owner's window: 1320x860 at the small text size. The second approval stays on the card's foot.
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "0.9"));
  await expect(card.getByTestId("plan-fresh")).toBeInViewport();
  await shoot(page, "plan-fresh-01-card-1320x860-small");
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1"));
  await page.setViewportSize({ width: 1920, height: 1040 });

  // His edit goes with it: the new session's script line is his last line.
  await card.getByTestId("plan-edit").click();
  const edited = `${plan}\n3. Say when it is done.\nscript:say Carrying out the greeting plan.`;
  await card.locator("textarea").fill(edited);
  await card.getByTestId("plan-edit").click();
  await choose(card.getByTestId("plan-mode"), "auto-edits");
  const open = (await (await request.get(`/api/sessions/${planning.id}/plan`)).json()).open;
  await card.getByTestId("plan-fresh").click();

  // The page goes to the new session: its first prompt is the plan, verbatim, under a link back.
  await expect(page).not.toHaveURL(new RegExp(`/s/${planning.id}`), { timeout: 20_000 });
  const fresh = new URL(page.url()).pathname.split("/").at(-1)!;
  const first = page.getByTestId("user-message").first();
  await expect(first.getByTestId("origin-plan")).toContainText("Plan the greeting");
  await expect(first).toContainText("3. Say when it is done.");
  await expect(page.getByText("Carrying out the greeting plan.").last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
  const got = await (await request.get(`/api/sessions/${fresh}`)).json();
  const prompt = got.events.find((e: any) => e.kind === "user");
  expect(prompt.data.text).toContain(edited);
  expect(prompt.data.plan_from).toBe(planning.id);
  expect(got.session.workspace).toBe(planning.workspace);
  expect((await (await request.get(`/api/sessions/${fresh}/permissions`)).json()).perm.mode).toBe("auto-edits");
  // The worktree went with the work.
  expect((await (await request.get(`/api/sessions/${fresh}/worktree`)).json()).worktree?.path).toBe(wt.path);
  await shoot(page, "plan-fresh-02-new-session");

  // The planning session: still in plan mode, its turn ended at the plan's step with no model step after it,
  // and a line that names the new session. A second approval of the same plan starts nothing.
  const back = await (await request.get(`/api/sessions/${planning.id}`)).json();
  const kinds = back.events.map((e: any) => e.kind);
  const end = back.events.findLast((e: any) => e.kind === "turn_end");
  expect(end.data.stopped_by).toBe("plan_fresh");
  expect(kinds.lastIndexOf("assistant")).toBeLessThan(kinds.lastIndexOf("tool_result"));
  expect((await (await request.get(`/api/sessions/${planning.id}/permissions`)).json()).perm.mode).toBe("plan");
  expect((await request.post(`/api/sessions/${planning.id}/plan/${open[0].id}`, { data: { approve: true, mode: "auto-edits", fresh: true } })).status()).toBe(404);
  const kept = (await (await request.get(`/api/sessions/${planning.id}/plan`)).json()).plan;
  expect(kept.fresh_session).toBe(fresh);

  await first.getByTestId("plan-from").click();
  await expect(page).toHaveURL(new RegExp(`/s/${planning.id}`));
  const line = page.getByTestId("plan-fresh-note");
  await expect(line).toContainText("The plan went to a fresh session");
  await expect(page.getByTestId("plan-card")).toHaveCount(0);
  // Its turn's end is no stop to resume: the line says where the work went.
  await expect(page.getByTestId("turn-reason")).toHaveCount(0);
  await expect(page.getByTestId("resume")).toHaveCount(0);
  await expect((await boxTools(page)).getByTestId("permission-mode")).toHaveText("Plan");
  await closeBoxTools(page);
  await shoot(page, "plan-fresh-03-planning-session");
  await line.getByTestId("plan-fresh-to").click();
  await expect(page).toHaveURL(new RegExp(`/s/${fresh}`));

  for (const id of [fresh, planning.id]) await request.delete(`/api/sessions/${id}`);
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
