import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { openPanel, shoot, SHOTS } from "./shots.ts";

// Feature: the state of a session is one fact. The daemon works it out in one
// place (what the session waits on, why, since when) and every surface reads
// it: the list row, the pane band, the folded rail and its card, the tab's
// count, the inbox, `keel sessions` and the session tools. The scripted
// stand-in sends the exact calls.
const STAND_IN = "scripted:stand-in";
const WS = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/state`;
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  return models.some((m) => m.id === STAND_IN);
}
const row = (page: Page, id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
async function start(request: APIRequestContext, title: string, mode = "full-auto", workspace = WS) {
  mkdirSync(workspace, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
  return session.id as string;
}
const send = (request: APIRequestContext, id: string, text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
const stateOf = async (request: APIRequestContext, id: string) => ((await (await request.get("/api/state")).json()).states ?? {})[id] as { watch: string; why?: string; text?: string; since?: number } | undefined;
async function drop(request: APIRequestContext, ids: string[]) {
  for (const id of ids) {
    await request.post(`/api/sessions/${id}/interrupt`).catch(() => {});
    await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
}

test("a plan waiting for approval reads Needs you on the row, the pane, the tab and in the inbox", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    const other = await start(request, "A quiet session to watch from");
    const planner = await start(request, "Plan the move to resumable uploads", "plan");
    made.push(other, planner);
    await send(request, planner, script([{ name: "present_plan", input: { title: "Resumable uploads", plan: "1. Add a chunk table.\n2. Resume from the last chunk." } }]));
    await expect.poll(async () => (await (await request.get(`/api/sessions/${planner}/plan`)).json()).open.length, { timeout: 30_000 }).toBe(1);

    // From another session's page: the row says who waits and why.
    await page.goto(`/s/${other}`);
    const r = row(page, planner);
    await expect(r).toHaveAttribute("data-watch", "need");
    await expect(r.getByTestId("row-state")).toContainText("Needs you");
    await expect(page).toHaveTitle(/^\(\d+\) /);
    // The inbox holds it until it is answered.
    const inbox = async () => ((await (await request.get("/api/alerts?limit=100&with_unread")).json()).alerts as { session_id: string; data?: { plan_id?: string }; read: boolean }[]).filter((a) => a.session_id === planner && a.data?.plan_id);
    expect((await inbox()).filter((a) => !a.read)).toHaveLength(1);
    // The daemon says the same, with the reason and since when.
    const st = await stateOf(request, planner);
    expect(st).toMatchObject({ watch: "need", why: "plan" });
    expect(st!.since).toBeGreaterThan(Date.now() - 120_000);

    // Its own pane: the band and the word.
    await page.goto(`/s/${planner}`);
    await expect(page.getByTestId("plan-card")).toBeVisible();
    await expect(page.getByTestId("station-word")).toContainText("Needs you");
    await expect(page.locator(`[data-station="${planner}"]`)).toHaveAttribute("data-watch", "need");
    await shoot(page, "session-state-01-plan-needs-you");

    // Approved: the wait is over everywhere.
    const open = (await (await request.get(`/api/sessions/${planner}/plan`)).json()).open;
    await request.post(`/api/sessions/${planner}/plan/${open[0].id}`, { data: { approve: true, mode: "full-auto" } });
    await expect(row(page, planner)).not.toHaveAttribute("data-watch", "need");
    await expect.poll(async () => (await inbox()).filter((a) => !a.read).length).toBe(0);
  } finally {
    await drop(request, made);
  }
});

test("a session waiting on a timer or a background command says so, with what it waits for and since when", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const ended = async (id: string) => {
    const d = await (await request.get(`/api/sessions/${id}`)).json();
    return !d.running && d.events.at(-1)?.kind === "turn_end";
  };
  try {
    const timer = await start(request, "Check the deploy in a quarter of an hour");
    const job = await start(request, "Run the slow suite in the background");
    made.push(timer, job);
    await send(request, timer, script([{ name: "wait_for", input: { kind: "timer", seconds: 900, note: "check the deploy" } }]));
    await send(request, job, script([{ name: "Bash", input: { command: "sleep 300", run_in_background: true } }]));
    await expect.poll(() => ended(timer), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => ended(job), { timeout: 30_000 }).toBe(true);

    // The timer: waiting, on what, and when it is due.
    await page.goto(`/s/${timer}`);
    const t = row(page, timer);
    await expect(t).toHaveAttribute("data-watch", "wait");
    await expect(t.getByTestId("row-state")).toHaveText("Waiting");
    await expect(t.getByTestId("row-why")).toHaveText("Timer: check the deploy");
    await expect(t.getByTestId("row-time")).toHaveText(/^in 1[45]m$/);
    await expect(page.getByTestId("station-word")).toHaveText("Waiting");
    await expect(page.getByTestId("station-why")).toHaveText("Timer: check the deploy");
    await expect(page.getByTestId("station-clock")).toHaveText(/^due in 1[45]m$/);
    // The command left running: named, with how long it has run.
    const j = row(page, job);
    await expect(j).toHaveAttribute("data-watch", "wait");
    await expect(j.getByTestId("row-why")).toHaveText("Command: sleep 300");
    await expect(j.getByTestId("row-time")).toHaveText(/^\d+s$/);
    expect(await stateOf(request, timer)).toMatchObject({ watch: "wait", why: "timer", text: "Timer: check the deploy" });
    expect(await stateOf(request, job)).toMatchObject({ watch: "wait", why: "command" });
    await shoot(page, "session-state-02-waiting");

    // The wait cancelled: nothing is waited on, the session is done.
    const waits = (await (await request.get("/api/automation")).json()).waits as { id: string; session_id: string; status: string }[];
    for (const w of waits.filter((w) => w.session_id === timer && w.status === "active")) await request.delete(`/api/waits/${w.id}`);
    await expect(t).toHaveAttribute("data-watch", "done");
  } finally {
    await drop(request, made);
  }
});

test("a stream that stopped producing output says so, with the time since its last output", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const gate = `${WS}/hold-${Date.now().toString(36)}.go`;
  try {
    const other = await start(request, "A quiet session to watch from");
    const held = await start(request, "Summarize the incident from Monday");
    made.push(other, held);
    await send(request, held, `script:hold ${gate}`);
    await page.goto(`/s/${other}`);
    const r = row(page, held);
    // While it streams it is the model answering; nothing is called silent yet.
    await expect(r).toHaveAttribute("data-watch", "work");
    await expect(r.getByTestId("row-why")).toHaveText("The model is answering");
    const now = async () => (await (await request.get(`/api/sessions/${held}/timeline?format=text&limit=1`)).text()).split("\n").filter((l) => l.startsWith("  ")).join("\n");
    expect(await now()).toContain("the model is answering");
    // The silence passes the threshold: the row, the daemon's state and the Now line say so, with its length.
    await expect(r.getByTestId("row-why")).toHaveText(/^The model is answering, no output for \d+s$/, { timeout: 40_000 });
    await expect(r.getByTestId("row-why")).toHaveAttribute("data-why", "stalled");
    expect(await stateOf(request, held)).toMatchObject({ watch: "work", why: "stalled" });
    expect(await now()).toMatch(/the model is answering, no output for \d+ s/);
    expect(await now()).not.toContain("between steps");
    await shoot(page, "session-state-03-stalled-stream");

    // Output again: the silence is over, and the turn ends.
    mkdirSync(WS, { recursive: true });
    writeFileSync(gate, "");
    await expect(r).toHaveAttribute("data-watch", "done", { timeout: 30_000 });
  } finally {
    await drop(request, made);
  }
});

test("is anything stuck: a held stream, a hung tool and a stalled agent are listed in one answer", async ({ page, request, baseURL }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const tag = Date.now().toString(36);
  const gates = { stream: `${WS}/stuck-${tag}-stream.go`, tool: `${WS}/stuck-${tag}-tool.go`, agent: `${WS}/stuck-${tag}-agent.go` };
  try {
    const stream = await start(request, "Draft the release notes");
    const tool = await start(request, "Run the migration against staging");
    const parent = await start(request, "Audit the three services");
    made.push(stream, tool, parent);
    await send(request, stream, `script:hold ${gates.stream}`);
    await send(request, tool, script([{ name: "Bash", input: { command: `until [ -f ${gates.tool} ]; do sleep 0.2; done; echo released` } }]));
    await send(request, parent, script([{ name: "spawn_agent", input: { message: `Read the billing service\nscript:hold ${gates.agent}`, isolation: "none" } }]));
    const child = async () => ((await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as { session_id: string; status: string }[])[0]?.session_id;
    await expect.poll(child, { timeout: 30_000 }).toBeTruthy();
    const agent = (await child())!;

    // By the daemon's own limits nothing has been silent long enough yet.
    expect((await (await request.get("/api/stuck")).json()).items).toEqual([]);
    expect(await (await request.get("/api/stuck?format=text")).text()).toMatch(/^Nothing is stuck/);
    // With a limit of a few seconds: the three, each with what it is stuck on and for how long.
    type Item = { session_id: string; what: string; agent: boolean; parent_id?: string; elapsed_ms: number };
    const stuck = async () => ((await (await request.get("/api/stuck?after=5")).json()).items as Item[]).filter((i) => [stream, tool, agent].includes(i.session_id));
    await expect.poll(async () => (await stuck()).map((i) => i.session_id).sort(), { timeout: 60_000 }).toEqual([stream, tool, agent].sort());
    const items = await stuck();
    expect(items.find((i) => i.session_id === stream)).toMatchObject({ what: "stream", agent: false });
    expect(items.find((i) => i.session_id === tool)).toMatchObject({ what: "tool", agent: false });
    expect(items.find((i) => i.session_id === agent)).toMatchObject({ what: "stream", agent: true, parent_id: parent });
    for (const i of items) expect(i.elapsed_ms).toBeGreaterThanOrEqual(5000);
    // The text form, from the route and from the command line.
    const text = await (await request.get("/api/stuck?after=5&format=text")).text();
    expect(text).toMatch(/stuck \(no progress for 5 s\), longest first:/);
    expect(text).toMatch(new RegExp(`${stream}  Draft the release notes: the model is answering, no output for \\d+s`));
    expect(text).toMatch(new RegExp(`${tool}  Run the migration against staging: running until .+, for \\d+s`));
    expect(text).toMatch(new RegExp(`${agent}  agent .+ of Audit the three services: the model is answering, no output for \\d+s`));
    const cli = execFileSync("bun", ["src/main.ts", "stuck", "--after", "5", "--url", baseURL!], { encoding: "utf8", env: { ...process.env, KEEL_CONFIG_DIR: process.env.KEEL_CONFIG_DIR ?? `${WS}/config` } });
    for (const id of [stream, tool, agent]) expect(cli).toContain(id);

    // The page: the same answer above the session list, once the page's own limits pass.
    await page.goto(`/s/${parent}`);
    await expect(row(page, stream)).toHaveAttribute("data-watch", "work");
    await expect(page.getByTestId("stuck")).toHaveCount(0);
    await page.clock.install();
    await page.clock.fastForward("11:00");
    const strip = page.getByTestId("stuck");
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(strip.getByTestId("stuck-item")).toHaveCount(3);
    await expect(strip.locator(`[data-session="${stream}"]`)).toContainText("no output");
    await expect(strip.locator(`[data-session="${tool}"]`)).toContainText("Running until");
    await expect(strip.locator(`[data-session="${agent}"]`)).toContainText("agent of Audit the three services");
    await shoot(page, "session-state-04-stuck");
    await strip.locator(`[data-session="${tool}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/s/${tool}$`));
  } finally {
    mkdirSync(WS, { recursive: true });
    for (const g of Object.values(gates)) writeFileSync(g, "");
    await drop(request, made);
  }
});

test("keel sessions, the page and keel__sessions_list report the same state", async ({ page, request, baseURL }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const gate = `${WS}/same-${Date.now().toString(36)}.go`;
  try {
    const asks = await start(request, "Clean the build output before the release", "ask");
    const parent = await start(request, "Tighten the error handling with a helper");
    const asker = await start(request, "Asks for the sessions");
    made.push(asks, parent, asker);
    await send(request, asks, script([{ name: "Bash", input: { command: "rm -rf dist build", description: "Remove the build output" } }]));
    await send(request, parent, script([{ name: "spawn_agent", input: { message: `Slow helper\n${script([{ name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done; echo released` } }])}`, isolation: "none" } }]));
    await expect.poll(async () => (await (await request.get(`/api/sessions/${asks}/approvals`)).json()).approvals.filter((a: { state: string }) => a.state === "pending").length, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => {
      const d = await (await request.get(`/api/sessions/${parent}`)).json();
      const agents = (await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as { status: string }[];
      return !d.running && d.events.at(-1)?.kind === "turn_end" && agents[0]?.status === "running";
    }, { timeout: 30_000 }).toBe(true);

    // The page.
    await page.goto(`/s/${asker}`);
    await expect(row(page, asks)).toHaveAttribute("data-watch", "need");
    await expect(row(page, asks).getByTestId("row-state")).toHaveText("Needs you");
    await expect(row(page, parent)).toHaveAttribute("data-watch", "work");
    await expect(row(page, parent).getByTestId("row-state")).toHaveText("Working · 1 agent");

    // The command line: the same words, and why.
    const cli = execFileSync("bun", ["src/main.ts", "sessions", "--url", baseURL!], { encoding: "utf8", env: { ...process.env, KEEL_CONFIG_DIR: process.env.KEEL_CONFIG_DIR ?? `${WS}/config` } }).split("\n");
    const at = (id: string) => cli.findIndex((l) => l.startsWith(id));
    expect(cli[at(asks)]).toMatch(/\s+needs you\s+/);
    expect(cli[at(asks) + 1]).toMatch(/^\s+needs you: Approve Bash: rm -rf dist build, for \d+[sm]$/);
    expect(cli[at(parent)]).toMatch(/\s+working\s+/);
    expect(cli[at(parent)]).not.toMatch(/\sidle\s/);
    expect(cli[at(parent) + 1]).toMatch(/^\s+working · 1 agent$/);
    const json = JSON.parse(execFileSync("bun", ["src/main.ts", "sessions", "--json", "--url", baseURL!], { encoding: "utf8", env: { ...process.env, KEEL_CONFIG_DIR: process.env.KEEL_CONFIG_DIR ?? `${WS}/config` } })) as { id: string; state?: { watch: string } }[];
    expect(json.find((s) => s.id === asks)?.state?.watch).toBe("need");
    expect(json.find((s) => s.id === parent)?.state?.watch).toBe("work");

    // The session tool.
    await send(request, asker, script([{ name: "keel__sessions_list", input: {} }]));
    const listed = async (id: string) => {
      const d = await (await request.get(`/api/sessions/${asker}`)).json();
      const res = (d.events as any[]).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
      const text = res.map((x: any) => (typeof x.content === "string" ? x.content : x.content.map((b: any) => b.text ?? "").join(""))).join("\n");
      return text.split("\n").find((l: string) => l.startsWith(`${id}\t`)) ?? "";
    };
    await expect.poll(() => listed(asks), { timeout: 30_000 }).toMatch(/\tneeds you$/);
    expect(await listed(parent)).toMatch(/\tworking, 1 agent is still at work$/);
  } finally {
    mkdirSync(WS, { recursive: true });
    writeFileSync(gate, "");
    await drop(request, made);
  }
});

test("a session that needs the owner or failed is never behind the fold, and a failure carries its class", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const folder = `${WS}/many-${Date.now().toString(36)}`;
  const ended = async (id: string) => {
    const d = await (await request.get(`/api/sessions/${id}`)).json();
    return !d.running && ["turn_end", "error"].includes(d.events.at(-1)?.kind);
  };
  try {
    // The oldest of fourteen: three that failed and one that waits on an approval. Ten finished ones are newer.
    const failed: string[] = [];
    for (const title of ["Reindex the docs", "Summarize the incident", "Draft the changelog"]) {
      const id = await start(request, title, "full-auto", folder);
      made.push(id); failed.push(id);
      await send(request, id, "script:billing");
    }
    const asks = await start(request, "Clean the build output", "ask", folder);
    made.push(asks);
    await send(request, asks, script([{ name: "Bash", input: { command: "rm -rf dist build" } }]));
    for (const id of failed) await expect.poll(() => ended(id), { timeout: 30_000 }).toBe(true);
    const quiet: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const id = await start(request, `Finished piece of work ${i}`, "full-auto", folder);
      made.push(id); quiet.push(id);
      await send(request, id, "Say hello.");
    }
    for (const id of quiet) await expect.poll(() => ended(id), { timeout: 30_000 }).toBe(true);

    await page.goto(`/s/${quiet.at(-1)}`);
    await expect(row(page, quiet.at(-1)!)).toBeVisible();
    // Without a click: the one that needs the owner, and every failure with what kind it was.
    await expect(row(page, asks)).toBeVisible();
    await expect(row(page, asks)).toHaveAttribute("data-watch", "need");
    for (const id of failed) {
      await expect(row(page, id)).toBeVisible();
      await expect(row(page, id).getByTestId("row-state")).toHaveText("Failed");
      await expect(row(page, id).getByTestId("row-class")).toHaveText("billing");
    }
    expect(await stateOf(request, failed[0]!)).toMatchObject({ watch: "fail", cls: "quota" });
    // Only finished ones are folded, and the fold says how many.
    const group = page.locator(".k-group").filter({ has: page.locator(`[data-session="${asks}"]`) });
    await expect(group.locator(".k-more")).toHaveText("4 more");
    await expect(row(page, quiet[0]!)).toHaveCount(0);
    await shoot(page, "session-state-05-never-folded");
  } finally {
    await drop(request, made);
  }
});

test("a row says why once: what is asked of the owner, the step with its time, the failure; the rail card says the reason", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const gate = `${WS}/row-${Date.now().toString(36)}.go`;
  try {
    const watcher = await start(request, "A quiet session to watch from");
    const approval = await start(request, "Clean the build output before the release", "ask");
    const question = await start(request, "Pick the database for the queue");
    const plan = await start(request, "Plan the move to resumable uploads", "plan");
    const working = await start(request, "Run the slow test suite");
    const failed = await start(request, "Reindex the docs");
    made.push(watcher, approval, question, plan, working, failed);
    await send(request, approval, script([{ name: "Bash", input: { command: "rm -rf dist build .cache" } }]));
    await send(request, question, script([{ name: "AskUserQuestion", input: { questions: [{ header: "Store", question: "Which database should hold the queue?", options: [{ label: "SQLite" }, { label: "Valkey" }], multiSelect: false }] } }]));
    await send(request, plan, script([{ name: "present_plan", input: { title: "Resumable uploads", plan: "1. Add a chunk table." } }]));
    await send(request, working, script([{ name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done; echo suite passed`, description: "bun test --slow" } }]));
    await send(request, failed, "script:billing");

    await page.goto(`/s/${watcher}`);
    // What is asked of the owner, in one form, without a hover: the word once, then the thing.
    const why = (id: string) => row(page, id).getByTestId("row-why");
    await expect(why(approval)).toHaveText("Approve Bash: rm -rf dist build .cache");
    await expect(why(question)).toHaveText("Question: Which database should hold the queue?");
    await expect(why(plan)).toHaveText("Plan to approve: Resumable uploads");
    for (const id of [approval, question, plan]) {
      const r = row(page, id);
      await expect(r).toHaveAttribute("data-watch", "need");
      await expect(r.getByTestId("row-state")).toHaveText("Needs you");
      // Said once: no second "needs you" on the row.
      expect((await r.innerText()).match(/needs you/gi)).toHaveLength(1);
      await expect(r.getByTestId("needs-you")).toHaveCount(0);
      await expect(r.getByTestId("row-time")).toHaveText(/^\d+[sm]$/);
    }
    // A message this browser could not send is the same kind of reason.
    // (The refusal arrives after the owner moved to another session, so the message is kept for its own.)
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(`**/api/sessions/${watcher}/messages`, async (r) => { held.resolve(); await release.promise; await r.fulfill({ status: 400, json: { error: "The daemon refused this message." } }); }, { times: 1 });
    const composer = page.getByTestId("composer");
    await composer.fill("This one will not go.");
    await composer.press("Enter");
    await held.promise;
    await row(page, failed).click();
    const refused = page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${watcher}/messages`) && r.status() === 400);
    release.resolve();
    await refused;
    await expect(why(watcher)).toHaveText("A message was not sent");
    await expect(row(page, watcher).getByTestId("row-state")).toHaveText("Needs you");
    // Working: the command it runs and how long that step has run.
    await expect(why(working)).toHaveText(/^Running until \[ -f .+/);
    await expect(row(page, working).getByTestId("row-time")).toHaveText(/^\d+s$/);
    // Failed: the class beside the word and what the provider said.
    await expect(row(page, failed).getByTestId("row-class")).toHaveText("billing");
    await expect(why(failed)).toContainText("credit balance is too low");
    await shoot(page, "session-state-06-row-reasons");

    // Folded: the card beside a mark says the reason too.
    await page.getByTestId("rail-toggle").click();
    const tick = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
    const card = page.getByTestId("rail-card");
    await tick(failed).hover();
    await expect(card.getByTestId("rail-card-why")).toContainText("credit balance is too low");
    await expect(card).toContainText("billing");
    await tick(question).hover();
    await expect(card.getByTestId("rail-card-why")).toHaveText("Question: Which database should hold the queue?");
    await tick(working).hover();
    await expect(card.getByTestId("rail-card-why")).toHaveText(/^Running until/);
    await shoot(page, "session-state-07-rail-card-reason");
    await page.getByTestId("rail-toggle").click();
  } finally {
    mkdirSync(WS, { recursive: true });
    writeFileSync(gate, "");
    await drop(request, made);
  }
});

test("an agent that asks the owner is marked as asking in the tree, on its card and in the count", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const gate = `${WS}/asks-${Date.now().toString(36)}.go`;
  try {
    const parent = await start(request, "Fan out three checks");
    made.push(parent);
    const ask = `Ask about scope\n${script([{ name: "AskUserQuestion", input: { questions: [{ header: "Scope", question: "Should the check cover the staging cluster?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] } }])}`;
    const run = `Count the handlers\n${script([{ name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done; echo released` } }])}`;
    await send(request, parent, script([{ name: "spawn_agent", input: { message: ask, isolation: "none" } }, { name: "spawn_agent", input: { message: run, isolation: "none" } }]));
    const agents = async () => (await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as { session_id: string; title: string; status: string }[];
    await expect.poll(async () => (await agents()).length, { timeout: 30_000 }).toBe(2);
    const asker = (await agents()).find((a) => a.title.startsWith("Ask about scope"))!.session_id;
    await expect.poll(async () => (await stateOf(request, asker))?.watch, { timeout: 30_000 }).toBe("need");

    await page.goto(`/s/${parent}`);
    // The parent needs the owner, and says which agent asks what.
    await expect(row(page, parent)).toHaveAttribute("data-watch", "need");
    await expect(row(page, parent).getByTestId("row-why")).toHaveText(/^Agent Ask about scope.*: Question: Should the check cover the staging cluster\?$/);
    // The count under the row: one asks, one runs. Folded, the mark is the owner's.
    const kids = page.getByTestId("session-list").getByTestId("session-children");
    await expect(kids.getByTestId("children-asking")).toHaveText("· 1 asks you");
    await expect(kids.getByTestId("children-toggle")).toContainText("2 agents");
    await expect(kids.getByTestId("children-toggle")).toContainText("1 running");
    await expect(kids.getByTestId("children-toggle").locator('.k-mark[data-watch="need"]')).toBeVisible();
    // The tree: the asking agent is marked, the running one is not.
    await kids.getByTestId("children-toggle").click();
    const asking = kids.locator('[data-testid="child-session"][data-asking]');
    await expect(asking).toHaveCount(1);
    await expect(asking).toContainText("Ask about scope");
    await expect(asking.getByTestId("child-asking")).toHaveText("asks you");
    await expect(kids.getByTestId("child-session")).toHaveCount(2);
    // Its card in the parent's transcript.
    const card = page.getByTestId("agent-call").filter({ hasText: "Ask about scope" });
    await expect(card.getByTestId("agent-call-status")).toHaveText("Asks you");
    await expect(page.getByTestId("agent-call").filter({ hasText: "Count the handlers" }).getByTestId("agent-call-status")).toHaveText("Running in background");
    await shoot(page, "session-state-08-agent-asks");
  } finally {
    mkdirSync(WS, { recursive: true });
    writeFileSync(gate, "");
    await drop(request, made);
  }
});

test("the tab title counts each waiting thing once", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  try {
    const parent = await start(request, "Fan out one check");
    made.push(parent);
    const ask = `Ask about scope\n${script([{ name: "AskUserQuestion", input: { questions: [{ header: "Scope", question: "Should the check cover staging?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] } }])}`;
    await send(request, parent, script([{ name: "spawn_agent", input: { message: ask, isolation: "none" } }]));
    await expect.poll(async () => (await stateOf(request, parent))?.watch, { timeout: 30_000 }).toBe("need");
    // What else waits on this daemon is counted too; the agent's question adds one, not two.
    const others = async () => Object.entries((await (await request.get("/api/state")).json()).states as Record<string, { watch: string; asks?: number }>);
    const sessions = (await (await request.get("/api/sessions")).json()).sessions as { id: string; parent_id?: string }[];
    const roots = new Set(sessions.filter((s) => !s.parent_id).map((s) => s.id));
    const want = (await others()).filter(([id, st]) => roots.has(id) && st.watch === "need").reduce((n, [, st]) => n + (st.asks ?? 1), 0);
    expect((await stateOf(request, parent) as { asks?: number }).asks).toBe(1);
    await page.goto(`/s/${parent}`);
    await expect(page).toHaveTitle(new RegExp(`^\\(${want}\\) `));
    // A second thing in another session is one more.
    const asks = await start(request, "Clean the build output", "ask");
    made.push(asks);
    await send(request, asks, script([{ name: "Bash", input: { command: "rm -rf dist" } }]));
    await expect(page).toHaveTitle(new RegExp(`^\\(${want + 1}\\) `));
  } finally {
    await drop(request, made);
  }
});

test("the phone strip says how many need the owner in plain words, and its marks carry names", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  try {
    const quiet = await start(request, "Explain the build script");
    const asks = await start(request, "Clean the build output", "ask");
    made.push(quiet, asks);
    await send(request, quiet, "Say hello.");
    await send(request, asks, script([{ name: "Bash", input: { command: "rm -rf dist" } }]));
    await expect.poll(async () => (await stateOf(request, asks))?.watch, { timeout: 30_000 }).toBe("need");
    const needing = Object.values((await (await request.get("/api/state")).json()).states as Record<string, { watch: string }>).filter((s) => s.watch === "need").length;
    test.skip(needing !== 1, "other sessions on this daemon need the owner too");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${quiet}`);
    const dock = page.locator(".k-dock");
    await expect(dock.getByTestId("dock-need")).toHaveText("1 needs you");
    // Every mark has the session's short code beside its state.
    const marks = dock.locator(".k-dock-mark");
    await expect(marks).toHaveCount(2);
    await expect(dock.locator('.k-dock-mark[data-watch="need"]').getByTestId("dock-code")).toHaveText("CB");
    await expect(dock.locator(".k-dock-mark[aria-current]").getByTestId("dock-code")).toHaveText("EB");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shoot(page, "session-state-10-phone-strip");
  } finally {
    await drop(request, made);
  }
});

test("the card beside a mark says a question waits, as it says an approval waits", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    const watcher = await start(request, "A quiet session to watch from");
    const question = await start(request, "Pick the database for the queue");
    const approval = await start(request, "Clean the build output", "ask");
    made.push(watcher, question, approval);
    await send(request, question, script([{ name: "AskUserQuestion", input: { questions: [{ header: "Store", question: "Which database should hold the queue?", options: [{ label: "SQLite" }, { label: "Valkey" }], multiSelect: false }] } }]));
    await send(request, approval, script([{ name: "Bash", input: { command: "rm -rf dist" } }]));
    await expect.poll(async () => (await stateOf(request, question))?.watch, { timeout: 30_000 }).toBe("need");
    await expect.poll(async () => (await stateOf(request, approval))?.watch, { timeout: 30_000 }).toBe("need");

    await page.goto(`/s/${watcher}`);
    await page.getByTestId("rail-toggle").click();
    const tick = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
    const card = page.getByTestId("rail-card");
    await tick(question).hover();
    await expect(card).toHaveAttribute("data-watch", "need");
    await expect(card).toContainText("Question: Which database should hold the queue?");
    await expect(card).not.toContainText("New since you looked");
    await tick(approval).hover();
    await expect(card).toContainText("Approve Bash: rm -rf dist");
    await page.getByTestId("rail-toggle").click();
  } finally {
    await drop(request, made);
  }
});

test("the card beside a list row adds what the row lacks and repeats nothing of it", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    const watcher = await start(request, "A quiet session to watch from");
    const approval = await start(request, "Clean the build output before the release", "ask");
    made.push(watcher, approval);
    const command = "rm -rf dist build .cache node_modules/.vite coverage && git tag v0.9.0 && git push origin v0.9.0 --follow-tags";
    await send(request, approval, script([{ name: "Bash", input: { command } }]));
    await expect.poll(async () => (await stateOf(request, approval))?.watch, { timeout: 30_000 }).toBe("need");

    await page.goto(`/s/${watcher}`);
    const r = row(page, approval);
    await expect(r.getByTestId("row-why")).toContainText("Approve Bash: rm -rf dist");
    await r.hover();
    const card = page.getByTestId("rail-card");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-kind", "row");
    // What the row cuts: the whole command. What it has no room for: the model, the path, the exact time.
    await expect(card.getByTestId("rail-card-why")).toHaveText(`Approve Bash: ${command}`);
    await expect(card).toContainText("Model");
    await expect(card).toContainText("Path");
    // Nothing of the row again: not its state word, not its title, not the folder's name alone.
    await expect(card).not.toContainText(/needs you/i);
    await expect(card).not.toContainText("Clean the build output before the release");
    await expect(card.locator(".k-mark")).toHaveCount(0);
    await shoot(page, "session-state-11-row-card");
  } finally {
    await drop(request, made);
  }
});

test("the parent's Now line says what a parked agent waits for and until when", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    const parent = await start(request, "Roll out the new build");
    made.push(parent);
    const child = `Watch the deploy\n${script([{ name: "wait_for", input: { kind: "timer", seconds: 2520, note: "look at the canary" } }])}`;
    await send(request, parent, script([{ name: "spawn_agent", input: { message: child, isolation: "none" } }]));
    const agents = async () => (await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as { session_id: string; status: string }[];
    await expect.poll(async () => (await agents())[0]?.status, { timeout: 30_000 }).toBe("waiting");
    await expect.poll(async () => {
      const d = await (await request.get(`/api/sessions/${parent}`)).json();
      return !d.running && d.events.at(-1)?.kind === "turn_end";
    }, { timeout: 30_000 }).toBe(true);

    // The timeline's Now, as text: the agent, what it waits on, when that is due.
    const now = (await (await request.get(`/api/sessions/${parent}/timeline?format=text&limit=1`)).text()).split("\n").filter((l) => l.startsWith("  "));
    expect(now.join("\n")).toMatch(/Agent "Watch the deploy.*" is waiting on a timer, .*due in 4[12] min/);
    expect(now.join("\n")).not.toContain("a wake of its own");
    // The one state says the same: the parent waits, on its agent's timer, until then.
    const st = await stateOf(request, parent) as { watch: string; why?: string; text?: string; until?: number };
    expect(st).toMatchObject({ watch: "wait", why: "agent" });
    expect(st.text).toMatch(/^Agent Watch the deploy.*: timer: look at the canary$/);
    expect(st.until).toBeGreaterThan(Date.now() + 40 * 60_000);
    await page.goto(`/s/${parent}`);
    await expect(row(page, parent).getByTestId("row-state")).toHaveText("Waiting");
    await expect(row(page, parent).getByTestId("row-time")).toHaveText(/^in 4[12]m$/);
    // The panel's Now line.
    await openPanel(page, "timeline");
    await expect(page.getByTestId("side-panel")).toContainText(/is waiting on a timer/);
    await expect(page.getByTestId("side-panel")).toContainText(/due in 4[12] min/);
    await shoot(page, "session-state-09-parked-agent");
  } finally {
    await drop(request, made);
  }
});

// The look of it: a dozen sessions in mixed states, in the list, on the folded
// rail and on a phone, in both themes. Each row is checked for its state.
test("twelve sessions in mixed states read apart at a glance, wide and on a phone", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const tag = Date.now().toString(36);
  const api = `${WS}/api-${tag}`, web = `${WS}/web-${tag}`;
  const gate = `${WS}/twelve-${tag}.go`;
  const ended = async (id: string) => {
    const d = await (await request.get(`/api/sessions/${id}`)).json();
    return !d.running && ["turn_end", "error"].includes(d.events.at(-1)?.kind);
  };
  const mk = async (title: string, mode: string, folder: string, text?: string) => {
    const id = await start(request, title, mode, folder);
    made.push(id);
    if (text) await send(request, id, text);
    return id;
  };
  const hang = `until [ -f ${gate} ]; do sleep 0.2; done; echo released`;
  try {
    const fresh = await mk("Sketch the importer for old exports", "full-auto", web);
    const done1 = await mk("Explain the build script", "full-auto", web, "Say hello.");
    const done2 = await mk("List the open TODOs in the scanner", "full-auto", api, "Say hello.");
    const stopped = await mk("Rename the config keys", "full-auto", api, script([{ name: "Bash", input: { command: hang } }]));
    const failed = await mk("Reindex the docs after the schema change", "full-auto", web, "script:billing");
    const timer = await mk("Check the deploy in a quarter of an hour", "full-auto", api, script([{ name: "wait_for", input: { kind: "timer", seconds: 900, note: "check the deploy" } }]));
    const job = await mk("Run the slow suite in the background", "full-auto", api, script([{ name: "Bash", input: { command: "sleep 300", run_in_background: true } }]));
    const parent = await mk("Audit the three services", "full-auto", web, script([{ name: "spawn_agent", input: { message: `Read the billing service\n${script([{ name: "Bash", input: { command: hang } }])}`, isolation: "none" } }]));
    const silent = await mk("Summarize the incident from Monday", "full-auto", web, `script:hold ${gate}`);
    const working = await mk("Migrate the uploads table", "full-auto", api, script([{ name: "Bash", input: { command: hang, description: "bun run migrate --table uploads" } }]));
    const plan = await mk("Plan the move to resumable uploads", "plan", web, script([{ name: "present_plan", input: { title: "Resumable uploads", plan: "1. Add a chunk table.\n2. Resume from the last chunk." } }]));
    const question = await mk("Pick the database for the queue", "full-auto", api, script([{ name: "AskUserQuestion", input: { questions: [{ header: "Store", question: "Which database should hold the queue?", options: [{ label: "SQLite" }, { label: "Valkey" }], multiSelect: false }] } }]));
    const approval = await mk("Clean the build output before the release", "ask", api, script([{ name: "Bash", input: { command: "rm -rf dist build .cache && git tag v0.9.0" } }]));
    for (const id of [done1, done2, failed, timer, job]) await expect.poll(() => ended(id), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await stateOf(request, stopped))?.why, { timeout: 30_000 }).toBe("tool");
    await request.post(`/api/sessions/${stopped}/interrupt`);

    await page.goto(`/s/${done1}`);
    const want: [string, string][] = [
      [approval, "need"], [question, "need"], [plan, "need"], [working, "work"], [silent, "work"], [parent, "work"],
      [timer, "wait"], [job, "wait"], [failed, "fail"], [stopped, "stop"], [done1, "done"], [fresh, "idle"],
    ];
    for (const [id, w] of want) await expect(row(page, id), id).toHaveAttribute("data-watch", w, { timeout: 15_000 });
    // The stream goes silent after its limit: the row says so.
    await expect(row(page, silent).getByTestId("row-why")).toHaveAttribute("data-why", "stalled", { timeout: 40_000 });
    await shoot(page, "session-state-12-list");
    await page.screenshot({ path: `${SHOTS}/session-state-12-list-rail-dark.png`, clip: { x: 0, y: 0, width: 640, height: 1040 } });

    // Folded: the same sessions as marks, banded by state.
    await page.getByTestId("rail-toggle").click();
    await expect(page.getByTestId("rail-band").first()).toBeVisible();
    await page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${approval}"]`).hover();
    await expect(page.getByTestId("rail-card")).toBeVisible();
    await shoot(page, "session-state-12-rail");
    await page.getByTestId("rail-toggle").click();

    // A phone: the dock names what waits, the drawer is the same list.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${approval}`);
    await expect(page.locator(".k-dock")).toBeVisible();
    await shoot(page, "session-state-12-phone-dock");
    await page.getByRole("button", { name: "All sessions" }).click();
    await expect(row(page, approval)).toBeVisible();
    await shoot(page, "session-state-12-phone-list");
  } finally {
    mkdirSync(WS, { recursive: true });
    writeFileSync(gate, "");
    await drop(request, made);
  }
});
