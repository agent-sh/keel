import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the command sandbox. In auto-edits mode with the workspace-write
// profile and the network off, a command runs without asking, can write the
// workspace, cannot write outside it and cannot reach the network.
test("command sandbox", async ({ page, request }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `sandbox unavailable: ${settings.sandbox.reason}`);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  const ws = join(root, `sandbox-${Date.now()}`);
  const outside = `${ws}-outside.txt`;
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);

  // Turn the sandbox on from the menu.
  await page.getByTestId("permission-menu").click();
  await page.getByTestId("mode-auto-edits").click();
  await page.getByTestId("sandbox-workspace-write").click();
  await page.getByTestId("sandbox-network").click();
  await expect(page.getByTestId("sandbox-network")).not.toHaveAttribute("data-checked");
  await shoot(page, "sandbox-01-menu");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("permission-menu")).toContainText("sandbox");

  const cmd = `touch inside.txt; touch ${outside}; getent hosts example.com || echo no-network`;
  await page.getByTestId("composer").fill(`Run exactly this one Bash command, once, and nothing else: ${cmd}\nThen reply with one word: done.`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("approval")).toHaveCount(0);

  expect(existsSync(join(ws, "inside.txt"))).toBe(true);
  expect(existsSync(outside)).toBe(false);
  const tool = page.getByTestId("tool-call").first();
  await tool.click();
  await expect(tool).toContainText("Read-only file system");
  await expect(tool).toContainText("no-network");
  await shoot(page, "sandbox-02-result");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
