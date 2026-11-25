import { expect, test, type Page } from "./isolate.ts";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shoot } from "./shots.ts";

// Feature: the other machines' harness sessions in the import sheet. The
// machine is the stand-in ssh host of a scratch daemon (scripts/dev.sh: this
// machine with a scratch home), with no Keel daemon on it. Its Claude Code
// store holds a fixture session; a stand-in harness keeps another one open.
// The sheet shows them under the machine's separator, with what runs there now
// at its head, with no machine to pick first. Importing one makes a session
// placed on that machine, with the source as its mark.
const HOST = process.env.KEEL_SSH_STANDIN_HOST ?? "keel-standin";
const STAND_IN = "scripted:stand-in";
const tag = Date.now().toString(36);
const sid = (n: number) => `6f6f6f6f-${n}000-4000-8000-${tag.padStart(12, "0").slice(-12)}`;

function transcript(home: string, cwd: string, id: string, title: string) {
  const dir = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const t = Date.now() - 3600_000;
  const base = { cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli" };
  const recs = [
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: new Date(t).toISOString(), message: { role: "user", content: "Look at fruit.txt and name the fruit in it." } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: new Date(t + 1000).toISOString(), message: { id: "msg_1", type: "message", role: "assistant", model: "claude-stand-in", content: [{ type: "text", text: "The fruit is quince." }], stop_reason: "end_turn" } },
    { type: "ai-title", aiTitle: title, sessionId: id },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function openSheet(page: Page) {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import sessions");
  await page.getByRole("option", { name: /^Import sessions/ }).first().click();
  const sheet = page.getByTestId("import-sheet");
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  return sheet;
}

test("import sheet: a machine's sessions under its separator, running ones first, and an import placed there", async ({ page, request }) => {
  test.setTimeout(240_000);
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
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
  const root = join(home, "work");
  const proj = join(root, `proj-${tag}`);
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "fruit.txt"), "quince\n");
  await request.patch(`/api/fleet/machines/${m.id}`, { data: { workspace_root: root } });
  transcript(home, proj, sid(1), `Name the fruit ${tag}`);
  const procs: number[] = [];
  const made: string[] = [];
  try {
    // A harness at work there: its transcript and the record of its live session.
    const p = spawn("bun", [resolve("test/e2e/fixtures/harness-standin.ts"), "--home", home, "--cwd", proj, "--session", sid(2), "--hold", "600", "--job", "0", "--title", `Still running ${tag}`], { detached: true, stdio: "ignore" });
    p.unref();
    procs.push(p.pid!);

    await page.goto("/");
    const sheet = await openSheet(page);
    await page.getByTestId("import-search").fill(tag);
    // This machine's part and the machine's own part, each under its separator; nothing was picked first.
    const seps = sheet.getByTestId("import-machine-sep");
    await expect(seps).toHaveCount(2);
    await expect(seps.first()).toHaveAttribute("data-machine", "local");
    const far = sheet.locator(`[data-testid="import-machine"][data-machine="${m.id}"]`);
    await expect(far.getByTestId("import-machine-sep")).toContainText(m.name);
    await expect(far.getByTestId("import-machine-row").filter({ hasText: `Name the fruit ${tag}` })).toHaveCount(1, { timeout: 30_000 });
    // What runs there now is named first, with what it does.
    const running = far.getByTestId("import-machine-running");
    await expect(running.getByTestId("import-machine-running-row")).toHaveCount(1, { timeout: 30_000 });
    await expect(running.getByTestId("original-strip")).toHaveAttribute("data-state", "active", { timeout: 30_000 });
    // It is under Running now once, not again in the stored list below.
    await expect(far.locator(`[data-id="${sid(2)}"]`)).toHaveCount(1);
    await expect(sheet.getByTestId("import-machine-jump")).toContainText(m.name);
    await shoot(page, "fleet-sessions-sheet-01-machine-part");

    // Importing one: the session is placed on that machine, in its folder there, and the source is its mark.
    await far.locator(`[data-testid="import-machine-row"][data-id="${sid(1)}"]`).click();
    await expect(sheet.getByTestId("import-counts")).toContainText(/1\s*prompts/);
    await sheet.getByTestId("import-go").click();
    await expect(page.getByTestId("machine-chip")).toContainText(m.name, { timeout: 15_000 });
    const id = page.url().split("/s/")[1]!;
    made.push(id);
    const s = (await (await request.get(`/api/sessions/${id}`)).json()).session;
    expect(s.machine).toBe(m.id);
    expect(s.workspace).toBe(proj);
    const origin = await (await request.get(`/api/sessions/${id}/origin`)).json();
    expect(origin.origin.machine).toMatchObject({ id: m.id, name: m.name });
    expect(origin.origin.source_id).toBe(sid(1));
    await shoot(page, "fleet-sessions-sheet-02-imported");

    // The list again: the copy is marked on its row, and the kept list stands in when the sheet opens.
    await page.goto("/");
    const again = await openSheet(page);
    await page.getByTestId("import-search").fill(tag);
    await expect(again.locator(`[data-testid="import-machine-row"][data-id="${sid(1)}"]`).getByTestId("import-imported")).toBeVisible({ timeout: 30_000 });
    const kept = await (await request.get(`/api/fleet/machines/${m.id}/transcripts?harness=claude&limit=60&cached=1`)).json();
    expect(kept.sessions.some((x: any) => x.id === sid(1))).toBe(true);
    expect(kept.cached_ms).toBeGreaterThan(0);
  } finally {
    for (const pid of procs) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
    for (const id of made) await request.delete(`/api/sessions/${id}`);
    if (enabledHere) await request.delete(`/api/fleet/machines/${m.id}`);
    for (const n of [1, 2]) rmSync(join(home, ".claude", "projects", proj.replace(/[^A-Za-z0-9]/g, "-"), `${sid(n)}.jsonl`), { force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

// A machine that does not answer shows the list it last gave, dated; the daemon answers for it with `cached_ms`
// and `stale`. (The daemon's own answer is checked in src/fleet/listing.test.ts; here the page is given that
// answer, as a machine that dropped out gives it.)
test("import sheet: a machine that does not answer shows its last list, dated", async ({ page, request }) => {
  const machines = (await (await request.get("/api/fleet/machines")).json()).machines as any[];
  test.skip(!machines.some((m) => m.ssh_host === HOST), `the daemon's ssh configuration has no stand-in host ${HOST} (scripts/dev.sh adds it)`);
  await page.setViewportSize({ width: 1920, height: 1040 });
  let m = machines.find((x) => x.ssh_host === HOST && x.enabled);
  const enabledHere = !m;
  if (!m) {
    const r = await (await request.post("/api/fleet/machines", { data: { ssh_host: HOST } })).json();
    m = r.machines.find((x: any) => x.id === r.id);
  }
  const root = join(m.facts.home as string, "work");
  await request.patch(`/api/fleet/machines/${m.id}`, { data: { workspace_root: root } });
  try {
    const at = Date.now() - 7 * 60_000;
    const row = { harness: "claude", id: sid(7), path: `${root}/x/${sid(7)}.jsonl`, cwd: `${root}/x`, title: `Last seen ${tag}`, updated_ms: at, size_bytes: 2048, kind: "interactive" };
    await page.route(`**/api/fleet/machines/${m.id}/transcripts?*`, (route) => route.fulfill({ json: { machine_id: m.id, machine: m.name, sessions: [row], total: 1, harnesses: [], index: { building: false }, cached_ms: at, stale: "no answer within 30 s" } }));
    await page.route(`**/api/fleet/machines/${m.id}/running`, (route) => route.fulfill({ json: { machine_id: m.id, machine: m.name, sessions: [], supported: true, offline: "no answer within 30 s" } }));
    await page.goto("/");
    const sheet = await openSheet(page);
    const far = sheet.locator(`[data-testid="import-machine"][data-machine="${m.id}"]`);
    await expect(far).toHaveAttribute("data-state", "kept", { timeout: 15_000 });
    await expect(far.getByTestId("import-machine-kept")).toContainText(/last read 7m ago/);
    await expect(far.getByTestId("import-machine-row")).toContainText(`Last seen ${tag}`);
    await expect(far.getByTestId("import-machine-running-off")).toContainText("not known");
    await shoot(page, "fleet-sessions-sheet-03-kept");
  } finally {
    if (enabledHere) await request.delete(`/api/fleet/machines/${m.id}`);
  }
});
