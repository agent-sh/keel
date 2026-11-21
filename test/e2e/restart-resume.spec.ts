import { expect, test } from "./isolate.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a daemon restart does not lose a running turn. A crash (SIGKILL)
// leaves the turn open: the next daemon closes it, marks the tool call it cut
// and continues the turn by itself. A stop (SIGTERM) parks the turn after a
// short drain and the next daemon continues it the same way. This spec runs
// its own daemons on a scratch state folder, on the scripted stand-in.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

// `bin`: run that compiled binary instead of the source; `bind`: a fixed address
// (a page reconnects by itself only to the address it was loaded from).
function daemon(state: string, extra: Record<string, string> = {}, opts: { bin?: string; bind?: string } = {}): Promise<{ proc: ChildProcess; url: string }> {
  const args = ["serve", "--bind", opts.bind ?? "127.0.0.1:0", "--state-dir", state, "--workspace", state];
  const proc = spawn(opts.bin ?? "bun", opts.bin ? args : ["src/main.ts", ...args], {
    // A config folder of its own unless the run names one: never the owner's.
    env: { KEEL_CONFIG_DIR: join(state, "config"), ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); resolve({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("a turn cut by a daemon restart continues by itself", async ({ page }) => {
  const state = join(ROOT, `restart-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  try {
    const post = (url: string, path: string, body: unknown, method = "POST") =>
      fetch(url + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const { session } = await post(d.url, "/api/sessions", { model: "scripted:stand-in" });
    await post(d.url, `/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");

    // A crash while the tool runs.
    await page.goto(`${d.url}/s/${session.id}`);
    await page.getByTestId("composer").fill("script:long-tool");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("tool-call")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId("working")).toContainText("Running Bash"); // the command runs
    await page.waitForTimeout(1_000);
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state);
    await page.goto(`${d.url}/s/${session.id}`);
    await expect(page.getByTestId("turn-end").first()).toContainText("Cut by a daemon restart", { timeout: 60_000 });
    await expect(page.getByTestId("restart-note")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Continued after the restart.", { timeout: 15_000 });
    await expect(page.getByTestId("turn-end")).toHaveCount(2);
    // The call the crash cut reads as cut, not as failed.
    const cutCall = page.getByTestId("tool-call").first();
    await expect(cutCall).toHaveAttribute("data-state", "cut");
    await expect(cutCall.getByTestId("tool-ended")).toHaveText("cut by a restart");
    await expect(cutCall).not.toContainText("failed");
    await shoot(page, "restart-01-resumed-after-crash");
    // Its command outlived the daemon: the dock says it went on, not a bare "exit 0" beside "cut".
    await expect(page.getByTestId("dock-job").first()).toContainText("went on after the restart and finished", { timeout: 45_000 });
    await expect(page.getByTestId("dock-job").first()).not.toContainText("exit 0");
    await shoot(page, "restart-14-cut-command-went-on");

    // A graceful stop while the tool runs: parked, then continued.
    await page.getByTestId("composer").fill("script:long-tool");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("tool-call")).toHaveCount(2, { timeout: 15_000 });
    await page.waitForTimeout(1_000);
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state);
    await page.goto(`${d.url}/s/${session.id}`);
    await expect(page.getByTestId("restart-note")).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId("turn-end")).toHaveCount(4, { timeout: 15_000 });
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Continued after the restart.");

    // The model was told which calls the restarts cut.
    const ev = await (await fetch(`${d.url}/api/sessions/${session.id}`)).json() as any;
    const cut = ev.events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).filter((r: any) => /daemon restart/.test(r.content));
    expect(cut).toHaveLength(2);
    expect(ev.events.filter((e: any) => e.kind === "turn_end").map((e: any) => e.data.reason)).toEqual(["restart", "end_turn", "restart", "end_turn"]);
    await page.getByTestId("tool-call").first().click();
    await shoot(page, "restart-02-resumed-after-stop");
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Many cut sessions continue a few at a time: with one slot, the second starts
// only after the first continued turn ended.
test("continued turns after a restart take turns", async () => {
  const state = join(ROOT, `restart-slots-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  const one = { KEEL_RESUME_AT_ONCE: "1", KEEL_RESUME_GAP_MS: "0" };
  let d = await daemon(state, one);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in" });
      await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
      await call(`/api/sessions/${session.id}/messages`, { text: "script:long-tool" });
      ids.push(session.id);
    }
    const events = async (id: string) => (await call(`/api/sessions/${id}`, undefined, "GET")).events as any[];
    await expect.poll(async () => (await Promise.all(ids.map(events))).every((ev) => ev.some((e) => e.kind === "tool_use" || (e.kind === "assistant" && e.data.blocks?.some((b: any) => b.type === "tool_use")))), { timeout: 15_000 }).toBe(true);
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state, one);
    const done = async () => (await Promise.all(ids.map(events))).map((ev) => ev.filter((e) => e.kind === "turn_end").length);
    await expect.poll(done, { timeout: 60_000 }).toEqual([2, 2]);
    const spans = (await Promise.all(ids.map(events))).map((ev) => ({
      start: ev.find((e) => e.kind === "user" && e.data.origin === "restart")!.ts as number,
      end: ev.filter((e) => e.kind === "turn_end").at(-1)!.ts as number,
    })).sort((a, b) => a.start - b.start);
    expect(spans[1]!.start).toBeGreaterThanOrEqual(spans[0]!.end);
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: an owner's session goes on through any number of restarts by
// itself. Only a turn continued three times in a row with the daemon down
// again before a tool call finished is held: the session says why and offers
// Continue, which starts it again.
test("an owner session continues through restarts until its turn stops moving", async ({ page }) => {
  const state = join(ROOT, `restart-owner-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
    // The held tool reads a named pipe: it ends when something is written there
    // (or by itself: a command a crash cut outlives its daemon).
    const gate = join(state, "release");
    spawnSync("mkfifo", [gate]);
    const hold = { name: "Bash", input: { command: `timeout 90 cat ${gate} > /dev/null; echo released` } };
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Owner across restarts" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    await call(`/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify([hold, hold, hold, hold, hold])}` });
    const view = () => call(`/api/sessions/${session.id}`, undefined, "GET");
    const holds = async () => ((await view()).events as any[]).filter((e) => e.kind === "assistant" && e.data.blocks.some((b: any) => b.type === "tool_use")).length;
    // Cut four times with no tool call finished: continued after the first three.
    for (const n of [1, 2, 3, 4]) {
      await expect.poll(holds, { timeout: 60_000 }).toBe(n);
      expect((await view()).running).toBe(true);
      await page.waitForTimeout(500); // the command runs
      d.proc.kill(n % 2 ? "SIGTERM" : "SIGKILL");
      await exited(d.proc);
      d = await daemon(state);
    }
    const note = async () => ((await view()).events as any[]).findLast((e) => e.kind === "note" && e.data.kind === "restart")?.data.text;
    await expect.poll(note, { timeout: 60_000 }).toContain("3 times in a row");
    expect([(await view()).running, await holds()]).toEqual([false, 4]);
    await page.goto(`${d.url}/s/${session.id}`);
    await page.getByTestId("note").last().scrollIntoViewIfNeeded();
    await expect(page.getByTestId("note").last()).toContainText("was not continued again");
    await expect(page.getByTestId("resume")).toBeVisible();
    await shoot(page, "restart-05-owner-held");
    await page.getByTestId("resume").click();
    await expect.poll(holds, { timeout: 30_000 }).toBe(5);
    // Written until the last call reads it: a command a crash cut still reads
    // the pipe too, and a write can reach it before the last one opens it.
    const last = page.getByTestId("assistant-text").last();
    await expect.poll(async () => {
      spawnSync("sh", ["-c", `echo go > ${gate}`], { timeout: 2_000 });
      return last.textContent();
    }, { timeout: 30_000 }).toContain("Done with 5 calls. Last result: released");
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: an agent working in the background survives daemon restarts, and
// its record always says what its session does. The agent holds on a tool
// through two restarts: it is continued each time, stays running for its
// parent, and its one real report reaches the parent. A restart after that
// changes nothing. A turn started in the finished agent's own session makes it
// a running agent again, which its parent can close, and that report arrives too.
// Only an agent whose continued turn never gets a step done between restarts,
// three times in a row, is ended, as failed, with nothing left running.
test("a background agent is continued across restarts and its record matches what runs", async ({ page }) => {
  const state = join(ROOT, `restart-agent-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
    const restart = async (how: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
      d.proc.kill(how);
      await exited(d.proc);
      d = await daemon(state);
    };
    // The held tool reads a named pipe: it ends when something is written there
    // (or by itself: a command a crash cut outlives its daemon).
    const gate = join(state, "release");
    spawnSync("mkfifo", [gate]);
    const hold = { name: "Bash", input: { command: `timeout 90 cat ${gate} > /dev/null; echo released` } };
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Agent across restarts" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    const spawnCall = [{ name: "spawn_agent", input: { message: `Holder\nscript:calls ${JSON.stringify([hold, hold, hold])}`, isolation: "none" } }];
    await call(`/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify(spawnCall)}` });

    const agent = async () => (await call(`/api/sessions/${session.id}/agents`, undefined, "GET")).agents[0];
    await expect.poll(async () => (await agent())?.session_id, { timeout: 30_000 }).toBeTruthy();
    const child = (await agent()).session_id as string;
    const view = (id: string) => call(`/api/sessions/${id}`, undefined, "GET");
    const holds = async () => ((await view(child)).events as any[]).filter((e) => e.kind === "assistant" && e.data.blocks.some((b: any) => b.type === "tool_use")).length;
    const reports = async () => ((await view(session.id)).events as any[]).filter((e) => e.kind === "user" && String(e.data.text).includes("<subagent_result"));
    // The record and the session agree: the agent is live exactly while a turn runs in its session.
    const state_ = async () => [(await agent()).status, (await view(child)).running];

    await expect.poll(holds, { timeout: 30_000 }).toBe(1);
    for (const n of [2, 3]) {
      await page.waitForTimeout(500); // the command runs
      await restart(n === 2 ? "SIGTERM" : "SIGKILL"); // a stop that parks the turn, then a crash
      await expect.poll(holds, { timeout: 60_000 }).toBe(n);
      expect(await state_()).toEqual(["running", true]);
      expect(await reports()).toHaveLength(0);
    }
    await page.goto(`${d.url}/s/${session.id}`);
    await expect(page.getByTestId("agent-call-status").first()).toContainText(/running/i);
    await shoot(page, "restart-03-agent-running-after-two");

    // Released: its one report, with the real answer, reaches the parent.
    spawnSync("sh", ["-c", `echo go > ${gate}`], { timeout: 10_000 });
    await expect.poll(async () => (await reports()).length, { timeout: 60_000 }).toBe(1);
    expect((await reports())[0].data.text).toContain("Done with 3 calls. Last result: released");
    await expect.poll(state_, { timeout: 15_000 }).toEqual(["completed", false]);
    const turns = async (id: string) => ((await view(id)).events as any[]).filter((e) => e.kind === "turn_start").length;
    await expect.poll(async () => (await view(session.id)).running, { timeout: 30_000 }).toBe(false);

    // A restart with nothing running decides nothing again.
    const before = [await turns(child), await turns(session.id)];
    await restart();
    await page.waitForTimeout(2_000);
    expect([await turns(child), await turns(session.id)]).toEqual(before);
    expect(await state_()).toEqual(["completed", false]);
    expect(await reports()).toHaveLength(1);

    // A turn started in the agent's own session: the parent sees it running and can close it.
    await call(`/api/sessions/${child}/messages`, { text: `script:calls ${JSON.stringify([hold])}` });
    await expect.poll(holds, { timeout: 30_000 }).toBe(4);
    expect(await state_()).toEqual(["running", true]);
    const id = (await agent()).id;
    await call(`/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "close_agent", input: { target: id } }])}` });
    await expect.poll(state_, { timeout: 30_000 }).toEqual(["stopped", false]);
    await expect.poll(async () => (await reports()).length, { timeout: 30_000 }).toBe(2);

    // Continued three times in a row with the daemon down again before a step
    // ended: it is not continued a fourth time. It fails, nothing runs in its
    // session, the parent is told why, and one more restart changes nothing.
    await call(`/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "send_input", input: { target: id, message: `script:calls ${JSON.stringify([hold, hold, hold, hold, hold])}` } }])}` });
    for (const n of [5, 6, 7, 8]) {
      await expect.poll(holds, { timeout: 60_000 }).toBe(n);
      expect(await state_()).toEqual(["running", true]);
      await page.waitForTimeout(500);
      await restart("SIGKILL");
    }
    await expect.poll(state_, { timeout: 60_000 }).toEqual(["failed", false]);
    await expect.poll(async () => (await reports()).length, { timeout: 30_000 }).toBe(3);
    expect((await reports())[2].data.text).toContain("was not continued again");
    const after = await turns(child);
    await restart();
    await page.waitForTimeout(2_000);
    expect([await turns(child), await state_()]).toEqual([after, ["failed", false]]);
    const errs = (await call("/api/errors?resolved=0", undefined, "GET")).errors as any[];
    expect(errs.filter((e) => e.context?.at !== "listing")).toEqual([]);
    await page.goto(`${d.url}/s/${session.id}`);
    await expect(page.getByTestId("agent-report")).toHaveCount(3, { timeout: 30_000 });
    await shoot(page, "restart-04-agent-reports");
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: a goal's verification that needs longer than the gap between
// restarts still ends. The verifier's turn is cut three times (a stop that
// parks it, then two crashes); each start continues that same turn and the
// goal waits for it again: one judge call, one verifier session, one verdict.
test("a goal's verifier is continued across restarts and gives one verdict", async ({ page }) => {
  const state = join(ROOT, `restart-verifier-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  const log = join(state, "requests.jsonl");
  const pipe = join(state, "hold");
  spawnSync("mkfifo", [pipe]);
  let d = await daemon(state, { KEEL_SCRIPTED_LOG: log });
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Verifier across restarts" });
    await call(`/api/sessions/${session.id}/goal`, { objective: `script:verify-holds ${pipe} 3` }, "PUT");
    const goal = async () => (await call(`/api/sessions/${session.id}/goal`, undefined, "GET")).goal;
    const verifiers = async () => ((await call(`/api/sessions/${session.id}/agents`, undefined, "GET")).agents as any[]).filter((a) => a.type === "verifier");
    await expect.poll(async () => (await goal())?.verifier_session, { timeout: 30_000 }).toBeTruthy();
    const child = (await goal()).verifier_session as string;
    const view = (id: string) => call(`/api/sessions/${id}`, undefined, "GET");
    const holds = async () => ((await view(child)).events as any[]).filter((e) => e.kind === "assistant" && e.data.blocks.some((b: any) => b.type === "tool_use")).length;

    for (const [n, how] of [[1, "SIGTERM"], [2, "SIGKILL"], [3, "SIGKILL"]] as const) {
      await expect.poll(holds, { timeout: 60_000 }).toBe(n);
      expect(await goal()).toMatchObject({ status: "pursuing", verifying: true, verifier_session: child });
      await page.waitForTimeout(500); // the read runs
      d.proc.kill(how);
      await exited(d.proc);
      d = await daemon(state, { KEEL_SCRIPTED_LOG: log });
    }
    // The third start continues the turn to its verdict: nothing is left to read.
    await expect.poll(async () => (await goal()).status, { timeout: 60_000 }).toBe("achieved");
    expect(await goal()).toMatchObject({ verified: true, verifying: false, verifier_session: child, evidence: ["3 reads of the pipe were started"] });
    expect((await verifiers()).map((a) => [a.session_id, a.status])).toEqual([[child, "completed"]]);
    const ev = (await view(child)).events as any[];
    expect(ev.filter((e) => e.kind === "user").map((e) => e.data.kind ?? e.data.origin)).toEqual(["verify_goal", "restart", "restart", "restart"]);
    expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["restart", "restart", "restart", "end_turn"]);
    // The judge was asked once, in the first daemon; no start asked it again.
    const sent = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(sent.filter((r) => r.session === session.id && r.purpose === "side")).toHaveLength(1);
    const rows = ((await call(`/api/activity?session_id=${session.id}`, undefined, "GET")).items as any[]).map((a) => a.text as string);
    expect(rows.filter((t) => t.startsWith("Goal verification"))).toHaveLength(1);
    const errs = (await call("/api/errors?resolved=0", undefined, "GET")).errors as any[];
    expect(errs.filter((e) => e.context?.at !== "listing")).toEqual([]);

    await page.goto(`${d.url}/s/${session.id}`);
    await page.getByTestId("composer").fill("/goal"); // opens the goal's panel
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("goal-verify")).toHaveAttribute("data-state", "met", { timeout: 30_000 });
    await shoot(page, "restart-06-verifier-one-verdict");
  } finally {
    d.proc.kill("SIGKILL");
    // The reads a crash cut outlive their daemon: released.
    spawnSync("sh", ["-c", `echo go > ${pipe}`], { timeout: 5_000 });
  }
});

// A queue held by a stop stays held across a restart: the pause and its Resume
// are still shown, nothing runs by itself, and Resume sends the edited prompts in order.
test("a held queue survives a restart", async ({ page }) => {
  const state = join(ROOT, `restart-held-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
    const { session } = await call("/api/sessions", { model: "scripted:stand-in" });
    const sid = session.id;
    await call(`/api/sessions/${sid}/messages`, { text: "script:slow" });
    const one = (await call(`/api/sessions/${sid}/messages`, { text: "first draft", mode: "queue" })).queued;
    await call(`/api/sessions/${sid}/messages`, { text: "second", mode: "queue" });
    await call(`/api/sessions/${sid}/queue/${one.id}`, { text: "first, corrected" }, "PATCH");
    await call(`/api/sessions/${sid}/interrupt`);
    expect((await call(`/api/sessions/${sid}/queue`, undefined, "GET")).held).toBe(true);
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state);
    const q = await call(`/api/sessions/${sid}/queue`, undefined, "GET");
    expect([q.held, q.queue.map((x: any) => x.text)]).toEqual([true, ["first, corrected", "second"]]);
    await page.goto(`${d.url}/s/${sid}`);
    await expect(page.getByTestId("queue-held")).toBeVisible();
    await shoot(page, "restart-03-held-queue-after-restart");
    const ends = async () => ((await call(`/api/sessions/${sid}`, undefined, "GET")).events as any[]).filter((e) => e.kind === "turn_end").length;
    expect(await ends()).toBe(1);
    await page.getByTestId("queue-held").getByRole("button", { name: "Resume" }).click();
    await expect.poll(ends, { timeout: 30_000 }).toBe(3);
    const sent = ((await call(`/api/sessions/${sid}`, undefined, "GET")).events as any[]).filter((e) => e.kind === "user" && e.data.origin === "queued").map((e) => e.data.text);
    expect(sent).toEqual(["first, corrected", "second"]);
    expect((await call(`/api/sessions/${sid}/queue`, undefined, "GET")).held).toBe(false);
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// The compiled binary, killed while the page holds an approval card: the
// reconnected page shows the same card again, and nothing ran meanwhile. The
// continued turn waits on it; allowed, its call runs and the turn goes on to
// its next card. A stop (SIGTERM, which parks the turn) keeps an open card the
// same way, and a denial given after it reaches the model.
test("an approval pending at a crash or a stop is shown again after the restart", async ({ page }) => {
  const state = join(ROOT, `restart-approval-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  const bin = join(state, "keel");
  const built = spawnSync("bun", ["scripts/build.ts", bin], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
  const at = { bin, bind: `127.0.0.1:${port}` };
  let d = await daemon(state, {}, at);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
    const { session } = await call("/api/sessions", { model: "scripted:stand-in" });
    const sid = session.id;
    await call(`/api/sessions/${sid}/permissions`, { mode: "ask" }, "PUT");
    const mark = (n: number) => ({ name: "Bash", input: { command: `echo ran-${n} >> ${join(state, "ran.txt")}` } });
    const ran = () => (existsSync(join(state, "ran.txt")) ? readFileSync(join(state, "ran.txt"), "utf8") : "");

    await page.goto(`${d.url}/s/${sid}`);
    await expect(page.getByTestId("permission-mode")).toHaveText("Ask");
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([mark(1), mark(2)])}`);
    await page.getByTestId("composer").press("Enter");
    const card = page.getByTestId("approval");
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await expect(card.getByTestId("approval-summary")).toContainText("ran-1");
    const first = (await card.getAttribute("data-approval-id"))!;

    d.proc.kill("SIGKILL");
    await exited(d.proc);
    expect(ran()).toBe("");
    d = await daemon(state, {}, at);

    // The same page, reconnected by itself: the same card, still open, and nothing ran.
    await expect(page.getByTestId("sync-state")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(`[data-approval-id="${first}"]`)).toHaveCount(1, { timeout: 30_000 });
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("approval-summary")).toContainText("ran-1");
    await expect(page.getByTestId("working")).toBeVisible({ timeout: 15_000 }); // the continued turn waits on it
    await shoot(page, "restart-04-approval-after-crash");
    expect(ran()).toBe("");

    await card.getByTestId("allow-once").click();
    await expect(card.getByTestId("approval-summary")).toContainText("ran-2", { timeout: 15_000 });
    expect(ran()).toBe("ran-1\n");
    const second = (await card.getAttribute("data-approval-id"))!;
    expect(second).not.toBe(first);

    // A stop parks the turn: the card stays open across it too.
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state, {}, at);
    await expect(page.getByTestId("sync-state")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(`[data-approval-id="${second}"]`)).toHaveCount(1, { timeout: 30_000 });
    await card.getByTestId("deny").click();
    await page.getByTestId("deny-reason").fill("not ran-2");
    await page.getByTestId("deny-send").click();
    await expect(page.getByTestId("assistant-text").last()).toContainText("Done with 2 calls", { timeout: 15_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("not ran-2");
    await expect(card).toHaveCount(0);
    expect(ran()).toBe("ran-1\n");
    const again = await call(`/api/sessions/${sid}/approvals/${first}`, { choice: "once" });
    expect([again.status, again.error]).toEqual([409, "already allowed (once)"]);

    // Recorded once each: two cut turns, each call's one result in call order, the continued turns.
    const ev = (await call(`/api/sessions/${sid}`, undefined, "GET")).events as any[];
    expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length);
    expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["restart", "restart", "end_turn"]);
    const users = ev.filter((e) => e.kind === "user");
    expect(users.map((e) => e.data.origin ?? "owner")).toEqual(["owner", "restart", "restart"]);
    for (const u of users.slice(1)) expect(u.data.text).toContain("1 call that waited for the owner was asked again");
    const results = ev.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
    const uses = ev.filter((e) => e.kind === "assistant").flatMap((e) => e.data.blocks).filter((b: any) => b.type === "tool_use");
    expect(uses).toHaveLength(2);
    expect(results.map((r: any) => r.tool_use_id)).toEqual(uses.map((u: any) => u.id));
    expect(results.map((r: any) => !!r.is_error)).toEqual([false, true]);
    expect(results[1].content).toBe("The owner denied this call: not ran-2");
    const cards = (await call(`/api/sessions/${sid}/approvals?all`, undefined, "GET")).approvals as any[];
    expect(cards.map((a) => [a.id, a.state]).sort()).toEqual([[first, "allowed"], [second, "denied"]].sort());

    // A parallel batch: the owner denies one call with a reason while the other
    // still runs, then the daemon dies. The denial and its reason reach the
    // model after the restart; only the call that was running may have partly run.
    expect((await call("/api/permissions/grants", { session_id: sid, kind: "shell", pattern: "sleep *", lifetime: "session" })).status).toBe(201);
    const denied = join(state, "denied.txt");
    await page.getByTestId("composer").fill(`script:batch ${JSON.stringify([{ name: "Bash", input: { command: "sleep 20" } }, { name: "Bash", input: { command: `echo no > ${denied}` } }])}`);
    await page.getByTestId("composer").press("Enter");
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await expect(card.getByTestId("approval-summary")).toContainText("denied.txt");
    await card.getByTestId("deny").click();
    await page.getByTestId("deny-reason").fill("leave denied.txt alone");
    await page.getByTestId("deny-send").click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("working")).toContainText("Running Bash"); // the sleep still runs
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state, {}, at);
    await expect(page.getByTestId("assistant-text").last()).toContainText("Batch done.", { timeout: 30_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("leave denied.txt alone");
    expect(existsSync(denied)).toBe(false);
    const batch = ((await call(`/api/sessions/${sid}`, undefined, "GET")).events as any[]).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).filter((r: any) => r.tool_use_id.startsWith("batch-"));
    expect(batch.map((r: any) => [r.is_error, r.content]).sort()).toEqual([
      [true, "Interrupted by a daemon restart while this tool ran. It may have partly run: check its effects before running it again."],
      [true, "The owner denied this call: leave denied.txt alone"],
    ]);

    // Nothing but this machine's provider listings reached the Errors panel.
    const errs = (await call("/api/errors?resolved=0", undefined, "GET")).errors as any[];
    expect(errs.filter((e) => e.context?.at !== "listing")).toEqual([]);
    await page.getByTestId("errors-button").click();
    await expect(page.getByTestId("errors-panel").getByTestId("error-row")).toHaveCount(errs.length);
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: what waits on the owner survives a restart. A question (the
// owner's session's and a subagent's) and a plan put up for approval are
// still open on the same cards after a crash and after a stop, answerable,
// with no result written for them meanwhile; the inbox keeps the question as
// a decision, not as a finished turn.
test("a question and a plan waiting at a crash or a stop still wait after the restart", async ({ page }) => {
  const state = join(ROOT, `restart-waits-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  const bin = join(state, "keel");
  const built = spawnSync("bun", ["scripts/build.ts", bin], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
  const at = { bin, bind: `127.0.0.1:${port}` };
  let d = await daemon(state, {}, at);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
    const question = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } };
    const plan = "## Retry policy\n\n1. Read the importer.\n2. Change the retry policy.";
    const make = async (title: string, mode: string, calls: unknown[]) => {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
      await call(`/api/sessions/${session.id}/permissions`, { mode }, "PUT");
      await call(`/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify(calls)}` });
      return session.id as string;
    };
    const asker = await make("Pick an accent color", "ask", [question]);
    const planner = await make("Plan the retry policy", "plan", [{ name: "present_plan", input: { plan } }]);
    const parent = await make("Parent of an asking agent", "full-auto", [{ name: "spawn_agent", input: { message: `Color helper\nscript:calls ${JSON.stringify([question])}` } }]);
    const pending = async (id: string) => (await call(`/api/sessions/${id}/questions`, undefined, "GET")).pending as string[];
    const plans = async () => ((await call(`/api/sessions/${planner}/plan`, undefined, "GET")).open as { id: string }[]).map((c) => c.id);
    const events = async (id: string) => (await call(`/api/sessions/${id}`, undefined, "GET")).events as any[];
    await expect.poll(async () => (await call(`/api/sessions/${parent}/agents`, undefined, "GET")).agents?.[0]?.session_id, { timeout: 30_000 }).toBeTruthy();
    const child = (await call(`/api/sessions/${parent}/agents`, undefined, "GET")).agents[0].session_id as string;
    await expect.poll(() => pending(asker), { timeout: 30_000 }).toHaveLength(1);
    await expect.poll(() => pending(child), { timeout: 30_000 }).toHaveLength(1);
    await expect.poll(plans, { timeout: 30_000 }).toHaveLength(1);
    const [askId] = await pending(asker), [childId] = await pending(child), [planId] = await plans();

    await page.goto(`${d.url}/s/${asker}`);
    const card = page.getByTestId("question");
    await expect(card).toHaveAttribute("data-state", "open");
    const waits = async () => [await pending(asker), await pending(child), await plans()];

    // A crash: the same three cards wait again, by themselves, and nothing was recorded as their result.
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state, {}, at);
    await expect.poll(waits, { timeout: 60_000 }).toEqual([[askId], [childId], [planId]]);
    await expect(page.getByTestId("sync-state")).toHaveCount(0, { timeout: 30_000 });
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await expect(card).toHaveCount(1);
    await expect(page.getByTestId("station-word")).toHaveText("Needs you"); // the continued turn waits on it
    await shoot(page, "restart-06-question-after-crash");
    for (const id of [asker, child, planner]) expect((await events(id)).filter((e) => e.kind === "tool_result")).toEqual([]);
    // The inbox keeps the question as a decision the owner owes; the cut turn is not filed as finished.
    const filed = async (id: string) => ((await call("/api/alerts?with_unread", undefined, "GET")).alerts as any[]).filter((a) => a.session_id === id).map((a) => a.kind);
    expect(await filed(asker)).toEqual(["question"]);
    await page.getByTestId("inbox-button").click();
    const item = page.getByTestId("inbox-item").filter({ hasText: "Pick an accent color" });
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId("inbox-state")).toContainText("Question");
    await shoot(page, "restart-07-question-in-inbox");
    await page.keyboard.press("Escape");
    // Read once: a restart that puts the question back does not raise it again.
    await call("/api/alerts/read", { session_id: asker });
    const alertsOf = async (id: string) => ((await call("/api/alerts?with_unread", undefined, "GET")).alerts as any[]).filter((a) => a.session_id === id).map((a) => [a.kind, a.read]);
    expect(await alertsOf(asker)).toEqual([["question", true]]);

    // A stop parks the turns: the cards are open across it too.
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state, {}, at);
    await expect.poll(waits, { timeout: 60_000 }).toEqual([[askId], [childId], [planId]]);
    await expect(page.getByTestId("sync-state")).toHaveCount(0, { timeout: 30_000 });
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    expect(await alertsOf(asker)).toEqual([["question", true]]);
    // The two restarts under the waiting card read as one line, with their count.
    await expect(page.getByTestId("turn-reason")).toHaveText("Cut by a daemon restart, 2 times");
    await expect(page.getByTestId("turn-end")).toHaveCount(1);
    // The parked turns are not filed as finished beside their open cards (nobody was watching these two).
    expect(await filed(planner)).toEqual([]);
    expect(await filed(parent)).not.toContain("finished");

    // Answerable: the owner's answer is the question's one result.
    await card.getByRole("radio", { name: "Amber" }).click();
    await card.getByTestId("question-submit").click();
    await expect(card).toHaveAttribute("data-state", "answered", { timeout: 15_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("Amber", { timeout: 15_000 });
    const ev = await events(asker);
    expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["restart", "restart", "end_turn"]);
    const results = ev.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
    expect(results.map((r: any) => [r.tool_use_id, !!r.is_error])).toEqual([[askId, false]]);
    // Two restarts while the card waited: the model is told once, not once per restart.
    const told = ev.filter((e) => e.kind === "user" && e.data.origin === "restart");
    expect(told).toHaveLength(1);
    expect(told[0].data.text).toContain("1 call that waited for the owner was asked again");

    // The plan card is on its session's page, and approving it moves the work on.
    await page.goto(`${d.url}/s/${planner}`);
    const planCard = page.getByTestId("plan-card");
    await expect(planCard).toHaveCount(1, { timeout: 15_000 });
    await expect(planCard.getByTestId("plan-text")).toContainText("Change the retry policy");
    await shoot(page, "restart-08-plan-after-restarts");
    await planCard.getByTestId("plan-approve").click();
    await expect(planCard).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("The owner approved the plan", { timeout: 15_000 });
    expect((await events(planner)).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => [r.tool_use_id, !!r.is_error])).toEqual([[planId, false]]);

    // The agent's question takes its answer too, and the agent ends with it.
    expect((await call(`/api/sessions/${child}/questions/${childId}`, { answers: { "0": { picked: ["Teal"] } } })).status).toBe(200);
    await expect.poll(async () => (await events(child)).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => [r.tool_use_id, !!r.is_error]), { timeout: 15_000 }).toEqual([[childId, false]]);
    await expect.poll(async () => (await call(`/api/sessions/${parent}/agents`, undefined, "GET")).agents[0].status, { timeout: 30_000 }).toBe("completed");
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: a message sent while the daemon is away is not lost and not sent
// twice. Down (a crash) or taking no new work (a stop waiting for a running
// turn), the message waits on the box's shelf under the id it was sent with,
// goes out by itself when the daemon is back, and is stored once.
test("a message sent while the daemon is down or draining goes out once when it is back", async ({ page }) => {
  const state = join(ROOT, `restart-sends-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  const bin = join(state, "keel");
  const built = spawnSync("bun", ["scripts/build.ts", bin], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
  const at = { bin, bind: `127.0.0.1:${port}` };
  const env = { KEEL_DRAIN_MS: "15000" };
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM4YaOh0XOHAUIBACUCBXmhkn0oAAAAAElFTkSuQmCC";
  let d = await daemon(state, env, at);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Sends across restarts" });
    const other = await call("/api/sessions", { model: "scripted:stand-in", title: "Another session" });
    const sid = session.id as string;
    // Every post of a message of the session, across page loads.
    let posts = 0;
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith(`/api/sessions/${sid}/messages`)) posts++; });
    await call(`/api/sessions/${sid}/permissions`, { mode: "full-auto" }, "PUT");
    const view = () => call(`/api/sessions/${sid}`, undefined, "GET");
    const sent = async () => ((await view()).events as any[]).filter((e) => e.kind === "user" && e.data.origin !== "restart").map((e) => e.data.text);
    const composer = page.getByTestId("composer");
    const saved = page.getByTestId("saved-draft");
    await page.goto(`${d.url}/s/${sid}`, { waitUntil: "networkidle" }); // every part of the page is loaded before the daemon goes
    await expect(composer).toBeVisible();
    await expect(page.getByTestId("sync-state")).toHaveCount(0, { timeout: 30_000 });

    // Down: the message waits, and says so.
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    await expect(page.getByTestId("sync-state")).toHaveText("Reconnecting", { timeout: 15_000 });
    await composer.fill("sent while Keel was down");
    await composer.press("Enter");
    await expect(saved).toHaveAttribute("data-state", "waiting");
    await expect(saved).toContainText("Waiting for Keel");
    await expect(saved).toContainText("sent while Keel was down");
    await expect(saved.getByTestId("saved-waiting")).toContainText("goes out by itself, once");
    await expect(composer).toHaveValue("");
    await shoot(page, "restart-09-send-waits-for-daemon");

    // Back: it goes out by itself, once, and no card is left.
    d = await daemon(state, env, at);
    await expect(saved).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("user-message").filter({ hasText: "sent while Keel was down" })).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Scripted reply.", { timeout: 15_000 });
    expect(await sent()).toEqual(["sent while Keel was down"]);

    // The same send again under its id (an answer that was lost): the daemon stores nothing new and says so.
    const named = { text: "named once", client_id: "spec-send-1" };
    const first = await call(`/api/sessions/${sid}/messages`, named);
    const again = await call(`/api/sessions/${sid}/messages`, named);
    expect([first.status, again.status, again.replayed]).toEqual([201, 200, true]);
    expect((again.event ?? again.queued).id).toBe((first.event ?? first.queued).id);
    expect((await call(`/api/sessions/${sid}/messages`, { text: "another message", client_id: "spec-send-1" })).status).toBe(409);
    await expect.poll(async () => (await view()).running, { timeout: 15_000 }).toBe(false);
    expect(await sent()).toEqual(["sent while Keel was down", "named once"]);

    // Stopping while a turn runs: the daemon takes no new work, and the message
    // (here with a picture) waits the same way. It is not posted again while the
    // daemon drains, its session's row says it waits, and it goes out after a
    // reload on another session's page, without its own box being opened.
    await composer.fill("script:long-tool");
    await composer.press("Enter");
    await expect(page.getByTestId("working")).toContainText("Running Bash", { timeout: 15_000 });
    expect((await call(`/api/sessions/${sid}/draft`, { images: [{ name: "shot.png", mime: "image/png", data: PNG }], origin: "capture" })).status).toBe(200);
    await expect(page.getByTestId("attachments").getByRole("img", { name: "shot.png" })).toBeVisible();
    d.proc.kill("SIGTERM");
    await expect(page.getByTestId("admin-band")).toBeVisible({ timeout: 5_000 });
    await composer.fill("sent while Keel was stopping");
    await composer.press("Enter");
    await expect(saved).toHaveAttribute("data-state", "waiting");
    await expect(saved).toContainText("sent while Keel was stopping");
    await expect(page.locator(`[data-testid="session-row"][data-session="${sid}"]`).getByTestId("waiting-send-mark")).toHaveText("waits to send");
    await shoot(page, "restart-10-send-waits-for-drain");
    const posted = posts;
    await page.goto(`${d.url}/s/${other.session.id}`);
    await expect(page.locator(`[data-testid="session-row"][data-session="${sid}"]`).getByTestId("waiting-send-mark")).toBeVisible();
    await page.waitForTimeout(4_500); // two of the old two-second rounds
    expect(posts).toBe(posted);
    await exited(d.proc);
    d = await daemon(state, env, at);
    await expect.poll(sent, { timeout: 30_000 }).toContain("sent while Keel was stopping");
    await expect(page.locator(`[data-testid="session-row"][data-session="${sid}"]`).getByTestId("waiting-send-mark")).toHaveCount(0);
    await expect.poll(async () => (await view()).running, { timeout: 60_000 }).toBe(false);
    expect(await sent()).toEqual(["sent while Keel was down", "named once", "script:long-tool", "sent while Keel was stopping"]);
    const last = ((await view()).events as any[]).find((e) => e.kind === "user" && e.data.text === "sent while Keel was stopping");
    expect(last.data.images).toHaveLength(1);
    // The message did not take the place of the cut turn's continuation: the model was told of the restart, once.
    expect(((await view()).events as any[]).filter((e) => e.kind === "user" && e.data.origin === "restart")).toHaveLength(1);
    await page.goto(`${d.url}/s/${sid}`);
    await expect(page.getByTestId("user-message").filter({ hasText: "sent while Keel was stopping" })).toHaveCount(1);
    await expect(saved).toHaveCount(0);
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: the page says when it cannot reach the daemon. A band across the
// top appears within two seconds of the drop, the clock of the running turn
// stops (the page no longer knows that the work goes on), and both go back
// to normal when the daemon is reachable again.
test("the page says the daemon is unreachable and stops its clocks", async ({ page }) => {
  const state = join(ROOT, `restart-away-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  const bin = join(state, "keel");
  const built = spawnSync("bun", ["scripts/build.ts", bin], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
  const at = { bin, bind: `127.0.0.1:${port}` };
  let d = await daemon(state, {}, at);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Working when the daemon went" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    const gate = join(state, "gate");
    await call(`/api/sessions/${session.id}/messages`, { text: `script:hold ${gate}` });
    await page.goto(`${d.url}/s/${session.id}`, { waitUntil: "networkidle" });
    const band = page.getByTestId("daemon-away");
    const clock = page.locator(".k-station-clock");
    await expect(page.getByTestId("station-word")).toHaveText("Working");
    await expect(clock).toHaveText(/^\d+s$/);
    await expect(band).toHaveCount(0);

    d.proc.kill("SIGKILL");
    await exited(d.proc);
    await expect(band).toBeVisible({ timeout: 2_000 });
    await expect(band).toContainText(/Keel is not reachable since \d\d:\d\d\. Reconnecting\./);
    await expect(band.getByTestId("daemon-away-note")).toContainText("Messages you send wait");
    const stopped = await clock.innerText();
    await page.waitForTimeout(2_500);
    expect(await clock.innerText()).toBe(stopped);
    await shoot(page, "restart-11-daemon-unreachable");
    // Narrow: the band keeps its first words.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(band).toContainText("Keel is not reachable");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shoot(page, "restart-12-daemon-unreachable-narrow");
    await page.setViewportSize({ width: 1920, height: 1040 });

    // Back: the band goes, and the turn (continued by itself) ends.
    d = await daemon(state, {}, at);
    await expect(band).toHaveCount(0, { timeout: 30_000 });
    writeFileSync(gate, "");
    await expect(page.getByTestId("station-word")).toHaveText("Done", { timeout: 60_000 });
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: a turn the provider asked to wait long for continues by itself.
// The failure says when, with a countdown; at that time the turn goes on with
// nobody pressing anything, also when the daemon restarted meanwhile; the
// owner can go on at once or call it off. (These daemons take a wait of a few
// seconds for a long one, so the spec does not sit for minutes.)
test("a rate-limited turn continues by itself at the time the provider named", async ({ page }) => {
  const state = join(ROOT, `restart-ratelimit-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  const env = { KEEL_RETRY_WAIT_MAX_MS: "1000", KEEL_SCRIPTED_RATE_WAIT_MS: "2000" };
  let d = await daemon(state, env);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Rate limited for a while" });
    const sid = session.id as string;
    const view = () => call(`/api/sessions/${sid}`, undefined, "GET");
    const ends = async () => ((await view()).events as any[]).filter((e) => e.kind === "turn_end").map((e) => e.data.reason);
    const composer = page.getByTestId("composer");
    const box = page.getByTestId("turn-error");
    const answer = "Answered after the wait the provider asked for.";

    // The failure names the time and counts down; the turn then goes on unprompted.
    await page.goto(`${d.url}/s/${sid}`);
    await composer.fill("script:rate-limit-long");
    await composer.press("Enter");
    await expect(box).toContainText(/asked to wait until \d\d:\d\d/, { timeout: 15_000 });
    const due = box.getByTestId("resume-at");
    await expect(due).toContainText(/Resumes by itself at \d\d:\d\d/);
    await expect(due.getByTestId("resume-in")).toHaveText(/^in \ds$/);
    await shoot(page, "restart-13-continues-at");
    expect((await view()).session.settings.continue_at.at).toBeGreaterThan(Date.now());
    await expect(page.getByTestId("assistant-text").last()).toHaveText(answer, { timeout: 20_000 });
    await expect(due).toHaveCount(0);
    expect(await ends()).toEqual(["error", "end_turn"]);
    expect((await view()).session.settings.continue_at).toBeUndefined();

    // A daemon that restarts during the wait still continues it.
    await composer.fill("script:rate-limit-long again");
    await composer.press("Enter");
    await expect(due).toHaveCount(1, { timeout: 15_000 });
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state, env);
    await page.goto(`${d.url}/s/${sid}`);
    await expect(page.getByTestId("assistant-text")).toHaveCount(2, { timeout: 30_000 });
    expect(await ends()).toEqual(["error", "end_turn", "error", "end_turn"]);

    // Called off: nothing continues, and the owner's Continue is still there.
    await composer.fill("script:rate-limit-long once more");
    await composer.press("Enter");
    await expect(due).toHaveCount(1, { timeout: 15_000 });
    await due.getByTestId("resume-cancel").click();
    await expect(due).toHaveCount(0);
    await page.waitForTimeout(4_000);
    expect(await ends()).toEqual(["error", "end_turn", "error", "end_turn", "error"]);
    expect((await call(`/api/sessions/${sid}/resume`, undefined, "DELETE")).cancelled).toBe(false);

    // Continue now does not wait for the time.
    await composer.fill("script:rate-limit-long, the last");
    await composer.press("Enter");
    await expect(due).toHaveCount(1, { timeout: 15_000 });
    await due.getByTestId("resume-now").click();
    await expect.poll(async () => (await ends()).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(7);

    // A provider that asks for the wait every time: three rounds, each twice as long, then it stops and says so.
    const stuck = (await call("/api/sessions", { model: "scripted:stand-in", title: "Limited every time" })).session.id as string;
    const errorsOf = async () => ((await call(`/api/sessions/${stuck}`, undefined, "GET")).events as any[]).filter((e) => e.kind === "error").map((e) => e.data);
    await page.goto(`${d.url}/s/${stuck}`);
    await composer.fill("script:rate-limit-always");
    await composer.press("Enter");
    await expect(due).toHaveCount(1, { timeout: 15_000 });
    await expect(box.first()).not.toContainText("Continue after that");
    await expect(due.getByTestId("resume-round")).toHaveText("after 1 try, waiting longer each time", { timeout: 15_000 });
    const stopped = page.getByTestId("resume-stopped");
    await expect(stopped).toHaveText("It resumed by itself 3 times and the provider asked for the wait each time, so it is not resumed again.", { timeout: 40_000 });
    await expect(due).toHaveCount(0);
    await expect(box.last().getByTestId("try-again")).toBeVisible();
    await shoot(page, "restart-15-continue-stopped");
    const errs = await errorsOf();
    expect(errs.map((e) => e.continued)).toEqual([undefined, undefined, undefined, 3]);
    expect((await call(`/api/sessions/${stuck}`, undefined, "GET")).session.settings.continue_at).toBeUndefined();
    await page.waitForTimeout(3_000);
    expect(await errorsOf()).toHaveLength(4);
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: a turn that only waits on the owner does not hold the daemon. A
// stop does not wait its drain time for a question, a plan or an approval
// card (they would still be waiting at the end of it, with new work refused
// meanwhile): it parks them at once and the next daemon puts all three back.
// After a restart such a turn takes no resume slot either, so a session at
// work is continued at once however many cards are open.
test("cards that wait on the owner hold neither a drain nor the turns continued after it", async () => {
  const state = join(ROOT, `restart-cards-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  const env = { KEEL_DRAIN_MS: "20000", KEEL_RESUME_AT_ONCE: "1" };
  let d = await daemon(state, env);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
    const question = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } };
    const make = async (title: string, mode: string, text: string) => {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
      await call(`/api/sessions/${session.id}/permissions`, { mode }, "PUT");
      await call(`/api/sessions/${session.id}/messages`, { text });
      return session.id as string;
    };
    const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
    const asker = await make("A question", "full-auto", calls([question]));
    const planner = await make("A plan", "plan", calls([{ name: "present_plan", input: { plan: "1. Read.\n2. Change." } }]));
    const gated = await make("An approval", "ask", calls([{ name: "Bash", input: { command: `echo ran >> ${join(state, "ran.txt")}` } }]));
    const open = async (extra: string[] = []) => [
      (await call(`/api/sessions/${asker}/questions`, undefined, "GET")).pending as string[],
      ((await call(`/api/sessions/${planner}/plan`, undefined, "GET")).open as { id: string }[]).map((c) => c.id),
      ((await call(`/api/sessions/${gated}/approvals`, undefined, "GET")).approvals as { id: string }[]).map((a) => a.id),
      ...(await Promise.all(extra.map(async (id) => (await call(`/api/sessions/${id}/questions`, undefined, "GET")).pending as string[]))),
    ];
    await expect.poll(async () => (await open()).map((l) => l.length), { timeout: 30_000 }).toEqual([1, 1, 1]);
    const cards = await open();

    // A stop with twenty seconds for running turns: over in well under that, since nothing is at work.
    const t0 = Date.now();
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    const took = Date.now() - t0;
    console.log(`drain with three waiting cards: ${took} ms`);
    expect(took).toBeLessThan(3_000);
    d = await daemon(state, env);
    await expect.poll(() => open(), { timeout: 30_000 }).toEqual(cards);
    expect(existsSync(join(state, "ran.txt"))).toBe(false);

    // A session at work, then one more question (the newest session, first in line after a restart).
    const worker = await make("At work", "full-auto", "script:long-tool");
    const view = async () => (await call(`/api/sessions/${worker}`, undefined, "GET")).events as any[];
    await expect.poll(async () => (await view()).some((e) => e.kind === "assistant" && e.data.blocks.some((b: any) => b.type === "tool_use")), { timeout: 15_000 }).toBe(true);
    const late = await make("A later question", "full-auto", calls([question]));
    await expect.poll(async () => (await open([late])).map((l) => l.length), { timeout: 30_000 }).toEqual([1, 1, 1, 1]);
    const four = await open([late]);
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state, env);
    const up = Date.now();
    // With one resume slot, the four cards are back and the working session goes on at once.
    await expect.poll(async () => (await view()).some((e) => e.kind === "user" && e.data.origin === "restart"), { timeout: 15_000 }).toBe(true);
    console.log(`working session continued ${Date.now() - up} ms after the daemon was up`);
    await expect.poll(() => open([late]), { timeout: 15_000 }).toEqual(four);
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// The other waits on the owner hold no drain either: a secret the model asked
// for, a call that blocks on an agent whose own question waits, and a card of
// a call a program made. The secret's card and the agent's question are open
// again after each restart. The program's card closes at the stop (the
// program is gone with the daemon, so an answer would run nothing).
test("a secret card, a call blocked on an asking agent and a program's card do not hold a drain", async () => {
  const state = join(ROOT, `restart-waits-more-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  const env = { KEEL_DRAIN_MS: "20000" };
  let d = await daemon(state, env);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
    const question = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } };
    const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
    const make = async (title: string, mode: string, text: string) => {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
      await call(`/api/sessions/${session.id}/permissions`, { mode }, "PUT");
      await call(`/api/sessions/${session.id}/messages`, { text });
      return session.id as string;
    };
    const wait = { name: "wait_agent", input: {} };
    const secret = await make("Asks for a secret", "full-auto", calls([{ name: "request_secret", input: { name: "SPEC_TOKEN", purpose: "a spec" } }]));
    const parent = await make("Blocked on its agent", "full-auto", calls([{ name: "spawn_agent", input: { message: `Color helper\n${calls([question])}` } }, wait, wait, wait, wait]));
    const coder = await make("A card inside a program", "ask", calls([{ name: "run_code", input: { code: `await tools.Bash({ command: "echo ran >> ${join(state, "code.txt")}" }); return "done";` } }]));
    const secrets = async () => ((await call(`/api/sessions/${secret}/secrets`, undefined, "GET")).requests as { id: string }[]).map((r) => r.id);
    const cardsOf = async (all = false) => ((await call(`/api/sessions/${coder}/approvals${all ? "?all" : ""}`, undefined, "GET")).approvals as { id: string; state: string; tool: string }[]);
    await expect.poll(async () => (await call(`/api/sessions/${parent}/agents`, undefined, "GET")).agents?.[0]?.session_id, { timeout: 30_000 }).toBeTruthy();
    const child = (await call(`/api/sessions/${parent}/agents`, undefined, "GET")).agents[0].session_id as string;
    const asked = async () => (await call(`/api/sessions/${child}/questions`, undefined, "GET")).pending as string[];
    // The parent's wait_agent calls so far: it blocks in the last one.
    const waitsOf = async () => ((await call(`/api/sessions/${parent}`, undefined, "GET")).events as any[]).filter((e) => e.kind === "assistant" && e.data.blocks.some((b: any) => b.type === "tool_use" && b.name === "wait_agent")).length;
    // The program is let run; the card that then waits is the one of the command it runs.
    await expect.poll(async () => (await cardsOf()).map((a) => a.tool), { timeout: 30_000 }).toEqual(["run_code"]);
    expect((await call(`/api/sessions/${coder}/approvals/${(await cardsOf())[0]!.id}`, { choice: "once" })).status).toBe(200);
    await expect.poll(async () => [(await secrets()).length, (await asked()).length, (await cardsOf()).map((a) => a.tool), await waitsOf()], { timeout: 30_000 }).toEqual([1, 1, ["Bash"], 1]);
    const [secretId] = await secrets(), [askedId] = await asked(), [inner] = await cardsOf();

    // Three stops in a row, each with twenty seconds for running turns: none waits.
    for (let round = 1; round <= 3; round++) {
      const t0 = Date.now();
      d.proc.kill("SIGTERM");
      await exited(d.proc);
      const took = Date.now() - t0;
      console.log(`drain ${round} with a secret card, a blocked parent and a program's card: ${took} ms`);
      expect(took).toBeLessThan(3_000);
      d = await daemon(state, env);
      // The secret's card and the agent's question are back under the same ids; the parent blocks on its agent again.
      await expect.poll(async () => [await secrets(), await asked(), await waitsOf()], { timeout: 30_000 }).toEqual([[secretId], [askedId], round + 1]);
      // The program's card closed at the first stop, nothing ran, and an answer says so.
      expect(await cardsOf()).toEqual([]);
      expect((await cardsOf(true)).filter((a) => a.tool === "Bash").map((a) => [a.id, a.state])).toEqual([[inner!.id, "cancelled"]]);
      expect(existsSync(join(state, "code.txt"))).toBe(false);
    }
    expect((await call(`/api/sessions/${coder}/approvals/${inner!.id}`, { choice: "once" })).status).toBe(409);
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// Feature: a loop's run goes on through a restart with its turn. The run a
// crash or a stop cut is the run that finishes: it closes once, as the
// continued turn ended, and the loop counts no failure and starts no other run.
test("a loop run cut by a restart finishes as the same run", async () => {
  const state = join(ROOT, `restart-loop-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Loop across restarts" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    const loop = await call("/api/loops", { session_id: session.id, schedule: "daily", prompt: "script:long-tool" });
    const history = async () => (await call(`/api/loops/${loop.id}/runs`, undefined, "GET")) as { loop: any; runs: any[] };
    const toolCalls = async () => ((await call(`/api/sessions/${session.id}`, undefined, "GET")).events as any[]).filter((e) => e.kind === "assistant" && e.data.blocks?.some((b: any) => b.type === "tool_use")).length;
    for (const [n, signal] of [[1, "SIGKILL"], [2, "SIGTERM"]] as const) {
      await call(`/api/loops/${loop.id}/run`, {});
      await expect.poll(toolCalls, { timeout: 15_000 }).toBe(n);
      await new Promise((r) => setTimeout(r, 1_000));
      d.proc.kill(signal);
      await exited(d.proc);
      d = await daemon(state);
      await expect.poll(async () => (await history()).runs.map((r) => r.outcome), { timeout: 60_000 }).toEqual(Array(n).fill("ok"));
      const h = await history();
      expect(h.runs[0].note).toContain("Continued after a daemon restart.");
      expect(h.loop).toMatchObject({ runs: n, fails: 0, last_status: "ok", enabled: true });
    }
    const errs = (await call("/api/errors?resolved=0", undefined, "GET")).errors as any[];
    expect(errs.filter((e) => e.context?.at !== "listing")).toEqual([]);
  } finally {
    d.proc.kill("SIGKILL");
  }
});
