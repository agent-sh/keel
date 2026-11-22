import { expect, test, type Page } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exited, ownDaemon } from "./peer.ts";
import { HAIKU, SCRIPTED, shoot } from "./shots.ts";

// Feature: the page says what it knows to be true of its connection, and a
// session on another machine is followed like one here.
//
// 1. A network that goes silent closes nothing (a Wi-Fi change, a tunnel that
//    stalls). The page asks the daemon while it is quiet and, two asks
//    unanswered, says "not reachable" with since when: the band within six
//    seconds, the state words "as of HH:MM", the clocks stopped. The moment
//    the network is back it reads again what it holds and is right within a
//    second, with what happened in the silence (a finish, a question).
//    The asking is cheap: one small frame each way every two seconds while
//    the page is seen and quiet, nothing while it is hidden.
// 2. A session of another daemon that finishes or asks gets the unread mark,
//    the alert and the inbox row of a session here, once, on every page and
//    across a restart of that daemon. That daemon stopped: said above the
//    list (never below the fold), its sessions "as of HH:MM, offline", one
//    alert; started again: said, and the page is current.

const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
// A command that goes on until its gate file is there (at most 100 s).
const until = (gate: string) => ({ name: "Bash", input: { command: `i=0; until [ -f ${gate} ] || [ $i -ge 100 ]; do i=$((i+1)); sleep 1; done; echo released` } });
const question = { name: "AskUserQuestion", input: { questions: [{ header: "Jitter", question: "Full jitter or equal jitter?", options: [{ label: "Full" }, { label: "Equal" }], multiSelect: false }] } };
const row = (page: Page, id: string) => page.locator(`[data-testid="session-list"] [data-testid="session-row"][data-session="${id}"]`);
const after = (page: Page, id: string) => row(page, id).getByTestId("row-state").evaluate((el) => getComputedStyle(el, "::after").content);

test("connection truth: a network that goes silent is said within seconds, and the page is right a second after it is back", async ({ page, request }, info) => {
  test.skip(!SCRIPTED, "the scenario is scripted: a turn that ends and a question asked on cue");
  test.setTimeout(240_000);
  const tag = Date.now().toString(36);
  const gate = join(info.outputPath(), `gate-${tag}`);
  mkdirSync(info.outputPath(), { recursive: true });
  await request.post("/api/alerts/read", { data: {} });
  const make = async (title: string, text?: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    if (text) await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    return session.id as string;
  };
  const viewed = await make(`Viewed ${tag}`);
  const finisher = await make(`Finishes in the silence ${tag}`, `Work. ${script([until(gate)])}`);
  const asker = await make(`Asks in the silence ${tag}`);

  // The network between the page and the daemon, with a hand on it: in the
  // hole nothing passes either way and nothing closes; a socket opened in the
  // hole opens and stays silent. What the page sends is counted.
  const net = { hole: false, sent: [] as { at: number; bytes: number; text: string }[], got: [] as { at: number; bytes: number }[] };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (net.hole) return;
    const server = ws.connectToServer();
    ws.onMessage((m) => { if (net.hole) return; net.sent.push({ at: Date.now(), bytes: String(m).length, text: String(m) }); server.send(m); });
    server.onMessage((m) => { if (net.hole) return; net.got.push({ at: Date.now(), bytes: String(m).length }); ws.send(m); });
  });
  await page.route(/\/api\//, (route) => (net.hole ? route.abort("internetdisconnected") : route.fallback()));
  // The page's visibility, by hand: a hidden page must ask nothing.
  await page.addInitScript(() => {
    const w = window as unknown as { __hidden?: boolean };
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !!w.__hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (w.__hidden ? "hidden" : "visible") });
  });
  const hide = (hidden: boolean) => page.evaluate((h) => { (window as unknown as { __hidden?: boolean }).__hidden = h; document.dispatchEvent(new Event("visibilitychange")); }, hidden);

  await page.goto(`/s/${viewed}`);
  await expect(row(page, finisher)).toHaveAttribute("data-watch", "work", { timeout: 30_000 });
  await expect(row(page, asker)).toBeVisible();
  const logo = page.locator(".k-logo");
  await expect(logo).toHaveAttribute("title", "Connected to the daemon");
  await expect(page.getByTestId("daemon-away")).toHaveCount(0);

  // ---- the cost of knowing, on a quiet page: ten seconds seen, five hidden.
  await page.waitForTimeout(1500);
  const pings = (from: number, to: number) => net.sent.filter((f) => f.at >= from && f.at < to && f.text === '{"op":"ping"}');
  const a0 = Date.now();
  await page.waitForTimeout(10_000);
  const a1 = Date.now();
  const seen = pings(a0, a1);
  const all = net.sent.filter((f) => f.at >= a0 && f.at < a1);
  const back = net.got.filter((f) => f.at >= a0 && f.at < a1);
  // One ask every two seconds, answered each time; the work session's own frames are few.
  expect(seen.length).toBeGreaterThanOrEqual(3);
  expect(seen.length).toBeLessThanOrEqual(6);
  const perMinute = { asks: seen.length * 6, bytes_up: all.reduce((n, f) => n + f.bytes, 0) * 6, bytes_down: back.reduce((n, f) => n + f.bytes, 0) * 6 };
  await hide(true);
  await page.waitForTimeout(500);
  const h0 = Date.now();
  await page.waitForTimeout(5000);
  expect(pings(h0, Date.now())).toHaveLength(0);
  const v0 = Date.now();
  await hide(false);
  // Seen again: asked at once, not at the next beat.
  await expect.poll(() => pings(v0, Date.now()).length, { timeout: 1000, intervals: [50] }).toBeGreaterThanOrEqual(1);
  console.log(`CONNECTION-TRUTH cost per idle minute seen: ${JSON.stringify(perMinute)}; hidden: 0 asks in 5 s`);
  await page.waitForTimeout(1000);

  // ---- the silence.
  const clockBefore = await row(page, finisher).getByTestId("row-time").innerText();
  const t0 = Date.now();
  net.hole = true;
  const band = expect(page.getByTestId("daemon-away")).toBeVisible({ timeout: 6000 }).then(() => Date.now() - t0);
  // Meanwhile one session finishes and another asks.
  writeFileSync(gate, "go\n");
  await request.post(`/api/sessions/${asker}/messages`, { data: { text: `Ask. ${script([question])}` } });
  const saidAfter = await band;
  expect(saidAfter).toBeLessThanOrEqual(6000);
  // It says so, and since when; never "Connected".
  await expect(page.getByTestId("daemon-away")).toContainText(/Keel is not reachable since \d\d:\d\d/);
  await expect(logo).toHaveAttribute("title", "Reconnecting to the daemon");
  // The daemon knows what the page cannot: the page's rows are as of the last frame, and say so.
  await expect.poll(async () => {
    const st = (await (await request.get("/api/state")).json()).states as Record<string, { watch: string }>;
    return [st[finisher]?.watch, st[asker]?.watch];
  }, { timeout: 30_000 }).toEqual(["done", "need"]);
  await expect(row(page, finisher)).toHaveAttribute("data-watch", "work");
  await expect(row(page, asker)).not.toHaveAttribute("data-watch", "need");
  await expect(page.getByTestId("stale-marks")).toHaveAttribute("data-stale", "page");
  expect(await after(page, finisher)).toMatch(/as of \d\d:\d\d/);
  // The clocks stand still, where they were when the daemon was last heard.
  const c1 = await row(page, finisher).getByTestId("row-time").innerText();
  await page.waitForTimeout(2500);
  const c2 = await row(page, finisher).getByTestId("row-time").innerText();
  expect(c2).toBe(c1);
  await shoot(page, "connection-truth-01-silent");
  // Stale for the whole silence, and saying so the whole time.
  await page.waitForTimeout(Math.max(0, t0 + 12_000 - Date.now()));
  await expect(page.getByTestId("daemon-away")).toBeVisible();
  await expect(row(page, finisher)).toHaveAttribute("data-watch", "work");

  // ---- the network is back.
  const t1 = Date.now();
  net.hole = false;
  await Promise.all([
    expect(row(page, finisher)).toHaveAttribute("data-watch", "done", { timeout: 1000 }),
    expect(row(page, asker)).toHaveAttribute("data-watch", "need", { timeout: 1000 }),
  ]);
  const rightAfter = Date.now() - t1;
  console.log(`CONNECTION-TRUTH band ${saidAfter} ms after the silence began (clock ${clockBefore} then ${c1}); right ${rightAfter} ms after the network was back`);
  await expect(page.getByTestId("daemon-away")).toHaveCount(0);
  await expect(logo).toHaveAttribute("title", "Connected to the daemon");
  await expect(page.getByTestId("stale-marks")).toHaveCount(0);
  // What happened in the silence is all there: the finish's mark, the question's count.
  await expect(row(page, finisher)).toHaveAttribute("data-unread", "true");
  await expect(page.getByTestId("inbox-count")).toHaveText("2");
  await expect(page).toHaveTitle(/^\(1\) /);
  // And the page asks again, as before.
  const b0 = Date.now();
  await expect.poll(() => pings(b0, Date.now()).length, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  await shoot(page, "connection-truth-02-back");

  // ---- afterwards: the absence is in the activity list, once.
  await expect.poll(async () => {
    const { items } = await (await request.get("/api/activity?kind=daemon&limit=50")).json();
    return (items as { sub: string; text: string; ts: number }[]).filter((a) => a.sub === "connection" && a.ts >= t0).map((a) => a.text);
  }, { timeout: 10_000 }).toEqual([expect.stringMatching(/^A page did not hear Keel for 1\d s, from \d\d:\d\d:\d\d: its connection went silent$/)]);

  await request.post(`/api/sessions/${asker}/interrupt`);
});

test("connection truth: a session on another machine is followed like one here, and a machine out of reach is said", async ({ page, context, request }, info) => {
  test.skip(!SCRIPTED, "the scenario is scripted: a turn that ends and a question asked on cue");
  test.setTimeout(300_000);
  const tag = Date.now().toString(36);
  const dir = info.outputPath("far");
  const root = join(dir, "root");
  mkdirSync(root, { recursive: true });
  const gate = join(dir, `gate-${tag}`);
  await request.post("/api/alerts/read", { data: {} });

  // Another machine: a daemon of the spec's own, which it can stop and start again.
  let far = await ownDaemon(join(dir, "state"), 0, { KEEL_SERVER_NAME: "farbox" });
  const name = `farbox-${tag}`;
  let machine = "";
  try {
    machine = (await (await request.post("/api/fleet/machines", { data: { name, daemon_url: far.url, workspace_root: root } })).json()).id;
    await expect.poll(async () => (await (await request.get(`/api/fleet/machines/${machine}`)).json()).daemon?.state, { timeout: 20_000 }).toBe("linked");
    const there = async (path: string, data?: unknown, method = "POST") => (await request.fetch(`${far.url}${path}`, { method, data })).json();
    const { session } = await there("/api/sessions", { model: "scripted:stand-in", title: `Far work ${tag}`, workspace: root });
    await there(`/api/sessions/${session.id}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
    const id = `${machine}--${session.id}`;
    const mine = async () => ((await (await request.get("/api/alerts?limit=200")).json()).alerts as { kind: string; session_id: string | null; read: boolean; data?: any }[]).filter((a) => a.session_id === id);

    // The page is at home: nobody watches that session.
    await page.goto("/");
    await there(`/api/sessions/${session.id}/messages`, { text: `Work. ${script([until(gate)])}` });
    await expect(row(page, id)).toHaveAttribute("data-watch", "work", { timeout: 30_000 });
    await expect(page.getByTestId("inbox-count")).toHaveCount(0);

    // ---- it finishes: the mark, the alert, the inbox row, as for a session here.
    writeFileSync(gate, "go\n");
    await expect(row(page, id)).toHaveAttribute("data-watch", "done", { timeout: 30_000 });
    await expect(row(page, id)).toHaveAttribute("data-unread", "true", { timeout: 10_000 });
    await expect(page.getByTestId("inbox-count")).toHaveText("1");
    expect((await mine()).map((a) => [a.kind, a.read])).toEqual([["finished", false]]);
    // A second device sees the same one alert, and it stays one.
    const second = await context.newPage();
    await second.goto("/");
    await expect(second.getByTestId("inbox-count")).toHaveText("1", { timeout: 20_000 });
    await expect(row(second, id)).toHaveAttribute("data-unread", "true");
    expect(await mine()).toHaveLength(1);
    await page.getByTestId("inbox-button").click();
    // One row for it in the inbox (other specs' read rows may stand beside it).
    const item = page.getByTestId("inbox-item").filter({ hasText: `Far work ${tag}` });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("Finished");
    await expect(item).toHaveAttribute("data-unread", "true");
    await shoot(page, "connection-truth-03-far-finish");
    await page.keyboard.press("Escape");

    // ---- it asks: the row needs the owner, the title counts it, the alert is a question.
    await there(`/api/sessions/${session.id}/messages`, { text: `Ask. ${script([question])}` });
    await expect(row(page, id)).toHaveAttribute("data-watch", "need", { timeout: 30_000 });
    await expect(page.getByTestId("inbox-count")).toHaveText("2", { timeout: 10_000 });
    await expect(page).toHaveTitle(/^\(1\) /);
    expect((await mine()).map((a) => a.kind).sort()).toEqual(["finished", "question"]);

    // ---- that machine's daemon stops: said above the list within seconds, at a laptop's size too.
    await page.setViewportSize({ width: 1440, height: 900 });
    const s0 = Date.now();
    far.proc.kill("SIGKILL");
    await exited(far.proc);
    const line = page.locator(`[data-testid="reach-item"][data-machine="${machine}"]`);
    await expect(line).toHaveAttribute("data-reach", "offline", { timeout: 8000 });
    const shownAfter = Date.now() - s0;
    await expect(line).toContainText(new RegExp(`${name} offline since \\d\\d:\\d\\d`));
    const box = (await line.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    // Its sessions' states say as of when, and that the machine is offline.
    await expect(page.getByTestId("stale-marks")).toHaveAttribute("data-stale", "machine");
    expect(await after(page, id)).toMatch(/as of \d\d:\d\d, offline/);
    await shoot(page, "connection-truth-04-far-offline-1440");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await shoot(page, "connection-truth-04-far-offline");
    // One alert says it, once it has stayed out a little while.
    const offline = async () => ((await (await request.get("/api/alerts?limit=200")).json()).alerts as { title: string; body: string; read: boolean; data?: any }[]).filter((a) => a.data?.machine_offline === machine);
    await expect.poll(async () => (await offline()).map((a) => [a.title, a.read]), { timeout: 40_000 }).toEqual([[`${name} is offline`, false]]);
    expect((await offline())[0]!.body).toMatch(/^Not heard from since \d\d:\d\d/);
    await expect(page.getByTestId("inbox-count")).toHaveText("3");

    // ---- it starts again, on the same state: said, the page is current, and nothing was told twice.
    const port = Number(new URL(far.url).port);
    far = await ownDaemon(join(dir, "state"), port, { KEEL_SERVER_NAME: "farbox" });
    await expect(line).toHaveAttribute("data-reach", "back", { timeout: 90_000 });
    await expect(line).toContainText(`${name} is back`);
    await shoot(page, "connection-truth-05-far-back");
    await expect(page.getByTestId("stale-marks")).toHaveCount(0);
    await expect(line).toHaveCount(0, { timeout: 15_000 });
    // Once it has stayed heard half a minute the absence is over: its alert is read, and it is one row of the activity list.
    await expect.poll(async () => (await offline()).map((a) => a.read), { timeout: 60_000 }).toEqual([true]);
    expect((await mine()).map((a) => a.kind).sort()).toEqual(["finished", "question"]);
    await expect.poll(async () => {
      const { items } = await (await request.get("/api/activity?kind=daemon&limit=50")).json();
      return (items as { sub: string; text: string }[]).filter((a) => a.sub === "machine" && a.text.startsWith(`${name} was out of reach for`)).length;
    }, { timeout: 10_000 }).toBe(1);
    console.log(`CONNECTION-TRUTH machine offline shown ${shownAfter} ms after its daemon stopped`);

    // ---- read here is read there: opening the session reads its alerts on both daemons.
    await page.getByTestId("inbox-button").click();
    await page.getByTestId("inbox-item").filter({ hasText: `Far work ${tag}` }).filter({ hasText: "Finished" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/s/${id}`));
    await expect(row(page, id)).not.toHaveAttribute("data-unread", "true", { timeout: 10_000 });
    await expect.poll(async () => ((await (await request.get(`${far.url}/api/alerts?limit=50`)).json()).alerts as { kind: string; read: boolean }[]).filter((a) => a.kind === "finished").map((a) => a.read), { timeout: 10_000 }).toEqual([true]);
    await second.close();
  } finally {
    if (machine) await request.delete(`/api/fleet/machines/${machine}`).catch(() => {});
    far.proc.kill("SIGTERM");
    await exited(far.proc);
  }
});
