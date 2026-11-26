import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

test.use({ hasTouch: true });

// Feature: a file an agent's report names opens in the coordinator's Files panel from the agent's own
// worktree, not the coordinator's folder (both hold a file of that name here). Once the worktree is gone,
// the report says so where the path stands.
test("a file an agent's report names opens from its worktree", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === "scripted:stand-in"), "needs a scripted scratch daemon: the agent's work is scripted");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `report-files-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=Keel Test", "-c", "user.email=test@example.invalid", ...a], { cwd: ws, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(ws, "plan.md"), "# The coordinator's plan\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  const { session } = await (await request.post("/api/sessions", { data: { title: "Coordinator", model: "scripted:stand-in", workspace: ws } })).json();
  const id = session.id as string;
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    const work = "printf '# The agent plan\\n\\nShip it.\\n' > plan.md && git add -A && git -c user.name=Agent -c user.email=agent@example.invalid commit -qm 'Write the plan' && echo 'Wrote `plan.md`'";
    const agent = `Write the plan\nscript:calls ${JSON.stringify([{ name: "Bash", input: { command: work } }])}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: agent, isolation: "worktree" } }])}` } });
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { status: string }[])[0]?.status, { timeout: 60_000 }).toBe("completed");
    const mine = ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { session_id: string; worktree?: string; title: string }[])[0]!;
    expect(mine.worktree).toBeTruthy();

    // The report itself is collapsed in the transcript.
    const openReport = async () => {
      const stream = page.getByTestId("lens-to-stream");
      const r = page.locator(`[data-station="${id}"]`).getByTestId("agent-report").last();
      await expect(stream.or(r)).toBeVisible({ timeout: 15_000 });
      if (await stream.isVisible()) await stream.tap();
      await expect(r).toBeVisible({ timeout: 15_000 });
      await r.getByRole("button").first().tap();
      return r;
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${id}`);
    // The link works even if the browser has no idle time to enhance the report.
    const idle = await page.evaluateHandle(() => window.requestIdleCallback);
    await page.evaluate(() => { window.requestIdleCallback = () => 0; });
    const report = await openReport();
    const link = report.getByRole("link", { name: "plan.md" }).first();
    await expect(link).toBeVisible({ timeout: 5000 });
    const lookup = page.waitForRequest((r) => r.url().endsWith(`/api/sessions/${mine.session_id}/files/exist`));
    await link.tap();
    expect((await lookup).postDataJSON()).toEqual({ paths: ["plan.md"] });
    await page.evaluate((restore) => { window.requestIdleCallback = restore; }, idle);
    await idle.dispose();
    const view = page.getByTestId("file-view");
    await expect(view).toHaveAttribute("data-of", mine.session_id);
    await expect(view).toContainText("The agent plan");
    await expect(view).not.toContainText("The coordinator's plan");
    await expect(view.getByTestId("file-of")).toContainText("worktree");
    // Still the coordinator's own view.
    await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
    await shoot(page, "agent-report-files-01-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.reload();
    const desktop = await openReport();
    await desktop.getByRole("link", { name: "plan.md" }).first().press("Enter");
    await expect(view).toHaveAttribute("data-of", mine.session_id);
    await expect(view).toContainText("The agent plan");
    await shoot(page, "agent-report-files-01-open");
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "0.9"));
    await shoot(page, "agent-report-files-02-1320x860-small");
    await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1"));
    await page.setViewportSize({ width: 1920, height: 1040 });

    // The worktree goes (as when its work landed): the path says it is not there any more.
    git("worktree", "remove", "--force", mine.worktree!);
    await page.reload();
    const again = await openReport();
    const gone = again.locator("code.k-fileref", { hasText: "plan.md" }).first();
    await gone.click();
    await expect(gone).toHaveAttribute("data-gone", "1");
    await expect(gone).toHaveAttribute("title", /worktree is gone/);
    await expect(gone).not.toHaveAttribute("data-rel");
    await shoot(page, "agent-report-files-03-gone");
  } finally {
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${id}`);
  }
});
