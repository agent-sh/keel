import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a model provider that cannot be reached makes a turn wait and go on
// by itself. A real provider cannot be
// taken off the network on demand, so the scripted stand-in plays the outage
// (src/providers/scripted.ts, `script:outage`): for a while every request and
// every listing fails with a DNS or connection refusal (including an explicit
// broker 502), then it
// answers again. The wait is one per provider (src/providers/outage.ts).
const STAND_IN = "scripted:stand-in";
const SINCE = /The provider cannot be reached since \d\d:\d\d; trying again/;

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

async function open(request: APIRequestContext, title: string, workspace?: string) {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, ...(workspace ? { workspace } : {}) } })).json();
  expect((await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } })).ok()).toBe(true);
  return session.id as string;
}
const events = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
const stateOf = async (request: APIRequestContext, id: string) => (await (await request.get("/api/state")).json()).states[id] as any;
// The Errors rows of a provider that was not reached (a stream that began and broke is another failure, with its own row).
const outageRow = (e: any) => e.source === "provider" && /EAI_AGAIN|could not reach|Unable to connect/.test(e.message) && !/the stream broke/.test(e.message);
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
};
// Ends an outage a test may have left (it failed before the provider was back): the next test starts with a provider that answers.
test.afterEach(async ({ request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Outage over" } })).json();
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:outage-end" } });
  await expect.poll(async () => (await events(request, session.id)).some((e) => e.kind === "turn_end"), { timeout: 60_000 }).toBe(true);
});

test("a turn started while the provider cannot be reached waits and completes when it answers", async ({ page, request }) => {
  const t0 = Date.now();
  const id = await open(request, "Outage: a turn waits");
  await page.goto(`/s/${id}`);
  // A DNS failure for 9 s: the first request never gets an answer.
  await send(page, "script:outage dns 9000");

  // The transcript's footer: since when, that Keel tries again, and what the transport said. No count, no countdown.
  const wait = page.getByTestId("provider-wait");
  await expect(wait).toContainText(SINCE);
  await expect(wait).toContainText("EAI_AGAIN");
  await expect(page.getByTestId("retrying")).toHaveCount(0);
  await expect(page.getByTestId("turn-announcer")).toContainText(SINCE);
  // The row: Waiting, with the same words.
  const row = page.locator(`[data-testid="session-row"][data-session="${id}"]`);
  await expect(row).toHaveAttribute("data-watch", "wait");
  await expect(row.getByTestId("row-state")).toHaveText("Waiting");
  await expect(row.locator('[data-testid="row-why"][data-why="unreachable"]')).toContainText(SINCE);
  await shoot(page, "outage-01-turn-waits");
  // The state every reader gets, and the timeline.
  expect(await stateOf(request, id)).toMatchObject({ watch: "wait", why: "unreachable", text: "The provider cannot be reached" });
  const timeline = await (await request.get(`/api/sessions/${id}/timeline?format=text`)).text();
  expect(timeline).toContain("Now: waiting.");
  expect(timeline).toMatch(/waiting: the provider cannot be reached since \d\d:\d\d; trying again/);
  // The turn is not over and nothing failed in the transcript.
  await expect(page.getByTestId("turn-end")).toHaveCount(0);
  await expect(page.getByTestId("turn-error")).toHaveCount(0);

  // The provider answers again: the same request goes and the turn completes, by itself.
  await expect(page.getByTestId("assistant-text").last()).toHaveText("Answered after the outage.", { timeout: 60_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await expect(wait).toHaveCount(0);
  await expect(page.getByTestId("turn-error")).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-watch", "wait");
  const ev = await events(request, id);
  expect(ev.filter((e) => e.kind === "error")).toEqual([]);
  expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["end_turn"]);
  expect(ev.filter((e) => e.kind === "user")).toHaveLength(1); // nothing was added to the history to go on

  // Activity: one line when the outage was known and one when it ended, with its length.
  const { items } = await (await request.get("/api/activity?kind=daemon&limit=20")).json();
  const mine = items.filter((a: any) => a.ts >= t0 && a.sub.startsWith("outage"));
  expect(mine.map((a: any) => a.sub).sort()).toEqual(["outage", "outage_over"]);
  expect(mine.find((a: any) => a.sub === "outage").text).toMatch(/^Scripted \(test\) cannot be reached since \d\d:\d\d.*: 1 session waits and goes on when it answers$/);
  expect(mine.find((a: any) => a.sub === "outage_over").text).toMatch(/^Scripted \(test\) answers again: it could not be reached for \d+s$/);
  // Errors: one row for the outage, recovered.
  const { errors } = await (await request.get("/api/errors")).json();
  const rows = errors.filter(outageRow);
  expect(rows).toHaveLength(1);
  expect(rows[0].recovered_ts).toBeTruthy();

  // A rate limit is still what it was: the provider answered, so the counted retries and their countdown.
  await send(page, "script:rate-limit");
  await expect(page.getByTestId("retrying")).toContainText(/retrying in [1-4]s, attempt 1 of 9/);
  await expect(page.getByTestId("provider-wait")).toHaveCount(0);
  await expect(page.getByTestId("assistant-text").last()).toHaveText("Answered after the rate limit passed.", { timeout: 20_000 });
});

test("a turn that loses the provider between two tool calls goes on from where it was", async ({ page, request }) => {
  const scratch = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, "outage-steps-"));
  made.push(work);
  const id = await open(request, "Outage: mid tool loop", work);
  await page.goto(`/s/${id}`);
  // Two steps, each a command that leaves a line. The provider is gone (a connection refusal
  // before it can be sent) when the first result is sent, for 6 s.
  const calls = [{ name: "Bash", input: { command: "echo one >> steps.txt" } }, { name: "Bash", input: { command: "echo two >> steps.txt" } }];
  await send(page, `script:calls ${JSON.stringify(calls)}\nscript:outage-at 1 refused 6000`);
  const wait = page.getByTestId("provider-wait");
  await expect(wait).toContainText(SINCE);
  await expect(wait).toContainText("ConnectionRefused");
  // The first step is done and stays done while the turn waits.
  expect(readFileSync(join(work, "steps.txt"), "utf8")).toBe("one\n");
  await expect(page.getByTestId("assistant-text").last()).toContainText("Done with 2 calls.", { timeout: 60_000 });
  // No step repeated, no tool run twice: each call has one result, each command ran once, one turn.
  expect(readFileSync(join(work, "steps.txt"), "utf8")).toBe("one\ntwo\n");
  const ev = await events(request, id);
  const uses = ev.filter((e) => e.kind === "assistant").flatMap((e) => e.data.blocks.filter((b: any) => b.type === "tool_use").map((b: any) => b.id));
  const results = ev.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results.map((r: any) => r.tool_use_id));
  expect(uses).toHaveLength(2);
  expect(results.sort()).toEqual([...uses].sort());
  expect(ev.filter((e) => e.kind === "assistant")).toHaveLength(3);
  expect(ev.filter((e) => e.kind === "user")).toHaveLength(1);
  expect(ev.filter((e) => e.kind === "turn_start")).toHaveLength(1);
  expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["end_turn"]);
  expect(ev.filter((e) => e.kind === "error")).toEqual([]);
});

test("a reply cut mid-stream with the provider gone right after is answered whole when it is back", async ({ page, request }) => {
  const id = await open(request, "Outage: broken stream");
  await page.goto(`/s/${id}`);
  // Half a reply streams, the stream breaks (the counted retry sends the request again), and that
  // retry cannot connect: from there the turn waits for the provider.
  await send(page, "script:outage-mid dns 6000");
  await expect(page.getByTestId("transcript")).toContainText("This half reply");
  await expect(page.getByTestId("provider-wait")).toContainText(SINCE, { timeout: 15_000 });
  await expect(page.getByTestId("transcript")).not.toContainText("This half reply"); // the half reply is not kept
  await expect(page.getByTestId("assistant-text").last()).toHaveText("The whole reply, after the broken stream and the outage.", { timeout: 60_000 });
  const ev = await events(request, id);
  expect(ev.filter((e) => e.kind === "assistant")).toHaveLength(1);
  expect(ev.filter((e) => e.kind === "error")).toEqual([]);
  expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["end_turn"]);
});

test("the owner's Stop during the wait stops the turn at once", async ({ page, request }) => {
  const id = await open(request, "Outage: stopped");
  await page.goto(`/s/${id}`);
  await send(page, "script:outage refused 120000");
  await expect(page.getByTestId("provider-wait")).toContainText(SINCE);
  await expect(page.getByTestId("provider-wait")).toContainText("ConnectionRefused");
  const t0 = Date.now();
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 5_000 });
  expect(Date.now() - t0).toBeLessThan(5_000);
  await expect(page.getByTestId("provider-wait")).toHaveCount(0);
  const ev = await events(request, id);
  expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["interrupted"]);
  expect((await stateOf(request, id)).watch).toBe("stop");
  // Nobody waits for the provider any more: nothing is tried, and the session is not said to wait.
  await page.waitForTimeout(3_000);
  expect((await stateOf(request, id)).watch).toBe("stop");
});

test("twelve agents of one parent wait through an outage of a minute: none fails, the parent is told once and once more at the end", async ({ page, request }) => {
  test.setTimeout(420_000);
  const scratch = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, "outage-agents-"));
  made.push(work);
  const parent = await open(request, "Outage: twelve agents", work);
  expect((await request.patch(`/api/sessions/${parent}/agents`, { data: { limit: 12 } })).ok()).toBe(true); // more than the eight a session gets by default
  await page.goto(`/s/${parent}`);
  // Twelve background agents, each in the middle of its work (a command) when the provider goes.
  const N = 12;
  const kids = Array.from({ length: N }, (_, i) => ({ name: "spawn_agent", input: { message: `Worker ${i + 1}\nscript:calls ${JSON.stringify([{ name: "Bash", input: { command: `sleep 5; echo worker-${i + 1} >> done-${i + 1}.txt` } }])}`, isolation: "none" } }));
  await send(page, `script:batch ${JSON.stringify(kids)}`);
  const agents = async () => (await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as any[];
  await expect.poll(async () => (await agents()).length, { timeout: 30_000 }).toBe(N);
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
  // The provider is gone for a minute (a broker's 502 naming a DNS failure), from another session's request.
  const starter = await open(request, "Outage: starter");
  await request.post(`/api/sessions/${starter}/messages`, { data: { text: "script:outage gateway 60000" } });

  // Every agent waits; none failed, none ended.
  await expect.poll(async () => {
    const list = await agents();
    const states = (await (await request.get("/api/state")).json()).states;
    return list.filter((a) => a.status === "running" && states[a.session_id]?.watch === "wait" && states[a.session_id]?.why === "unreachable").length;
  }, { timeout: 30_000 }).toBe(N);
  // The parent's own row says it once for all of them.
  const row = page.locator(`[data-testid="session-row"][data-session="${parent}"]`);
  await expect(row).toHaveAttribute("data-watch", "wait");
  await expect(row.locator('[data-testid="row-why"][data-why="unreachable"]')).toContainText(/12 agents wait: the provider cannot be reached since \d\d:\d\d/);
  await shoot(page, "outage-02-agents-wait");
  // The owner writes to the parent meanwhile: its request carries the one line about its agents, and waits too.
  await page.waitForTimeout(6_000);
  await request.post(`/api/sessions/${parent}/messages`, { data: { text: "script:say Noted while they wait." } });
  await expect(page.getByTestId("provider-wait")).toContainText(SINCE, { timeout: 15_000 });
  await expect(page.getByTestId("provider-wait")).toContainText("could not reach");
  expect((await agents()).filter((a) => a.status !== "running")).toEqual([]);

  // The provider answers: all twelve go on and complete, within seconds of each other.
  await expect.poll(async () => (await agents()).filter((a) => a.status === "completed").length, { timeout: 180_000, intervals: [1_000] }).toBe(N);
  const list = await agents();
  expect(list.filter((a) => a.status === "failed")).toEqual([]);
  for (let i = 1; i <= N; i++) expect(readFileSync(join(work, `done-${i}.txt`), "utf8")).toBe(`worker-${i}\n`); // each command ran once
  const ended = list.map((a) => a.ended ?? a.updated).filter(Boolean).sort((a: number, b: number) => a - b);
  if (ended.length === N) expect(ended.at(-1) - ended[0]).toBeLessThan(15_000);
  // The parent was told once that they wait, and once that they went on.
  await expect.poll(async () => (await events(request, parent)).filter((e) => e.kind === "note" && e.data.model && /The provider answers again after/.test(e.data.text)).length, { timeout: 60_000 }).toBe(1);
  const notes = (await events(request, parent)).filter((e) => e.kind === "note" && e.data.model).map((e) => String(e.data.text));
  const waits = notes.filter((t) => /agents wait: the provider cannot be reached since/.test(t));
  expect(waits).toHaveLength(1);
  expect(waits[0]).toContain("[harness] 12 agents wait: the provider cannot be reached since ");
  expect(notes.filter((t) => /the 12 agents that waited for it went on/.test(t))).toHaveLength(1);
  // The whole daemon sent a handful of requests into the outage, not one per agent per try.
  const counter = await open(request, "Outage: count");
  await request.post(`/api/sessions/${counter}/messages`, { data: { text: "script:outage-count" } });
  let said = "";
  await expect.poll(async () => (said = String((await events(request, counter)).find((e) => e.kind === "assistant")?.data.blocks[0]?.text ?? "")), { timeout: 30_000 }).toContain("refused");
  const [, requests, listings] = said.match(/refused (\d+) requests and (\d+) listings/)!.map(Number);
  // One failed request per session that had one to send (twelve agents, the starter, the parent), and one listing per try.
  expect(requests).toBeLessThanOrEqual(N + 4);
  expect(listings).toBeLessThanOrEqual(12);
  // Errors: one row for the outage, however many sessions it held.
  const { errors } = await (await request.get("/api/errors")).json();
  const rows = errors.filter(outageRow);
  expect(rows).toHaveLength(1);
  expect(rows[0].count).toBeGreaterThanOrEqual(N);
});

// A daemon of this test's own, on the scripted provider only: no key, no keyring, a home of its own.
function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const home = join(state, "home");
  mkdirSync(join(home, "run"), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8",
    KEEL_CONFIG_DIR: join(state, "config"), KEEL_KEYRING_SERVICE: "keel-scratch-empty", KEEL_CRED_GET: "/bin/false", KEEL_DESKTOP_NOTIFY: "off",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/bus", XDG_RUNTIME_DIR: join(home, "run"),
    KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: STAND_IN, KEEL_DRAIN_MS: "300",
    TACIT_BIN: join(process.cwd(), "test/e2e/fixtures/tacit-standin.sh"), TACIT_STANDIN_STORE: join(state, "tacit-store"),
  };
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", state], { env, stdio: ["ignore", "pipe", "pipe"] });
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

test("a daemon restart in the middle of the outage: the turn waits on in the next daemon and completes", async ({ page }) => {
  const state = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state", `outage-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  try {
    const call = (url: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      fetch(url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json() as any);
    // Only the scripted provider can answer on it.
    const real = ((await call(d.url, "/api/providers")).providers as any[]).filter((p) => p.available && !["scripted", "acp", "alibaba"].includes(p.id));
    expect(real).toEqual([]);
    const { session } = await call(d.url, "/api/sessions", { model: STAND_IN, title: "Outage: a restart meanwhile" });
    await page.goto(`${d.url}/s/${session.id}`);
    await send(page, "script:outage dns 30000");
    await expect(page.getByTestId("provider-wait")).toContainText(SINCE);
    // Known as an outage (said once) before the daemon stops.
    await expect.poll(async () => (await call(d.url, "/api/activity?kind=daemon&limit=10")).items.filter((a: any) => a.sub === "outage").length, { timeout: 20_000 }).toBe(1);
    const since = (await call(d.url, "/api/state")).states[session.id].since;
    expect(since).toBeGreaterThan(0);

    // A stop: the waiting turn is parked at once (it is not waited for), and the next daemon goes on with it.
    const t0 = Date.now();
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    expect(Date.now() - t0).toBeLessThan(10_000);
    d = await daemon(state);
    await page.goto(`${d.url}/s/${session.id}`);
    // The resumed turn waits again, for the same outage: the same start, and no second line in Activity.
    await expect(page.getByTestId("provider-wait")).toContainText(SINCE, { timeout: 60_000 });
    const now = (await call(d.url, "/api/state")).states[session.id];
    expect(now).toMatchObject({ watch: "wait", why: "unreachable", since });
    const row = page.locator(`[data-testid="session-row"][data-session="${session.id}"]`);
    await expect(row.locator('[data-testid="row-why"][data-why="unreachable"]')).toContainText(SINCE);
    await shoot(page, "outage-03-waits-after-restart");
    // The provider answers: the turn completes by itself, with nobody resuming it.
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Answered after the outage.", { timeout: 90_000 });
    const ev = (await call(d.url, `/api/sessions/${session.id}`)).events as any[];
    expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["restart", "end_turn"]);
    expect(ev.filter((e) => e.kind === "error")).toEqual([]);
    expect(ev.filter((e) => e.kind === "note" && e.data.kind === "provider_wait")).toHaveLength(1);
    const lines = (await call(d.url, "/api/activity?kind=daemon&limit=20")).items.filter((a: any) => a.sub.startsWith("outage")).map((a: any) => a.sub).sort();
    expect(lines).toEqual(["outage", "outage_over"]);
    // Still one Errors row: the listing the new daemon could not read at its start is the same outage.
    const rows = (await call(d.url, "/api/errors")).errors.filter(outageRow);
    expect(rows).toHaveLength(1);
    expect(rows[0].recovered_ts).toBeTruthy();
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
  }
});
