import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from "./isolate.ts";
import { calls, create, drop, folder, open, pane, row, scripted, settle } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a page costs what it shows. Its socket brings the whole stream (the
// reply as it is written, the stored events, what the turn is doing) only of
// the sessions it shows in a pane or a look; of every other session it brings
// what the list, the counts and the inbox show, one frame per change. A
// session that is opened is asked for from where its snapshot ended, so its
// transcript is whole at once; one that is left is still heard for a short
// time and then let go; a new socket is told again what the page shows. A
// pane's own session under a look is not drawn again until it shows. Agents
// that come and go, and alerts that arrive, cost the page no request.
test.use({ storageState: { cookies: [], origins: [] } });

const LINGER_MS = 20_000; // ui/src/lib/scope.ts

// Every frame of the page's socket, both ways, and a way to cut it.
type Tap = { got: any[]; sent: any[]; opened: number; cut: () => Promise<void> };
async function tap(page: Page): Promise<Tap> {
  let route: WebSocketRoute | undefined;
  const t: Tap = { got: [], sent: [], opened: 0, cut: async () => { await route?.close({ code: 4000, reason: "cut by the test" }); } };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    route = ws;
    t.opened++;
    ws.onMessage((m) => { try { t.sent.push({ socket: t.opened, ...JSON.parse(String(m)) }); } catch {} server.send(m); });
    server.onMessage((m) => { try { t.got.push(JSON.parse(String(m))); } catch {} ws.send(m); });
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
  // (the row, the count above the list, the inbox), each within a second of the daemon having it.
  await request.patch(`/api/sessions/${third}`, { data: { title: "Third: renamed while it works" } });
  await expect(row(page, third)).toContainText("Third: renamed while it works", { timeout: 1_000 });
  await request.post(`/api/sessions/${asker}/messages`, { data: { text: calls([question]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${asker}/questions`)).json()).pending.length, { timeout: 30_000 }).toBe(1);
  await expect(row(page, asker)).toHaveAttribute("data-watch", "need", { timeout: 1_000 });
  await expect(page.getByTestId("sum-need")).toContainText("1", { timeout: 1_000 });
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
