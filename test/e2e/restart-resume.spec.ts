import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a daemon restart does not lose a running turn. A crash (SIGKILL)
// leaves the turn open: the next daemon closes it, marks the tool call it cut
// and continues the turn by itself. A stop (SIGTERM) parks the turn after a
// short drain and the next daemon continues it the same way. This spec runs
// its own daemons on a scratch state folder, on the scripted stand-in.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", state], {
    env: { ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); resolve({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

test("a turn cut by a daemon restart continues by itself", async ({ page }) => {
  const state = join(ROOT, `restart-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  try {
    const post = (url: string, path: string, body: unknown, method = "POST") =>
      fetch(url + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const { session } = await post(d.url, "/api/sessions", { model: "scripted:stand-in" });
    await post(d.url, `/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");

    // A crash while the tool runs.
    await page.goto(`${d.url}/s/${session.id}`);
    await page.getByTestId("composer").fill("script:long-tool");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("tool-call")).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(1_000); // the command runs
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state);
    await page.goto(`${d.url}/s/${session.id}`);
    await expect(page.getByTestId("turn-end").first()).toContainText("Cut by a daemon restart", { timeout: 60_000 });
    await expect(page.getByTestId("restart-note")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Continued after the restart.", { timeout: 15_000 });
    await expect(page.getByTestId("turn-end")).toHaveCount(2);
    await shoot(page, "restart-01-resumed-after-crash");

    // A graceful stop while the tool runs: parked, then continued.
    await page.getByTestId("composer").fill("script:long-tool");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("tool-call")).toHaveCount(2, { timeout: 15_000 });
    await page.waitForTimeout(1_000);
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state);
    await page.goto(`${d.url}/s/${session.id}`);
    await expect(page.getByTestId("restart-note")).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId("turn-end")).toHaveCount(4, { timeout: 15_000 });
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Continued after the restart.");

    // The model was told which calls the restarts cut.
    const ev = await (await fetch(`${d.url}/api/sessions/${session.id}`)).json() as any;
    const cut = ev.events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).filter((r: any) => /daemon restart/.test(r.content));
    expect(cut).toHaveLength(2);
    expect(ev.events.filter((e: any) => e.kind === "turn_end").map((e: any) => e.data.reason)).toEqual(["restart", "end_turn", "restart", "end_turn"]);
    await page.getByTestId("tool-call").first().click();
    await shoot(page, "restart-02-resumed-after-stop");
  } finally {
    d.proc.kill("SIGKILL");
  }
});
