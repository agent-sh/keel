import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { choose, shoot } from "./shots.ts";

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
    // The card asks, with the colour and the weight; the bar under it says so as plain lines beside its mark.
    const weights = () => bar.evaluate((el) => ["outside-state", "outside-holder"].map((id) => getComputedStyle(el.querySelector(`[data-testid="${id}"]`)!).fontWeight));
    expect(await weights()).toEqual(["400", "400"]);
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
    // With no card above, the bar's own state has its weight back.
    expect((await weights())[0]).toBe("600");
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
      // Later stands with the answers, not on a row of its own under the risk.
      const later = card.getByTestId("ask-later").locator("visible=true");
      await expect(later).toHaveCount(1);
      const deny = (await card.getByTestId("deny").boundingBox())!, put = (await later.boundingBox())!;
      expect(Math.abs(put.y + put.height / 2 - (deny.y + deny.height / 2))).toBeLessThan(4);
      await shoot(page, "outside-answer-risk-phone");
    } finally { await page.setViewportSize(desk); }
    await card.getByRole("button", { name: /^Deny/ }).click();
    await card.getByTestId("deny-send").click();
    const denied = page.locator('[data-testid="tool-call"][data-call="c2"]').last();
    await expect(denied.getByTestId("call-answer")).toHaveText("denied by you", { timeout: 15_000 });
    // It did not run: the line asks, it does not say it ran.
    await expect(denied.locator(".k-line-verb")).toHaveText("Asked to run");
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

// Feature: a Claude Code session the owner runs elsewhere is answered in its own row, same id. Nothing holds it, so
// its box resumes it through `claude -p --resume ID` (the daemon's KEEL_CLAUDE_BIN, a stand-in that speaks Claude
// Code's stream-json wire and writes the transcript as Claude Code does), the command Claude Code asks about is a
// Keel card answered once, and the reply comes into the same row from the transcript. Run the daemon with
// KEEL_IMPORT_CLAUDE_DIR at a scratch store and KEEL_CLAUDE_BIN at test/e2e/fixtures/claude-code.ts
// (scripts/scratch-env.ts names both).
test("a Claude Code session is answered in place: a send, its card, the reply in the same row", async ({ page, request }) => {
  const listed = await (await request.get("/api/import/sessions?limit=1")).json();
  const root = listed.harnesses?.find((h: any) => h.harness === "claude")?.store as string | undefined;
  test.skip(!root || !root.includes("import/claude"), "needs a scratch Claude Code store (KEEL_IMPORT_CLAUDE_DIR) and the claude stand-in (KEEL_CLAUDE_BIN)");
  const watches = async () => (await (await request.get("/api/outside")).json()).watches as number;
  const tag = String(Date.now());
  const id = `0c1a0e2e-0000-4000-8000-${tag.slice(-12).padStart(12, "0")}`;
  const cwd = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `outside-claude-${tag}`);
  mkdirSync(cwd, { recursive: true });
  // Kept under the folder Claude Code names after the session's own folder: Keel starts the child there.
  const dir = join(root!, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const path = join(dir, `${id}.jsonl`);
  let parent: string | null = null;
  const write = (r: object) => {
    const uuid = crypto.randomUUID();
    appendFileSync(path, JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.1.332", entrypoint: "cli", timestamp: new Date().toISOString(), uuid, ...r }) + "\n");
    parent = uuid;
  };
  const sessionOf = async () => ((await (await request.get("/api/sessions")).json()).sessions as any[]).find((s) => s.outside?.source_id === id);
  const config = join(dirname(root!), ".claude.json");
  const trust = (folder: string) => {
    let c: any = {};
    try { c = JSON.parse(readFileSync(config, "utf8")); } catch {}
    writeFileSync(config, JSON.stringify({ ...c, projects: { ...c.projects, [folder]: { hasTrustDialogAccepted: true } } }));
  };
  let sid: string | undefined;
  try {
    const before = await watches();
    mkdirSync(dir, { recursive: true });
    await expect.poll(watches, { timeout: 10_000 }).toBeGreaterThan(before);
    write({ type: "user", message: { role: "user", content: `Set up the release script ${tag}` }, permissionMode: "acceptEdits" });
    write({ type: "assistant", message: { id: "m0", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "The script is in place." }], stop_reason: "end_turn" } });
    // Written a minute ago (a write of the last seconds that no record explains holds a send), in a folder Claude Code
    // trusts (its own record, in the scratch store's config: a print run asks nothing).
    const t = new Date(Date.now() - 60_000);
    utimesSync(path, t, t);
    trust(cwd);
    await expect.poll(async () => (await sessionOf())?.outside?.state, { timeout: 15_000 }).toBe("done");
    sid = (await sessionOf()).id as string;

    await page.goto(`/s/${sid}`);
    const bar = page.getByTestId("outside-bar");
    await expect(bar).toBeVisible();
    await expect(bar.getByTestId("outside-holder")).toHaveText("Free");
    const input = bar.getByTestId("outside-input");
    await expect(input).toHaveAttribute("placeholder", "Answer here: Keel resumes this session in Claude Code");
    await shoot(page, "outside-answer-claude-free");
    // On a phone it is the session's one-line box: a few words said whole, a finger's height, Send a line's icon.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(input).toHaveAttribute("placeholder", "Answer in Claude Code");
    await expect(input).toHaveAttribute("aria-label", "Answer here: Keel resumes this session in Claude Code");
    const px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(2.75 * px - 1);
    expect(await input.evaluate((e) => e.scrollHeight <= e.clientHeight + 1), "the placeholder is one line").toBe(true);
    const sendLook = await bar.getByTestId("outside-send").evaluate((e) => ({ shadow: getComputedStyle(e).boxShadow, label: getComputedStyle(e.querySelector(".k-outside-btn-label")!).display }));
    expect(sendLook).toEqual({ shadow: "none", label: "none" });
    await shoot(page, "outside-answer-claude-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });

    // A send: Claude Code resumes the session and asks before it runs a command.
    await input.fill(`Run the tests ${tag}`);
    await bar.getByTestId("outside-send").dblclick();
    const card = page.getByTestId("approval");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("approval-summary")).toContainText("make test");
    await expect(bar.getByTestId("outside-holder")).toHaveText("Keel is answering");
    await expect(bar.getByTestId("outside-stop")).toBeVisible();
    await expect(page.getByTestId("transcript").getByText(`Run the tests ${tag}`).first()).toBeVisible();
    await shoot(page, "outside-answer-claude-card");

    // Answered once: the reply comes into the same row, from the transcript.
    await card.getByRole("button", { name: /Allow once/i }).click();
    await expect(page.getByTestId("transcript").getByText(`The command was allowed: Run the tests ${tag}`).first()).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveCount(0);
    await expect(bar.getByTestId("outside-holder")).toHaveText("Free", { timeout: 10_000 });
    await expect(bar.getByTestId("outside-sends")).toHaveCount(0);
    expect((await sessionOf())?.id).toBe(sid);
    await shoot(page, "outside-answer-claude-reply");

    // What Keel sent is the transcript's own record, once, in the same session file.
    const text = readFileSync(path, "utf8");
    expect(text.split(`"content":"Run the tests ${tag}"`).length - 1).toBe(1);
    // Resumed by its id with its own model and mode; the text went on standard input, not the command line.
    const started = readFileSync(`${path}.standin.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.argv);
    expect(started?.argv).toEqual(["-p", "--resume", id, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--model", "claude-opus-5-5", "--permission-mode", "acceptEdits"]);

    // A long request has its own scroll area on a phone turned sideways.
    await input.fill(["run: make test", ...Array.from({ length: 28 }, (_, i) => `# Check ${i + 1} of the test plan`)].join("\n"));
    await bar.getByTestId("outside-send").click();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const touch = await page.context().newCDPSession(page);
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect.poll(() => page.getByTestId("composer-tray").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const deny = card.getByTestId("deny");
    await deny.scrollIntoViewIfNeeded();
    await expect(deny).toBeInViewport();
    await expect(input).toBeInViewport({ ratio: 1 });
    await shoot(page, "outside-answer-claude-card-landscape");
    await deny.click();
    await card.getByTestId("deny-send").click();
    await expect(card).toHaveCount(0);
    await expect(bar.getByTestId("outside-holder")).toHaveText("Free", { timeout: 10_000 });
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await touch.detach();
    await page.setViewportSize({ width: 1920, height: 1040 });

    // A plan Claude Code presents is Keel's plan card; approved in Auto edits, Claude Code goes on in acceptEdits.
    await input.fill(`plan the rename ${tag}`);
    await bar.getByTestId("outside-send").click();
    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible({ timeout: 15_000 });
    await expect(plan.getByTestId("plan-text")).toContainText("Rename the loader");
    await shoot(page, "outside-answer-claude-plan");
    // (Approve takes a press once the plan stood read in view: the card says so.)
    await expect(plan).toHaveAttribute("data-read", "true");
    await choose(plan.getByTestId("plan-mode"), "auto-edits");
    await plan.getByTestId("plan-approve").click();
    await expect(page.getByTestId("transcript").getByText("The plan was approved; going on in acceptEdits mode.").first()).toBeVisible({ timeout: 15_000 });
    await expect(plan).toHaveCount(0);
    await expect(bar.getByTestId("outside-holder")).toHaveText("Free", { timeout: 10_000 });

    // A command that is really high risk is marked so, in Keel's words (judged as running with no sandbox of
    // Keel's). Denied, its line says it was asked and denied by the owner (the transcript says only what it returned).
    await input.fill(`wipe it ${tag}`);
    await bar.getByTestId("outside-send").click();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("approval-summary")).toContainText("rm -rf ~/projects");
    const risk = card.getByTestId("approval-risk");
    await expect(risk).toBeVisible();
    await expect(risk).not.toContainText("Claude Code runs this command");
    await card.getByRole("button", { name: /^Deny/ }).click();
    await card.getByTestId("deny-send").click();
    const denied = page.locator('[data-testid="tool-call"]').filter({ hasText: "rm -rf ~/projects" }).last();
    await expect(denied.getByTestId("call-answer")).toHaveText("denied by you", { timeout: 15_000 });
    await expect(denied.locator(".k-line-verb")).toHaveText("Asked to run");
    await expect(bar.getByTestId("outside-holder")).toHaveText("Free", { timeout: 10_000 });
    await shoot(page, "outside-answer-claude-denied");
    expect((await request.post(`/api/sessions/${sid}/messages`, { data: { text: "hello" } })).status()).toBe(409);
  } finally {
    if (sid) await request.delete(`/api/sessions/${sid}`);
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// An Antigravity conversation Keel follows is read-only here: its bar says so, has no box, and names no holder
// (who holds a session says whether Keel can answer it, and Keel answers this one nowhere). Run the daemon with
// KEEL_IMPORT_AGY_DIR at a scratch store (scripts/scratch-env.ts names it).
test("an Antigravity session is followed read-only: no box and no holder in its bar", async ({ page, request }) => {
  const listed = await (await request.get("/api/import/sessions?limit=1")).json();
  const home = listed.harnesses?.find((h: any) => h.harness === "agy")?.store as string | undefined;
  test.skip(!home || !home.includes("import/agy"), "needs a scratch Antigravity store (KEEL_IMPORT_AGY_DIR)");
  const tag = String(Date.now());
  const id = `a9a9a9a9-0000-4000-8000-${tag.slice(-12).padStart(12, "0")}`;
  const cwd = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `outside-agy-${tag}`);
  mkdirSync(cwd, { recursive: true });
  const transcript = execFileSync("bun", [join(import.meta.dirname, "fixtures/agy-store.ts"), home!, cwd, id, `Keeper${tag.slice(-4)}`], { encoding: "utf8" }).trim();
  const sessionOf = async () => ((await (await request.get("/api/sessions")).json()).sessions as any[]).find((s) => s.outside?.source_id === id);
  // The conversation grows while Keel watches: that is what makes it a session of the list.
  await expect.poll(async () => {
    appendFileSync(transcript, JSON.stringify({ step_index: 6 + Math.floor(Math.random() * 1e6), type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: new Date().toISOString().replace("T", " ").replace("Z", "000000+00:00"), content: "<USER_REQUEST>\nAnd the keeper's name?\n</USER_REQUEST>" }) + "\n");
    return !!(await sessionOf());
  }, { timeout: 30_000, intervals: [2000] }).toBe(true);
  const sid = (await sessionOf()).id as string;
  try {
    await page.goto(`/s/${sid}`);
    const bar = page.getByTestId("outside-bar");
    await expect(bar).toHaveAttribute("data-harness", "agy");
    await expect(bar.getByTestId("outside-note")).toContainText("Read-only here");
    await expect(bar.getByTestId("outside-compose")).toHaveCount(0);
    await expect(bar.getByTestId("outside-holder")).toHaveCount(0);
    await shoot(page, "outside-answer-agy-read-only");
    // On a phone the read-only bar has room beside its state: Copy says its word, and its whole name to a screen reader.
    await page.setViewportSize({ width: 390, height: 844 });
    const copy = bar.getByRole("button", { name: "Copy into Keel" });
    await expect(copy).toHaveAttribute("title", /keeps running there/);
    await expect(copy.getByText("Copy", { exact: true })).toBeVisible();
    await expect(copy.getByText("Copy into Keel", { exact: true })).toBeHidden();
    await shoot(page, "outside-answer-agy-read-only-phone");
  } finally {
    await request.delete(`/api/sessions/${sid}`).catch(() => {});
  }
});
