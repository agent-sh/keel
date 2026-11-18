import { expect, test } from "@playwright/test";
import { HAIKU, shoot } from "./shots.ts";

// Feature: Settings > Resources shows the daemon and the processes it started,
// a command a session's tool runs in the background is booked to that session,
// and the memory and CPU of the last hour are charted.
test("resources view", async ({ page, request }) => {
  const cmd = `sleep ${100 + Math.floor(Math.random() * 800)}`;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const s = (await (await request.post("/api/sessions", {
    data: { model: HAIKU, title: "Resources check", text: `Start \`${cmd}\` in the background with your shell tool (run_in_background), then reply with the word started.` },
  })).json()).session;
  await expect.poll(async () => {
    const r = await (await request.get(`/api/resources?session_id=${s.id}&refresh=1`)).json();
    return r.processes.some((p: any) => p.command.includes(cmd) && p.kind === "tool");
  }, { timeout: 120_000 }).toBe(true);

  await page.goto("/settings/resources");
  const panel = page.getByTestId("resources-panel");
  await expect(panel.getByTestId("tile-memory")).not.toContainText("none");
  const row = panel.getByTestId("process-row").filter({ hasText: cmd }).first();
  await expect(row).toContainText("Resources check");
  await expect(panel.getByTestId("resources-sessions")).toContainText("Resources check");
  await shoot(page, "resources-01");
  await panel.getByTestId("resources-processes").scrollIntoViewIfNeeded();
  await shoot(page, "resources-02-processes");

  // Deleting the session stops its commands.
  await request.delete(`/api/sessions/${s.id}`);
  await expect.poll(async () => (await (await request.get("/api/resources?refresh=1")).json()).processes.some((p: any) => p.command.includes(cmd))).toBe(false);
  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
});
