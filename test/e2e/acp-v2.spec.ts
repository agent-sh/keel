import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: ACP v2 (a Preview). Settings has one switch that asks agents for v2; with it on, an agent that offers v2 is
// spoken to in v2 and what it leaves running in the background (its terminals and tool calls) is among the session's
// commands above the box, each with Stop where the agent offered to stop it alone. A prompt's message id is kept on
// the turn's end.
test("acp v2 background work", async ({ page, request }) => {
  const standin = join(import.meta.dirname, "fixtures/acp-agent-standin.ts");
  await request.delete("/api/acp/agents/standin-v2").catch(() => {});
  const before = (await (await request.get("/api/settings")).json()).settings.acp.protocol;
  try {
    expect((await request.post("/api/acp/agents", { data: { id: "standin-v2", command: "bun", args: [standin, "v2"] } })).ok()).toBe(true);
    // The switch is in Settings > ACP agents, off until the owner turns it on.
    await page.goto("/settings/acp-agents");
    const sw = page.getByTestId("acp-v2-switch");
    await expect(sw).toBeVisible();
    await expect(sw).not.toBeChecked();
    await sw.click();
    await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.acp.protocol).toBe("auto");
    await shoot(page, "acp-v2-1-switch");

    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-v2-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "acp:standin-v2" } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "workspace-write" } });
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill("start the background things");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("The dev server runs in the background.");
    // The turn's end keeps the id the agent gave the prompt's message.
    const ends = ((await (await request.get(`/api/sessions/${session.id}/events`)).json()).events as any[]).filter((e) => e.kind === "turn_end");
    expect(ends[0].data.acp_message_id).toMatch(/^msg-/);

    // Its background list: three things, the session idle.
    const chip = page.getByTestId("dock-jobs");
    await expect(chip).toContainText("3");
    await chip.click();
    const rows = page.getByTestId("dock-job");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("npm run dev");
    await expect(rows.nth(0)).toContainText("agent terminal");
    await expect(rows.nth(0).getByTestId("dock-job-stop")).toBeVisible();
    // A terminal that offered no cancel has no Stop.
    await expect(rows.nth(1)).toContainText("tail -f server.log");
    await expect(rows.nth(1).getByTestId("dock-job-stop")).toHaveCount(0);
    await expect(rows.nth(2).getByTestId("dock-job-stop")).toBeVisible();
    await shoot(page, "acp-v2-2-background");

    // Stop ends that one terminal alone; the others stay.
    await rows.nth(0).getByTestId("dock-job-stop").click();
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId("dock-job").filter({ hasText: "npm run dev" })).toHaveCount(0);
    await expect(chip).toContainText("2");
    await shoot(page, "acp-v2-3-one-stopped");
    // The tool call too.
    await page.getByTestId("dock-job").filter({ hasText: "Watch the build" }).getByTestId("dock-job-stop").click();
    await expect(page.getByTestId("dock-job")).toHaveCount(1);
  } finally {
    await request.patch("/api/settings", { data: { acp: { protocol: before } } });
    await request.delete("/api/acp/agents/standin-v2");
  }
});
