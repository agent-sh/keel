import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, SCRIPTED } from "./shots.ts";

const HOOK = join(import.meta.dirname, "fixtures/hook.sh");
const file = (groups: Record<string, string>) =>
  JSON.stringify({ hooks: Object.fromEntries(Object.entries(groups).map(([event, arg]) => [event, [{ matcher: event.includes("Tool") ? "Bash" : undefined, hooks: [{ type: "command", command: `${HOOK} ${arg}` }] }]])) }, null, 1);

// Feature: hooks. The owner's hooks.json runs; a repository's runs only after
// the owner reads and pins it. A prompt hook refuses a prompt or adds context,
// a pre-tool hook blocks a call, asks the owner or adds context (what an
// "allow" and a changed input do: hook-events.spec.ts), a post-tool hook adds
// context to the result, a Stop hook sends the session back to work once.
// Run the daemon with KEEL_HOOKS at a scratch file: this test writes it.
test("hooks", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: it has to try the commands the hooks block and change");
  const info = await (await request.get("/api/hooks")).json();
  test.skip(!String(info.owner_path).includes("keel-work"), "needs a scratch owner hooks file (KEEL_HOOKS)");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  writeFileSync(info.owner_path, file({ UserPromptSubmit: "prompt", PreToolUse: "pre", Stop: "stop" }));
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `hooks-e2e-${Date.now()}`);
  mkdirSync(join(ws, ".keel"), { recursive: true });
  writeFileSync(join(ws, ".keel/hooks.json"), file({ PostToolUse: "post" }));
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });

  // The repository's file is listed, not running until pinned.
  await page.goto("/settings/hooks");
  const project = page.locator(`[data-testid="hook-source"][data-scope="project"]`).filter({ hasText: ws.split("/").pop()! });
  await expect(project).toHaveAttribute("data-active", "false");
  await expect(page.locator('[data-testid="hook-source"][data-scope="owner"]').first()).toHaveAttribute("data-active", "true");
  await project.click();
  await expect(page.getByTestId("hook-text")).toContainText("PostToolUse");
  await shoot(page, "hooks-01-unpinned");
  await page.getByTestId("hook-pin").click();
  await expect(project).toHaveAttribute("data-active", "true");

  await page.goto(`/s/${session.id}`);
  const say = async (text: string, turns: number) => {
    await page.getByTestId("composer").fill(text);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(turns, { timeout: 120_000 });
  };
  // A refused prompt never reaches the model.
  await say("refuse-me: say hi", 1);
  await expect(page.getByTestId("turn-error").last()).toContainText("A hook refused this prompt");

  // A blocked call.
  await say("Run exactly this Bash command and nothing else: echo forbidden. Then reply with one word: ok.", 2);
  const events = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events;
  const results = async () => JSON.stringify((await events()).filter((e: any) => e.kind === "tool_result"));
  expect(await results()).toContain("A hook blocked this call: no forbidden here");

  // Context from the prompt hook, the pre-tool hook and the pinned post-tool hook;
  // the Stop hook then sends the session back once.
  await say("Run exactly this Bash command: echo hello. Then tell me the password your context gives, in one word.", 4);
  expect(await results()).toContain("hook-ctx: the owner hook saw this call");
  expect(await results()).toContain("project-ctx: the repository hook saw the result");
  await expect(page.getByText("[hook] Reply with the single word AGAIN-DONE.")).toBeVisible();
  await expect(page.getByTestId("assistant-text").last()).toContainText("AGAIN-DONE");
  const texts = (await events()).filter((e: any) => e.kind === "assistant").map((e: any) => JSON.stringify(e.data.blocks)).join(" ");
  expect(texts.toLowerCase()).toContain("falcon");

  // A hook that asks puts the call to the owner, with no standing answer.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await page.getByTestId("composer").fill("Run exactly this Bash command and nothing else: echo askme. Then reply with one word: ok.");
  await page.keyboard.press("Enter");
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("A hook of yours asks: askme commands need the owner");
  await expect(card.getByTestId("allow-always")).toHaveCount(0);
  await shoot(page, "hooks-02-ask");
  await card.getByTestId("deny").click();
  await page.getByTestId("deny-send").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(5, { timeout: 120_000 });

  // A changed repository file stops running until pinned again.
  writeFileSync(join(ws, ".keel/hooks.json"), file({ PostToolUse: "post", PreToolUse: "pre" }));
  const again = (await (await request.get(`/api/hooks?cwd=${encodeURIComponent(ws)}`)).json()).sources.find((s: any) => s.scope === "project");
  expect(again.active).toBe(false);
  expect(again.problems[0]).toContain("changed since it was pinned");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
