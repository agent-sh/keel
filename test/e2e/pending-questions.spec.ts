import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

const MODEL = "scripted:stand-in";
const question = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } };
const script = (call: unknown) => `script:calls ${JSON.stringify([call])}`;

test("only live questions mark an unopened session and its parent as Needs you", async ({ page, request }) => {
  test.skip(!(await (await request.get("/api/models")).json()).models.some((m: { id: string }) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  const create = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json();
    const id = session.id as string;
    made.push(id);
    return id;
  };
  const send = async (id: string, call: unknown) => expect((await request.post(`/api/sessions/${id}/messages`, { data: { text: script(call) } })).ok()).toBeTruthy();
  const pending = async (id: string) => (await (await request.get(`/api/sessions/${id}/questions`)).json()).pending as string[];
  const waiting = (id: string) => expect.poll(() => pending(id)).toHaveLength(1);
  const row = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
  const pane = page.getByTestId("station-word");
  const card = page.getByTestId("question");
  const loaded = new Set<string>();
  page.on("request", (r) => {
    const m = new URL(r.url()).pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (r.method() === "GET" && m) loaded.add(m[1]!);
  });
  try {
    const other = await create("Other session");
    const asker = await create("Pick an accent color");
    await send(asker, question);
    await waiting(asker);
    await page.goto(`/s/${other}`);
    await expect(row(asker).getByTestId("row-state")).toHaveText("Needs you");
    await expect(pane).not.toHaveText("Needs you");
    expect(loaded.has(asker)).toBe(false);
    await shoot(page, "pending-questions-01-unopened");

    // Reading its notification does not answer the question.
    expect((await request.post("/api/alerts/read", { data: { session_id: asker } })).ok()).toBeTruthy();
    await expect(row(asker)).not.toHaveAttribute("data-unread", "true");
    await expect(row(asker).getByTestId("row-state")).toHaveText("Needs you");

    await page.getByTestId("rail-toggle").click();
    await expect(row(asker)).toHaveAttribute("data-watch", "need");
    await row(asker).hover();
    await expect(page.getByTestId("rail-card")).toContainText("Needs you");
    await shoot(page, "pending-questions-02-rail");
    await row(asker).click();
    await expect(pane).toHaveText("Needs you");
    await expect(card).toHaveAttribute("data-state", "open");
    await page.getByTestId("rail-toggle").click();
    await shoot(page, "pending-questions-03-pane");
    await card.getByRole("radio", { name: "Amber" }).click();
    await card.getByTestId("question-submit").click();
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(row(asker)).toHaveAttribute("data-watch", "done");
    await expect(pane).toHaveText("Done");

    // A second question streams in. Stopping the turn closes it, but keeps the transcript.
    await send(asker, question);
    await expect(pane).toHaveText("Needs you");
    await expect(card.last()).toHaveAttribute("data-state", "open");
    expect((await request.post(`/api/sessions/${asker}/interrupt`, { data: { by: "owner" } })).ok()).toBeTruthy();
    await expect(pane).toHaveText("Stopped");
    await expect(card.last()).toHaveAttribute("data-state", "closed");
    expect(await pending(asker)).toEqual([]);
    await page.reload();
    await expect(pane).toHaveText("Stopped");
    await expect(card.last()).toHaveAttribute("data-state", "closed");

    // A nested program may exit without waiting for a tool. Interactive
    // questions have to be top-level, where the owner can answer them.
    await request.put(`/api/sessions/${asker}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    await send(asker, { name: "run_code", input: { code: `
      const input = ${JSON.stringify(question.input)};
      void tools.AskUserQuestion(input).catch(() => {});
      try { await tools.AskUserQuestion(input); } catch (e) { console.log(e.message); }
    ` } });
    await expect(pane).toHaveText("Done");
    await expect(page.locator('[data-testid="tool-call"][data-tool="run_code"]')).toHaveAttribute("data-state", "ok");
    await expect.poll(async () => JSON.stringify((await (await request.get(`/api/sessions/${asker}`)).json()).events.filter((e: { kind: string }) => e.kind === "tool_result").at(-1))).toContain("Call it directly outside the program.");
    expect(await pending(asker)).toEqual([]);

    const parent = await create("Parent with a question from an agent");
    await request.put(`/api/sessions/${parent}/permissions`, { data: { mode: "full-auto" } });
    await send(parent, { name: "spawn_agent", input: { message: `Color helper\n${script(question)}` } });
    const agents = async () => (await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as { session_id: string }[];
    await expect.poll(async () => (await agents())[0]?.session_id).toBeTruthy();
    const child = (await agents())[0]!.session_id;
    await waiting(child);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${parent}`)).json()).running).toBe(false);
    await expect(row(parent).getByTestId("row-state")).toHaveText("Needs you");
    expect(loaded.has(parent)).toBe(false);
    await row(parent).click();
    await expect(pane).toHaveText("Needs you");
    const childLink = page.getByRole("button", { name: /Color helper.*needs you: a question/ });
    await expect(childLink).toBeVisible();
    // Under the agent's head, which says who asks, its question card has no head of its own.
    const asks = page.getByTestId("child-asks");
    await expect(asks.getByTestId("child-path")).toContainText("Color helper");
    await expect(asks.getByTestId("question")).toBeVisible();
    await expect(asks.getByTestId("question").getByTestId("question-from")).toHaveCount(0);
    await shoot(page, "pending-questions-04-child-wait");
    expect(loaded.has(child)).toBe(false);
    expect(await pending(parent)).toEqual([]);
    const [callId] = await pending(child);
    expect((await request.post(`/api/sessions/${child}/questions/${callId}`, { data: { answers: { "0": { picked: ["Teal"] } } } })).ok()).toBeTruthy();
    await expect(pane).not.toHaveText("Needs you");
    await expect(row(parent)).not.toHaveAttribute("data-watch", "need");
    await expect(childLink).toHaveCount(0);
  } finally {
    for (const id of made.reverse()) await request.delete(`/api/sessions/${id}`);
  }
});

test("peer questions survive old daemons and a browser-only reconnect", async ({ page, request, baseURL }) => {
  const old = process.env.KEEL_OLD_PEER_URL;
  const current = process.env.KEEL_PEER_URL;
  if (!old || !current || !baseURL) return test.skip(true, "set KEEL_OLD_PEER_URL and KEEL_PEER_URL to separate scripted scratch daemons");
  for (const root of ["", old, current]) {
    const { models } = await (await request.get(`${root}/api/models`)).json();
    test.skip(!models.some((m: { id: string }) => m.id === MODEL), "all three fixture daemons must run the scripted provider");
  }
  const add = async (here: string, there: string, name: string) => {
    const r = await request.post(`${here}/api/fleet/machines`, { data: { name, daemon_url: there } });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).id as string;
  };
  const create = async (peer: string, title: string) => {
    const { session } = await (await request.post(`${peer}/api/sessions`, { data: { model: MODEL, title } })).json();
    return session.id as string;
  };
  const pending = async (route: string) => (await (await request.get(`${route}/questions`)).json()).pending as string[];
  const send = async (peer: string, id: string) => expect((await request.post(`${peer}/api/sessions/${id}/messages`, { data: { text: script(question) } })).ok()).toBeTruthy();
  const fleetList = async (root: string) => (await (await request.get(`${root}/api/fleet`)).json()).machines as { id: string; questions?: { pending: { session_id: string }[] } }[];
  const row = (id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`);
  const card = page.getByTestId("question");
  const pane = page.getByTestId("station-word");
  let oldMachine = "", currentMachine = "", inboundMachine = "", oldSession = "", currentSession = "";
  let drop: (() => void) | undefined;
  let unblock: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  try {
    oldMachine = await add("", old, "older question peer");
    currentMachine = await add("", current, "current question peer");
    oldSession = await create(old, "Question on older Keel");
    currentSession = await create(current, "Question on current Keel");
    const compat = `/api/fleet/machines/${oldMachine}/api/sessions/${oldSession}`;
    await page.routeWebSocket("**/ws", async (ws) => {
      await hold;
      const server = ws.connectToServer();
      drop = () => { ws.close({ code: 1001 }); server.close({ code: 1001 }); };
    });
    await page.goto(`/s/${oldMachine}--${oldSession}`);
    await expect(pane).toHaveText("Not started");
    await send(old, oldSession);
    // Old peers do not send a global snapshot. The paired route still serves
    // their authoritative per-session pending IDs, including an empty list.
    await expect.poll(() => pending(compat)).toHaveLength(1);
    expect((await fleetList("")).find((m) => m.id === oldMachine)?.questions).toBeUndefined();
    await expect(card).toHaveAttribute("data-state", "open");
    await expect(pane).toHaveText("Needs you");
    await card.getByRole("radio", { name: "Teal" }).click();
    await card.getByTestId("question-submit").click();
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(pane).toHaveText("Done");
    expect(await pending(compat)).toEqual([]);

    const remote = `${currentMachine}--${currentSession}`;
    await row(remote).click();
    await expect(pane).toHaveText("Not started");
    await expect.poll(() => !!drop).toBe(true);
    hold = new Promise<void>((r) => (unblock = r));
    drop!();
    await send(current, currentSession);
    await expect.poll(async () => (await fleetList("")).find((m) => m.id === currentMachine)?.questions?.pending[0]?.session_id).toBe(currentSession);
    unblock!();
    await expect(pane).toHaveText("Needs you");
    await expect(card).toHaveAttribute("data-state", "open");

    // Direct browser access includes fleet question snapshots; an incoming
    // paired request may not read the snapshot local Keel got from a third daemon.
    await request.delete(`/api/fleet/machines/${oldMachine}`);
    oldMachine = "";
    inboundMachine = await add(old, baseURL, "question relay privacy");
    const { machines } = await (await request.get(`${old}/api/fleet/machines/${inboundMachine}/api/fleet`)).json();
    const viaPeer = (machines as Awaited<ReturnType<typeof fleetList>>).find((m) => m.id === currentMachine);
    expect(viaPeer).toBeDefined();
    expect(viaPeer?.questions).toBeUndefined();
    expect((await fleetList("")).find((m) => m.id === currentMachine)?.questions?.pending[0]?.session_id).toBe(currentSession);
    await card.getByRole("radio", { name: "Amber" }).click();
    await card.getByTestId("question-submit").click();
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(pane).toHaveText("Done");
  } finally {
    unblock?.();
    if (oldSession) await request.delete(`${old}/api/sessions/${oldSession}`);
    if (currentSession) await request.delete(`${current}/api/sessions/${currentSession}`);
    if (oldMachine) await request.delete(`/api/fleet/machines/${oldMachine}`);
    if (currentMachine) await request.delete(`/api/fleet/machines/${currentMachine}`);
    if (inboundMachine) await request.delete(`${old}/api/fleet/machines/${inboundMachine}`);
  }
});
