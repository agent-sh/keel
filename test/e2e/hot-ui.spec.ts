import { expect, test } from "./isolate.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a new UI without a daemon restart. A bundle built from the same
// daemon sources is installed with `keel ui install` while a turn runs: the
// turn goes on, an open page at rest reloads into the new page by itself, and
// a page with text in its box offers the reload and keeps the text across it.
// A bundle from other sources is refused. The daemon is put back on its
// embedded page at the end.
const DIR = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state", `hot-ui-${Date.now()}`);

// The page as built now, with a visible change: another title, a newer version.
let built = "";
function bundle(name: string, title: string, api?: string): { file: string; version: number } {
  mkdirSync(DIR, { recursive: true });
  if (!built) {
    built = join(DIR, "built.tar.gz");
    const b = spawnSync("bun", ["scripts/build.ts", "--ui", built], { encoding: "utf8" });
    expect(b.status, b.stderr).toBe(0);
  }
  const file = join(DIR, `${name}.tar.gz`);
  const r = spawnSync("bun", ["test/e2e/fixtures/repack-ui.ts", built, file, title, ...(api ? [api] : [])], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return { file, version: Number(r.stdout.trim()) };
}

const install = (url: string, file: string) => spawnSync("bun", ["src/main.ts", "ui", "install", file, "--url", url], { encoding: "utf8" });

test("a UI bundle installs while a turn runs, and open pages reload into it", async ({ page, baseURL }) => {
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(baseURL + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Hot UI" });
  await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
  try {
    await page.goto(`/s/${session.id}`);
    const served = () => page.locator('meta[name="keel-ui"]').getAttribute("content").catch(() => null);
    // A turn whose tool runs 30 s.
    await call(`/api/sessions/${session.id}/messages`, { text: "script:long-tool" });
    await expect(page.getByTestId("transcript").getByText("Running a long command.")).toBeVisible({ timeout: 20_000 });
    await shoot(page, "hot-ui-01-turn-running");

    // Installed mid-turn: the page at rest reloads into it, the turn goes on.
    const a = bundle("a", "Keel (updated)");
    const pid = (await call("/api/health")).pid;
    const r = install(baseURL!, a.file);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`installed ${a.version}`);
    await expect.poll(served, { timeout: 15_000 }).toBe(String(a.version));
    await expect(page.getByTestId("transcript").getByText("Running a long command.")).toBeVisible();
    const mid = await call(`/api/sessions/${session.id}`);
    expect(mid.running, "the turn still runs").toBe(true);
    expect((await call("/api/health")).pid, "the same daemon").toBe(pid);
    await shoot(page, "hot-ui-02-reloaded-mid-turn");

    // Text in the box: the page offers the reload instead, and keeps the text.
    await page.getByTestId("composer").fill("half a thought");
    const b = bundle("b", "Keel (again)");
    expect(install(baseURL!, b.file).status).toBe(0);
    await expect(page.getByTestId("ui-update")).toBeVisible({ timeout: 10_000 });
    expect(await served()).toBe(String(a.version));
    await shoot(page, "hot-ui-03-reload-offered");
    await page.getByTestId("ui-update-reload").click();
    await expect.poll(served, { timeout: 15_000 }).toBe(String(b.version));
    await expect(page.getByTestId("composer")).toHaveValue("half a thought");
    await page.getByTestId("composer").fill("");

    // The turn ends on its own, in the same daemon.
    await expect(page.getByTestId("transcript").getByText("Finished after the tool.")).toBeVisible({ timeout: 60_000 });

    // Built from other daemon sources: refused, nothing changes.
    const c = bundle("c", "Keel (other)", "0000000000000000");
    const refused = install(baseURL!, c.file);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("daemon restart");
    expect((await call("/api/ui")).active.version).toBe(String(b.version));

    // Rollback: the one before, then the embedded page.
    await call("/api/ui/rollback", {});
    expect((await call("/api/ui")).active.version).toBe(String(a.version));
    await call("/api/ui/rollback", {});
    expect((await call("/api/ui")).active.source).toBe("embedded");
  } finally {
    await fetch(`${baseURL}/api/sessions/${session.id}`, { method: "DELETE" });
  }
});
