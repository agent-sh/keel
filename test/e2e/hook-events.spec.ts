import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const HOOK = join(import.meta.dirname, "fixtures/hook.sh");
const scripted = HAIKU.startsWith("scripted:");
const calls = (...commands: string[]) => `script:calls ${JSON.stringify(commands.map((command) => ({ name: "Bash", input: { command } })))}`;

// A repository of its own under the scratch home, with a hooks file the owner pins in Settings.
async function pinned(page: any, request: any, hooks: Record<string, unknown>) {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `hooks-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(ws, ".keel"), { recursive: true });
  writeFileSync(join(ws, ".keel/hooks.json"), JSON.stringify({ hooks }, null, 1));
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto("/settings/hooks");
  const project = page.locator(`[data-testid="hook-source"][data-scope="project"]`).filter({ hasText: ws.split("/").pop()! });
  await expect(project).toHaveAttribute("data-active", "false");
  await project.click();
  await page.getByTestId("hook-pin").click();
  await expect(project).toHaveAttribute("data-active", "true");
  return { ws, id: session.id as string };
}

// Feature: a PreToolUse hook changes a call's input and allows it. The changed
// command is the one that is judged and runs: a low-risk one runs without a
// card (the hook's allow answers it), a high-risk one still asks the owner,
// with the changed command on the card. The transcript shows what ran and what
// the model asked for, and the model reads what ran on the result.
test("a hook changes a call's input and allows it", async ({ page, request }) => {
  test.skip(!scripted, "needs the scripted model: the calls are given exactly");
  const { ws, id } = await pinned(page, request, { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${HOOK} rewrite` }] }] });
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${id}`);
  await page.getByTestId("composer").fill(calls("echo asked-by-model"));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  // The changed command ran, with no card: the file it makes is there.
  expect(existsSync(join(ws, "hook-made.txt"))).toBe(true);
  const call = page.getByTestId("tool-call").first();
  await expect(call).toHaveAttribute("data-state", "ok");
  await expect(call).toContainText("touch hook-made.txt");
  await expect(call.getByTestId("tool-rewritten")).toBeVisible();
  await expect(call.getByTestId("tool-asked")).toHaveText("echo asked-by-model");
  await expect(call.getByTestId("tool-hook-allowed")).toContainText("touching files is fine here");
  await shoot(page, "hook-events-01-rewritten");
  const events = async () => (await (await request.get(`/api/sessions/${id}`)).json()).events;
  const results = JSON.stringify((await events()).filter((e: any) => e.kind === "tool_result"));
  expect(results).toContain("It ran with:");
  expect(results).toContain("touch hook-made.txt");
  // The history keeps what the model wrote.
  expect(JSON.stringify((await events()).filter((e: any) => e.kind === "assistant"))).toContain("echo asked-by-model");

  // Changed into a high-risk command: the hook's allow does not answer it. The card shows the changed command.
  await page.getByTestId("composer").fill(calls("echo asked-by-model-high"));
  await page.keyboard.press("Enter");
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("sudo rm -rf /var/lib/hook-e2e-thing");
  await expect(card).toContainText("The model asked for: echo asked-by-model-high");
  await shoot(page, "hook-events-02-high-risk-asks");
  await card.getByTestId("deny").click();
  await page.getByTestId("deny-send").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("tool-call").nth(1).getByTestId("tool-asked")).toHaveText("echo asked-by-model-high");
});
