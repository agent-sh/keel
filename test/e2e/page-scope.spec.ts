import { expect, test, type APIRequestContext, type Locator, type Page, type WebSocketRoute } from "./isolate.ts";
import { calls, create, drop, folder, open, pane, row, scripted, settle } from "./answering.ts";
import { shoot, WORKBENCH } from "./shots.ts";

// Feature: a page costs what it shows. Its socket brings the whole stream (the
// reply as it is written, the stored events, what the turn is doing) only of
// the sessions it shows in a pane or a look; of every other session it brings
// what the list, the counts and the inbox show, one frame per change. A
// session that is opened is asked for from where its snapshot ended, so its
// transcript is whole at once; one that is left is still heard for a short
// time and then let go; a new socket is told again what the page shows. A
// pane's own session under a look is not drawn again until it shows. Agents
// that come and go, and alerts that arrive, cost the page no request.
test.use({ storageState: WORKBENCH });

const LINGER_MS = 20_000; // ui/src/lib/scope.ts

// Every frame of the page's socket, both ways, and a way to cut it.
// `earlier`: the page speaks to the daemon as a tab of an earlier build does (one that was open
// when the daemon was restarted into this build): its resume names the sessions it holds and says
// nothing of `only`, and it never asks for one more session or lets one go.
type Tap = { got: any[]; sent: any[]; replayed: number[]; opened: number; cut: () => Promise<void> };
async function tap(page: Page, earlier = false): Promise<Tap> {
  let route: WebSocketRoute | undefined;
  const t: Tap = { got: [], sent: [], replayed: [], opened: 0, cut: async () => { await route?.close({ code: 4000, reason: "cut by the test" }); } };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    route = ws;
    const socket = ++t.opened;
    ws.onMessage((m) => {
      let f: any;
      try { f = JSON.parse(String(m)); } catch { return void server.send(m); }
      if (earlier && (f.op === "sub" || f.op === "unsub")) return;
      if (earlier && f.op === "resume") f = { op: "resume", cursors: f.cursors };
      t.sent.push({ socket, ...f });
      server.send(earlier ? JSON.stringify(f) : m);
    });
    server.onMessage((m) => {
      try {
        const f = JSON.parse(String(m));
        t.got.push(f);
        if (f.t === "replayed") t.replayed.push(socket);
      } catch {}
      ws.send(m);
    });
  });
  return t;
}
const sessionOf = (f: any): string | undefined => f.session_id ?? f.event?.session_id ?? f.session?.id;
// How many frames of a kind came for a session, from the `from`th frame on.
const count = (t: Tap, kind: string, id: string, from = 0) => t.got.slice(from).filter((f) => f.t === kind && sessionOf(f) === id).length;

// A reply that streams for about `seconds`: ten parts a second.
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ");
const stream = (request: APIRequestContext, id: string, seconds: number) =>
  request.post(`/api/sessions/${id}/messages`, { data: { text: `script:say ${words(Math.round((seconds * 10 * 40) / 6))}\nscript:pace 100` } });
const WHOLE = words(9000);
const question = { name: "AskUserQuestion", input: { questions: [{ header: "Order", question: "Which item goes first?", options: [{ label: "The importer" }, { label: "The release branch" }], multiSelect: false }] } };

test("a page hears the whole stream of the session it shows, and of the others what the list shows", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await request.post("/api/alerts/read", { data: { all: true } });
  const ws = folder("page-scope-one");
  const shown = await create(request, "Shown: the importer", ws);
  const other = await create(request, "Other: the release notes", ws);
  const third = await create(request, "Third: the flaky test", ws);
  const asker = await create(request, "Asker: the standup", ws);
  const t = await tap(page);
  const reads: string[] = [];
  page.on("request", (r) => { if (r.method() === "GET") reads.push(new URL(r.url()).pathname); });
  await page.goto(`/s/${shown}`);
  await expect(pane(page, shown).getByTestId("composer")).toBeVisible();
  for (const id of [shown, other, third]) await stream(request, id, 60);
  await expect(pane(page, shown).getByTestId("draft")).toContainText("w0005", { timeout: 20_000 });
  for (const id of [other, third]) await expect(row(page, id)).toHaveAttribute("data-watch", "work");
  const from = t.got.length;
  const alertReads = reads.filter((p) => p === "/api/alerts").length;
  await page.waitForTimeout(3_000);

  // The shown session streams here; of the two others not one delta, event or status came.
  expect(count(t, "delta", shown, from)).toBeGreaterThan(15);
  for (const id of [other, third]) {
    expect(count(t, "delta", id), `deltas of a session that is not shown`).toBe(0);
    expect(count(t, "event", id), `events of a session that is not shown`).toBe(0);
    expect(count(t, "status", id), `status of a session that is not shown`).toBe(0);
  }
  // In all: under 30 frames a second with three sessions streaming (one of them here).
  expect(t.got.length - from).toBeLessThan(90);
  await shoot(page, "page-scope-01-one-shown");

  // What the list shows of the others is as fresh as before: a new title, a question that waits
  // (the row, the tab's title, the inbox), each within a second of the daemon having it.
  await request.patch(`/api/sessions/${third}`, { data: { title: "Third: renamed while it works" } });
  await expect(row(page, third)).toContainText("Third: renamed while it works", { timeout: 1_000 });
  await request.post(`/api/sessions/${asker}/messages`, { data: { text: calls([question]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${asker}/questions`)).json()).pending.length, { timeout: 30_000 }).toBe(1);
  await expect(row(page, asker)).toHaveAttribute("data-watch", "need", { timeout: 1_000 });
  await expect(page).toHaveTitle(/^\(1\) /, { timeout: 1_000 });
  await expect(row(page, asker)).toHaveAttribute("data-unread", "true", { timeout: 1_000 });
  await expect(page.getByTestId("inbox-count")).toHaveText("1", { timeout: 1_000 });
  // The alert came by its frame, with the counts: the list of alerts was not read for it.
  await page.waitForTimeout(500);
  expect(reads.filter((p) => p === "/api/alerts").length - alertReads).toBe(0);
  await shoot(page, "page-scope-02-another-asks");

  // Opening one of the others: its transcript is whole at once (the prompt, the reply so far),
  // and its stream comes from there on, asked for from where the snapshot ended.
  const before = t.got.length;
  await row(page, other).click();
  await expect(pane(page, other).getByTestId("draft")).toContainText("w0000 w0001 w0002", { timeout: 5_000 });
  const first = (await pane(page, other).getByTestId("draft").innerText()).length;
  await expect.poll(() => count(t, "delta", other, before), { timeout: 5_000 }).toBeGreaterThan(5);
  expect(t.sent.some((m) => m.op === "sub" && m.cursors && other in m.cursors)).toBe(true);
  await expect.poll(async () => (await pane(page, other).getByTestId("draft").innerText()).length, { timeout: 5_000 }).toBeGreaterThan(first);
  // No part of the reply is missing or twice: the draft is the start of what was asked for.
  const text = (await pane(page, other).getByTestId("draft").innerText()).replace(/\s+/g, " ").trim();
  expect(WHOLE.startsWith(text.slice(0, -8))).toBe(true);
  await drop(request, shown, other, third, asker);
});

test("four panes get four streams, a look gets its own until it is left, and a new socket is told again", async ({ page, request }) => {
  test.setTimeout(150_000);
  await scripted(request);
  await settle(request);
  const ws = folder("page-scope-panes");
  const panes: string[] = [];
  for (const title of ["Pane one", "Pane two", "Pane three", "Pane four"]) panes.push(await create(request, title, ws));
  const looked = await create(request, "Looked at for a moment", ws);
  const never = await create(request, "Never on screen", ws);
  const t = await tap(page);
  await open(page, panes);
  for (const id of [...panes, looked, never]) await stream(request, id, 110);
  for (const id of panes) await expect(pane(page, id).getByTestId("draft")).toContainText("w0005", { timeout: 30_000 });
  let from = t.got.length;
  await page.waitForTimeout(2_500);
  for (const id of panes) expect(count(t, "delta", id, from), "a pane's stream").toBeGreaterThan(10);
  for (const id of [looked, never]) expect(count(t, "delta", id), "a session in no pane").toBe(0);

  // A look over the first pane: its stream comes, and the pane's own session under it is not drawn again.
  await row(page, looked).click();
  const slot0 = page.getByTestId("bridge").locator(':scope > [data-slot="0"]');
  await expect(slot0).toHaveAttribute("data-look", "");
  await expect(slot0.locator('[data-view="look"]').getByTestId("draft")).toContainText("w0005", { timeout: 10_000 });
  from = t.got.length;
  const under = slot0.locator('[data-view="own"]');
  const drawn = () => under.evaluate((el) => el.innerHTML.length);
  const covered = await drawn();
  await page.waitForTimeout(2_500);
  expect(count(t, "delta", looked, from), "the look's stream").toBeGreaterThan(10);
  expect(count(t, "delta", panes[0]!, from), "the covered pane is still heard").toBeGreaterThan(10);
  expect(await drawn(), "the covered pane was drawn again").toBe(covered);
  await shoot(page, "page-scope-03-look-over-a-pane");

  // Back from the look: the pane shows its session as it is now, at once.
  const was = (await under.getByTestId("draft").innerText()).length;
  await page.keyboard.press("Escape");
  await expect(slot0).not.toHaveAttribute("data-look", "");
  await expect.poll(async () => (await pane(page, panes[0]!).getByTestId("draft").innerText()).length, { timeout: 1_000 }).toBeGreaterThan(was + 200);
  // The session that was looked at is heard a little longer, then the daemon is told to stop.
  expect(t.sent.some((m) => m.op === "unsub")).toBe(false);
  await expect.poll(() => t.sent.some((m) => m.op === "unsub" && m.watch?.includes(looked)), { timeout: LINGER_MS + 8_000, intervals: [500] }).toBe(true);
  await page.waitForTimeout(500); // what was on its way
  from = t.got.length;
  await page.waitForTimeout(2_000);
  expect(count(t, "delta", looked, from), "a look that was left").toBe(0);
  for (const id of panes) expect(count(t, "delta", id, from), "a pane's stream").toBeGreaterThan(8);

  // The socket is cut: the next one is told the four panes first, and their streams go on.
  await t.cut();
  await expect.poll(() => t.opened, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => t.sent.find((m) => m.socket === 2)?.op, { timeout: 10_000 }).toBe("resume");
  const resume = t.sent.find((m) => m.socket === 2)!;
  expect(Object.keys(resume.cursors).sort()).toEqual([...panes].sort());
  await expect.poll(() => t.got.some((f, i) => i > from && f.t === "replayed"), { timeout: 10_000 }).toBe(true);
  from = t.got.length;
  await page.waitForTimeout(2_500);
  for (const id of panes) expect(count(t, "delta", id, from), "a pane's stream after the reconnect").toBeGreaterThan(8);
  for (const id of [looked, never]) expect(count(t, "delta", id, from), "a session in no pane, after the reconnect").toBe(0);
  // Each pane's reply is whole: what it shows is the start of what was asked for.
  for (const id of panes) {
    const text = (await pane(page, id).getByTestId("draft").innerText()).replace(/\s+/g, " ").trim();
    expect(text.length).toBeGreaterThan(400);
    expect(WHOLE.startsWith(text.slice(0, -8)), `the reply in ${id}`).toBe(true);
  }
  await drop(request, ...panes, looked, never);
});

test("agents that come and go cost the page no request", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("page-scope-agents");
  const parent = await create(request, "Coordinator of three", ws);
  await request.put(`/api/sessions/${parent}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const reads: string[] = [];
  page.on("request", (r) => reads.push(new URL(r.url()).pathname));
  await page.goto(`/s/${parent}`);
  await expect(pane(page, parent).getByTestId("composer")).toBeVisible();
  const spawn = (i: number) => ({ name: "spawn_agent", input: { message: `Lane ${i}\n${calls([{ name: "Bash", input: { command: `echo lane-${i}; sleep 1` } }])}`, isolation: "none" } });
  await request.post(`/api/sessions/${parent}/messages`, { data: { text: `Run three lanes\n${calls([spawn(1), spawn(2), spawn(3), { name: "wait_agent", input: { timeout_ms: 60_000 } }])}` } });
  const kids = async () => ((await (await request.get("/api/sessions")).json()).sessions as { id: string; parent_id?: string }[]).filter((s) => s.parent_id === parent).map((s) => s.id);
  await expect.poll(async () => (await kids()).length, { timeout: 30_000 }).toBe(3);
  await expect.poll(async () => ((await (await request.get("/api/automation")).json()).agents as { parent_id: string; status: string }[]).filter((a) => a.parent_id === parent && (a.status === "running" || a.status === "waiting")).length, { timeout: 60_000 }).toBe(0);
  await page.waitForTimeout(500);
  const children = await kids();
  // Their cards would have come by frames: nothing was read for an agent that asked nothing.
  expect(reads.filter((p) => children.some((id) => p === `/api/sessions/${id}/approvals` || p === `/api/sessions/${id}/permissions`))).toEqual([]);
  await drop(request, parent);
});

// The words of a reply as the page shows them, in order.
const shownWords = (page: Page, id: string) => pane(page, id).getByTestId("draft").innerText().then((t) => t.match(/w\d{4}/g) ?? [], () => [] as string[]);
const inOrder = (list: string[]) => list.every((w, i) => w === `w${String(i).padStart(4, "0")}`);

test("a tab of an earlier build draws a streaming reply once", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("page-scope-earlier");
  const shown = await create(request, "Shown by an earlier build", ws);
  const other = await create(request, "Another one at work", ws);
  await request.post(`/api/sessions/${shown}/messages`, { data: { text: "script:say A first short turn." } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${shown}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
  const t = await tap(page, true);
  await page.goto(`/s/${shown}`);
  await expect(pane(page, shown).getByTestId("assistant-text").last()).toHaveText("A first short turn.");
  // The snapshot can draw the reply before the first socket finishes its replay.
  await expect.poll(() => t.replayed, { timeout: 15_000 }).toEqual([1]);
  // Its socket opens again (the daemon was restarted under it): the resume names the session it holds, with no `only`.
  await t.cut();
  await expect.poll(() => t.opened, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => t.sent.find((m) => m.socket === 2 && m.op === "resume"), { timeout: 10_000 }).toEqual({ socket: 2, op: "resume", cursors: { [shown]: expect.any(Number) } });
  await expect.poll(() => t.replayed, { timeout: 10_000 }).toEqual([1, 2]);
  const from = t.got.length;
  await stream(request, shown, 12);
  await stream(request, other, 12);
  // Sampled while it streams: the words stand once each, in order. (Sent twice, the reply read "w0000 w0001 w0000 w0001".)
  let samples = 0;
  const doubled: string[] = [];
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(150);
    const words = await shownWords(page, shown);
    if (!words.length) continue;
    samples++;
    if (!inOrder(words)) doubled.push(words.slice(0, 8).join(" "));
  }
  expect(samples).toBeGreaterThan(20);
  expect(doubled, "the reply as it streamed").toEqual([]);
  // It hears every session, as it always did: each frame once.
  const seqs = t.got.slice(from).filter((f) => f.t === "event" && f.event.session_id === shown).map((f) => f.event.seq);
  expect(seqs.length).toBeGreaterThan(0);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(count(t, "delta", other, from)).toBeGreaterThan(10);
  await expect(row(page, other)).toHaveAttribute("data-watch", "work");
  // And the stored reply is the one it drew.
  await expect(pane(page, shown).getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
  const said = (await pane(page, shown).getByTestId("assistant-text").last().innerText()).match(/w\d{4}/g) ?? [];
  expect(said.length).toBeGreaterThan(100);
  expect(inOrder(said)).toBe(true);
  await drop(request, shown, other);
});

test("a pane read far up keeps its place under a look while its session works on", async ({ page, request }) => {
  test.setTimeout(300_000);
  await scripted(request);
  await settle(request);
  const ws = folder("page-scope-place");
  const reader = await create(request, "Read far above its end", ws);
  const beside = await create(request, "The pane beside it", ws);
  const looked = await create(request, "Looked at meanwhile", ws);
  await request.put(`/api/sessions/${reader}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const rows = (from: number, n: number) => calls(Array.from({ length: n }, (_, i) => ({ name: "Bash", input: { command: `echo row-${String(from + i).padStart(4, "0")}` } })));
  const idle = () => expect.poll(async () => (await (await request.get(`/api/sessions/${reader}?events=0`)).json()).session.phase, { timeout: 120_000, intervals: [500] }).not.toBe("working");
  const send = async (from: number, n: number) => {
    const reply = await request.post(`/api/sessions/${reader}/messages`, { data: { text: rows(from, n) } });
    expect(reply.ok()).toBe(true);
    const { event } = await reply.json() as { event: { id: string } };
    await idle();
    return event.id;
  };
  // A long session: more than the page holds of one that nobody reads (three turns of ninety calls).
  const ids: string[] = [];
  for (let turn = 0; turn < 3; turn++) ids.push(await send(turn * 90, 90));
  await request.post(`/api/sessions/${looked}/messages`, { data: { text: "script:say The other one." } });
  await open(page, [reader, beside]);
  // Go back to the first prompt (reading older parts), then forward one. The place is a
  // particular prompt, not a pixel distance that depends on how many work lines are folded.
  const p = pane(page, reader);
  const prompt = (n: number) => p.locator(`[data-testid="user-message"][data-event-id="${ids[n - 1]}"]`);
  await expect(p.getByTestId("load-earlier")).toBeAttached();
  for (const n of [3, 2, 1]) {
    await page.keyboard.press("Alt+ArrowUp");
    await expect(p.getByTestId("prompt-place")).toHaveText(`Prompt ${n} of 3`, { timeout: 15_000 });
    await expect(prompt(n)).toBeFocused();
  }
  await page.keyboard.press("Alt+ArrowDown");
  await expect(p.getByTestId("prompt-place")).toHaveText("Prompt 2 of 3");
  const marker = prompt(2);
  await expect(marker).toBeFocused();
  await expect(marker).toBeInViewport();
  const offset = () => marker.evaluate((el) => el.getBoundingClientRect().top - el.closest(".k-reading")!.getBoundingClientRect().top);
  const before = await offset();
  await expect(p.getByTestId("jump-latest")).toHaveText("Latest");

  // A look at another session, and the session under it takes three more steps.
  await row(page, looked).click();
  const slot0 = page.getByTestId("bridge").locator(':scope > [data-slot="0"]');
  await expect(slot0).toHaveAttribute("data-look", "");
  const next = await send(900, 3);
  await slot0.getByTestId("look-back").click();
  await expect(slot0).not.toHaveAttribute("data-look", "");
  // The same prompt at the same place, and nothing above it was let go.
  await expect(p.locator(`[data-event-id="${next}"]`)).toBeAttached();
  await expect(marker).toBeInViewport();
  await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThan(4);
  await expect(p.locator(`[data-event-id="${ids[0]}"]`)).toBeAttached();
  await expect(p.getByTestId("load-earlier")).toHaveCount(0);
  await shoot(page, "page-scope-04-place-kept-under-a-look");
  await drop(request, reader, beside, looked);
});

// A session opened as its turn goes on. Its snapshot is read, its turn moves on, and the session's
// row (with the head the turn reached) comes by the socket before the snapshot is in the page: the
// page then holds a part of the branch that does not reach the head it was told. Its transcript is
// drawn from that part, and is whole once the rest is in: by the stream the page asks for from
// the snapshot's end, or, when that stream does not bring it, by a read of the end its row names.
// The page's ask for the stream waits until the test lets it go.
async function lateSnapshot(page: Page, request: APIRequestContext, title: string) {
  await scripted(request);
  await settle(request);
  const id = await create(request, title, folder("page-scope-late"));
  const ends = async () => (((await (await request.get(`/api/sessions/${id}`)).json()).events ?? []) as { kind: string }[]).filter((e) => e.kind === "turn_end").length;
  await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say The first answer." } });
  await expect.poll(ends, { timeout: 30_000 }).toBe(1);
  const rows: { head: string | null }[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let asked = false;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      let f: any;
      try { f = JSON.parse(String(m)); } catch { return void server.send(m); }
      if (f.op === "sub" && f.cursors && id in f.cursors) { asked = true; void held.then(() => server.send(m)); return; }
      server.send(m);
    });
    server.onMessage((m) => {
      try { const f = JSON.parse(String(m)); if (f.t === "session" && f.session?.id === id) rows.push(f.session); } catch {}
      ws.send(m);
    });
  });
  // The snapshot is read at once, and reaches the page only after the second turn ended and its row came.
  await page.route(new RegExp(`/api/sessions/${id}\\?page=`), async (r) => {
    const res = await r.fetch();
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "echo second" } }]) } });
    await expect.poll(ends, { timeout: 30_000 }).toBe(2);
    const head = (await (await request.get(`/api/sessions/${id}?events=0`)).json()).session.head;
    await expect.poll(() => rows.some((s) => s.head === head), { timeout: 20_000 }).toBe(true);
    await r.fulfill({ response: res });
  });
  await page.goto(`/s/${id}`);
  const p = pane(page, id);
  // The snapshot is in the page, its stream asked for, and its transcript drawn before that stream comes.
  await expect.poll(() => asked, { timeout: 30_000 }).toBe(true);
  await expect(p.getByTestId("transcript")).toBeAttached();
  return { id, p, release };
}
async function whole(p: Locator, turns: number) {
  await expect(p.getByTestId("turn-end")).toHaveCount(turns, { timeout: 30_000 });
  await expect(p.getByTestId("user-message")).toHaveCount(turns);
  await expect(p.getByTestId("tool-call")).toHaveCount(1);
  await expect(p.getByText("No messages yet")).toHaveCount(0);
}

test("a session whose row came before its snapshot shows its whole transcript once its stream comes", async ({ page, request }) => {
  // Only the stream brings the rest here: the page's reads of a part of the session wait meanwhile.
  let reads!: () => void;
  const parts = new Promise<void>((r) => (reads = r));
  await page.route(/\/api\/sessions\/[^/]+\/page\?/, (r) => void parts.then(() => r.continue()));
  const { id, p, release } = await lateSnapshot(page, request, "Late snapshot: the importer");
  release();
  await whole(p, 2);
  reads();
  await shoot(page, "page-scope-05-late-snapshot-whole");
  // The stream goes on from there, with nothing twice.
  await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say The third answer." } });
  await whole(p, 3);
  await expect(p.getByTestId("assistant-text").last()).toContainText("The third answer.");
  await drop(request, id);
});

test("a session whose row came before its snapshot reads the end of its branch when its stream does not bring it", async ({ page, request }) => {
  const { id, p, release } = await lateSnapshot(page, request, "Late snapshot: the release notes");
  await whole(p, 2);
  // The stream, when it comes, adds nothing twice and goes on.
  release();
  await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say The third answer." } });
  await whole(p, 3);
  await expect(p.getByTestId("assistant-text").last()).toContainText("The third answer.");
  await drop(request, id);
});
