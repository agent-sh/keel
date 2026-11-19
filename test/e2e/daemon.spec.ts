import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the daemon keeps the machine awake while a turn runs, and a restart
// from Settings > Daemon lets the running turn finish first; a restart that
// cannot wait parks the turn and it continues by itself after the start.
const daemon = async (request: APIRequestContext) => {
  try {
    const r = await request.get("/api/daemon", { timeout: 2000 });
    return r.ok() ? await r.json() : null;
  } catch { return null; }
};
const events = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
const inhibitors = (pid: number) => execFileSync("systemd-inhibit", ["--list", "--no-pager"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`daemon pid ${pid})`)).length;

test("keep awake, restart after turns, a parked turn continues", async ({ page, request }) => {
  test.setTimeout(360_000);
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const pid0 = (await daemon(request)).pid;

  // A turn that runs for a while.
  const a = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Restart waits for me", text: "Run `sleep 12` with your shell tool in the foreground, then reply with the word finished." } })).json()).session;
  await expect.poll(async () => (await daemon(request))?.running.includes(a.id), { timeout: 60_000 }).toBe(true);

  await page.goto("/settings/daemon");
  const panel = page.getByTestId("daemon-panel");
  await expect(panel.getByTestId("daemon-running")).toHaveText("1");
  const awake = await (await request.get("/api/awake")).json();
  if (awake.available) {
    await expect(panel.getByTestId("awake-state")).toHaveText("Held");
    expect(inhibitors(pid0)).toBe(1);
  }
  await shoot(page, "daemon-01-turn-running");

  // Restart from the page: the turn finishes, then the daemon comes back.
  await panel.getByTestId("daemon-restart").click();
  await page.getByTestId("confirm").getByRole("button", { name: "Restart" }).click();
  await expect(panel.getByTestId("daemon-status")).toContainText(/Restarting|Reconnecting/);
  await expect(page.getByTestId("admin-band")).toContainText("Keel restarts when the running turns finish");
  expect((await request.post("/api/sessions", { data: { model: HAIKU, title: "refused" } })).status()).toBe(503);
  await shoot(page, "daemon-02-draining");
  await expect.poll(async () => { const d = await daemon(request); return d && d.pid !== pid0 ? d.pid : 0; }, { timeout: 120_000, intervals: [1000] }).toBeGreaterThan(0);
  const ev = await events(request, a.id);
  expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).not.toContain("restart");
  expect(ev.some((e) => e.kind === "assistant" && JSON.stringify(e.data.blocks).toLowerCase().includes("finished"))).toBe(true);
  await expect(panel.getByTestId("daemon-status")).toContainText("pid", { timeout: 30_000 });
  await shoot(page, "daemon-03-back");

  // A restart that does not wait: the turn is parked and continues after the start.
  const pid1 = (await daemon(request)).pid;
  const b = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Parked and continued", text: "Run `sleep 20` with your shell tool in the foreground, then reply with the word continued." } })).json()).session;
  await expect.poll(async () => (await events(request, b.id)).some((e) => e.kind === "assistant"), { timeout: 60_000 }).toBe(true);
  await request.post("/api/drain", { data: { restart: true, timeout_seconds: 1 } });
  await expect.poll(async () => { const d = await daemon(request); return d && d.pid !== pid1 ? d.pid : 0; }, { timeout: 120_000, intervals: [1000] }).toBeGreaterThan(0);
  await expect.poll(async () => (await events(request, b.id)).some((e) => e.kind === "user" && e.data.origin === "restart"), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await events(request, b.id)).filter((e) => e.kind === "turn_end").length, { timeout: 120_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${b.id}`)).json()).session.phase, { timeout: 30_000 }).toBe("idle");
  if (awake.available) expect(inhibitors(pid1) + inhibitors(pid0)).toBe(0);

  await page.goto(`/s/${b.id}`);
  await expect(page.getByTestId("restart-note")).toBeVisible();
  await shoot(page, "daemon-04-continued");

  // The problem report is written from the page.
  await page.goto("/settings/daemon");
  await page.getByTestId("report-write").click();
  await expect(page.getByTestId("daemon-panel")).toContainText("Written to");

  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  for (const s of [a, b]) await request.delete(`/api/sessions/${s.id}`);
});
