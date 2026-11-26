import { expect, test, type APIRequestContext, type Locator, type Page } from "./isolate.ts";
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
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
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
    // The timeline's Now reads the same state and names the plan.
    const now = await (await request.get(`/api/sessions/${planner}/timeline?format=text&limit=1`)).text();
    expect(now).toContain("Now: needs you.");
    expect(now).toContain("Needs you: a plan");

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

test("a session waiting on a timer says so, with what it waits for and since when; one with a command in the background works", async ({ page, request }) => {
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
    // The command left running: named in words (it was given no description, and its shell text is
    // not words), the command itself in the state and on the row's card.
    const j = row(page, job);
    await expect(j).toHaveAttribute("data-watch", "work");
    await expect(j.getByTestId("row-state")).toHaveText("Working");
    await expect(j.getByTestId("row-why")).toHaveText("Command in background");
    expect(await stateOf(request, job)).toMatchObject({ text: "Command in background: sleep 300", brief: "Command in background" });
    await expect(j.getByTestId("row-time")).toHaveText("now");
    expect(await stateOf(request, timer)).toMatchObject({ watch: "wait", why: "timer", text: "Timer: check the deploy" });
    expect(await stateOf(request, job)).toMatchObject({ watch: "work", why: "command" });
    // The timeline's Now says waiting too, and on what.
    const now = await (await request.get(`/api/sessions/${job}/timeline?format=text&limit=1`)).text();
    expect(now).toContain("Now: working.");
    expect(now).toContain("A command runs in the background");
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

test("is anything stuck: a held stream, a silent command and a stalled agent are listed once each, by time without progress", async ({ page, request, baseURL }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const tag = Date.now().toString(36);
  const gates = { stream: `${WS}/stuck-${tag}-stream.go`, tool: `${WS}/stuck-${tag}-tool.go`, agent: `${WS}/stuck-${tag}-agent.go` };
  try {
    const stream = await start(request, "Draft the release notes");
    const tool = await start(request, "Run the migration against staging");
    const chatty = await start(request, "Build with a progress line a second");
    const parent = await start(request, "Audit the three services");
    made.push(stream, tool, chatty, parent);
    await send(request, stream, `script:hold ${gates.stream}`);
    await send(request, tool, script([{ name: "Bash", input: { command: `until [ -f ${gates.tool} ]; do sleep 0.2; done; echo released` } }]));
    // A command that keeps writing makes progress, however long it runs.
    await send(request, chatty, script([{ name: "Bash", input: { command: `until [ -f ${gates.tool} ]; do echo tick; sleep 1; done` } }]));
    // The parent's own turn is blocked on its agent: the agent is the piece of work, not the parent.
    await send(request, parent, script([{ name: "spawn_agent", input: { message: `Read the billing service\nscript:hold ${gates.agent}`, isolation: "none" } }, { name: "wait_agent", input: {} }]));
    // A coordinator whose turn ended with an agent at work in the background: told of its silence once.
    const lead = await start(request, "Coordinate the log survey");
    made.push(lead);
    await send(request, lead, script([{ name: "spawn_agent", input: { message: `Survey the access logs\nscript:hold ${gates.agent}`, isolation: "none" } }]));
    const child = async () => ((await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as { session_id: string; status: string }[])[0]?.session_id;
    await expect.poll(child, { timeout: 30_000 }).toBeTruthy();
    const agent = (await child())!;
    const mine = [stream, tool, chatty, parent, agent];

    // By the daemon's own limits (two minutes for a model, ten for a tool) nothing is stuck yet.
    type Item = { session_id: string; what: string; agent: boolean; parent_id?: string; elapsed_ms: number };
    const stuck = async (q = "") => ((await (await request.get(`/api/stuck${q}`)).json()).items as Item[]).filter((i) => mine.includes(i.session_id));
    expect(await stuck()).toEqual([]);
    expect(await (await request.get("/api/stuck?format=text")).text()).toMatch(/^(Nothing is stuck|\d+ stuck)/);
    // The owner sets the limits to a few seconds: the three that made no progress, each once.
    expect((await request.patch("/api/settings", { data: { stuck: { model_s: 5, tool_s: 5 } } })).ok()).toBe(true);
    await expect.poll(async () => (await stuck()).map((i) => i.session_id).sort(), { timeout: 60_000 }).toEqual([stream, tool, agent].sort());
    const items = await stuck();
    expect(items.find((i) => i.session_id === stream)).toMatchObject({ what: "stream", agent: false });
    expect(items.find((i) => i.session_id === tool)).toMatchObject({ what: "tool", agent: false });
    expect(items.find((i) => i.session_id === agent)).toMatchObject({ what: "stream", agent: true, parent_id: parent });
    for (const i of items) expect(i.elapsed_ms).toBeGreaterThanOrEqual(5000);
    // The coordinator is told, once, which agent made no progress and on what; it is not told again.
    const told = async () => ((await (await request.get(`/api/sessions/${lead}`)).json()).events as { kind: string; data: { kind?: string; status?: string; text?: string } }[])
      .filter((e) => e.kind === "user" && e.data.kind === "harness" && e.data.status === "silent").map((e) => e.data.text ?? "");
    await expect.poll(async () => (await told()).length, { timeout: 60_000 }).toBe(1);
    expect((await told())[0]).toMatch(/^\[harness\] Agent "Survey the access logs" \(\w+\) has made no progress: the model is answering, no output for \d+s\. It is still running and has not reported\./);
    await page.waitForTimeout(12_000);
    expect(await told()).toHaveLength(1);
    // The parent runs (blocked in wait_agent), and the chatty command runs, and neither is listed.
    expect((await stateOf(request, parent))?.watch).toBe("work");
    expect((await stateOf(request, chatty))?.watch).toBe("work");
    // A request can name its own limit.
    expect(await stuck("?after=3600")).toEqual([]);
    // The text form, from the route and from the command line: what each has not done, and for how long.
    const text = await (await request.get("/api/stuck?format=text")).text();
    expect(text).toMatch(/stuck \(no progress for 5 s\), longest first:/);
    expect(text).toMatch(new RegExp(`${stream}  Draft the release notes: the model is answering, no output for \\d+s`));
    expect(text).toMatch(new RegExp(`${tool}  Run the migration against staging: running until .+, no output for \\d+s`));
    expect(text).toMatch(new RegExp(`${agent}  agent .+ of Audit the three services: the model is answering, no output for \\d+s`));
    expect(text).not.toContain(chatty);
    expect(text).not.toContain(`${parent}  `);
    const cli = execFileSync("bun", ["src/main.ts", "stuck", "--url", baseURL!], { encoding: "utf8", env: { ...process.env, KEEL_CONFIG_DIR: process.env.KEEL_CONFIG_DIR ?? `${WS}/config` } });
    for (const id of [stream, tool, agent]) expect(cli).toContain(id);

    // The page: the daemon's mark on each state is the same answer, above the session list.
    expect((await stateOf(request, tool) as { stuck?: { what: string } }).stuck?.what).toBe("tool");
    await page.goto(`/s/${parent}`);
    const strip = page.getByTestId("stuck");
    await expect(strip).toBeVisible({ timeout: 15_000 });
    // (The list shows its first three entries: while there are more that made no progress, it is opened to all of them.)
    await expect.poll(async () => {
      const more = strip.getByTestId("stuck-more");
      if (await more.count() && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
      return Promise.all([stream, tool, parent].map((id) => strip.locator(`[data-session="${id}"]`).count()));
    }, { timeout: 30_000 }).toEqual([1, 1, 1]);
    // (A tooltip moves from title to data-tip once a pointer has been over it.)
    const tip = async (el: Locator) => (await el.getAttribute("title")) ?? (await el.getAttribute("data-tip")) ?? "";
    // The strip belongs to the list: a quiet head in sentence case, no box, no glyph, and one line an entry as a session
    // row is (the session's own dot, the title, how long); what it has not done and whose agent it is are in the tooltip.
    const head = strip.locator(".k-stuck-head");
    await expect(head).toContainText("Not moving");
    expect(await head.evaluate((el) => getComputedStyle(el).textTransform), "no capitals").toBe("none");
    await expect(strip.locator("svg"), "no warning glyph").toHaveCount(0);
    expect(await strip.evaluate((el) => { const c = getComputedStyle(el); return [c.borderTopWidth, c.borderBottomWidth, c.backgroundColor, c.boxShadow]; }), "no box and no rule").toEqual(["0px", "0px", "rgba(0, 0, 0, 0)", "none"]);
    // Its head and its titles are in the quiet inks at a regular weight: the entry's own dot is the one colour.
    expect(await head.evaluate((el) => getComputedStyle(el).fontWeight), "a head that is not heavy").toBe("400");
    expect(await strip.locator(".k-row-title").first().evaluate((el) => { const p = document.body.appendChild(document.createElement("i")); p.style.color = "var(--muted)"; const muted = getComputedStyle(p).color; p.remove(); return getComputedStyle(el).color === muted; }), "muted titles").toBe(true);
    await expect.poll(() => tip(strip.locator(`[data-session="${stream}"]`))).toMatch(/no output/);
    await expect.poll(() => tip(strip.locator(`[data-session="${tool}"]`))).toMatch(/Running until .+, no output/);
    // An agent is no entry of its own: the session it works for is, with how many of its agents are stuck.
    await expect.poll(() => tip(strip.locator(`[data-session="${parent}"]`))).toMatch(/agent of Audit the three services/);
    await expect(strip.locator(`[data-session="${parent}"]`)).toHaveAttribute("data-agents", "1");
    // The row says no count of them: the tooltip names the agent.
    await expect(strip.locator(`[data-session="${parent}"] [data-testid="stuck-agents"]`)).toHaveCount(0);
    await expect(strip.locator(`[data-session="${agent}"]`)).toHaveCount(0);
    for (const id of [stream, tool, parent]) {
      const item = strip.locator(`[data-session="${id}"]`);
      await expect(item, "a session row").toHaveClass(/\bk-row\b/);
      await expect(item.locator(".k-mark"), "the session's own state, not needs-you").toHaveAttribute("data-watch", /^(work|wait)$/);
      expect(await item.evaluate((el) => el.getBoundingClientRect().height), "one line").toBeLessThan(32);
      await expect(item.locator(".k-stuck-what")).toHaveCount(0);
    }
    await expect(strip.locator(`[data-session="${chatty}"]`)).toHaveCount(0);
    await shoot(page, "session-state-04-stuck");
    await strip.locator(`[data-session="${tool}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/s/${tool}$`));
    // Progress again: the mark goes, and the list with its last item.
    writeFileSync(gates.tool, "");
    await expect(strip.locator(`[data-session="${tool}"]`)).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await request.patch("/api/settings", { data: { stuck: null } }).catch(() => {});
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
    await expect(row(page, parent).getByTestId("row-state")).toHaveText("Working");

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
    await expect.poll(() => listed(asks), { timeout: 30_000 }).toMatch(/\tneeds you \(an approval\)$/);
    expect(await listed(parent)).toMatch(/\tworking, 1 agent is still at work$/);
  } finally {
    mkdirSync(WS, { recursive: true });
    writeFileSync(gate, "");
    await drop(request, made);
  }
});

// Rows keep their place (rail-stable.spec.ts), so the guarantee is not kept by moving them to the
// top: such a session is never folded away under "N more", it is counted on the line above the
// list whatever the list is scrolled to, and a press on the count goes to its row.
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
    // (They were read: a finished session with something unread is not folded away either, see rail-stable.spec.ts.)
    for (const id of quiet) await request.post("/api/alerts/read", { data: { session_id: id } });

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
    // They stand where they were made, after the newer ones, and only finished ones are folded.
    const group = page.locator(".k-group").filter({ has: page.locator(`[data-session="${asks}"]`) });
    expect(await group.locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-watch")))).toEqual(["done", "done", "done", "done", "done", "done", "need", "fail", "fail", "fail"]);
    await expect(group.locator(".k-more")).toHaveText("4 more");
    await expect(row(page, quiet[0]!)).toHaveCount(0);
    // What waits on the owner is counted in the tab's title and at the list's foot.
    await expect(page).toHaveTitle(/^\(1\) /);
    await expect(page.getByTestId("inbox-count")).toHaveText("1");
    await shoot(page, "session-state-05-never-folded");
    // However short the window is, the rows out of view are named at the list's foot: the one that needs the owner
    // first, the failures behind "+3", whose press brings a failure's row on screen with the keyboard on it.
    await page.setViewportSize({ width: 1920, height: 480 });
    await page.getByTestId("session-list").evaluate((nav) => { nav.scrollTop = 0; });
    await expect(row(page, asks)).not.toBeInViewport();
    const strip = page.getByTestId("need-strip");
    await expect(strip.locator(`.k-need-name[data-session="${asks}"]`)).toBeInViewport({ ratio: 1 });
    await expect(strip.getByTestId("need-strip-more")).toHaveText("+3");
    for (const title of ["Reindex the docs", "Summarize the incident", "Draft the changelog"]) await expect(strip.getByTestId("need-strip-more")).toHaveAttribute("title", new RegExp(title));
    await strip.getByTestId("need-strip-more").click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-watch"))).toBe("fail");
    const reached = (await page.evaluate(() => document.activeElement?.getAttribute("data-session")))!;
    expect(failed).toContain(reached);
    await expect(row(page, reached)).toBeInViewport({ ratio: 0.95 });
    await page.getByTestId("composer").focus();
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
      // Said once: no second "needs you" on the row (its line's state word gives way to the word at its end).
      expect((await r.innerText()).match(/needs\s+you/gi)?.length ?? 0).toBeLessThanOrEqual(1);
      await expect(r.getByTestId("needs-you")).toHaveCount(0);
      // Who it waits on stands in the time's place; the time is its tooltip.
      await expect(r.getByTestId("row-on")).toHaveText("Needs you");
      expect((await r.getByTestId("row-on").boundingBox())!.width, "the word is the dot's, not drawn in the slot").toBeLessThanOrEqual(1);
      await expect(r.getByTestId("row-time")).toHaveAttribute("title", /^Needs you since /);
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
    await expect(why(working)).toHaveText("bun test --slow");
    await expect(row(page, working).getByTestId("row-time")).toHaveText("now");
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
    // (The card says the reason with how long it has stood: src/core/stand.ts.)
    await expect(card.getByTestId("rail-card-why")).toHaveText(/^Question: Which database should hold the queue\?(, for \d+[smh])?$/);
    await tick(working).hover();
    await expect(card.getByTestId("rail-card-why")).toHaveText(/^bun test --slow(, for \d+[smh])?$/);
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
    // The count is in the session: one asks, one runs, the line over the box says how many with the one dot of the
    // owner's, and its popup names each by its dot. The row says none, and its dot is the owner's.
    const kids = page.getByTestId("session-list").getByTestId("session-children");
    await expect(page.getByTestId("dock-agents-count")).toHaveText("2");
    await expect(page.getByTestId("dock-agents").locator('.k-mark[data-watch="need"]')).toBeVisible();
    await page.getByTestId("dock-agents").click();
    const popRows = page.getByTestId("background-popup").getByTestId("bg-agent");
    await expect(popRows.and(page.locator('[data-watch="need"]'))).toContainText("Ask about scope");
    await expect(popRows.and(page.locator('[data-watch="work"]'))).toContainText("Count the handlers");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("background-popup")).toBeHidden();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(1, 1);
    await shoot(page, "session-state-agents-need");
    await expect(page.getByTestId("dock-agents")).toHaveAttribute("aria-label", "Agents: 2 agents: 1 needs you, 1 working");
    await expect(row(page, parent).locator('.k-mark[data-watch="need"]')).toBeVisible();
    // The tree: the asking agent is marked, the running one is not.
    await row(page, parent).getByTestId("children-toggle").click();
    const asking = kids.locator('[data-testid="child-session"][data-asking]');
    await expect(asking).toHaveCount(1);
    await expect(asking).toContainText("Ask about scope");
    await expect(asking.getByTestId("child-state")).toHaveText("Needs you");
    await expect(kids.getByTestId("child-session")).toHaveCount(2);
    // Its card in the parent's transcript: the two agents started together are one line, which opens to each.
    // (A session with agents opens on the conversation: the call rows are in the full stream.)
    await page.getByTestId("lens-to-stream").click({ timeout: 60_000 });
    await page.locator('[data-testid="work-step"][data-family="agents"] button.k-line').first().click();
    const card = page.getByTestId("agent-call").filter({ hasText: "Ask about scope" });
    await expect(card.getByTestId("agent-call-status")).toHaveText("Needs you: a question");
    await expect(page.getByTestId("agent-call").filter({ hasText: "Count the handlers" }).getByTestId("agent-call-status")).toHaveText("Working, in background");
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

test("the phone strip says how many need the owner, in plain words to a reader, and its marks carry the first word of a title", async ({ page, request }) => {
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
    // Its mark and its figure on the strip, the words for a screen reader and the tooltip.
    await expect(dock.getByTestId("dock-need")).toHaveAccessibleName("1 needs you");
    await expect(dock.getByTestId("dock-need")).toHaveAttribute("title", "1 needs you");
    await expect(dock.getByTestId("dock-need").locator(".k-dock-need-n")).toHaveText("1");
    // Every mark has the first word of the session's title beside its state.
    await expect(dock.locator('.k-dock-mark[data-watch="need"]').getByTestId("dock-code")).toHaveText("Clean");
    await expect(dock.locator(".k-dock-mark[aria-current]").getByTestId("dock-code")).toHaveText("Explain");
    expect((await dock.getByTestId("dock-code").allInnerTexts()).length).toBeGreaterThanOrEqual(2);
    // The strip keeps the desk's calm rules: a name in the text face and its regular weight, the state's color on its
    // dot alone (no filled pill), a count as a figure (no ring, no fill).
    const look = await dock.evaluate((d) => {
      const code = getComputedStyle(d.querySelector('[data-testid="dock-code"]')!);
      const need = d.querySelector<HTMLElement>(".k-dock-need-n")!;
      return { face: code.fontFamily.split(",")[0], weight: code.fontWeight, fill: getComputedStyle(need).backgroundColor, dot: !!need.querySelector('.k-mark[data-watch="need"]') };
    });
    expect(look.face, "a name is in the text face").toContain("Plex Sans");
    expect(look.weight, "a name is regular").toBe("400");
    expect(look.fill, "no filled pill").toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    expect(look.dot, "the need is said by its dot").toBe(true);
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

// A row is one line: it has no room for its reason, so the card beside it is the whole one, with the
// state's word, the title and the reason in full. The row has no tooltip of the browser's own.
test("the card beside a list row of one line is the whole card", async ({ page, request }) => {
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
    const card = page.getByTestId("rail-card");
    // The whole card, with the state's word, the title and the reason in full.
    await r.hover();
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute("data-kind", "row");
    await expect(card).toContainText(/needs you/i);
    await expect(card).toContainText("Clean the build output before the release");
    await expect(card.getByTestId("rail-card-why")).toContainText(`Approve Bash: ${command}`);
    await expect(card.getByTestId("rail-card-why")).toHaveText(/v0\.9\.0 --follow-tags(, for \d+[smh])?$/);
    await expect(card).toContainText("Model");
    expect(await r.locator(".k-row-title").getAttribute("title")).toBeNull();
    await shoot(page, "session-state-11-row-card");
    await page.mouse.move(1200, 500);
    await expect(card).toHaveCount(0);
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
    expect(now.join("\n")).toMatch(/Agent "Watch the deploy.*" is waiting for a timer, .*due in 4[12] min/);
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
    await expect(page.getByTestId("side-panel")).toContainText(/is waiting for a timer/);
    await expect(page.getByTestId("side-panel")).toContainText(/due in 4[12] min/);
    await shoot(page, "session-state-09-parked-agent");
  } finally {
    await drop(request, made);
  }
});

test("a failure is not hidden by a wait still armed", async ({ page, request, baseURL }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const ended = async (id: string, n: number) => {
    const d = await (await request.get(`/api/sessions/${id}`)).json();
    return !d.running && (d.events as { kind: string }[]).filter((e) => e.kind === "turn_end" || e.kind === "error").length >= n;
  };
  try {
    const id = await start(request, "Poll the queue and bill the run");
    made.push(id);
    // A twenty-minute timer is armed, then the next turn fails on billing.
    await send(request, id, script([{ name: "wait_for", input: { kind: "timer", seconds: 1200, note: "poll the queue" } }]));
    await expect.poll(() => ended(id, 1), { timeout: 30_000 }).toBe(true);
    expect(await stateOf(request, id)).toMatchObject({ watch: "wait", why: "timer" });
    await send(request, id, "script:billing");
    await expect.poll(async () => (await stateOf(request, id))?.watch, { timeout: 30_000 }).toBe("fail");
    // Every surface says Failed, with what kind: the timer still armed does not turn it to Waiting.
    expect(await stateOf(request, id)).toMatchObject({ watch: "fail", cls: "quota" });
    await page.goto(`/s/${id}`);
    await expect(row(page, id)).toHaveAttribute("data-watch", "fail");
    await expect(row(page, id).getByTestId("row-state")).toHaveText("Failed");
    await expect(row(page, id).getByTestId("row-class")).toHaveText("billing");
    await expect(page.getByTestId("station-word")).toHaveText("Failed");
    const cli = execFileSync("bun", ["src/main.ts", "sessions", "--url", baseURL!], { encoding: "utf8", env: { ...process.env, KEEL_CONFIG_DIR: process.env.KEEL_CONFIG_DIR ?? `${WS}/config` } }).split("\n");
    expect(cli.find((l) => l.startsWith(id))).toMatch(/\s+failed\s+/);
    // The timeline's Now does not call it waiting either, and still lists the timer.
    const now = await (await request.get(`/api/sessions/${id}/timeline?format=text&limit=1`)).text();
    expect(now).toContain("Now: failed.");
    expect(now).toContain("Waiting for a timer");
  } finally {
    await drop(request, made);
  }
});

test("a declined turn, a stopped one with a held queue and a scheduled loop read the same on the row and in the timeline's Now", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const gate = `${WS}/now-${Date.now().toString(36)}.go`;
  const now = async (id: string) => (await (await request.get(`/api/sessions/${id}/timeline?format=text&limit=1`)).text()).split("\n").slice(1, 6).join("\n");
  try {
    const declined = await start(request, "Write the exploit for the parser bug");
    const stopped = await start(request, "Rename the config keys");
    const armed = await start(request, "Watch the canary, then stop");
    const looped = await start(request, "Report the plan for the day");
    made.push(declined, stopped, armed, looped);
    await send(request, declined, "script:refuse");
    await send(request, stopped, script([{ name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done` } }]));
    await send(request, armed, script([{ name: "wait_for", input: { kind: "timer", seconds: 660, note: "look at the canary" } }, { name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done` } }]));
    await send(request, looped, "Say hello.");
    expect((await request.post("/api/loops", { data: { session_id: looped, schedule: "every day at 09:30", prompt: "Report the plan for the day.", tz: "UTC" } })).ok()).toBe(true);
    // The two with a command running are stopped by the owner; one then gets a prompt that waits in its held queue.
    for (const id of [stopped, armed]) {
      await expect.poll(async () => { const st = await stateOf(request, id); return st?.why === "tool" && /until/.test(st.text ?? ""); }, { timeout: 30_000 }).toBe(true);
      await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
      await expect.poll(async () => (await stateOf(request, id))?.watch, { timeout: 30_000 }).toBe("stop");
    }
    expect((await request.post(`/api/sessions/${stopped}/messages`, { data: { text: "And then update the docs.", mode: "queue" } })).ok()).toBe(true);

    // A turn the model declined is not done: its own word, with the failed ones.
    await expect.poll(async () => (await stateOf(request, declined))?.watch, { timeout: 30_000 }).toBe("declined");
    expect(await stateOf(request, declined)).toMatchObject({ watch: "declined", text: "The model declined the turn" });
    // Stopped with a prompt in the held queue: stopped, and it says what waits.
    await expect.poll(async () => (await stateOf(request, stopped))?.text, { timeout: 15_000 }).toBe("1 queued prompt waits until you resume");
    expect(await now(stopped)).toMatch(/^Now: stopped\./);
    expect(await now(stopped)).toContain("1 queued prompt waits");
    // Stopped after arming a timer: still stopped (the queue is held), with the timer listed under it.
    expect((await stateOf(request, armed))?.watch).toBe("stop");
    expect(await now(armed)).toMatch(/^Now: stopped\./);
    expect(await now(armed)).toContain("Waiting for a timer");
    // A scheduled loop does not make a finished session wait: it is at rest between runs.
    await expect.poll(async () => (await stateOf(request, looped))?.watch, { timeout: 30_000 }).toBe("done");
    expect(await now(looped)).toMatch(/^Now: done\./);
    expect(await now(looped)).toContain("runs next");

    await page.goto(`/s/${looped}`);
    await expect(row(page, declined)).toHaveAttribute("data-watch", "declined");
    await expect(row(page, declined).getByTestId("row-state")).toHaveText("Declined");
    await expect(row(page, declined).getByTestId("row-why")).toHaveText("The model declined the turn");
    await expect(row(page, stopped).getByTestId("row-state")).toHaveText("Stopped");
    await expect(row(page, stopped).getByTestId("row-why")).toHaveText("1 queued prompt waits until you resume");
    await expect(row(page, armed)).toHaveAttribute("data-watch", "stop");
    await expect(row(page, looped)).toHaveAttribute("data-watch", "done");
    await shoot(page, "session-state-13-declined-stopped-loop");
  } finally {
    mkdirSync(WS, { recursive: true });
    writeFileSync(gate, "");
    await drop(request, made);
  }
});

test("a turn that resumes by itself after a provider's wait is Waiting with its time; called off, it is Failed", async ({ page, request, baseURL }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    const watcher = await start(request, "A quiet session to watch from");
    const limited = await start(request, "Reindex the docs under a rate limit");
    made.push(watcher, limited);
    await send(request, limited, "script:rate-limit-long");
    await expect.poll(async () => (await stateOf(request, limited))?.why, { timeout: 30_000 }).toBe("resume");
    // The provider asked for a wait longer than a turn waits: the session resumes by itself then. Waiting, not Failed.
    const st = await stateOf(request, limited) as { watch: string; why: string; text: string; until: number; cls?: string };
    expect(st).toMatchObject({ watch: "wait", why: "resume", text: "Resumes by itself", cls: "rate_limit" });
    expect(st.until).toBeGreaterThan(Date.now() + 10 * 60_000);
    await page.goto(`/s/${watcher}`);
    const r = row(page, limited);
    await expect(r).toHaveAttribute("data-watch", "wait");
    await expect(r.getByTestId("row-state")).toHaveText("Waiting");
    await expect(r.getByTestId("row-why")).toHaveText(/^Resumes by itself at \d\d:\d\d$/);
    await expect(r.getByTestId("row-time")).toHaveText(/^in 1[45]m$/);
    // The command line and the timeline's Now say the same.
    const cli = execFileSync("bun", ["src/main.ts", "sessions", "--url", baseURL!], { encoding: "utf8", env: { ...process.env, KEEL_CONFIG_DIR: process.env.KEEL_CONFIG_DIR ?? `${WS}/config` } }).split("\n");
    const at = cli.findIndex((l) => l.startsWith(limited));
    expect(cli[at]).toMatch(/\s+waiting\s+/);
    expect(cli[at + 1]).toMatch(/^\s+waiting: Resumes by itself at \d\d:\d\d, due in 1[45]m$/);
    const now = await (await request.get(`/api/sessions/${limited}/timeline?format=text&limit=1`)).text();
    expect(now).toContain("Now: waiting.");
    expect(now).toMatch(/Resumes by itself when the wait the provider asked for is over, .*due in 1[45] min/);
    // Its own pane: the band and the transcript's box agree, and the box carries the two actions.
    await r.click();
    await expect(page.getByTestId("station-word")).toHaveText("Waiting");
    await expect(page.getByTestId("station-why")).toHaveText(/^Resumes by itself at \d\d:\d\d$/);
    const box = page.getByTestId("resume-at");
    await expect(box).toContainText(/Resumes by itself at \d\d:\d\d/);
    await expect(box.getByTestId("resume-now")).toHaveText(/Resume now/);
    await expect(box.getByTestId("resume-cancel")).toHaveText("Do not resume");
    await shoot(page, "session-state-14-resumes-by-itself");
    // Called off: nothing resumes by itself, and the failure is in sight with its class.
    await box.getByTestId("resume-cancel").click();
    await expect(r).toHaveAttribute("data-watch", "fail");
    await expect(r.getByTestId("row-state")).toHaveText("Failed");
    await expect(r.getByTestId("row-class")).toHaveText("rate limit");
    expect(await stateOf(request, limited)).toMatchObject({ watch: "fail", cls: "rate_limit" });
  } finally {
    await drop(request, made);
  }
});

test("a secret the model asks for reads Needs you with its name", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    const watcher = await start(request, "A quiet session to watch from");
    const asks = await start(request, "Check the deploy with the deploy key");
    made.push(watcher, asks);
    await send(request, asks, script([{ name: "request_secret", input: { name: "DEPLOY_KEY", purpose: "deploy check" } }]));
    await expect.poll(async () => (await stateOf(request, asks))?.watch, { timeout: 30_000 }).toBe("need");
    expect(await stateOf(request, asks)).toMatchObject({ watch: "need", why: "secret", text: "Secret to give: DEPLOY_KEY", asks: 1 });
    await page.goto(`/s/${watcher}`);
    await expect(row(page, asks)).toHaveAttribute("data-watch", "need");
    await expect(row(page, asks).getByTestId("row-why")).toHaveText("Secret to give: DEPLOY_KEY");
    await expect(page).toHaveTitle(/^\(\d+\) /);
    const now = await (await request.get(`/api/sessions/${asks}/timeline?format=text&limit=1`)).text();
    expect(now).toContain("Now: needs you.");
    expect(now).toContain("Needs you: a secret");
  } finally {
    await drop(request, made);
  }
});

test("a long session the page holds only the newest part of reads the daemon's word and reason", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const ended = async (id: string, n: number) => {
    const d = await (await request.get(`/api/sessions/${id}?events=0`)).json();
    if (d.running) return false;
    const ev = (await (await request.get(`/api/sessions/${id}/events`)).json()).events as { kind: string }[];
    return ev.filter((e) => e.kind === "turn_end").length >= n;
  };
  // Four turns of 70 commands each: some 570 events, where the page reads the newest 200 of a session
  // (back to the turn they begin in) and the rest when asked.
  const TURNS = 4;
  const long = (turn: number) => script(Array.from({ length: 70 }, (_, i) => ({ name: "Bash", input: { command: `echo turn ${turn} step ${i}` } })));
  try {
    const watcher = await start(request, "A quiet session to watch from");
    const waits = await start(request, "A long migration, then a look in a quarter of an hour");
    const failed = await start(request, "A long reindex that ran out of credit");
    const declined = await start(request, "A long audit the model then declined");
    made.push(watcher, waits, failed, declined);
    for (let t = 0; t < TURNS; t++) {
      for (const id of [waits, failed, declined]) await send(request, id, long(t));
      for (const id of [waits, failed, declined]) await expect.poll(() => ended(id, t + 1), { timeout: 120_000, intervals: [1000] }).toBe(true);
    }
    await send(request, declined, "script:refuse");
    await expect.poll(async () => (await stateOf(request, declined))?.watch, { timeout: 30_000 }).toBe("declined");
    await send(request, waits, script([{ name: "wait_for", input: { kind: "timer", seconds: 900, note: "look at the migration" } }]));
    await send(request, failed, "script:billing");
    await expect.poll(async () => (await stateOf(request, waits))?.watch, { timeout: 30_000 }).toBe("wait");
    await expect.poll(async () => (await stateOf(request, failed))?.watch, { timeout: 30_000 }).toBe("fail");

    // The page reads each in parts: the newest part only, with the rest a press away.
    const read: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (r.method() === "GET" && [waits, failed, declined].some((id) => u.pathname === `/api/sessions/${id}/events`)) read.push(u.pathname); });
    for (const [id, word, why] of [[waits, "Waiting", "Timer: look at the migration"], [failed, "Failed", /^HTTP 402/]] as const) {
      await page.goto(`/s/${id}`);
      await expect(page.getByTestId("load-earlier")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("transcript").getByText("echo turn 0 step 0", { exact: false })).toHaveCount(0);
      // The word and the reason are the daemon's, on the row and on the pane, as /api/state has them.
      await expect(row(page, id).getByTestId("row-state")).toHaveText(word);
      await expect(row(page, id).getByTestId("row-why")).toHaveText(why);
      await expect(page.getByTestId("station-word")).toHaveText(word);
      // A failure's reason is its card's in the transcript: the head keeps the word and the reason is its tooltip.
      if (id === failed) {
        await expect(page.getByTestId("station-why")).toHaveCount(0);
        await expect(page.getByTestId("station-word")).toHaveAttribute("title", why);
      } else await expect(page.getByTestId("station-why")).toHaveText(why);
    }
    await expect(row(page, failed).getByTestId("row-class")).toHaveText("billing");
    await expect(row(page, waits).getByTestId("row-time")).toHaveText(/^in 1[45]m$/);
    await shoot(page, "session-state-15-part-held");

    // From another session's page neither is read at all, and both rows say the same.
    await page.goto(`/s/${watcher}`);
    await expect(row(page, waits)).toHaveAttribute("data-watch", "wait");
    await expect(row(page, waits).getByTestId("row-why")).toHaveText("Timer: look at the migration");
    await expect(row(page, failed)).toHaveAttribute("data-watch", "fail");
    await expect(row(page, failed).getByTestId("row-class")).toHaveText("billing");
    // Nothing read a session whole to know its word.
    expect(read).toEqual([]);

    // The daemon's states cannot be read (the snapshot fails): a row falls back to the marks the daemon
    // keeps on the session, not to the part of its events the page holds. Failed stays Failed.
    await page.route("**/api/state", (r) => r.abort());
    await page.goto(`/s/${failed}`);
    await expect(page.getByTestId("load-earlier")).toBeVisible({ timeout: 30_000 });
    await expect(row(page, failed)).toHaveAttribute("data-watch", "fail");
    await expect(page.getByTestId("station-word")).toHaveText("Failed");
    // The reader is far up in a session whose last turn the model declined: the part held ends in an
    // earlier turn that finished. The row and the pane still say Declined, not Done.
    const first = ((await (await request.get(`/api/sessions/${declined}/events`)).json()).events as { id: string; kind: string; data: { text?: string } }[])
      .find((e) => e.kind === "user" && String(e.data.text).includes("turn 0 step 0"))!;
    await page.goto(`/s/${declined}?e=${first.id}`);
    await expect(page.locator(`#e-${first.id}`)).toBeInViewport({ timeout: 30_000 });
    await expect(page.getByTestId("refusal")).toHaveCount(0);
    await expect(row(page, declined)).toHaveAttribute("data-watch", "declined");
    await expect(row(page, declined).getByTestId("row-state")).toHaveText("Declined");
    await expect(page.getByTestId("station-word")).toHaveText("Declined");
    await shoot(page, "session-state-16-part-far-up");
    await page.unroute("**/api/state");
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
    const done1 = await mk("Explain the build script", "full-auto", web, "Say hello.");
    const declined = await mk("Write the exploit for the parser bug", "full-auto", api, "script:refuse");
    const stopped = await mk("Rename the config keys", "full-auto", web, script([{ name: "Bash", input: { command: hang } }]));
    const failed = await mk("Reindex the docs after the schema change", "full-auto", web, "script:billing");
    const timer = await mk("Check the deploy in a quarter of an hour", "full-auto", api, script([{ name: "wait_for", input: { kind: "timer", seconds: 900, note: "check the deploy" } }]));
    const job = await mk("Run the slow suite in the background", "full-auto", api, script([{ name: "Bash", input: { command: "sleep 300", run_in_background: true } }]));
    const parent = await mk("Audit the three services", "full-auto", web, script([{ name: "spawn_agent", input: { message: `Read the billing service\n${script([{ name: "Bash", input: { command: hang } }])}`, isolation: "none" } }]));
    const silent = await mk("Summarize the incident from Monday", "full-auto", web, `script:hold ${gate}`);
    const working = await mk("Migrate the uploads table", "full-auto", api, script([{ name: "Bash", input: { command: hang, description: "bun run migrate --table uploads" } }]));
    const plan = await mk("Plan the move to resumable uploads", "plan", web, script([{ name: "present_plan", input: { title: "Resumable uploads", plan: "1. Add a chunk table.\n2. Resume from the last chunk." } }]));
    const question = await mk("Pick the database for the queue", "full-auto", api, script([{ name: "AskUserQuestion", input: { questions: [{ header: "Store", question: "Which database should hold the queue?", options: [{ label: "SQLite" }, { label: "Valkey" }], multiSelect: false }] } }]));
    const approval = await mk("Clean the build output before the release", "ask", api, script([{ name: "Bash", input: { command: "rm -rf dist build .cache && git tag v0.9.0" } }]));
    for (const id of [done1, declined, failed, timer, job]) await expect.poll(() => ended(id), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await stateOf(request, stopped))?.why, { timeout: 30_000 }).toBe("tool");
    await request.post(`/api/sessions/${stopped}/interrupt`, { data: { by: "owner" } });

    await page.goto(`/s/${done1}`);
    const want: [string, string][] = [
      [approval, "need"], [question, "need"], [plan, "need"], [working, "work"], [silent, "work"], [parent, "work"],
      [timer, "wait"], [job, "work"], [failed, "fail"], [declined, "declined"], [stopped, "stop"], [done1, "done"],
    ];
    for (const [id, w] of want) await expect(row(page, id), id).toHaveAttribute("data-watch", w, { timeout: 15_000 });
    // All of them are on screen at once: a row is two lines at most.
    const listBox = (await page.getByTestId("session-list").boundingBox())!;
    for (const [id] of want) {
      const box = (await row(page, id).boundingBox())!;
      expect(box.height, id).toBeLessThanOrEqual(56); // two lines of text and the row's padding
      expect(box.y + box.height, id).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
    }
    // Within a folder a row stands where its session was made, the newest first, whatever its state:
    // the state is the mark and the word. Every row is as high as every other.
    const order = await page.getByTestId("session-list").locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-session")));
    for (const ids of [[approval, question, working, job, timer, declined], [plan, silent, parent, failed, stopped, done1]]) expect(order.filter((id) => ids.includes(id!))).toEqual(ids);
    expect(new Set(await page.getByTestId("session-list").locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))).size).toBe(1);
    // Sorted by state, the order that was the list's own before: what needs the owner first, then what failed, what waits, what works, what is at rest.
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-sort-state").click();
    await page.keyboard.press("Escape");
    await page.mouse.move(1200, 500);
    const tier: Record<string, number> = { need: 0, fail: 1, declined: 1, wait: 2, work: 3, stop: 4, done: 4, idle: 4 };
    await expect.poll(async () => {
      const rows = await page.getByTestId("session-list").locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => [e.getAttribute("data-session"), e.getAttribute("data-watch")]));
      return [[approval, question, declined, timer, job, working], [plan, failed, silent, parent, stopped, done1]].every((ids) => {
        const tiers = rows.filter(([id]) => ids.includes(id!)).map(([, w]) => tier[w!]!);
        return tiers.length === ids.length && tiers.every((t, i) => i === 0 || tiers[i - 1]! <= t);
      });
    }).toBe(true);
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-reset").click();
    await expect(row(page, declined).getByTestId("row-state")).toHaveText("Declined");
    await expect(row(page, working).getByTestId("row-why")).toHaveText("bun run migrate --table uploads");
    // The stream goes silent after its limit: the row says so.
    await expect(row(page, silent).getByTestId("row-why")).toHaveAttribute("data-why", "stalled", { timeout: 40_000 });
    await shoot(page, "session-state-12-list");
    await page.screenshot({ path: `${SHOTS}/session-state-12-list-rail-dark.png`, clip: { x: 0, y: 0, width: 640, height: 1040 } });

    // Folded: the same sessions as marks, banded by state.
    await page.getByTestId("rail-toggle").click();
    await expect(page.getByTestId("rail-band").first()).toBeVisible();
    // Every band is on the rail without a scroll: need, fail, wait, work, stop, done.
    const bands = page.getByTestId("rail-band");
    await expect(bands).toHaveCount(6);
    expect(await bands.evaluateAll((els) => els.map((e) => e.getAttribute("data-watch")))).toEqual(["need", "fail", "wait", "work", "resume", "done"]);
    // With room for all, every one of the twelve has its mark. (On a daemon crowded by other specs' sessions
    // a band holds some back behind a count, and what needs the owner still has its marks.)
    const crowded = (await page.getByTestId("rail-more").count()) > 0;
    for (const [id, w] of want) if (!crowded || w === "need") await expect(page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`), id).toBeVisible();
    const railBox = (await page.getByTestId("session-list").boundingBox())!;
    for (const b of await bands.all()) {
      const box = (await b.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(railBox.y + railBox.height + 1);
    }
    // A finished session's mark is the quiet grey, in its band's head too: the folded rail's column of them is not a column of green.
    {
      const ink = (v: string) => page.evaluate((v) => { const p = document.body.appendChild(document.createElement("i")); p.style.color = `var(${v})`; const c = getComputedStyle(p).color; p.remove(); return c; }, v);
      const done = page.locator('[data-testid="rail-band"][data-watch="done"] .k-mark[data-watch="done"]');
      expect(await done.count()).toBeGreaterThan(1);
      expect(await done.evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).backgroundColor))])).toEqual([await ink("--st-idle")]);
    }
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

// Feature (UX-M62): the list of what made no progress shows its first three entries and says how many more, and an
// agent is no entry of its own: the session it works for is, with how many of its agents are stuck.
test("what made no progress is capped at three entries with the rest a count, agents folded into their session", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  const gate = `${WS}/cap-${Date.now().toString(36)}.go`;
  const hold = (n: number) => script([{ name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done; echo ${n}` } }]);
  try {
    const singles: string[] = [];
    for (let i = 0; i < 4; i++) { const id = await start(request, `Cap: silent command ${i + 1}`); made.push(id); singles.push(id); await send(request, id, hold(i)); }
    const lead = await start(request, "Cap: a coordinator with two stalled helpers");
    made.push(lead);
    const agent = (n: number) => ({ name: "spawn_agent", input: { message: `Quiet worker ${n}\n${hold(n)}`, isolation: "none" } });
    await send(request, lead, `script:batch ${JSON.stringify([agent(1), agent(2)])}`);
    expect((await request.patch("/api/settings", { data: { stuck: { model_s: 5, tool_s: 5 } } })).ok()).toBe(true);
    // The entries the page should list: each stuck session once, its agents at the root of their tree.
    const entries = async () => {
      const { items } = await (await request.get("/api/stuck")).json() as { items: { session_id: string; agent: boolean; parent_id?: string }[] };
      const sessions = (await (await request.get("/api/sessions")).json()).sessions as { id: string; parent_id?: string }[];
      const parent = new Map(sessions.map((s) => [s.id, s.parent_id]));
      const root = (id: string) => { for (let i = 0; i < 16 && parent.get(id); i++) id = parent.get(id)!; return id; };
      return new Set(items.map((i) => root(i.session_id)));
    };
    await expect.poll(async () => { const e = await entries(); return [...singles, lead].every((id) => e.has(id)); }, { timeout: 60_000 }).toBe(true);
    const total = (await entries()).size;
    expect(total, "five or more entries to cap").toBeGreaterThanOrEqual(5);
    await page.goto("/");
    const strip = page.getByTestId("stuck");
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(strip.getByTestId("stuck-item")).toHaveCount(3);
    await expect(strip.getByTestId("stuck-more")).toHaveText(`+${total - 3} more`);
    // The head is the group's name and how many are in it.
    await expect(strip.locator("h2")).toContainText("Not moving");
    await expect(strip.locator("h2 .k-stuck-n")).toHaveText(String(total));
    expect(await strip.evaluate((el) => el.getBoundingClientRect().height), "the band takes about five rows").toBeLessThan(5.5 * 24 + 16);
    await shoot(page, "session-state-05-stuck-capped");
    await strip.getByTestId("stuck-more").click();
    await expect(strip.getByTestId("stuck-item")).toHaveCount(total);
    // The coordinator is one entry for both its agents; they are not entries of their own.
    const folded = strip.locator(`[data-session="${lead}"]`);
    await expect(folded).toHaveAttribute("data-agents", "2");
    // The row has no count of its agents: its tooltip has a line for each.
    await expect(folded.getByTestId("stuck-agents")).toHaveCount(0);
    await expect.poll(async () => ((await folded.getAttribute("title")) ?? (await folded.getAttribute("data-tip")) ?? "").split("\n").filter((l) => l.includes("agent of")).length).toBe(2);
    await expect(strip.locator("[data-testid=stuck-item]", { hasText: "Quiet worker" })).toHaveCount(0);
    await shoot(page, "session-state-06-stuck-all");
    await strip.getByTestId("stuck-more").click();
    await expect(strip.getByTestId("stuck-item")).toHaveCount(3);
    // A phone: the drawer holds the same list, the strip over it as it is on a wide page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "All sessions" }).click();
    await expect(page.getByTestId("stuck").getByTestId("stuck-item").first()).toBeVisible();
    await shoot(page, "session-state-07-stuck-phone");
  } finally {
    await request.patch("/api/settings", { data: { stuck: null } }).catch(() => {});
    mkdirSync(WS, { recursive: true });
    writeFileSync(gate, "");
    await drop(request, made);
  }
});
