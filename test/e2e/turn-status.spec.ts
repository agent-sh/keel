import type { WebSocketRoute } from "./isolate.ts";
import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, ask, scriptBash } from "./shots.ts";

// Feature: what a screen reader is told about a running turn. One status
// region per session changes when the reason changes (working, waiting for an
// approval, the end), never with the ticking clock, and says nothing when an
// idle session opens or the page reconnects.
test("turn status is announced once per change", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `status-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("turn-announcer")).toHaveText("");

  // Record every text the region takes.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="turn-announcer"]')!;
    (window as any).said = [];
    new MutationObserver(() => (window as any).said.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.getByTestId("composer").fill(ask("Run exactly this Bash command and nothing else: touch status.txt. Then reply with the word ok.", scriptBash("touch status.txt")));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("approval")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2500); // the visible clock ticks meanwhile
  await page.getByTestId("allow-once").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("turn-announcer")).toHaveText("The turn ended.");
  const said = (await page.evaluate(() => (window as any).said)).filter(Boolean);
  expect(said).toEqual(["Working.", "Waiting for your approval.", "Working.", "The turn ended."]);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A question to the owner stops the turn until it is answered: the region
// says so once, not again when the page reconnects and the same question is
// replayed, and goes on to the next state when the answer is in.
test("a pending question is announced once", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => { ws.connectToServer(); socket = ws; });
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "A question" } })).json();
  try {
    await page.goto(`/s/${session.id}`);
    const region = page.getByTestId("turn-announcer");
    await expect(region).toHaveText("");
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="turn-announcer"]')!;
      (window as any).said = [];
      new MutationObserver(() => (window as any).said.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const ask = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } };
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([ask])}`);
    await page.keyboard.press("Enter");
    const card = page.getByTestId("question");
    await expect(card).toHaveAttribute("data-state", "open");
    await expect(region).toHaveText("Waiting for your answer.");
    await expect(page.getByTestId("working")).toHaveCount(0);
    await shoot(page, "turn-status-01-question");
    // The socket drops and comes back: the same question is sent again, and nothing new is said.
    await socket!.close({ code: 4000, reason: "cut by the test" });
    await expect(page.getByTestId("sync-state")).toHaveCount(1);
    await expect(page.getByTestId("sync-state")).toHaveCount(0, { timeout: 20_000 });
    await expect(card).toHaveAttribute("data-state", "open");
    await expect(region).toHaveText("Waiting for your answer.");
    await page.waitForTimeout(500);
    expect(((await page.evaluate(() => (window as any).said)) as string[]).filter((t) => t === "Waiting for your answer.")).toHaveLength(1);

    await card.getByRole("radio", { name: "Amber" }).click();
    await card.getByTestId("question-submit").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    await expect(region).toHaveText("The turn ended.");
    const said = ((await page.evaluate(() => (window as any).said)) as string[]).filter(Boolean);
    expect(said.filter((t) => t === "Waiting for your answer.")).toHaveLength(1);
    expect(said[0]).toBe("Working.");
    // After the answer: working again (a turn that ends at once may go straight to its end).
    expect(["Working.", "The turn ended."]).toContain(said[said.indexOf("Waiting for your answer.") + 1]);
    expect(said.at(-1)).toBe("The turn ended.");
  } finally { await request.delete(`/api/sessions/${session.id}`); }
});
