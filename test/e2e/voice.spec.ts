import { expect, test } from "./isolate.ts";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// The parlar stand-in the daemon runs (KEEL_PARLAR): no daemon, mic or speaker;
// a test plays the owner's speech by writing the file `speech` beside it.
const PARLAR = process.env.KEEL_PARLAR_DIR ?? join(process.env.HOME!, ".cache/keel-work/bun/dev-voice/parlar");
const log = () => (existsSync(join(PARLAR, "parlar.log")) ? readFileSync(join(PARLAR, "parlar.log"), "utf8") : "");
// Waits that run now (a killed wait leaves its marker behind; its process is gone).
const waiting = () => readdirSync(PARLAR).filter((f) => f.startsWith("waiting.") && existsSync(`/proc/${f.slice(8)}`));

// Feature: voice through parlar. Talk in a session gives it the voice and arms
// the wait; the owner's speech arrives as a message that runs a turn, and the
// model's say reaches parlar for that session only; another session's say is
// not spoken. Mute closes the mic; Stop ends the conversation and its waits.
test("voice", async ({ page, request }) => {
  test.skip(!existsSync(join(PARLAR, "parlar")), "needs the parlar stand-in (run the daemon with KEEL_PARLAR)");
  for (const f of ["focus", "active", "muted", "speech", "known", "parlar.log"]) rmSync(join(PARLAR, f), { force: true });
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU, title: "Voice e2e" } })).json();
  const { session: other } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU, title: "No voice here" } })).json();

  await page.goto(`/s/${session.id}`);
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  const card = page.getByTestId("voice-card");
  await expect(card.getByTestId("voice-state")).toContainText("Off.");
  await shoot(page, "voice-01-off");

  await card.getByTestId("voice-talk").click();
  await expect(card.getByTestId("voice-state")).toContainText("Listening");
  await expect(page.getByTestId("voice-icon")).toHaveAttribute("data-here", "1");
  expect(log()).toContain(`ctl talk --session ${session.id} --harness codex`);
  await expect.poll(() => waiting().length).toBe(1);
  await shoot(page, "voice-02-listening");

  // The owner speaks: a message of the voice that runs a turn, and say reaches parlar.
  writeFileSync(join(PARLAR, "speech"), "[voice u1] Find the say tool with search_tools, run parlar__say with mcp_call saying hello, then reply with the single word: heron.");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByText("[voice u1]")).toBeVisible();
  await expect(page.getByTestId("assistant-text").last()).toContainText(/heron/i);
  expect(log()).toMatch(new RegExp(`say ${session.id} \\S`));
  // The stop hook runs after the turn's end reaches the page: wait for its line.
  await expect.poll(log).toContain(`hook stop --harness codex ${session.id}`);
  await expect.poll(() => waiting().length).toBe(1); // armed again after the turn
  await page.keyboard.press("Escape");
  await shoot(page, "voice-03-heard");

  // Another session: its say is refused before parlar is reached.
  const before = (log().match(/^say /gm) ?? []).length;
  await request.post(`/api/sessions/${other.id}/messages`, { data: { text: "Find the say tool with search_tools and run parlar__say with mcp_call saying hi. Then reply with the tool's result only." } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${other.id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 120_000 }).toBe(true);
  const results = (await (await request.get(`/api/sessions/${other.id}`)).json()).events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results);
  expect(JSON.stringify(results)).toContain("not spoken");
  expect((log().match(/^say /gm) ?? []).length).toBe(before);
  expect((await (await request.get(`/api/sessions/${other.id}/voice`)).json()).here).toBe(false);

  // Mute, then Stop: the conversation ends with its wait.
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await card.getByTestId("voice-mute").click();
  await expect(card.getByTestId("voice-state")).toContainText("Muted");
  await shoot(page, "voice-04-muted");
  await card.getByTestId("voice-stop").click();
  await expect(card.getByTestId("voice-state")).toContainText("Off.");
  await expect.poll(() => waiting().length).toBe(0);
  expect(log()).toContain("ctl off");
  expect((await request.post(`/api/sessions/${session.id}/voice`, { data: { action: "shout" } })).status()).toBe(400);

  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
