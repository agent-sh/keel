import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: an agent's report of work on a branch of its own leads to that work. Beside what the
// report says (its branch, its worktree), the report offers the branch's review and the agent's session.
test("an agent's report offers its branch's review and its session", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  const model = models.find((m) => m.id === "scripted:stand-in")?.id;
  test.skip(!model, "requires a scripted scratch daemon");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `report-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=Keel Test", "-c", "user.email=test@example.invalid", ...a], { cwd: ws, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(ws, "cart.js"), "// cart\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  const { session } = await (await request.post("/api/sessions", { data: { title: "Shop", model, workspace: ws } })).json();
  const id = session.id as string;
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    const work = "printf 'test()\\n' > cart.test.js && git add -A && git -c user.name=Agent -c user.email=agent@example.invalid commit -qm 'Add a test'";
    const agent = `Add a test\nscript:calls ${JSON.stringify([{ name: "Bash", input: { command: work } }])}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: agent, isolation: "worktree" } }])}` } });
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { status: string }[])[0]?.status, { timeout: 60_000 }).toBe("completed");
    const mine = ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { session_id: string; branch?: string }[])[0]!;
    expect(mine.branch).toBeTruthy();

    await page.goto(`/s/${id}`);
    const report = page.locator(`[data-station="${id}"]`).getByTestId("agent-report").last();
    await expect(report).toBeVisible({ timeout: 30_000 });
    await report.getByRole("button").first().click();
    const acts = report.getByTestId("agent-report-actions");
    await expect(acts).toContainText(mine.branch!);
    await expect(acts.getByTestId("agent-report-review")).toHaveText("Review the branch");
    await shoot(page, "agent-report-actions-01");
    // The review is of the agent's branch, in the Review panel.
    const posted = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/sessions/${id}/reviews`);
    await acts.getByTestId("agent-report-review").click();
    expect((await posted).postDataJSON()).toMatchObject({ agent_id: expect.any(String) });
    // Its session opens from the report.
    await acts.getByTestId("agent-report-open").click();
    await expect(page).toHaveURL(new RegExp(`/s/${mine.session_id}$`));
  } finally {
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${id}`);
  }
});
