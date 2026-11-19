import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the fleet. Two daemons on this machine stand in for two machines:
// this one (KEEL_URL) pairs with the other (KEEL_PEER_URL) from the Machines
// page, the other's session shows up in the session list and is driven through
// the link, and a session placed on the other machine runs its tools there.
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;

test("fleet: pair, the other machine's sessions, a tool on the peer", async ({ page, request }) => {
  const peerUp = await request.get(`${PEER}/api/health`, { timeout: 3000 }).then((r) => r.ok(), () => false);
  test.skip(!peerUp, `no peer daemon at ${PEER}: start a second daemon and set KEEL_PEER_URL and KEEL_PEER_ROOT`);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  // Start clean: no session placed on an old pairing, no old machine record.
  const { machines } = await (await request.get("/api/fleet/machines")).json();
  const old = machines.filter((m: any) => m.daemon_url === PEER).map((m: any) => m.id);
  for (const s of (await (await request.get("/api/sessions")).json()).sessions) if (old.includes(s.machine)) await request.delete(`/api/sessions/${s.id}`);
  for (const id of old) await request.delete(`/api/fleet/machines/${id}`);
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  const prevRules = (await (await request.get("/api/fleet/placement")).json()).rules;
  await request.post("/api/fleet/placement", { data: { rules: [] } });
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });

  // The other machine has its own session and a file only it has.
  mkdirSync(ROOT, { recursive: true });
  const token = `peer-${Date.now().toString(36)}`;
  writeFileSync(`${ROOT}/note.txt`, `${token}\n`);
  const made = await (await request.post(`${PEER}/api/sessions`, { data: { workspace: ROOT, title: "Started on the other machine", model: HAIKU } })).json();

  try {
    // Pair from the Machines page.
    await page.goto("/settings/machines");
    await expect(page.getByTestId("machines-panel")).toBeVisible();
    await page.getByTestId("machine-add-open").click();
    await page.getByTestId("machine-add-name").fill("devbox");
    await page.getByTestId("machine-add-url").fill(PEER);
    await page.getByTestId("machine-add-root").fill(ROOT);
    await page.getByTestId("machine-add-submit").click();
    const row = page.locator('[data-testid="machine-row"]').filter({ hasText: "devbox" });
    await expect(row.getByTestId("machine-link")).toContainText("linked", { timeout: 15_000 });
    await expect(row.getByTestId("machine-state")).toContainText(/ready|busy/);
    await expect(row).toContainText(ROOT);
    // A placement rule: sessions go to the other machine when Auto is picked.
    await page.getByLabel("Kind of work").selectOption("session");
    await page.getByTestId("placement-machine").selectOption({ label: "devbox" });
    await page.getByLabel("Note").fill("work lives there");
    await page.getByTestId("placement-add").click();
    await expect(page.getByTestId("placement-rule")).toContainText("When a session, run it on devbox");
    await shoot(page, "fleet-01-machines");

    // One session list: the other daemon's session, under its machine.
    const remote = page.locator(`[data-testid="session-row"][data-session$="--${made.session.id}"]`);
    await expect(remote).toBeVisible({ timeout: 15_000 });
    // The full index groups it under its machine.
    await page.getByTestId("show-sidebar").click();
    await expect(page.locator(`section:has([data-session$="--${made.session.id}"])`).getByTestId("group-machine")).toHaveText("devbox");
    await page.locator(`[data-testid="session-row"][data-session$="--${made.session.id}"]`).click();
    await page.getByLabel("Fold the list").click();
    await expect(page.getByTestId("machine-chip")).toContainText("devbox");
    await expect(page.getByTestId("session-title")).toHaveText("Started on the other machine");
    // Driven through the link: the turn runs on the other daemon, its frames come back over the relay.
    await page.getByTestId("composer").fill("Reply with the single word: pong");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("main")).toContainText(/pong/i);
    await shoot(page, "fleet-02-remote-session");

    // A new session placed by the rule on the other machine: its tools run there.
    await page.getByTestId("new-session").click();
    await page.getByTestId("machine-picker").click();
    await expect(page.locator('[data-testid="machine-option"]').filter({ hasText: "devbox" })).toBeVisible();
    await page.locator('[data-testid="machine-option"][data-machine="auto"]').click();
    await expect(page.getByTestId("machine-picker")).toContainText("Auto");
    await page.getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("haiku 5.5");
    await page.getByRole("option").first().click();
    await page.getByTestId("composer").fill("Run this with the Bash tool, one call: cat note.txt && pwd. Then reply with the output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
    const tool = page.locator('[data-tool="Bash"]').first();
    await expect(tool.getByTestId("tool-machine")).toHaveText("devbox");
    await expect(page.locator("main")).toContainText("Placed on devbox by rule 1 (work lives there)");
    await expect(page.getByTestId("machine-chip")).toContainText("devbox");
    await tool.click();
    await expect(tool).toContainText(token);
    await expect(tool).toContainText(ROOT);
    await shoot(page, "fleet-03-tool-on-peer");

    // One command on the other machine from a session that stays here.
    await page.getByTestId("new-session").click();
    await page.getByTestId("machine-picker").click();
    await page.locator('[data-testid="machine-option"][data-machine="local"]').click();
    await page.getByTestId("composer").fill("Call keel__run_on once with machine \"devbox\" and command \"cat note.txt\". Then reply with its output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
    const run = page.locator('[data-tool="keel__run_on"]').first();
    await expect(run.getByTestId("tool-machine")).toHaveText("devbox");
    await run.click();
    await expect(run).toContainText(`[ran on devbox]`);
    await expect(run).toContainText(token);
    await shoot(page, "fleet-04-run-on");

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    await request.put("/api/permissions/settings", { data: { default_mode: prev } });
    await request.post("/api/fleet/placement", { data: { rules: prevRules } });
    await request.delete(`${PEER}/api/sessions/${made.session.id}`);
  }
});
