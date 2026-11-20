import { expect, test } from "./isolate.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
    env: { ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in", ...extra },
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
    await shoot(page, "restart-01-resumed-after-crash");

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
// reconnected page drops the old card and answering it is refused (409, with
// how it ended); the cut turn continues and asks again on a new card that
// settles once; the command waiting on the old card never runs.
test("an approval pending at a crash is closed, and the continued turn asks again", async ({ page }) => {
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
    const old = (await card.getAttribute("data-approval-id"))!;

    d.proc.kill("SIGKILL");
    await exited(d.proc);
    expect(ran()).toBe("");
    d = await daemon(state, {}, at);

    // The same page, reconnected by itself: the old card is gone and the turn asks again.
    await expect(page.locator(`[data-approval-id="${old}"]`)).toHaveCount(0, { timeout: 30_000 });
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(card.getByTestId("approval-summary")).toContainText("ran-2");
    const fresh = (await card.getAttribute("data-approval-id"))!;
    expect(fresh).not.toBe(old);
    await shoot(page, "restart-04-approval-after-crash");
    const stale = await call(`/api/sessions/${sid}/approvals/${old}`, { choice: "once" });
    expect([stale.status, stale.error]).toEqual([409, "cancelled: the daemon restarted"]);
    expect(ran()).toBe("");

    await card.getByTestId("allow-once").click();
    await expect(page.getByTestId("assistant-text").last()).toContainText("Done with 2 calls", { timeout: 15_000 });
    await expect(card).toHaveCount(0);
    const again = await call(`/api/sessions/${sid}/approvals/${fresh}`, { choice: "once" });
    expect([again.status, again.error]).toEqual([409, "already allowed (once)"]);
    expect(ran()).toBe("ran-2\n");

    // Recorded once each: the cut turn's end, the call it cut, the continued turn.
    const ev = (await call(`/api/sessions/${sid}`, undefined, "GET")).events as any[];
    expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length);
    expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["restart", "end_turn"]);
    expect(ev.filter((e) => e.kind === "user").map((e) => e.data.origin ?? "owner")).toEqual(["owner", "restart"]);
    const results = ev.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
    const uses = ev.filter((e) => e.kind === "assistant").flatMap((e) => e.data.blocks).filter((b: any) => b.type === "tool_use");
    expect(uses).toHaveLength(2);
    expect(results.map((r: any) => r.tool_use_id)).toEqual(uses.map((u: any) => u.id));
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("did not run");
    const cards = (await call(`/api/sessions/${sid}/approvals?all`, undefined, "GET")).approvals as any[];
    expect(cards.map((a) => [a.id, a.state]).sort()).toEqual([[old, "cancelled"], [fresh, "allowed"]].sort());

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
