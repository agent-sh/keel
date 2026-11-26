import { expect, test } from "./isolate.ts";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a Codex session the owner runs elsewhere is answered in its own row. Its bar says who holds it
// (free here), its box sends the text to that same thread through Codex's server (the daemon's
// KEEL_CODEX_BIN, a stand-in of `codex app-server` that writes the thread's rollout as Codex does), what
// Codex asks before it runs a command is a Keel card answered once, and the reply comes into the same row
// from the rollout. Keel writes nothing of its own into the session: the user's message and the reply are
// the harness's records. Run the daemon with KEEL_IMPORT_CODEX_DIR at a scratch store and KEEL_CODEX_BIN at
// test/e2e/fixtures/codex-app-server.ts (scripts/scratch-env.ts names both).
test("a Codex session is answered in place: a send, its card, the reply in the same row", async ({ page, request }) => {
  const listed = await (await request.get("/api/import/sessions?limit=1")).json();
  const home = listed.harnesses?.find((h: any) => h.harness === "codex")?.store as string | undefined;
  test.skip(!home || !home.includes("import/codex"), "needs a scratch Codex store (KEEL_IMPORT_CODEX_DIR) and the app-server stand-in (KEEL_CODEX_BIN)");
  const watches = async () => (await (await request.get("/api/outside")).json()).watches as number;
  const tag = String(Date.now());
  const thread = `019a0e2e-0000-7000-8000-${tag.slice(-12).padStart(12, "0")}`;
  const cwd = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `outside-answer-${tag}`);
  mkdirSync(cwd, { recursive: true });
  const now = new Date();
  // A day folder of its own, a year from now: its watch is the daemon's signal that it reads the folder.
  const year = join(home!, "sessions", String(now.getFullYear() + 1));
  const day = join(year, String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  const rollout = join(day, `rollout-${now.toISOString().slice(0, 19).replaceAll(":", "-")}-${thread}.jsonl`);
  const rec = (type: string, payload: object) => appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n");
  const sessionOf = async () => ((await (await request.get("/api/sessions")).json()).sessions as any[]).find((s) => s.outside?.source_id === thread);
  let sid: string | undefined;
  try {
    // A Codex that keeps writer locks (0.172 and later): their folder is in its home.
    mkdirSync(join(home!, "thread-writer-locks"), { recursive: true });
    const before = await watches();
    mkdirSync(day, { recursive: true });
    await expect.poll(watches, { timeout: 10_000 }).toBeGreaterThan(before);
    rec("session_meta", { id: thread, timestamp: now.toISOString(), cwd, originator: "codex_cli_rs", cli_version: "0.172.0", source: "cli", model_provider: "openai", thread_source: "user" });
    rec("turn_context", { turn_id: "t0", cwd, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "gpt-x", summary: "auto" });
    rec("event_msg", { type: "task_started", turn_id: "t0" });
    rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `Set up the release script ${tag}` }] });
    rec("event_msg", { type: "user_message", message: `Set up the release script ${tag}` });
    rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "The script is in place." }] });
    rec("event_msg", { type: "task_complete", turn_id: "t0" });
    await expect.poll(async () => (await sessionOf())?.outside?.state, { timeout: 15_000 }).toBe("done");
    sid = (await sessionOf()).id as string;

    // Its row says, in its tooltip, that it is answered here.
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-row"][data-session="${sid}"] .k-row-title`)).toHaveAttribute("title", "Runs in Codex: answer it here");
    await page.goto(`/s/${sid}`);
    const bar = page.getByTestId("outside-bar");
    await expect(bar).toBeVisible();
    // Nothing holds it: Keel can answer it here.
    await expect(bar.getByTestId("outside-holder")).toHaveText("Free");
    const input = bar.getByTestId("outside-input");
    await expect(input).toHaveAttribute("placeholder", "Answer here: Keel resumes this session in Codex");
    // The lines under the head (the box, the note) start where the head's words do.
    const left = async (id: string) => (await bar.getByTestId(id).boundingBox())!.x;
    const words = await left("outside-state");
    expect(Math.abs((await left("outside-compose")) - words)).toBeLessThan(1);
    expect(Math.abs((await left("outside-note")) - words)).toBeLessThan(1);
    await shoot(page, "outside-answer-free");

    // A send: Codex resumes the thread and asks before it runs a command.
    await input.fill(`Run the tests ${tag}`);
    // Pressed twice: one draft is one send.
    await bar.getByTestId("outside-send").dblclick();
    const card = page.getByTestId("approval");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("approval-summary")).toContainText("make test");
    // Keel holds the thread while its turn runs, and says so.
    await expect(bar.getByTestId("outside-holder")).toHaveText("Keel is answering");
    await expect(bar.getByTestId("outside-stop")).toBeVisible();
    // The owner's message is in the row as Codex wrote it.
    await expect(page.getByTestId("transcript").getByText(`Run the tests ${tag}`).first()).toBeVisible();
    // The card waits on the owner: the session needs him, on its row and in its bar, not "working".
    await expect(page.locator(`[data-testid="session-row"][data-session="${sid}"]`)).toHaveAttribute("data-watch", "need");
    await expect(bar.getByTestId("outside-state")).toContainText("Waits for your answer: Codex asks above");
    await shoot(page, "outside-answer-card");
    // On a phone the bar is one quiet line over a box that fits: Send and Stop are in view, nothing runs off.
    const desk = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      const fits = async (id: string) => { const b = (await bar.getByTestId(id).boundingBox())!; return b.x >= 0 && b.x + b.width <= 390 + 0.5; };
      await expect.poll(() => fits("outside-send")).toBe(true);
      expect(await fits("outside-stop")).toBe(true);
      expect(await fits("outside-copy")).toBe(true);
      expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(bar.getByTestId("outside-note")).toBeHidden();
      await expect(bar.getByTestId("outside-facts")).toBeHidden();
      await shoot(page, "outside-answer-card-phone");
    } finally { await page.setViewportSize(desk); }

    // Answered once: the reply comes into the same row, from the rollout.
    await card.getByRole("button", { name: /Allow once/i }).click();
    await expect(page.getByTestId("transcript").getByText(`The command was allowed: Run the tests ${tag}`).first()).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveCount(0);
    // The call's line says the command, and what the owner chose (Codex's record says only what it returned).
    const line = page.locator('[data-testid="tool-call"][data-call="c1"]').last();
    await expect(line.getByTestId("call-answer")).toHaveText("allowed by you");
    await expect(line).toContainText("make test");
    await expect(line).not.toContainText('{"command"');
    // The turn is over and the child with it: the thread is free again, the send is delivered.
    await expect(bar.getByTestId("outside-holder")).toHaveText("Free", { timeout: 10_000 });
    await expect(bar.getByTestId("outside-sends")).toHaveCount(0);
    expect((await sessionOf())?.id).toBe(sid);
    await shoot(page, "outside-answer-reply");

    // An MCP server of Codex's asks for a form: Keel declines it, and the bar says so until the next send.
    await input.fill(`form please ${tag}`);
    await bar.getByTestId("outside-send").click();
    await expect(bar.getByTestId("outside-said")).toContainText("asked for a form, and Keel declined it", { timeout: 15_000 });
    await expect(bar.getByTestId("outside-holder")).toHaveText("Free", { timeout: 10_000 });
    await shoot(page, "outside-answer-form");

    // A command that is really high risk is marked so, in Keel's words; on a phone the mark gives way to the
    // card's title (a row of its own) instead of squeezing it a word a line. Denied, its line says so.
    await input.fill(`wipe it ${tag}`);
    await bar.getByTestId("outside-send").click();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const risk = card.getByTestId("approval-risk");
    await expect(risk).toBeVisible();
    await expect(risk).not.toContainText("Codex runs this command");
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      const title = card.locator('[id$="-title"]').first();
      await expect.poll(async () => { const t = (await title.boundingBox())!, r = (await risk.boundingBox())!; return t.y + t.height <= r.y + 0.5 || r.x >= t.x + t.width - 0.5; }).toBe(true);
      // The title keeps its words on a line or two, never one word a line.
      expect((await title.boundingBox())!.height).toBeLessThan(64);
      await shoot(page, "outside-answer-risk-phone");
    } finally { await page.setViewportSize(desk); }
    await card.getByRole("button", { name: /^Deny/ }).click();
    await card.getByTestId("deny-send").click();
    await expect(page.locator('[data-testid="tool-call"][data-call="c2"]').last().getByTestId("call-answer")).toHaveText("denied by you", { timeout: 15_000 });
    await expect(bar.getByTestId("outside-holder")).toHaveText("Free", { timeout: 10_000 });

    // A Codex that keeps no writer locks: nothing says whether a terminal has it open, so the box goes.
    rmSync(join(home!, "thread-writer-locks"), { recursive: true, force: true });
    try {
      await page.reload();
      await expect(bar.getByTestId("outside-note")).toContainText("keeps no writer locks", { timeout: 10_000 });
      await expect(bar.getByTestId("outside-compose")).toHaveCount(0);
      await shoot(page, "outside-answer-unlocked");
    } finally { mkdirSync(join(home!, "thread-writer-locks"), { recursive: true }); }

    // A send a restart cut while Codex worked, as the bar shows it after the restart (a restart is not made
    // here: the bar's own read is answered with that row).
    await page.route(`**/api/sessions/${sid}/outside`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, sends: [{ id: "cut-1", text: `Deploy the build ${tag}`, state: "cut", said: "Keel restarted while Codex worked: the turn stopped there" }] } });
    });
    await page.reload();
    const cut = bar.getByTestId("outside-send-row");
    await expect(cut).toHaveAttribute("data-state", "cut");
    await expect(cut).toContainText("Keel restarted while Codex worked: the turn stopped there");
    await expect(cut.getByTestId("outside-send-again")).toHaveCount(0);
    await expect(bar.getByTestId("outside-send")).toBeDisabled();
    await shoot(page, "outside-answer-cut");
    await page.unroute(`**/api/sessions/${sid}/outside`);

    // What Keel sent is the rollout's own record, once; nothing of Keel's was written beside it.
    const text = readFileSync(rollout, "utf8");
    expect(text.split(`"message":"Run the tests ${tag}"`).length - 1).toBe(1);
    // Resumed with the thread's own provider, folder, approval policy and sandbox.
    const resumed = readFileSync(`${rollout}.standin.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.method === "thread/resume");
    expect(resumed?.params).toEqual({ threadId: thread, excludeTurns: true, modelProvider: "openai", cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
    // The old way in is still refused: a Keel turn in it.
    expect((await request.post(`/api/sessions/${sid}/messages`, { data: { text: "hello" } })).status()).toBe(409);
  } finally {
    if (sid) await request.delete(`/api/sessions/${sid}`);
    rmSync(year, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
