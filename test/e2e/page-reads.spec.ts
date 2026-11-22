import { expect, test, type WebSocketRoute } from "./isolate.ts";
import { ask, shoot } from "./shots.ts";
import { connect, createServer, type Socket } from "node:net";

// Feature: what the page asks the daemon for. A session at work costs no
// read of its own: its background commands are read when the daemon says
// they changed, and whether it is a copy of another tool's conversation is
// asked once.
const STAND_IN = "scripted:stand-in";

test("a session at work reads its background commands when they change, not per turn", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Reads while working" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const reads = { jobs: 0, origin: 0 };
  page.on("request", (r) => {
    if (r.method() !== "GET") return;
    const path = new URL(r.url()).pathname;
    if (path === `/api/sessions/${session.id}/jobs`) reads.jobs++;
    if (path === `/api/sessions/${session.id}/origin`) reads.origin++;
  });
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  await expect(composer).toBeVisible();
  await expect.poll(() => reads.jobs).toBe(1);

  // Three turns of tool calls, each a few seconds long, none in the background.
  const calls = ["echo one", "sleep 2.5", "echo three"].map((command) => ({ name: "Bash", input: { command } }));
  for (let turn = 1; turn <= 3; turn++) {
    await composer.fill(`script:calls ${JSON.stringify(calls)}`);
    await composer.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(turn, { timeout: 30_000 });
  }
  expect(reads).toEqual({ jobs: 1, origin: 1 });

  // A command started in the background shows above the box at once, its last line follows, and its end is said.
  await composer.fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo step-1-of-2; sleep 3; echo job-finished", run_in_background: true } }])}`);
  await composer.press("Enter");
  const job = page.getByTestId("dock-job");
  await expect(job).toHaveCount(1, { timeout: 15_000 });
  await expect(job.getByTestId("dock-job-last")).toHaveText("job-finished", { timeout: 15_000 });
  await expect(job).toContainText("exit 0", { timeout: 15_000 });
  // Its two seconds of looking end with it: nothing is read once it is over.
  const after = reads.jobs;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
  expect(reads.jobs).toBe(after);
  expect(reads.origin).toBe(1);
  await request.delete(`/api/sessions/${session.id}`);
});

// W2RE-S23. A feature reads its state as the page loads and again when the
// socket opens again; the page's first socket open is not "again". Two views
// that need the same list ask for it once.
test("a page load asks each endpoint once", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Reads at load" } })).json();
  for (const url of ["/", `/s/${session.id}`]) {
    const asked: string[] = [];
    const on = (r: { method(): string; url(): string }) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && u.pathname.startsWith("/api/")) asked.push(u.pathname + u.search);
    };
    page.on("request", on);
    await page.goto(url);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("sync-state")).toHaveCount(0);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
    page.off("request", on);
    expect(asked.length).toBeGreaterThan(10);
    expect(asked.filter((p, i) => asked.indexOf(p) !== i).map((p) => p.replace(session.id, ":id")), `repeats loading ${url === "/" ? "/" : "/s/:id"}`).toEqual([]);
  }
  await request.delete(`/api/sessions/${session.id}`);
});


// W2RE-S23, the large lists. The model listing can hold hundreds of entries
// and the fleet view repeated every local session twice. A page reads, as
// it loads, the few models it shows (the default, the ones its sessions run
// on) and the other machines alone; the whole listing is read when
// something lists models, once.
test("the whole model listing and this machine's own sessions are not read before they are used", async ({ page, request }) => {
  const all = (await (await request.get("/api/models")).json()).models as { id: string; name: string }[];
  test.skip(!all.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Reads of the large lists" } })).json();
  // What the brief read holds: the default and the models sessions run on (this session's among them), and the count of all.
  const brief = await (await request.get("/api/models?brief")).json();
  expect(brief.total).toBe(all.length);
  const used = new Set<string>([brief.default, ...((await (await request.get("/api/sessions")).json()).sessions as { model: string }[]).map((x) => x.model)]);
  expect(brief.models.map((m: { id: string }) => m.id).filter((id: string) => !used.has(id))).toEqual([]);
  expect(brief.models.map((m: { id: string }) => m.id)).toContain(STAND_IN);
  // The providers' names come with it: a page names a provider (a limit's, a failure's) before it lists any model.
  expect(brief.providers).toEqual((await (await request.get("/api/models")).json()).providers);
  expect(brief.providers.map((p: { id: string }) => p.id)).toContain("scripted");
  // The fleet view for a page: no machine entry of this daemon's own sessions, no recents.
  const others = await (await request.get("/api/fleet?others")).json();
  expect(others.machines.some((m: { id: string }) => m.id === "local")).toBe(false);
  expect(others.recents).toEqual([]);
  expect((await (await request.get("/api/fleet")).json()).machines[0].sessions.length).toBeGreaterThan(0);

  const asked: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() === "GET" && (u.pathname === "/api/models" || u.pathname === "/api/fleet")) asked.push(u.pathname + u.search);
  });
  await page.goto(`/s/${session.id}`);
  const picker = page.getByTestId("model-picker");
  // The message box names its model from the brief read.
  await expect(picker).toContainText(all.find((m) => m.id === STAND_IN)!.name);
  await expect(page.getByTestId("model-unlisted")).toHaveCount(0);
  await expect(page.getByTestId("sync-state")).toHaveCount(0);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
  expect(asked.sort()).toEqual(["/api/fleet?others", "/api/models?brief"]);

  // Opening the picker reads the whole listing, once, and offers a model the page did not hold.
  const held = new Set(brief.models.map((m: { id: string }) => m.id));
  const listed = (all as { id: string; name: string; model: string; hidden?: boolean }[]).filter((m) => !m.hidden && m.id !== STAND_IN);
  const other = listed.find((m) => !held.has(m.id)) ?? listed[0]!;
  const popup = page.getByTestId("model-popup");
  for (let open = 0; open < 2; open++) {
    await picker.click();
    await expect(popup).toBeVisible();
    await page.getByPlaceholder("Search models").fill(other.model);
    await expect(popup.locator(`[data-testid="model-option"][data-model="${other.id}"]`).first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
  }
  expect(asked.filter((p) => p === "/api/models")).toHaveLength(1);
  // A command that takes a model's name looks in the whole listing too.
  await page.getByTestId("composer").fill(`/model ${other.id}`);
  await page.getByTestId("composer").press("Enter");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}?events=0`)).json()).session.model, { timeout: 10_000 }).toBe(other.id);
  await expect(picker).toContainText(other.name);
  await request.delete(`/api/sessions/${session.id}`);
});

// What changes between a page's first reads and its socket's open is told
// by no frame. A feature's state (the open approvals, a session's state) is
// therefore read when the socket opens, not before; the session list, read
// as the page loads so it paints at once, is read again when the daemon says
// its list moved in between. The socket is held back here the way a slow
// link does: a pass-through in front of the daemon lets every request
// through at once and the WebSocket's upgrade when the test says. Inside
// that gap a session asks for an approval and another session is made: both
// show once the socket opens, with no reload.
test("what changed before the page's socket opened is shown once it opens", async ({ page, request, baseURL }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const daemon = new URL(baseURL!);
  const open = Promise.withResolvers<void>();
  const pipes = new Set<Socket>();
  const front = createServer((c) => {
    const up = connect(Number(daemon.port), daemon.hostname);
    pipes.add(c).add(up);
    for (const [x, y] of [[c, up], [up, c]] as const) { x.on("error", () => y.destroy()); x.on("close", () => y.destroy()); }
    up.pipe(c);
    c.once("data", (first) => {
      const go = () => { up.write(first); c.pipe(up); };
      if (/^upgrade:\s*websocket/im.test(first.toString("latin1"))) void open.promise.then(go);
      else go();
    });
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Asked before the socket opened" } })).json();
  let made: string | undefined;
  try {
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    // A second after it loads, with no socket yet, the page reads its features' state once (the next
    // test): that read is answered before anything changes here, so what changes is told by no read.
    // (Waited for by its answers, not by a time: a page that loaded fast had it still ahead.)
    const read = Promise.all(["/api/state", "/api/approvals"].map((path) => page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === path)));
    await page.goto(`http://127.0.0.1:${(front.address() as { port: number }).port}/`);
    const row = page.locator(`[data-testid="session-row"][data-session="${session.id}"]`);
    await expect(row).toBeVisible();
    await read;
    // The session asks for an approval while the socket is still on its way.
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "touch asked.txt" } }])}` } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/approvals`)).json()).approvals.length, { timeout: 30_000 }).toBe(1);
    await expect(row).not.toHaveAttribute("data-watch", "need");
    // And a session is made meanwhile.
    made = (await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Made before the socket opened" } })).json()).session.id as string;
    const fresh = page.locator(`[data-testid="session-row"][data-session="${made}"]`);
    await expect(fresh).toHaveCount(0);
    const loads: string[] = [];
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) loads.push(f.url()); });
    open.resolve();
    await expect(row).toHaveAttribute("data-watch", "need", { timeout: 10_000 });
    await expect(fresh).toContainText("Made before the socket opened", { timeout: 10_000 });
    expect(loads).toEqual([]); // shown by the page as it stands: nothing was loaded again
  } finally {
    open.resolve();
    if (made) await request.delete(`/api/sessions/${made}`);
    await request.delete(`/api/sessions/${session.id}`);
    for (const s of pipes) s.destroy();
    front.close();
  }
});

// A socket that does not open is not waited for: a second after the page
// loaded the features read their state once without it. Three sessions wait
// on the owner (an approval, a question, a secret) before the page loads,
// and the page's socket is held for eight seconds: the rows say what each
// waits for while the page still reconnects, each feature read once.
test("what waits on the owner shows while the socket is still held", async ({ page, request, baseURL }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const daemon = new URL(baseURL!);
  const HELD_MS = 8000;
  const pipes = new Set<Socket>();
  let heldAt = 0, let_through = 0;
  const front = createServer((c) => {
    const up = connect(Number(daemon.port), daemon.hostname);
    pipes.add(c).add(up);
    for (const [x, y] of [[c, up], [up, c]] as const) { x.on("error", () => y.destroy()); x.on("close", () => y.destroy()); }
    up.pipe(c);
    c.once("data", (first) => {
      const go = () => { up.write(first); c.pipe(up); };
      if (!/^upgrade:\s*websocket/im.test(first.toString("latin1"))) return go();
      heldAt ||= Date.now();
      setTimeout(() => { let_through ||= Date.now(); go(); }, Math.max(0, heldAt + HELD_MS - Date.now()));
    });
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const mk = async (title: string, call: unknown, mode: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, sandbox: "off" } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([call])}` } });
    return session.id as string;
  };
  const ids: string[] = [];
  try {
    const approval = await mk("Waits on an approval", { name: "Bash", input: { command: "touch asked.txt" } }, "ask");
    ids.push(approval);
    const question = await mk("Waits on an answer", { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } }, "full-auto");
    ids.push(question);
    const secret = await mk("Waits on a secret", { name: "request_secret", input: { name: "SPEC_TOKEN", purpose: "a spec" } }, "full-auto");
    ids.push(secret);
    const need = async () => Object.fromEntries(Object.entries((await (await request.get("/api/state")).json()).states as Record<string, { watch: string }>).filter(([id]) => ids.includes(id)).map(([id, s]) => [id, s.watch]));
    await expect.poll(need, { timeout: 30_000 }).toEqual({ [approval]: "need", [question]: "need", [secret]: "need" });

    const reads: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && ["/api/state", "/api/approvals", "/api/automation", "/api/projects", "/api/session-folders", "/api/helper", "/api/bootstrap"].includes(u.pathname)) reads.push(u.pathname);
    });
    await page.goto(`http://127.0.0.1:${(front.address() as { port: number }).port}/`);
    const row = (id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`);
    // Shown well inside the eight seconds, with the socket not open yet.
    for (const id of ids) await expect(row(id)).toHaveAttribute("data-watch", "need", { timeout: 4000 });
    await expect(row(approval)).toContainText("touch asked.txt");
    expect(let_through, "the socket was let through before the rows showed").toBe(0);
    expect([...reads].sort()).toEqual(["/api/approvals", "/api/automation", "/api/bootstrap", "/api/helper", "/api/projects", "/api/session-folders", "/api/state"]);
    await shoot(page, "page-reads-01-socket-held");

    // The open reads again, as every open does: once more each, and the rows stand.
    await expect.poll(() => let_through, { timeout: HELD_MS + 5000 }).toBeGreaterThan(0);
    await expect.poll(() => reads.filter((p) => p === "/api/state").length, { timeout: 10_000 }).toBe(2);
    for (const id of ids) await expect(row(id)).toHaveAttribute("data-watch", "need");
  } finally {
    for (const id of ids) await request.delete(`/api/sessions/${id}`);
    for (const s of pipes) s.destroy();
    front.close();
  }
});

// An unopened session has no cursor to replay. Its badge catches up from /api/state.
test("unopened queue badges catch up on reconnect without replacing a newer frame", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider to hold turns on an approval");
  const ids: string[] = [];
  const mk = async (title: string) => {
    const { session: { id } } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title } })).json();
    ids.push(id);
    await expect(await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } })).toBeOK();
    // A write needs approval in Ask mode. Read-only commands such as echo do not.
    const command = "touch queue-ready.txt";
    await expect(await request.post(`/api/sessions/${id}/messages`, { data: { text: ask(`Run ${command}.`, `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`) } })).toBeOK();
    await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.length, { timeout: 30_000 }).toBe(1);
    return id as string;
  };
  const enqueue = async (id: string) => {
    const res = await request.post(`/api/sessions/${id}/messages`, { data: { text: "Wait behind the approval", mode: "queue" } });
    await expect(res).toBeOK();
    return (await res.json()).queued.id as string;
  };
  let socket: WebSocketRoute | undefined, cut = false, hold = false;
  const taken = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
  try {
    const removed = await mk("Queue cleared while away"), added = await mk("Queue grew after the snapshot");
    await page.routeWebSocket(/\/ws$/, (ws) => {
      if (cut) return void ws.close({ code: 4000 });
      ws.connectToServer();
      socket = ws;
    });
    await page.route("**/api/state", async (route) => {
      if (!hold) return route.fallback();
      hold = false;
      const response = await route.fetch();
      taken.resolve();
      await reply.promise;
      await route.fulfill({ response });
    });
    const first = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/state");
    await page.goto("/");
    await first;
    const row = (id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`);
    await expect(row(removed)).toHaveAttribute("data-watch", "need");
    const badge = (id: string) => row(id).getByTestId("row-queued");
    const prompt = await enqueue(removed);
    await expect(badge(removed)).toHaveText("1"); // the page cached a live queue frame

    cut = true;
    await socket!.close({ code: 4000 });
    await expect(await request.delete(`/api/sessions/${removed}/queue/${prompt}`)).toBeOK();
    hold = true;
    cut = false;
    await taken.promise; // the reconnect snapshot was read with both queues empty
    await enqueue(added);
    await expect(badge(added)).toHaveText("1");
    reply.resolve();
    await expect(badge(removed)).toHaveCount(0); // that snapshot repairs the missed clear
    await expect(badge(added)).toHaveText("1"); // but does not undo a newer frame
    await shoot(page, "page-reads-02-queue-reconnect");
  } finally {
    reply.resolve();
    for (const id of ids) await request.delete(`/api/sessions/${id}`);
  }
});
