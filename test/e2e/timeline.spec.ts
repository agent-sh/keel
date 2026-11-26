import { expect, test, type Page } from "./isolate.ts";
import { specEnv, TACIT_STANDIN } from "./own-daemon.ts";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TimelinePage, TimelineRow } from "../../src/admin/timeline-rows.ts";
import type { StoredEvent } from "../../src/core/types.ts";
import { shoot } from "./shots.ts";

// Feature: the session timeline. One route and one panel say what happened in
// a session (its turns and who started each, agents, waits, approvals, a
// daemon restart, failures), what it is doing now and what it waits on,
// without a word of its prompts or tool output; an Activity row keeps the
// turn it happened in. The spec runs its own daemon on a scratch state
// folder, on the scripted stand-in, and restarts it once mid-turn.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], {
    // Nothing of the machine's own is reached (own-daemon.ts): no other harness's sessions, no registry, no phone.
    env: specEnv(state, { KEEL_RESUME_GAP_MS: "0", TACIT_BIN: TACIT_STANDIN, KEEL_MCP_CONFIG: join(state, "mcp.json") }, join(state, "work")),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 60_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); done({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));
const script = (calls: unknown[], word = "script:calls") => `${word} ${JSON.stringify(calls)}`;
// Words of prompts, commands and notes: none may reach the timeline.
const PRIVATE = ["timeline-prompt-marker", "timeline-tool-marker", "timeline-note-marker", "timeline-agent-marker", "script:"];

// Each fixture daemon is a different origin. The runner's workbench preference
// only applies to the shared daemon, and Focus hides the panel picker.
const useWorkbench = (page: Page) => page.addInitScript(() => localStorage.setItem("keel.workbench", "true"));

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("the timeline tells a session's story, live, and opens each turn's receipt", async ({ page }) => {
  test.setTimeout(420_000);
  const state = join(ROOT, `timeline-${Date.now()}`);
  made.push(state);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  let d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  // Every view at the owner's window and at a narrow one, in both themes.
  const shots = async (name: string) => {
    await page.mouse.move(600, 4);
    await shoot(page, name);
    await page.setViewportSize({ width: 900, height: 1040 });
    await shoot(page, `${name}-narrow`);
    await page.setViewportSize({ width: 1920, height: 1040 });
  };
  try {
    const open = async (title: string) => {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
      await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
      return session.id as string;
    };
    const id = await open("Parser cleanup");
    const base = `/api/sessions/${id}`;
    const events = async (sid = id): Promise<StoredEvent[]> => (await call(`/api/sessions/${sid}`)).events;
    const ends = async (sid = id) => (await events(sid)).filter((e) => e.kind === "turn_end");
    const ended = (n: number, sid = id) => expect.poll(async () => (await ends(sid)).length, { timeout: 60_000 }).toBe(n);
    const send = (text: string, mode?: "queue", sid = id) => call(`/api/sessions/${sid}/messages`, { text, mode });
    const timeline = (q = "", sid = id): Promise<TimelinePage> => call(`/api/sessions/${sid}/timeline${q}`);
    const turnAfter = async (text: string) => {
      const ev = await events();
      const prompt = ev.find((e) => e.kind === "user" && String(e.data.text).includes(text))!;
      return ev.find((e) => e.kind === "turn_start" && e.parent === prompt.id)!;
    };
    const text = (r: TimelineRow) => r.text;

    // An owner's turn, then a queued one whose two tool calls fail.
    await send("script:slow timeline-prompt-marker");
    await send(script([{ name: "Bash", input: { command: "printf timeline-tool-marker; exit 1" } }, { name: "timeline-no-such-tool", input: {} }], "script:batch"), "queue");
    await ended(2);
    // An agent, then a wait whose wake starts the next turn.
    await send(script([{ name: "spawn_agent", input: { message: "Check the parser\ntimeline-agent-marker\nscript:calls []", isolation: "none" } }]));
    await expect.poll(async () => (await timeline("?only=agents")).rows.map((r) => r.sub).sort(), { timeout: 60_000 }).toEqual(["completed", "started"]);
    // Its report starts a turn of its own.
    await expect.poll(async () => (await timeline("?only=turns")).rows.find((r) => r.turn?.origin === "subagent")?.sub, { timeout: 60_000 }).toBe("ok");
    let n = (await ends()).length;
    await send(script([{ name: "wait_for", input: { kind: "timer", seconds: 2, note: "timeline-note-marker" } }]));
    await ended((n += 2));
    // A model request that fails twice before it answers: the turn is fine, the failures are told.
    await send("script:overloaded");
    await ended(++n);
    // The owner stops a turn while its tool runs: the call was stopped, it did not fail.
    await send("script:long-tool");
    await expect.poll(async () => (await timeline()).now!.lines[0]?.text, { timeout: 30_000 }).toBe("Running a turn started by the owner: step 1, running Bash");
    await call(`${base}/interrupt`, { by: "owner" });
    await ended(++n);
    // A crash while a tool runs: the next daemon closes the turn and continues it.
    await send(script([{ name: "Bash", input: { command: "sleep 9; echo slept" } }]));
    await expect.poll(async () => (await timeline()).now!.lines[0]?.text, { timeout: 30_000 }).toBe("Running a turn started by the owner: step 1, running Bash");
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state);
    // The command outlived the daemon and its turn was waiting on it: when it ends, a turn starts with its end.
    await expect.poll(async () => (await ends()).map((e) => e.data.reason).slice(-3), { timeout: 90_000 }).toEqual(["restart", "end_turn", "end_turn"]);

    // --- the route
    const all = await timeline("?limit=200");
    const turns = all.rows.filter((r) => r.kind === "turn").reverse();
    // Each sentence leads with who started the turn.
    // A wake or a report that started a turn is told in that turn's row.
    expect(turns.map(text)).toEqual([
      "Owner prompt, 1 step",
      "Queued prompt, 2 steps, 2 failed tools",
      "Owner prompt, 2 steps",
      'Agent report from "Check the parser", 1 step',
      "Owner prompt, 2 steps",
      expect.stringMatching(/^Wait wake \(a timer, after \d s\), 1 step$/),
      // Twice overloaded, then answered: the row says every request it made.
      "Owner prompt, 1 step, 3 requests, 2 failed",
      "Owner prompt, stopped by the owner after 1 step",
      "Owner prompt, cut when the daemon went down after 1 step",
      "Resumed after a daemon restart, 1 step",
      "Command ended, 1 step",
    ]);
    // One call ran and failed; the other named a tool the session does not have, which is a failed call too.
    expect(turns[1]).toMatchObject({ bad: "2 failed tools", tone: "plain", turn: { origin: "queued", outcome: "ok", steps: 2, tools: 2, failed_tools: 2 } });
    expect(turns[1]!.ms).toBeGreaterThan(0);
    expect(turns[1]!.turn!.cost).toBeGreaterThan(0);
    // The stopped call is a result, not a failure: the row has nothing wrong in it and is no failure.
    expect(turns[7]).toMatchObject({ turn: { outcome: "stopped_by_owner", tools: 1, failed_tools: 0 } });
    expect(turns[7]!.bad).toBeUndefined();
    // A cut turn is one row: its end makes no second row saying the same.
    expect(turns[8]).toMatchObject({ turn: { outcome: "cut" } });
    expect(turns[9]).toMatchObject({ turn: { origin: "restart", outcome: "ok" } });
    expect(all.rows.filter((r) => r.kind === "restart")).toEqual([]);
    // The failed requests, counted for this session.
    const failed = all.rows.filter((r) => r.kind === "error");
    expect(failed.map(text)).toEqual(["Model request failed (overloaded), 2 times"]);
    // Agents, the wait and its wake, each with the ids that open it and the turn it happened in.
    const spawning = await turnAfter("spawn_agent");
    // The report and the wake have no row of their own here: their turns say them, and lead to the agent.
    const agents = all.rows.filter((r) => r.kind === "agent").reverse();
    expect(agents.map(text)).toEqual(['Agent "Check the parser" started (general-purpose)']);
    expect(agents[0]).toMatchObject({ turn_event: spawning.id, refs: { child_session: expect.any(String), agent_id: expect.any(String) } });
    expect(turns[3]!.refs).toMatchObject({ agent_id: agents[0]!.refs!.agent_id, child_session: agents[0]!.refs!.child_session });
    const waits = all.rows.filter((r) => r.kind === "wait").reverse();
    expect(waits.map(text)).toEqual(["Wait set on a timer"]);
    expect(waits[0]!.turn_event).toBe((await turnAfter("wait_for")).id);
    expect(turns.find((r) => r.turn?.origin === "wait")!.refs!.wait_id).toBe(waits[0]!.refs!.wait_id);
    // Under Agents the report is a row: no turn is listed there to say it.
    expect((await timeline("?only=agents")).rows.map(text)).toEqual([expect.stringMatching(/^Agent "Check the parser" reported after \d+ m?s$/), 'Agent "Check the parser" started (general-purpose)']);
    // The agent's own session has its side of the story: its task's turn, and what its parent's list holds about it.
    const child = await timeline("", agents[0]!.refs!.child_session!);
    expect(child.rows.map(text)).toEqual(expect.arrayContaining(["Parent's task, 1 step", 'Agent "Check the parser" started (general-purpose)']));
    // Newest first, and a page at a time gives the same rows once each.
    expect(all.rows.map((r) => r.ts)).toEqual([...all.rows.map((r) => r.ts)].sort((a, b) => b - a));
    const paged: string[] = [];
    for (let before: string | null = "", k = 0; before !== null && k < 50; k++) {
      const p = await timeline(`?limit=3&now=0${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      expect(p.rows.length).toBeLessThanOrEqual(3);
      expect(p.now).toBeUndefined();
      paged.push(...p.rows.map((r) => r.id));
      before = p.next;
    }
    expect(paged).toEqual(all.rows.map((r) => r.id));
    expect((await timeline("?only=turns")).rows.map((r) => r.id)).toEqual(turns.map((r) => r.id).reverse());
    const failures = await timeline("?only=failures");
    expect(failures.rows.map(text)).toEqual(["Model request failed (overloaded), 2 times", "Queued prompt, 2 steps, 2 failed tools"]);
    // It read the whole (short) session to find them, and says how much it read.
    expect(failures.scanned).toBeGreaterThanOrEqual(all.rows.length);
    expect(failures.next).toBeNull();
    // A refresh asks only for what is newer than what it holds: nothing older is read or returned.
    expect((await timeline(`?since=${all.as_of + 1000}`)).rows).toEqual([]);
    expect((await timeline(`?since=${turns[9]!.ts}`)).rows.map((r) => r.id)).toEqual([turns[10]!.id, turns[9]!.id]);
    expect((await fetch(`${d.url}${base}/timeline?only=nothing`)).status).toBe(400);
    expect((await fetch(`${d.url}/api/sessions/none/timeline`)).status).toBe(404);
    // Content-free: the title and the agent's title, never a prompt, a command or a note.
    const body = JSON.stringify(all);
    for (const word of PRIVATE) expect(body).not.toContain(word);
    // The owner's page asks for what each turn was about: the first words of the owner's own prompts,
    // and of nothing else (an agent's report, a wake and a restart start turns too).
    const told = await timeline("?about=1");
    const about = told.rows.filter((r) => r.about);
    expect(about.map((r) => r.about)).toContain("script:slow timeline-prompt-marker");
    expect(about.every((r) => r.kind === "turn" && ["owner", "queued", "steer"].includes(r.turn!.origin))).toBe(true);
    expect(told.rows.filter((r) => r.turn && !["owner", "queued", "steer"].includes(r.turn.origin)).length).toBeGreaterThan(0);
    expect(all.rows.some((r) => "about" in r)).toBe(false);
    // The same story as text, for a model; without ids when it only reads.
    const plain = await (await fetch(`${d.url}${base}/timeline?format=text`)).text();
    expect(plain).toContain('Timeline of session "Parser cleanup"');
    // The command the cut turn started may still run (the daemon took it back to report its end): the session waits on it until then.
    expect(plain).toMatch(/Now: (done|working)\./);
    if (plain.includes("Now: working.")) expect(plain).toContain("A command runs in the background");
    expect(plain).toMatch(/\n\d\d-\d\d \d\d:\d\d:\d\d {3}Wait wake \(a timer, after \d s\), 1 step, \d+ m?s, \$[\d.]+ {2}\[turn=[0-9a-f-]{36}\]\n/);
    for (const word of PRIVATE) expect(plain).not.toContain(word);
    expect(await (await fetch(`${d.url}${base}/timeline?format=text&ids=0`)).text()).not.toMatch(/\[turn=/);

    // Activity rows keep the turn they happened in, also after later turns ran.
    const activity = (await call(`/api/activity?session_id=${id}&limit=100`)).items as { kind: string; sub: string; turn_event: string | null }[];
    expect(activity.find((a) => a.kind === "agent" && a.sub === "started")!.turn_event).toBe(spawning.id);
    // A turn's own row names it (the turn the crash cut never told its end).
    const starts = (await events()).filter((e) => e.kind === "turn_start").map((e) => e.id);
    expect(activity.filter((a) => a.kind === "turn" && a.sub !== "goal").map((a) => a.turn_event).reverse()).toEqual(starts.filter((x) => x !== turns[8]!.id));

    // --- another session: its own failures, and a branch that is not shown
    const other = await open("Second session");
    await send("script:overloaded", undefined, other);
    await ended(1, other);
    await send("script:slow", undefined, other);
    await ended(2, other);
    // The same failure happened elsewhere: this session's row is still here, with its own count.
    expect((await timeline("?only=failures")).rows.map(text)).toContain("Model request failed (overloaded), 2 times");
    expect((await timeline("?only=failures", other)).rows.map(text)).toEqual(["Model request failed (overloaded), 2 times"]);
    // The owner goes back to the first prompt and writes another: the two turns after it are on a branch not shown.
    const firstPrompt = (await events(other)).find((e) => e.kind === "user")!;
    await call(`/api/sessions/${other}/head`, { head_event_id: firstPrompt.id, leaf: false });
    await send("script:slow again", undefined, other);
    await ended(3, other);
    const branched = (await timeline("?only=turns", other)).rows;
    expect(branched.map(text)).toEqual(["Owner prompt, 1 step", "Owner prompt, 1 step, on a branch not shown", "Owner prompt, 1 step, 3 requests, 2 failed, on a branch not shown"]);
    expect(branched.map((r) => r.turn?.branch)).toEqual([undefined, "other", "other"]);

    // --- the panel
    await useWorkbench(page);
    await page.goto(`${d.url}/s/${id}`);
    // The receipt's prompt jump is in the full stream. Sessions with agents
    // default to Conversation instead.
    await page.getByTestId("lens-to-stream").click({ timeout: 30_000 });
    await expect(page.getByTestId("panel-menu")).toBeVisible();
    await page.getByTestId("panel-menu").click();
    await page.getByTestId("panel-search").fill("timeline");
    await page.getByTestId("panel-pick-timeline").click();
    const panel = page.getByTestId("timeline-panel");
    const rows = panel.getByTestId("timeline-row");
    const line = (r: TimelineRow) => panel.locator(`[data-testid="timeline-row"][data-id="${r.id}"]`);
    await expect(rows).toHaveCount(all.rows.length);
    // The command the cut turn started has ended and its turn with it: nothing is going on.
    await expect(panel.getByTestId("timeline-state")).toHaveText("Done");
    await expect(panel.getByTestId("timeline-now-line").first()).toContainText("Nothing is running or waited on. The last turn finished.");
    await expect(rows.first()).toContainText("Command ended, 1 step");
    await expect(rows.nth(1)).toContainText("Resumed after a daemon restart, 1 step");
    // A turn the owner started leads with what they asked; what it took is the line under it.
    await expect(panel.getByTestId("timeline-about").filter({ hasText: "script:slow timeline-prompt-marker" })).toHaveCount(1);
    await expect(panel.getByTestId("timeline-bad")).toHaveText("2 failed tools");
    // One time format in the view: every row has its time to the second.
    await expect(panel.locator("time").first()).toBeVisible();
    for (const t of await panel.locator("time").allTextContents()) expect(t).toMatch(/^\d\d:\d\d:\d\d$/);
    await shots("timeline-01-story");

    // Keyboard: the list is one Tab stop; arrows move, Enter opens the receipt.
    await page.getByTestId("timeline-only-all").focus();
    await page.keyboard.press("Tab");
    await expect(rows.first().locator("button[data-row]")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(panel.locator("button[data-row]:focus")).toHaveCount(0);
    await rows.first().locator("button[data-row]").focus();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowUp");
    const failedTurn = line(turns[1]!);
    await expect(failedTurn.locator("button[data-row]")).toBeFocused();
    await page.keyboard.press("Enter");
    const receipt = failedTurn.getByTestId("timeline-receipt");
    await expect(receipt.getByTestId("receipt-inputs")).toContainText("a queued prompt");
    await expect(receipt.getByTestId("receipt-requests")).toContainText("2 model requests");
    // Each failed call is named by its tool and opens in the trace: the command by its exit code, the call that named no tool as that
    // (in the order their results came: the call that named no tool was answered at once).
    await expect(receipt.getByTestId("receipt-tools")).toHaveText("2 tool calls, 2 failed: timeline-no-such-tool (no such tool), Bash (exit 1)");
    await expect(receipt.getByTestId("receipt-end")).toContainText("Done after");
    await shots("timeline-02-receipt");
    // Escape from inside the open row closes it and puts the keys back on its line.
    await receipt.getByTestId("receipt-bundle").focus();
    await page.keyboard.press("Escape");
    await expect(receipt).toHaveCount(0);
    await expect(failedTurn.locator("button[data-row]")).toBeFocused();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Enter");
    // The receipt leads to the turn's place in the conversation.
    const queuedPrompt = (await events()).find((e) => e.kind === "user" && e.data.origin === "queued")!;
    await receipt.getByTestId("receipt-show").click();
    await expect(page.locator(`#e-${queuedPrompt.id}`)).toBeInViewport();
    // The failed call opens in the trace, at its span; coming back, the panel is where it was left.
    await receipt.getByTestId("receipt-failed-tool").first().click();
    await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "traces");
    await expect(page.locator('[data-testid="span-row"][aria-current="true"]')).toHaveAttribute("data-status", "error");
    await page.getByTestId("panel-switch").click();
    await page.getByTestId("panel-pick-timeline").click();
    await expect(failedTurn.getByTestId("timeline-receipt")).toBeVisible();
    // The stopped turn's receipt agrees with its row: a call stopped with the turn, none failed.
    await line(turns[7]!).locator("button[data-row]").click();
    await expect(line(turns[7]!).getByTestId("receipt-tools")).toHaveText("1 tool call, 1 stopped with the turn");
    await expect(line(turns[7]!).getByTestId("receipt-end")).toContainText("Stopped after");

    // Filters.
    await page.getByTestId("timeline-only-failures").click();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Model request failed (overloaded), 2 times");
    await page.getByTestId("timeline-only-agents").click();
    await expect(rows).toHaveCount(2);
    await rows.last().locator("button[data-row]").click();
    await expect(rows.last().getByTestId("timeline-open-agent")).toBeVisible();
    await rows.last().getByTestId("timeline-its-turn").click();
    await expect(rows.last().getByTestId("timeline-receipt")).toHaveAttribute("data-turn", spawning.id);
    await shots("timeline-03-agents");
    await page.getByTestId("timeline-only-all").click();
    await expect(rows).toHaveCount(all.rows.length);

    // Live: a call that needs the owner turns "now" to them, and the line leads to the card.
    await call(`${base}/permissions`, { mode: "ask" }, "PUT");
    await send(script([{ name: "Bash", input: { command: "rm timeline-tool-marker.txt" } }]));
    await expect(panel.getByTestId("timeline-state")).toHaveText("Needs you", { timeout: 30_000 });
    const needs = panel.locator('[data-testid="timeline-now-line"][data-tone="owner"]');
    await expect(needs).toHaveText(/Needs you: an approval for Bash/);
    // The call's card is open: the turn waits on the answer, it is not "running Bash".
    await expect(panel.locator('[data-testid="timeline-now-line"][data-kind="turn"]')).toContainText("Running a turn started by the owner: step 1, needs you: an approval");
    // What "now" says is not said again as rows: the list still starts at the last turn that ended.
    await expect(panel.locator('[data-testid="timeline-row"][data-sub="running"]')).toHaveCount(0);
    await expect(panel.locator('[data-testid="timeline-row"][data-tone="owner"]')).toHaveCount(0);
    await expect(rows).toHaveCount(all.rows.length);
    await shots("timeline-04-needs-you");
    await needs.getByRole("button").click();
    await expect(page.locator('[data-testid="approval"] button:focus')).toHaveCount(1);
    // The running turn's line shows its receipt above the list (it has no row yet).
    await panel.locator('[data-testid="timeline-now-line"][data-kind="turn"]').getByRole("button").click();
    await expect(panel.getByTestId("timeline-asked").getByTestId("receipt-end")).toHaveText("Still running");
    await panel.getByTestId("timeline-asked").getByRole("button", { name: "Close the receipt" }).click();
    await expect(panel.locator("button[data-row]:focus")).toHaveCount(1);
    const pending = (await call(`${base}/approvals`)).approvals.filter((a: any) => a.state === "pending");
    expect(pending).toHaveLength(1);
    await call(`${base}/approvals/${pending[0].id}`, { choice: "deny" });
    // The answer moves it on, and what was open is now a row each.
    await expect(panel.getByTestId("timeline-state")).toHaveText("Done", { timeout: 60_000 });
    await expect(rows.first()).toContainText(/Approval for Bash denied from the API after/);
    await expect(rows.nth(1)).toContainText("Approval asked for Bash");
    // The owner's denial is a decision, said as one: not a failed tool, not red, not under Failures.
    await expect(rows.nth(2)).toHaveText(/Owner prompt, 2 steps, 1 denied call/);
    await expect(rows.nth(2).getByTestId("timeline-bad")).toHaveCount(0);
    await expect(rows).toHaveCount(all.rows.length + 3);
    const after = await timeline();
    expect(after.rows[2]).toMatchObject({ tone: "plain", turn: { tools: 1, failed_tools: 0, denied_tools: 1 } });
    expect((await timeline("?only=failures")).rows.map(text)).toEqual(["Model request failed (overloaded), 2 times", "Queued prompt, 2 steps, 2 failed tools"]);
    await rows.nth(2).locator("button[data-row]").click();
    await expect(rows.nth(2).getByTestId("receipt-tools")).toHaveText("1 tool call, 1 denied");
    expect(JSON.stringify(after)).not.toContain("timeline-tool-marker");

    // An Activity row opens the turn it happened in: its own row, open and shown.
    await page.getByTestId("inbox-button").click();
    await page.getByTestId("tab-activity").click();
    // Across sessions a session shows its newest rows and counts the rest: "N more" lists it alone, every row.
    await page.getByTestId("activity-more").filter({ hasText: "Parser cleanup" }).click();
    const started = page.locator('[data-testid="activity-item"][data-kind="agent"]').filter({ hasText: "Started agent" });
    await started.getByTestId("activity-receipt").click();
    const spawned = panel.locator(`[data-testid="timeline-row"][data-id="${spawning.id}"]`);
    await expect(spawned.locator("button[data-row]")).toHaveAttribute("aria-expanded", "true");
    await expect(spawned.locator("button[data-row]")).toBeFocused();
    await expect(spawned.getByTestId("receipt-tools")).toContainText("1 tool call");
    await expect(spawned).toBeInViewport();
    await expect(panel.getByTestId("timeline-asked")).toHaveCount(0);
    await shots("timeline-05-asked");

    // A branch that is not shown reads faint, and says so.
    await page.goto(`${d.url}/s/${other}`);
    await page.getByTestId("panel-menu").click();
    await page.getByTestId("panel-pick-timeline").click();
    await expect(rows.first()).toBeVisible();
    await expect(panel.locator('[data-testid="timeline-row"][data-branch="other"]')).toHaveCount(2);
    await expect(panel.locator('[data-testid="timeline-row"][data-branch="other"]').first()).toContainText("on a branch not shown");
    await shots("timeline-06-branch");
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: the timeline as a tool. A session with no shell reads the text form
// of its own timeline, and of an agent it started, through
// keel__session_timeline (since, only, limit, before); it is refused any other
// session, and so is an agent asking for its parent's. Content-free like the route.
test("a session reads its own timeline and its agents' through a tool, and no other session's", async ({ page }) => {
  const state = join(ROOT, `timeline-tool-${Date.now()}`);
  made.push(state);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  const d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  try {
    const open = async (title: string) => {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
      await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
      return session.id as string;
    };
    const id = await open("Reads its own story");
    const other = await open("Someone else's work");
    const events = async (sid: string): Promise<StoredEvent[]> => (await call(`/api/sessions/${sid}`)).events;
    const idle = (sid: string, ends: number) =>
      expect.poll(async () => { const v = await call(`/api/sessions/${sid}`); return !v.running && (v.events as StoredEvent[]).filter((e) => e.kind === "turn_end").length; }, { timeout: 60_000 }).toBe(ends);
    const results = async (sid: string) => (await events(sid)).flatMap((e) => (e.kind === "tool_result" ? (e.data.results as { content: string; is_error?: boolean }[]) : []));
    const tool = (input: Record<string, unknown> = {}) => ({ name: "keel__session_timeline", input });
    await call(`/api/sessions/${other}/messages`, { text: "timeline-prompt-marker script:slow" });
    await idle(other, 1);

    // The agent runs a command, reads its own timeline and asks for its parent's.
    const task = `Scout the parser\n${script([{ name: "Bash", input: { command: "echo timeline-tool-marker" } }, tool(), tool({ session: id })])}`;
    await call(`/api/sessions/${id}/messages`, { text: `timeline-prompt-marker ${script([{ name: "spawn_agent", input: { message: task, isolation: "none" } }])}` });
    await idle(id, 2); // the spawn, then the agent's report
    const agent = (await call(`/api/sessions/${id}/agents`)).agents[0] as { id: string; session_id: string };
    const own = (await results(agent.session_id)).slice(1);
    expect(own[0]!.is_error ?? false).toBe(false);
    expect(own[0]!.content).toContain(`(${agent.session_id}), newest first`);
    expect(own[0]!.content).toContain("Now: working.");
    expect(own[1]).toMatchObject({ is_error: true, content: expect.stringContaining("NOT_YOURS") });

    await call(`/api/sessions/${id}/messages`, {
      text: script([tool(), tool({ session: agent.id, only: "turns", limit: 1 }), tool({ session: agent.session_id, since: "1h", only: "failures" }), tool({ since: "2099-01-01T00:00:00Z" }), tool({ session: other }), tool({ only: "nothing" }), tool({ limit: 0 })]),
    });
    await idle(id, 3);
    const got = (await results(id)).slice(-7);
    // Its own: what it does now and its turns, each with the id that opens its receipt.
    expect(got[0]!.content).toContain(`Timeline of session "Reads its own story" (${id}), newest first.`);
    expect(got[0]!.content).toContain("Now: working.");
    expect(got[0]!.content).toMatch(/\n\d\d-\d\d \d\d:\d\d:\d\d {3}Owner prompt, 2 steps, \d+ m?s, \$[\d.]+ {2}\[turn=[0-9a-f-]{36}\]/);
    expect(got[0]!.content).toMatch(/Agent .*Scout the parser/);
    // Its agent's, by agent id and by session id, cut down by only, limit and since.
    expect(got[1]!.content).toContain(`(${agent.session_id}), newest first`);
    expect(got[1]!.content.split("\n").filter((l) => /^\d\d-\d\d /.test(l))).toHaveLength(1);
    expect(got[2]!.content).toContain(`(${agent.session_id}), newest first`);
    expect(got[2]!.content).toMatch(/Parent's task, 4 steps, 1 failed tool/); // the refused look at its parent
    expect(got[3]!.content.split("\n").filter((l) => /^\d\d-\d\d /.test(l))).toHaveLength(0);
    // The route gives the same text for the same page.
    const route = await (await fetch(`${d.url}/api/sessions/${agent.session_id}/timeline?format=text&only=turns&limit=1`)).text();
    expect(got[1]!.content.split("\n").slice(1)).toEqual(route.trimEnd().split("\n").slice(1));
    // Another session is refused, and nothing of it is said; bad input reads as the route's.
    expect(got[4]).toMatchObject({ is_error: true, content: expect.stringContaining("NOT_YOURS") });
    expect(got[5]).toMatchObject({ is_error: true, content: "only is one of failures, turns, agents" });
    expect(got[6]).toMatchObject({ is_error: true, content: expect.stringContaining("limit is a whole number") });
    const said = got.map((r) => r.content).join("\n") + own.map((r) => r.content).join("\n");
    for (const word of [...PRIVATE, "Someone else's work", other]) expect(said).not.toContain(word);
    expect(got.slice(0, 4).every((r) => !r.is_error)).toBe(true);

    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("assistant-text").last()).toContainText("Done with 7 calls", { timeout: 30_000 });
    await shoot(page, "timeline-tool-01-calls");
    // An agent whose session was deleted: the answer says that, not that it is on another machine.
    await call(`/api/sessions/${agent.session_id}`, undefined, "DELETE");
    await call(`/api/sessions/${id}/messages`, { text: script([tool({ session: agent.id })]) });
    await idle(id, 4);
    expect((await results(id)).at(-1)).toMatchObject({ is_error: true, content: "NOT_AVAILABLE: that agent's session was deleted, so it has no timeline to read." });
    const errs = (await call("/api/errors?resolved=0")).errors as { context?: { at?: string } }[];
    expect(errs.filter((e) => e.context?.at !== "listing")).toEqual([]);
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
  }
});

// Feature: "what is new since I last read" works on a timeline longer than a
// page. A session of sixty-odd turns reads its own timeline twice with
// `new: true`: the first read shows the newest page and says where the older
// rows start, the second is one line. (Each read returned the first page
// again: the cursor moved only after a read that had no older page.)
test("a second read for what is new is one line on a timeline longer than a page", async () => {
  const state = join(ROOT, `timeline-new-${Date.now()}`);
  made.push(state);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  const [id] = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/long-transcript.ts"), join(state, "state"), join(state, "work"), "400", "Sixty turns"],
    { encoding: "utf8", env: { ...specEnv(state, {}, join(state, "work")), KEEL_FIXTURE_SHAPE: "turns" } })) as string[];
  const d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  try {
    await call(`/api/sessions/${id}/permissions`, { mode: "full-auto" }, "PUT");
    const tool = { name: "keel__session_timeline", input: { new: true } };
    const ends = async () => { const v = await call(`/api/sessions/${id}`); return !v.running && (v.events as StoredEvent[]).filter((e) => e.kind === "turn_end").length; };
    const before = await ends() as number;
    expect(before).toBeGreaterThan(60);
    await call(`/api/sessions/${id}/messages`, { text: script([tool, tool]) });
    await expect.poll(ends, { timeout: 60_000 }).toBe(before + 1);
    const got = ((await call(`/api/sessions/${id}`)).events as StoredEvent[]).flatMap((e) => (e.kind === "tool_result" ? (e.data.results as { content: string }[]) : [])).slice(-2).map((r) => r.content);
    expect(got[0]!.split("\n")[0]).toContain("newest first (no earlier read of yours is kept: the newest rows; the next read with new goes from this one).");
    expect(got[0]).toContain("Older rows: before=");
    expect(got[1]).toMatch(/^Nothing new in session "Sixty turns" since you last read it at \d\d:\d\d:\d\d \(\d+ m?s ago\)\. Now: working\.$/);
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
  }
});

// Feature: the timeline is read in bounded time whatever the session holds. A
// session of 40,000 plain notes and no turn (none of them makes a row) opens
// its Timeline at once, and the daemon answers other requests meanwhile: what
// lies between a session's marks is never walked.
test("the timeline of a session of forty thousand notes opens at once and the daemon keeps answering", async ({ page }) => {
  const state = join(ROOT, `timeline-long-${Date.now()}`);
  made.push(state);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  const [id] = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/long-transcript.ts"), join(state, "state"), join(state, "work"), "40000", "Forty thousand notes"],
    { encoding: "utf8", env: specEnv(state, {}, join(state, "work")) })) as string[];
  const d = await daemon(state);
  try {
    // A read that walks the notes takes minutes and holds every other request: both are given seconds.
    const timed = async (path: string) => {
      const t = performance.now();
      const r = await fetch(d.url + path, { signal: AbortSignal.timeout(10_000) });
      const body = await r.text();
      return { ms: performance.now() - t, status: r.status, body };
    };
    const reads: number[] = [];
    for (const q of ["", "?only=failures", "?only=turns&limit=200", "?format=text", ""]) {
      const [tl, daemonInfo] = await Promise.all([timed(`/api/sessions/${id}/timeline${q}`), timed("/api/daemon")]);
      expect(tl.status, q).toBe(200);
      expect(daemonInfo.status).toBe(200);
      expect(daemonInfo.ms, `/api/daemon beside the timeline${q}`).toBeLessThan(2000);
      expect(tl.ms, `the timeline${q}`).toBeLessThan(2000);
      reads.push(tl.ms);
      if (!q) expect(JSON.parse(tl.body)).toMatchObject({ rows: [], next: null, now: { state: "idle", lines: [{ text: "Nothing has run in this session yet." }] } });
    }
    // The machine may be busy: the quickest of the reads is the read's own time.
    expect(Math.min(...reads), `timeline reads took ${reads.map((m) => m.toFixed(0)).join(", ")} ms`).toBeLessThan(100);

    await useWorkbench(page);
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${id}`);
    await page.getByTestId("panel-menu").click();
    await page.getByTestId("panel-search").fill("timeline");
    await page.getByTestId("panel-pick-timeline").click();
    const panel = page.getByTestId("timeline-panel");
    await expect(panel.getByTestId("timeline-state")).toHaveText("Not started");
    await expect(panel.getByTestId("timeline-now-line")).toHaveText("Nothing has run in this session yet.");
    await shoot(page, "timeline-long-session");
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
  }
});

// Feature: a long session's turns are placed on a branch a bounded piece a
// read. A turn the walk from the session's head has not reached says so
// ("branch not placed yet", and the page is `partial`), never that it is on
// the branch shown; the panel asks again by itself until it is placed, and the
// text form (the command, a model's tool) reads on before it answers.
test("a turn far up a long session says its branch is not placed yet, and is placed without the owner asking", async ({ page }) => {
  const state = join(ROOT, `timeline-branch-${Date.now()}`);
  made.push(state);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  const seeded = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/long-branch.ts"), join(state, "state"), join(state, "work"), "60000"],
    { encoding: "utf8", env: specEnv(state, {}, join(state, "work")) })) as { session: string; kept: string; left: string };
  const d = await daemon(state);
  try {
    // The first read walks its piece from the head and stops well short of the first turns: they say so, and the page does.
    const first = await (await fetch(`${d.url}/api/sessions/${seeded.session}/timeline`)).json() as TimelinePage;
    const rowOf = (p: TimelinePage, id: string) => p.rows.find((r) => r.id === id)!;
    expect(first.partial).toBe(true);
    expect(rowOf(first, seeded.left)).toMatchObject({ text: "Owner prompt, 1 step, branch not placed yet", turn: { branch: "unknown" } });
    expect(rowOf(first, seeded.kept).turn!.branch).toBe("unknown");
    // The text form reads on by itself: placed when it answers, with no word of turns not placed.
    const text = await (await fetch(`${d.url}/api/sessions/${seeded.session}/timeline?format=text&only=turns`)).text();
    expect(text).toContain("Owner prompt, 1 step, on a branch not shown");
    expect(text).not.toContain("not placed");
    expect(text.split("\n").filter((l) => l.includes("Owner prompt, 1 step")).map((l) => l.includes("on a branch not shown"))).toEqual([false, true, false]);

    // A daemon that has not walked it yet, and the page: the row is placed without a click.
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    const again = await daemon(state);
    d.proc = again.proc; d.url = again.url;
    await useWorkbench(page);
    await page.setViewportSize({ width: 1920, height: 1040 });
    const reads: boolean[] = [];
    page.on("response", async (r) => { if (/\/timeline\?/.test(r.url())) reads.push(!!(await r.json().catch(() => ({}))).partial); });
    await page.goto(`${d.url}/s/${seeded.session}`);
    await page.getByTestId("panel-menu").click();
    await page.getByTestId("panel-search").fill("timeline");
    await page.getByTestId("panel-pick-timeline").click();
    const panel = page.getByTestId("timeline-panel");
    const left = panel.locator(`[data-testid="timeline-row"][data-id="${seeded.left}"]`);
    await expect(left).toHaveAttribute("data-branch", "other", { timeout: 20_000 });
    await expect(left).toContainText("on a branch not shown");
    await expect(panel.getByTestId("timeline-row").filter({ hasText: "not placed yet" })).toHaveCount(0);
    // It took more than one read, and the reads stopped once every turn was placed.
    expect(reads[0]).toBe(true);
    expect(reads.at(-1)).toBe(false);
    const n = reads.length;
    await page.waitForTimeout(1_000);
    expect(reads.length).toBe(n);
    await shoot(page, "timeline-06-branch-placed");
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
  }
});
