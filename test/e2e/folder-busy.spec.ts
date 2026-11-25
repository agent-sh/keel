import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: the start box says when sessions already work in the chosen folder, and offers a worktree there. One
// session works in a folder; the box on the same folder names it and its button turns the worktree toggle on; a
// folder nobody works in, and a start that is in a worktree already, show no notice.
test("the start box names the sessions working in the folder and offers a worktree", async ({ page, request }) => {
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `busy-${Date.now()}`);
  const mk = (name: string) => {
    const d = join(top, name);
    mkdirSync(d, { recursive: true });
    git(d, "init", "-q", "-b", "main");
    writeFileSync(join(d, "a.txt"), "a\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "init");
    return d;
  };
  const busy = mk("busy"), idle = mk("idle");
  const gate = join(top, "release");
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: busy, title: "Fix the build", model: HAIKU } })).json();
  try {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `while [ ! -e '${gate}' ]; do sleep 0.2; done`, timeout: 120000 } }])}` } });
    await expect.poll(async () => (await (await request.get("/api/sessions")).json()).sessions.find((s: any) => s.id === session.id)?.phase, { timeout: 30_000 }).toBe("working");

    await page.goto("/");
    await page.evaluate(([ws]) => { localStorage.setItem("keel.newWorkspace", JSON.stringify(ws)); localStorage.setItem("keel.startInWorktree", "0"); }, [busy]);
    await page.reload();
    const notice = page.getByTestId("folder-busy");
    await expect(notice).toHaveText(/^A session works in this folder \(Fix the build\)\.\s*Start in a worktree$/);
    await shoot(page, "folder-busy-01-notice");
    // One press turns the worktree on, and the notice is not needed any more.
    await page.getByTestId("folder-busy-worktree").click();
    await expect(page.getByTestId("start-in-worktree")).toHaveAttribute("aria-checked", "true");
    await expect(notice).toHaveCount(0);
    await shoot(page, "folder-busy-02-worktree");

    // A folder nobody works in has no notice.
    await page.evaluate(([ws]) => { localStorage.setItem("keel.newWorkspace", JSON.stringify(ws)); localStorage.setItem("keel.startInWorktree", "0"); }, [idle]);
    await page.reload();
    await expect(page.getByTestId("start-in-worktree")).toBeVisible();
    await expect(page.getByTestId("folder-busy")).toHaveCount(0);
  } finally {
    writeFileSync(gate, "");
    await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${session.id}`);
  }
});
