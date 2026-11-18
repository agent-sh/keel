import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { HAIKU, shoot } from "./shots.ts";

// Feature: moving a session to another machine with its git state and back.
// Its uncommitted change travels, the model works on it over there, and coming
// back the folder it left gets the result; deleting the session removes the
// worktree it had over there.
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;
const HOME_DIR = `${process.env.HOME}/.cache/keel-work/bun/dev-fleet/move-${Date.now().toString(36)}`;

test("fleet move: there with its git state, work there, back home", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  mkdirSync(ROOT, { recursive: true });
  let { machines } = await (await request.get("/api/fleet/machines")).json();
  if (!machines.some((m: any) => m.daemon_url === PEER)) await request.post("/api/fleet/machines", { data: { name: "devbox", daemon_url: PEER, workspace_root: ROOT } });
  mkdirSync(HOME_DIR, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", HOME_DIR, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(`${HOME_DIR}/a.txt`, "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  writeFileSync(`${HOME_DIR}/a.txt`, "one\ntwo\n"); // uncommitted: it must travel
  const s = (await (await request.post("/api/sessions", { data: { workspace: HOME_DIR, title: "Move me", model: HAIKU } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });

  try {
    await page.goto(`/s/${s.id}`);
    await page.getByTestId("machine-chip").click();
    await page.locator('[data-testid="move-to"]').filter({ hasText: "devbox" }).click();
    await expect(page.getByTestId("move-progress")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(page.getByTestId("move-progress")).toContainText("Last move");
    await shoot(page, "fleet-move-01-there");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("machine-chip")).toContainText("devbox");
    await expect(page.getByTestId("note").filter({ hasText: "Moved from" })).toBeVisible();

    await page.getByTestId("composer").fill("Run this with the Bash tool, one call: echo three >> a.txt && cat a.txt && pwd. Then reply with the output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
    const tool = page.locator('[data-tool="Bash"]').first();
    await tool.click();
    await expect(tool.getByTestId("tool-machine")).toHaveText("devbox");
    await expect(tool).toContainText("two");
    await expect(tool).toContainText("/.keel/worktrees/handoff-");
    expect(readFileSync(`${HOME_DIR}/a.txt`, "utf8")).toBe("one\ntwo\n"); // the folder it left is untouched

    await page.getByTestId("machine-chip").click();
    await page.locator('[data-testid="move-to"][data-machine="local"]').click();
    await expect(page.getByTestId("move-progress")).toContainText("devbox to", { timeout: 60_000 });
    await expect(page.getByTestId("move-progress")).toHaveAttribute("data-state", "done");
    await shoot(page, "fleet-move-02-back");
    await page.keyboard.press("Escape");
    expect(readFileSync(`${HOME_DIR}/a.txt`, "utf8")).toBe("one\ntwo\nthree\n");
    expect(git("status", "--short")).toContain("M a.txt");

    const away = (await (await request.get(`/api/sessions/${s.id}/handoff`)).json()).handoff.away;
    const wt = Object.values(away)[0] as string;
    expect(existsSync(wt)).toBe(true);
    await request.delete(`/api/sessions/${s.id}`);
    await expect.poll(() => existsSync(wt), { timeout: 20_000 }).toBe(false);

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    await request.delete(`/api/sessions/${s.id}`);
  }
});
