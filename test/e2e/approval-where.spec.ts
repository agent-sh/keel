import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: an approval says where its command runs when that is not the folder of the page it is
// answered on. An agent in a worktree of its own asks on its parent's page: its card names the
// worktree and the branch, so a command that writes there is not taken for one in the owner's checkout.
test("an agent's approval names the worktree and branch it runs in", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string }[];
  const model = models.find((m) => m.id === "scripted:stand-in")?.id;
  test.skip(!model, "requires a scripted scratch daemon");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `where-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=Keel Test", "-c", "user.email=test@example.invalid", ...a], { cwd: ws, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(ws, "cart.test.js"), "// tests\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  const { session } = await (await request.post("/api/sessions", { data: { title: "Shop", model, workspace: ws } })).json();
  const id = session.id as string;
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    const agent = `Add a test\nscript:calls ${JSON.stringify([{ name: "Bash", input: { command: "printf 'test()\\n' >> cart.test.js" } }])}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: agent, isolation: "worktree" } }])}` } });
    await page.goto(`/s/${id}`);
    const theirs = page.locator(`[data-station="${id}"]`).getByTestId("child-approvals").getByTestId("approval");
    await expect(theirs).toHaveCount(1, { timeout: 30_000 });
    const where = theirs.getByTestId("approval-where");
    await expect(where).toBeVisible();
    // The worktree is the agent's own folder (not the session's), on a branch of its own.
    const mine = ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { worktree?: string; branch?: string }[])[0]!;
    expect(mine.worktree).toBeTruthy();
    await expect(where).toHaveText(`in ${mine.worktree!.split("/").at(-1)}, branch ${mine.branch}`);
    await shoot(page, "approval-where-01-agent");
  } finally {
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${id}`);
  }
});

// An agent's command that starts outside its worktree (here in the parent's checkout) runs on that
// checkout's branch: its card names that folder, not the agent's worktree, and not the agent's branch.
test("an agent's command outside its worktree names the folder it runs in, without the agent's branch", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  const model = models.find((m) => m.id === "scripted:gpt-stand-in")?.id;
  test.skip(!model, "requires a scripted scratch daemon");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `where-out-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=Keel Test", "-c", "user.email=test@example.invalid", ...a], { cwd: ws, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(ws, "cart.test.js"), "// tests\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  const { session } = await (await request.post("/api/sessions", { data: { title: "Shop", model, workspace: ws } })).json();
  const id = session.id as string;
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    const agent = `Add a test\nscript:calls ${JSON.stringify([{ name: "exec_command", input: { cmd: "printf 'test()\\n' >> cart.test.js", workdir: ws } }])}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: agent, isolation: "worktree" } }])}` } });
    await page.goto(`/s/${id}`);
    const theirs = page.locator(`[data-station="${id}"]`).getByTestId("child-approvals").getByTestId("approval");
    await expect(theirs).toHaveCount(1, { timeout: 30_000 });
    const mine = ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { worktree?: string; branch?: string }[])[0]!;
    expect(mine.branch).toBeTruthy();
    const where = theirs.getByTestId("approval-where");
    await expect(where).toHaveText(`in ${ws.split("/").at(-1)}`);
    await expect(where).toHaveAttribute("title", ws);
    await shoot(page, "approval-where-02-outside");
  } finally {
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${id}`);
  }
});
