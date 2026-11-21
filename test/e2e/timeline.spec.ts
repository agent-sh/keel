import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
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
    env: {
      ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_DRAIN_MS: "300", KEEL_RESUME_GAP_MS: "0",
      KEEL_CONFIG_DIR: join(state, "config"), KEEL_IMPORT_HOME: join(state, "home"), KEEL_DESKTOP_NOTIFY: "off", TACIT_BIN: resolve("test/e2e/fixtures/tacit-standin.sh"),
    },
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

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("the timeline tells a session's story, live, and opens each turn's receipt", async ({ page }) => {
  test.setTimeout(300_000);
  const state = join(ROOT, `timeline-${Date.now()}`);
  made.push(state);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  let d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  try {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Parser cleanup" });
    const base = `/api/sessions/${session.id}`;
    await call(`${base}/permissions`, { mode: "full-auto" }, "PUT");
    const events = async (): Promise<StoredEvent[]> => (await call(base)).events;
    const ended = (n: number) => expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(n);
    const send = (text: string, mode?: "queue") => call(`${base}/messages`, { text, mode });
    const timeline = (q = ""): Promise<TimelinePage> => call(`${base}/timeline${q}`);
    const turnAfter = async (text: string) => {
      const ev = await events();
      const prompt = ev.find((e) => e.kind === "user" && String(e.data.text).includes(text))!;
      return ev.find((e) => e.kind === "turn_start" && e.parent === prompt.id)!;
    };

    // An owner's turn, then a queued one whose two tool calls fail.
    await send("script:slow timeline-prompt-marker");
    await send(script([{ name: "Bash", input: { command: "printf timeline-tool-marker; exit 1" } }, { name: "timeline-no-such-tool", input: {} }], "script:batch"), "queue");
    await ended(2);
    // An agent, then a wait whose wake starts the next turn.
    await send(script([{ name: "spawn_agent", input: { message: "Check the parser\ntimeline-agent-marker\nscript:calls []", isolation: "none" } }]));
    await expect.poll(async () => (await timeline("?only=agents")).rows.map((r) => r.sub).sort(), { timeout: 60_000 }).toEqual(["completed", "started"]);
    // Its report starts a turn of its own.
    await expect.poll(async () => (await timeline("?only=turns")).rows.find((r) => r.turn?.origin === "subagent")?.sub, { timeout: 60_000 }).toBe("ok");
    const before = (await events()).filter((e) => e.kind === "turn_end").length;
    await send(script([{ name: "wait_for", input: { kind: "timer", seconds: 2, note: "timeline-note-marker" } }]));
    await ended(before + 2);
    // A crash while a tool runs: the next daemon closes the turn and continues it.
    await send("script:long-tool");
    await expect.poll(async () => (await timeline()).now!.lines[0]?.text, { timeout: 30_000 }).toBe("Running a turn started by the owner: step 1, running Bash");
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state);
    await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").map((e) => e.data.reason).slice(-2), { timeout: 90_000 }).toEqual(["restart", "end_turn"]);

    // --- the route
    const all = await timeline("?limit=200");
    const text = (r: TimelineRow) => r.text;
    const turns = all.rows.filter((r) => r.kind === "turn").reverse();
    expect(turns.map(text).slice(0, 2)).toEqual(["Turn started by the owner, 1 step", "Turn started by a queued prompt, 2 steps, 2 failed tools"]);
    expect(turns[1]).toMatchObject({ bad: "2 failed tools", tone: "plain", turn: { origin: "queued", outcome: "ok", steps: 2, tools: 2, failed_tools: 2 } });
    expect(turns[1]!.ms).toBeGreaterThan(0);
    expect(turns[1]!.turn!.cost).toBeGreaterThan(0);
    expect(turns.map(text)).toContain("Turn started by a wait wake, 1 step");
    expect(turns.at(-2)).toMatchObject({ text: "Turn started by the owner, cut by a daemon restart after 1 step", turn: { outcome: "cut" } });
    expect(turns.at(-1)).toMatchObject({ text: "Turn continued after a daemon restart, 1 step", turn: { origin: "restart", outcome: "ok" } });
    const cut = all.rows.find((r) => r.kind === "restart")!;
    expect(cut).toMatchObject({ sub: "crash", turn_event: turns.at(-2)!.id });
    // Agents, the wait and its wake, each with the ids that open it and the turn it happened in.
    const spawning = await turnAfter("spawn_agent");
    const agents = all.rows.filter((r) => r.kind === "agent").reverse();
    expect(agents.map(text)).toEqual(['Agent "Check the parser" started (general-purpose)', expect.stringMatching(/^Agent "Check the parser" reported after \d+ m?s$/)]);
    expect(agents[0]).toMatchObject({ turn_event: spawning.id, refs: { child_session: expect.any(String), agent_id: expect.any(String) } });
    const waits = all.rows.filter((r) => r.kind === "wait").reverse();
    expect(waits.map(text)).toEqual(["Wait set on a timer", expect.stringMatching(/^Wait on a timer fired after \d s$/)]);
    expect(waits[0]!.turn_event).toBe((await turnAfter("wait_for")).id);
    expect(turns.find((r) => r.turn?.origin === "wait")!.refs!.wait_id).toBe(waits[0]!.refs!.wait_id);
    // Newest first, and a page at a time gives the same rows once each.
    expect(all.rows.map((r) => r.ts)).toEqual([...all.rows.map((r) => r.ts)].sort((a, b) => b - a));
    const paged: string[] = [];
    for (let before: string | null = "", n = 0; before !== null && n < 50; n++) {
      const p = await timeline(`?limit=3&now=0${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      expect(p.rows.length).toBeLessThanOrEqual(3);
      expect(p.now).toBeUndefined();
      paged.push(...p.rows.map((r) => r.id));
      before = p.next;
    }
    expect(paged).toEqual(all.rows.map((r) => r.id));
    expect((await timeline("?only=turns")).rows.map((r) => r.id)).toEqual(turns.map((r) => r.id).reverse());
    expect((await timeline("?only=failures")).rows.map(text)).toEqual(["Turn started by a queued prompt, 2 steps, 2 failed tools"]);
    expect((await timeline(`?since=${Date.now() + 1000}`)).rows).toEqual([]);
    expect((await fetch(`${d.url}${base}/timeline?only=nothing`)).status).toBe(400);
    expect((await fetch(`${d.url}/api/sessions/none/timeline`)).status).toBe(404);
    // Content-free: the title and the agent's title, never a prompt, a command or a note.
    const body = JSON.stringify(all);
    for (const word of PRIVATE) expect(body).not.toContain(word);
    // The same story as text, for a model.
    const plain = await (await fetch(`${d.url}${base}/timeline?format=text`)).text();
    expect(plain).toContain('Timeline of session "Parser cleanup"');
    expect(plain).toContain("Now: idle.");
    expect(plain).toMatch(/\n\d\d-\d\d \d\d:\d\d {3}Turn started by a wait wake, 1 step, \d+ m?s, \$[\d.]+ {2}\[turn=[0-9a-f-]{36}\]\n/);
    for (const word of PRIVATE) expect(plain).not.toContain(word);

    // Activity rows keep the turn they happened in, also after later turns ran.
    const activity = (await call(`/api/activity?session_id=${session.id}&limit=100`)).items as { kind: string; sub: string; turn_event: string | null }[];
    expect(activity.find((a) => a.kind === "agent" && a.sub === "started")!.turn_event).toBe(spawning.id);
    // A turn's own row names it (the turn the crash cut never told its end).
    const starts = (await events()).filter((e) => e.kind === "turn_start").map((e) => e.id);
    expect(activity.filter((a) => a.kind === "turn" && a.sub !== "goal").map((a) => a.turn_event).reverse()).toEqual(starts.filter((s) => s !== turns.at(-2)!.id));

    // --- the panel
    await page.addInitScript(() => localStorage.setItem("keel.focus", "true"));
    await page.goto(`${d.url}/s/${session.id}`);
    await page.getByTestId("panel-menu").click();
    await page.getByTestId("panel-search").fill("timeline");
    await page.getByTestId("panel-pick-timeline").click();
    const panel = page.getByTestId("timeline-panel");
    const rows = panel.getByTestId("timeline-row");
    await expect(rows).toHaveCount(all.rows.length);
    await expect(panel.getByTestId("timeline-state")).toHaveText("Idle");
    await expect(panel.getByTestId("timeline-now-line")).toHaveText(/Nothing is running or waited on\. The last turn finished\./);
    await expect(rows.first()).toContainText("Turn continued after a daemon restart, 1 step");
    await expect(panel.getByTestId("timeline-bad")).toHaveText("2 failed tools");
    await page.mouse.move(600, 4);
    await shoot(page, "timeline-01-story");

    // Keyboard: the list is one Tab stop; arrows move, Enter opens the receipt.
    await page.getByTestId("timeline-only-all").focus();
    await page.keyboard.press("Tab");
    await expect(rows.first().locator("button[data-row]")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(panel.locator("button[data-row]:focus")).toHaveCount(0);
    await rows.first().locator("button[data-row]").focus();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowUp");
    const failedTurn = panel.locator(`[data-testid="timeline-row"][data-id="${turns[1]!.id}"]`);
    await expect(failedTurn.locator("button[data-row]")).toBeFocused();
    await page.keyboard.press("Enter");
    const receipt = failedTurn.getByTestId("timeline-receipt");
    await expect(receipt.getByTestId("receipt-inputs")).toContainText("a queued prompt");
    await expect(receipt.getByTestId("receipt-requests")).toContainText("2 model requests");
    // One call ran and failed (it opens in the trace); the other named no tool and never ran.
    await expect(receipt.getByTestId("receipt-tools")).toContainText("2 tool calls, 2 failed: call 1 (1 more never ran");
    await expect(receipt.getByTestId("receipt-end")).toContainText("Finished after");
    await page.mouse.move(600, 4);
    await shoot(page, "timeline-02-receipt");
    // The failed call opens in the trace, at its span.
    await receipt.getByTestId("receipt-failed-tool").first().click();
    await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "traces");
    await expect(page.locator('[data-testid="span-row"][aria-current="true"]')).toHaveAttribute("data-status", "error");
    await page.getByTestId("panel-switch").click();
    await page.getByTestId("panel-pick-timeline").click();

    // Filters.
    await page.getByTestId("timeline-only-failures").click();
    await expect(rows).toHaveCount(1);
    await page.getByTestId("timeline-only-agents").click();
    await expect(rows).toHaveCount(2);
    await rows.last().locator("button[data-row]").click();
    await expect(rows.last().getByTestId("timeline-open-agent")).toBeVisible();
    await rows.last().getByTestId("timeline-its-turn").click();
    await expect(rows.last().getByTestId("timeline-receipt")).toHaveAttribute("data-turn", spawning.id);
    await page.mouse.move(600, 4);
    await shoot(page, "timeline-03-agents");
    await page.getByTestId("timeline-only-all").click();
    await expect(rows).toHaveCount(all.rows.length);

    // Live: a call that needs the owner turns "now" to them; the answer moves it on.
    await call(`${base}/permissions`, { mode: "ask" }, "PUT");
    await send(script([{ name: "Bash", input: { command: "rm timeline-tool-marker.txt" } }]));
    await expect(panel.getByTestId("timeline-state")).toHaveText("Needs you", { timeout: 30_000 });
    await expect(panel.locator('[data-testid="timeline-now-line"][data-tone="owner"]')).toHaveText(/Waits on the owner: approval for Bash/);
    await expect(panel.locator('[data-testid="timeline-now-line"][data-kind="turn"]')).toContainText("Running a turn started by the owner: step 1");
    await expect(rows.first()).toHaveAttribute("data-kind", "approval");
    await expect(rows.first()).toHaveAttribute("data-tone", "owner");
    await expect(rows.nth(1)).toContainText("Turn started by the owner: running");
    await page.mouse.move(600, 4);
    await shoot(page, "timeline-04-needs-you");
    await page.setViewportSize({ width: 900, height: 1040 });
    await shoot(page, "timeline-05-narrow");
    await page.setViewportSize({ width: 1920, height: 1040 });
    const pending = (await call(`${base}/approvals`)).approvals.filter((a: any) => a.state === "pending");
    expect(pending).toHaveLength(1);
    await call(`${base}/approvals/${pending[0].id}`, { choice: "deny" });
    await expect(panel.getByTestId("timeline-state")).toHaveText("Idle", { timeout: 30_000 });
    await expect(rows.first()).toContainText(/Approval for Bash denied after/);
    await expect(rows.nth(2)).toContainText("Turn started by the owner, 2 steps, 1 failed tool");
    expect(JSON.stringify(await timeline())).not.toContain("timeline-tool-marker");

    // An Activity row opens the receipt of the turn it happened in.
    await page.getByTestId("inbox-button").click();
    await page.getByTestId("tab-activity").click();
    const started = page.locator('[data-testid="activity-item"][data-kind="agent"]').filter({ hasText: "Started agent" });
    await started.getByTestId("activity-receipt").click();
    const asked = panel.getByTestId("timeline-asked");
    await expect(asked.getByTestId("timeline-receipt")).toHaveAttribute("data-turn", spawning.id);
    await expect(asked.getByTestId("receipt-tools")).toContainText("1 tool call");
    await page.mouse.move(600, 4);
    await shoot(page, "timeline-06-asked");
  } finally {
    d.proc.kill("SIGKILL");
  }
});
