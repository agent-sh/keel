import { expect, test } from "./isolate.ts";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { shoot } from "./shots.ts";

// Feature: what Claude Code and Codex run on a machine reached over ssh is in
// the session list, under that machine's own line of sessions not in Keel
// (src/fleet/far-outside.ts). The machine is the stand-in ssh host of a scratch
// daemon (scripts/dev.sh: this machine with a scratch home), with no Keel
// daemon on it; a stand-in harness keeps a Claude Code session open there. Its
// row shows its title and state, read-only; opened, it says where it runs and
// in what, and Import a copy opens the import sheet at it. Its words stay on
// that machine. When the harness ends, the row goes.
const HOST = process.env.KEEL_SSH_STANDIN_HOST ?? "keel-standin";
const tag = Date.now().toString(36);
const sid = `7a7a7a7a-1000-4000-8000-${tag.padStart(12, "0").slice(-12)}`;

test("a machine's running Claude Code session: a read-only row under its line, opened where it runs", async ({ page, request }) => {
  test.setTimeout(240_000);
  let machines = (await (await request.get("/api/fleet/machines")).json()).machines as any[];
  test.skip(!machines.some((m) => m.ssh_host === HOST), `the daemon's ssh configuration has no stand-in host ${HOST} (scripts/dev.sh adds it)`);
  await page.setViewportSize({ width: 1920, height: 1040 });

  let m = machines.find((x) => x.ssh_host === HOST && x.enabled);
  const enabledHere = !m;
  if (!m) {
    const r = await (await request.post("/api/fleet/machines", { data: { ssh_host: HOST } })).json();
    m = r.machines.find((x: any) => x.id === r.id);
  }
  const home = m.facts.home as string;
  const proj = join(home, "work", `far-${tag}`);
  mkdirSync(proj, { recursive: true });
  const title = `Check the quince ${tag}`;
  let pid = 0;
  try {
    const p = spawn("bun", [resolve("test/e2e/fixtures/harness-standin.ts"), "--home", home, "--cwd", proj, "--session", sid, "--hold", "600", "--job", "0", "--title", title], { detached: true, stdio: "ignore" });
    p.unref();
    pid = p.pid!;

    await page.goto("/");
    // Its own line, after Keel's sessions: the sessions not in Keel on that machine, by its name.
    const sep = page.locator(`[data-testid="machine-sep"][data-section="external"][data-machine="${m.id}"]`);
    await expect(sep).toContainText(`External on ${m.name}`, { timeout: 60_000 });
    const group = page.locator(`[data-testid="external-group"][data-machine="${m.id}"]`);
    const row = group.locator('[data-testid="session-row"]').filter({ hasText: title });
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    // Its harness is named where the row is read: the title's tooltip.
    await expect(row.locator(".k-row-title")).toHaveAttribute("title", /Runs in Claude Code: read-only here/);
    // The daemon carries the row and its title, none of the session's words.
    const view = await (await request.get("/api/fleet?others")).json();
    const far = view.machines.find((x: any) => x.id === m.id);
    expect(far.sessions.map((s: any) => s.outside.source_id)).toEqual([sid]);
    expect(JSON.stringify(far.sessions)).not.toContain("slow check");
    // Nothing to pin or archive: this daemon holds its row only.
    await row.hover();
    await expect(row.getByTestId("row-pin")).toHaveCount(0);
    await expect(row.getByTestId("row-archive")).toHaveCount(0);
    await shoot(page, "far-outside-01-row");

    // Opened: where it runs and in what, and no box to type in.
    await row.click();
    const pane = page.getByTestId("far-outside");
    await expect(pane.getByTestId("far-outside-where")).toHaveText(`Claude Code runs this session on ${m.name}`);
    await expect(pane.getByTestId("far-outside-title")).toHaveText(title);
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await shoot(page, "far-outside-02-opened");

    // Import a copy: the sheet, at that machine's running session.
    await pane.getByTestId("far-outside-import").click();
    const sheet = page.getByTestId("import-sheet");
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await expect(sheet.locator(`[data-testid="import-machine-running-row"][data-id="${sid}"]`)).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");

    // The harness ends: its row goes at the machine's next word.
    await expect(row).toHaveCount(1);
    process.kill(pid, "SIGTERM");
    pid = 0;
    await expect(row).toHaveCount(0, { timeout: 90_000 });
    await expect(sep).toHaveCount(0);
  } finally {
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
    if (enabledHere) await request.delete(`/api/fleet/machines/${m.id}`);
    rmSync(join(home, ".claude", "projects", proj.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
