import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: code mode. The model sends one run_code program that calls two
// tools. The program is judged like a command (a card), the read inside it runs,
// the command inside it asks on its own card and is denied, so it throws
// ToolError in the program, which goes on. The page shows both calls under the
// program; only what the program printed went back to the model.
test("code mode", async ({ page, request }) => {
  test.setTimeout(240_000);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `code-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "notes.txt"), Array.from({ length: 300 }, (_, i) => (i === 137 ? "MARKER-7731 the one line that matters" : `filler line ${i}`)).join("\n"));
  writeFileSync(join(ws, "keep.txt"), "keep me\n");
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);

  const code = [
    `const [notes, rm] = await Promise.allSettled([`,
    `  tools.Read({ file_path: ${JSON.stringify(join(ws, "notes.txt"))} }),`,
    `  tools.Bash({ command: "rm keep.txt", description: "Remove keep.txt" }),`,
    `]);`,
    `const hit = notes.value.split("\\n").find((l) => l.includes("MARKER"));`,
    `console.log("found:", hit.replace(/^\\s*\\d+\\s*/, ""));`,
    `console.log(rm.status === "rejected" ? "rm refused: " + rm.reason.name : "rm ran");`,
  ].join("\n");
  await page.getByTestId("composer").fill(`Call the run_code tool once with exactly this code and nothing else:\n\n${code}\n\nThen reply with the two lines it printed, word for word.`);
  await page.keyboard.press("Enter");

  // The program itself asks, as a command of the session would.
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card.getByTestId("approval-summary")).toContainText("bun -e");
  await card.getByTestId("allow-once").click();

  // The command inside it asks on a card of its own, marked as from a program.
  await expect(card.getByTestId("approval-summary")).toContainText("rm keep.txt", { timeout: 60_000 });
  await expect(card.getByTestId("approval-from-code")).toBeVisible();
  const program = page.locator('[data-testid="tool-call"][data-tool="run_code"]');
  await expect(program.getByTestId("code-calls").getByTestId("tool-call")).toHaveCount(2);
  await shoot(page, "code-01-inner-card");
  await card.getByTestId("deny").click();
  await page.getByTestId("deny-reason").fill("keep.txt stays");
  await page.getByTestId("deny-send").click();

  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  expect(existsSync(join(ws, "keep.txt"))).toBe(true);
  await expect(program).toHaveAttribute("data-state", "ok");
  await expect(program.getByTestId("code-call-count")).toContainText("2 calls");
  await expect(program.getByTestId("code-call-count")).toContainText("1 failed");

  // Open it: the code, the two calls (the read ok, the command refused), and what went back.
  const trigger = program.getByRole("button").first();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(program.getByTestId("code-source")).toBeVisible();
  await expect(program.getByTestId("code-source")).toContainText("tools.Read");
  const inner = program.getByTestId("code-calls").getByTestId("tool-call");
  await expect(inner.nth(0)).toHaveAttribute("data-state", "ok");
  await expect(inner.nth(1)).toHaveAttribute("data-state", "error");
  const out = program.getByTestId("code-output");
  await expect(out).toContainText("found: MARKER-7731");
  await expect(out).toContainText("rm refused: ToolError");
  // The 300 lines it read stayed in the program.
  await expect(out).not.toContainText("filler line");
  await shoot(page, "code-02-done");

  // After a reload the calls come from the store.
  await page.reload();
  await expect(page.locator('[data-testid="tool-call"][data-tool="run_code"]').getByTestId("code-call-count")).toContainText("2 calls");

  // The model saw only the printed lines.
  const events = (await (await request.get(`/api/sessions/${session.id}/events`)).json()).events as any[];
  const result = events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results)[0];
  expect(JSON.stringify(result.content)).not.toContain("filler line");
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
