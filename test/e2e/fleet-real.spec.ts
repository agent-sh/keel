import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSite } from "./fixtures/dev-site.ts";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: the fleet on real machines. Each machine named in KEEL_REAL_MACHINES
// (names of enabled machines, reached over ssh, each running its own keel-bun
// on loopback) is linked, runs a tool for a session placed on it, and takes a
// session with its git state and gives it back. KEEL_REAL_DRIVEN names one
// whose daemon has a model: a session started there shows up in this list and
// runs a turn there, driven from here, and the dev server it starts there opens
// in this Preview panel, its socket included (KEEL_REAL_BUN: a command that
// runs bun there, such as a keel-bun binary with BUN_BE_BUN=1).
const NAMES = (process.env.KEEL_REAL_MACHINES ?? "").split(",").filter(Boolean);
const DRIVEN = process.env.KEEL_REAL_DRIVEN ?? "";
const BUN_THERE = process.env.KEEL_REAL_BUN ?? "bun";
const HOME_DIR = `${process.env.HOME}/.cache/keel-work/bun/dev-fleet2/real-${Date.now().toString(36)}`;

test.skip(!NAMES.length, "needs KEEL_REAL_MACHINES");
test.setTimeout(600_000);

test("fleet on real machines: linked, a tool there, a move there and back, a session over there", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const { machines } = await (await request.get("/api/fleet/machines")).json();
  const real = NAMES.map((n) => machines.find((m: any) => m.name === n && m.source === "ssh"));
  expect(real.every(Boolean)).toBe(true);
  const made: string[] = [];
  mkdirSync(HOME_DIR, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", HOME_DIR, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(`${HOME_DIR}/a.txt`, "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");

  try {
    await page.goto("/settings/machines");
    for (const m of real) {
      await request.post(`/api/fleet/machines/${m.id}/check`);
      const row = page.locator('[data-testid="machine-row"]').filter({ hasText: m.name });
      await expect(row.getByTestId("machine-link")).toContainText("linked", { timeout: 30_000 });
      await expect(row.getByTestId("machine-state")).toContainText(/ready|busy/);
    }
    await shoot(page, "fleet-real-01-machines");

    for (const m of real) {
      // A session placed there: its shell runs there.
      const s = (await (await request.post("/api/fleet/sessions", { data: { machine: m.id, model: HAIKU, title: `On ${m.name}` } })).json()).session;
      made.push(s.id);
      await page.goto(`/s/${s.id}`);
      await page.getByTestId("composer").fill("Run this with the Bash tool, one call: uname -sm && pwd. Then reply with the output only.");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
      const tool = page.locator('[data-tool="Bash"]').first();
      await expect(tool.getByTestId("tool-machine")).toHaveText(m.name);
      await tool.click();
      await expect(tool).toContainText(m.facts.os === "macos" ? "Darwin arm64" : "Linux x86_64");
      await expect(tool).toContainText(m.workspace_root);
      await shoot(page, `fleet-real-02-tool-${m.facts.os}`);

      // A session with an uncommitted change goes there and comes back with its work.
      git("checkout", "-q", "--", ".");
      writeFileSync(`${HOME_DIR}/a.txt`, "one\ntwo\n");
      const mv = (await (await request.post("/api/sessions", { data: { workspace: HOME_DIR, title: `Move to ${m.name}`, model: HAIKU } })).json()).session;
      made.push(mv.id);
      await page.goto(`/s/${mv.id}`);
      await page.getByTestId("machine-chip").click();
      await page.locator(`[data-testid="move-to"][data-machine="${m.id}"]`).click();
      await expect(page.getByTestId("move-progress")).toHaveAttribute("data-state", "done", { timeout: 120_000 });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("machine-chip")).toContainText(m.name);
      await page.getByTestId("composer").fill("Run this with the Bash tool, one call: echo three >> a.txt && cat a.txt && uname -s. Then reply with the output only.");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
      const t2 = page.locator('[data-tool="Bash"]').first();
      await expect(t2.getByTestId("tool-machine")).toHaveText(m.name);
      await t2.click();
      await expect(t2).toContainText("two");
      await expect(t2).toContainText(m.facts.os === "macos" ? "Darwin" : "Linux");
      await page.getByTestId("machine-chip").click();
      await page.locator('[data-testid="move-to"][data-machine="local"]').click();
      await expect(page.getByTestId("move-progress")).toContainText(`${m.name} to`, { timeout: 120_000 });
      await expect(page.getByTestId("move-progress")).toHaveAttribute("data-state", "done");
      await shoot(page, `fleet-real-03-moved-back-${m.facts.os}`);
      await page.keyboard.press("Escape");
      expect(readFileSync(`${HOME_DIR}/a.txt`, "utf8")).toBe("one\ntwo\nthree\n");
    }

    // Each machine's own transcripts, read by its daemon (shape only: they are the owner's).
    for (const m of real) {
      const t = await (await request.get(`/api/fleet/machines/${m.id}/transcripts?limit=3`)).json();
      expect(t.machine).toBe(m.name);
      expect(Array.isArray(t.sessions)).toBe(true);
      for (const x of t.sessions) expect(x.path).not.toMatch(/(^|\/)\.ssh(\/|$)/);
    }

    if (DRIVEN) {
      // A session that lives on that daemon: in this list, its turn runs there.
      const m = real.find((x) => x.name === DRIVEN)!;
      const local = `${HOME_DIR}-site`;
      writeSite(local);
      const site = `${m.workspace_root}/site-${Date.now().toString(36)}`;
      execFileSync("scp", ["-q", "-r", local, `${m.ssh_host}:${site}`]);
      const s = (await (await request.post(`/api/fleet/machines/${m.id}/api/sessions`, { data: { workspace: site, title: "Lives over there", model: HAIKU } })).json()).session;
      await request.put(`/api/fleet/machines/${m.id}/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
      await page.goto("/");
      const row = page.locator(`[data-testid="session-row"][data-session="${m.id}--${s.id}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.click();
      await expect(page.getByTestId("machine-chip")).toContainText(m.name);
      await page.getByTestId("composer").fill("Reply with the single word: pong");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
      const evs = (await (await request.get(`/api/fleet/machines/${m.id}/api/sessions/${s.id}/events`)).json()).events;
      expect(JSON.stringify(evs.filter((e: any) => e.kind === "assistant").map((e: any) => e.data.blocks))).toMatch(/pong/i);
      await shoot(page, "fleet-real-04-session-over-there");

      // A session here waits for that one to handle a message: one notice, from its own record.
      const sender = (await (await request.post("/api/sessions", { data: { title: "Waits for over there", model: HAIKU } })).json()).session;
      made.push(sender.id);
      await request.put(`/api/sessions/${sender.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
      await request.post(`/api/sessions/${sender.id}/messages`, { data: { text: `Make one keel__session_send call to "${m.name}/${s.id}" with notify_when_idle true and text "Reply right in your own conversation, without any tool, with the single word: done". Then reply "waiting" and stop.` } });
      await expect.poll(async () => ((await (await request.get("/api/waits")).json()).waits as any[]).find((w) => w.session_id === sender.id && w.kind === "session")?.status, { timeout: 150_000 }).toBe("fired");
      const evsHere = (await (await request.get(`/api/sessions/${sender.id}/events`)).json()).events;
      expect(JSON.stringify(evsHere.filter((e: any) => e.kind === "user").map((e: any) => e.data.text))).toContain("handled your message and is idle");

      const port = 40000 + Math.floor(Math.random() * 20000);
      await page.getByTestId("composer").fill(`Use the Bash tool once with run_in_background true to run: ${BUN_THERE} serve.ts ${port}. Then reply "started".`);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 120_000 });
      await openPanel(page, "preview");
      const p = page.locator(`[data-testid="preview-port"][data-port="${port}"]`);
      await expect(p).toBeVisible({ timeout: 20_000 });
      await p.click();
      const frame = page.frameLocator('[data-testid="preview-frame"]');
      await expect(frame.locator("h1")).toHaveCSS("color", "rgb(13, 148, 136)");
      await expect(frame.locator("#d")).toHaveText("fetched through the portal");
      await expect(frame.locator(".ws")).toHaveText(["hello from the dev server", "echo ping test-hmr"]);
      await shoot(page, "fleet-real-05-portal-over-there");
      rmSync(local, { recursive: true, force: true });
      await page.goto("/settings/machines");
      await request.delete(`/api/fleet/machines/${m.id}/api/sessions/${s.id}`);
      execFileSync("ssh", [m.ssh_host, "rm", "-rf", "--", site]);
    }

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
    await request.put("/api/permissions/settings", { data: { default_mode: prev } });
    rmSync(HOME_DIR, { recursive: true, force: true });
  }
});
