import { expect, test } from "./isolate.ts";
import { freePort } from "./ports.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a restart makes a backup first, and a backup that fails calls the
// restart off: no turn is cut, the failure is one error, the page and
// `keel restart` say so, and the same daemon takes work again, a wake that
// came due while it drained included. Once the fault is gone the restart goes
// through. Runs its own daemon on a scratch state
// folder, on the scripted stand-in.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const FAILED = "The backup before the restart failed";

function daemon(state: string, port: number): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", join(state, "state"), "--workspace", join(state, "work")], {
    env: {
      ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_RESUME_GAP_MS: "0",
      KEEL_CONFIG_DIR: join(state, "config"), KEEL_IMPORT_HOME: join(state, "home"), KEEL_DESKTOP_NOTIFY: "off", TACIT_BIN: resolve("test/e2e/fixtures/tacit-standin.sh"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      if (out.includes("keel listening")) { clearTimeout(t); done({ proc, url: `http://127.0.0.1:${port}` }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}

test("a failed backup calls the restart off; the retry restarts", async ({ page }) => {
  test.setTimeout(240_000);
  const state = join(ROOT, `restart-backup-${Date.now()}`);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  const d = await daemon(state, await freePort());
  // One connection per call: a kept one would be the old daemon's after the restart.
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json", connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...((await r.json()) as any) }));
  // Not a blocking spawn: this process is the daemon's parent. The old daemon
  // is not gone until its parent takes its exit, and the new one waits for that.
  const restart = (timeout: number) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const p = spawn("bun", ["src/main.ts", "restart", "--timeout", String(timeout), "--url", d.url], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout!.on("data", (b) => (stdout += b));
    p.stderr!.on("data", (b) => (stderr += b));
    p.once("exit", (status) => done({ status, stdout, stderr }));
  });
  const events = async (id: string) => (await call(`/api/sessions/${id}`)).events as any[];
  const failures = async () => (await call("/api/errors")).errors.filter((e: any) => e.message.includes(FAILED));
  const pid0 = (await call("/api/daemon")).pid as number;
  try {
    // A turn whose tool runs 30 s, and a backups folder that cannot be written.
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Runs through a called-off restart" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    await call(`/api/sessions/${session.id}/messages`, { text: "script:long-tool" });
    await expect.poll(async () => (await call(`/api/sessions/${session.id}`)).events.some((e: any) => e.kind === "assistant"), { timeout: 30_000 }).toBe(true);
    // A session that waits on a timer: it comes due while the daemon drains.
    const waiter = (await call("/api/sessions", { model: "scripted:stand-in", title: "Woken after a called-off restart" })).session;
    await call(`/api/sessions/${waiter.id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "wait_for", input: { kind: "timer", seconds: 6, note: "due during the drain" } }])}` });
    await expect.poll(async () => (await events(waiter.id)).filter((e) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);
    const fault = join(state, "state", "backups");
    writeFileSync(fault, "not a folder");

    // The restart gives the turn 10 s, less than it needs: the backup fails, and it is called off.
    expect((await events(waiter.id)).filter((e) => e.kind === "user")).toHaveLength(1);
    const off = await restart(10);
    expect(off.status, off.stdout + off.stderr).toBe(1);
    expect(off.stderr).toContain(`the restart was called off, and the daemon (pid ${pid0}) takes work again. ${FAILED}`);
    const st = await call("/api/daemon");
    expect(st).toMatchObject({ pid: pid0, draining: null });
    expect(st.restart_failed.error).toContain(FAILED);
    expect(await failures()).toMatchObject([{ source: "server", count: 1 }]);
    // The timer came due while no turn started: its wake is sent now, not at the session's next prompt.
    await expect.poll(async () => (await events(waiter.id)).filter((e) => e.kind === "user").length, { timeout: 15_000 }).toBe(2);
    expect((await events(waiter.id)).filter((e) => e.kind === "user")[1].ts).toBeGreaterThanOrEqual(st.restart_failed.ts_ms);
    // The same daemon takes work.
    const next = await call("/api/sessions", { model: "scripted:stand-in", title: "Taken after the called-off restart" });
    expect(next.status).toBe(201);

    await page.goto(`${d.url}/settings/daemon`);
    const panel = page.getByTestId("daemon-panel");
    await expect(panel.getByTestId("daemon-status")).toContainText(`pid ${pid0}`);
    await expect(panel.getByTestId("daemon-restart-failed")).toContainText(FAILED);
    await expect(page.getByTestId("admin-band")).toHaveCount(0);
    await shoot(page, "restart-backup-01-called-off");

    // The turn was never cut: it ends by itself, with no restart in it.
    await expect.poll(async () => (await call(`/api/sessions/${session.id}`)).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(1);
    const ev = (await call(`/api/sessions/${session.id}`)).events as any[];
    expect(ev.find((e) => e.kind === "turn_end").data.reason).not.toBe("restart");
    expect(ev.some((e) => e.kind === "user" && e.data.origin === "restart")).toBe(false);
    expect(JSON.stringify(ev.findLast((e) => e.kind === "assistant").data.blocks)).toContain("Finished after the tool.");

    // From the page, the fault still there: called off again, the same error once more.
    const before = (await call("/api/daemon")).restart_failed.ts_ms;
    await panel.getByTestId("daemon-restart").click();
    await page.getByTestId("confirm").getByRole("button", { name: "Restart" }).click();
    await expect.poll(async () => (await call("/api/daemon")).restart_failed?.ts_ms ?? before, { timeout: 30_000 }).toBeGreaterThan(before);
    await expect(panel.getByTestId("daemon-restart")).toBeEnabled();
    await expect(panel.getByTestId("daemon-restart-failed")).toBeVisible();
    expect(await failures()).toMatchObject([{ count: 2 }]);
    expect((await call("/api/daemon")).pid).toBe(pid0);

    // The fault is gone: the restart goes through, with its backup.
    rmSync(fault);
    const ok = await restart(5);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    const last = (await call("/api/daemon")).pid;
    expect(last).not.toBe(pid0);
    expect(ok.stdout).toContain(`restarted: pid ${last}`);
    expect((await call("/api/daemon")).restart_failed).toBeNull();
    expect((await call("/api/backups")).backups).toMatchObject([{ reason: "before a restart", sessions: 3 }]);
    await page.reload();
    await expect(panel.getByTestId("daemon-status")).toContainText(`pid ${last}`, { timeout: 30_000 });
    await expect(panel.getByTestId("daemon-restart-failed")).toHaveCount(0);
    await shoot(page, "restart-backup-02-restarted");
  } finally {
    // The restarted daemon is not this test's child: it is asked to stop at its
    // own address, once it says it serves this test's state folder.
    const now = await call("/api/daemon").catch(() => null);
    if (now?.state_dir === join(state, "state")) {
      await call("/api/drain", { timeout_seconds: 0 }).catch(() => null);
      for (let i = 0; i < 40 && (await call("/api/daemon").then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 500));
    }
    d.proc.kill("SIGKILL");
    rmSync(state, { recursive: true, force: true });
  }
});
