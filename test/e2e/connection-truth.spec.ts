import { expect, test, type Browser, type Page } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tcpLink } from "./link.ts";
import { exited, ownDaemon } from "./peer.ts";
import { HAIKU, SCRIPTED, shoot } from "./shots.ts";

// Feature: the page says what it knows to be true of its connection, and a
// session on another machine is followed like one here.
//
// 1. A network that goes silent closes nothing (a Wi-Fi change, a tunnel that
//    stalls). The page asks the daemon while it is quiet. Two asks unanswered:
//    slow to answer (the logo's tip). Three: "not reachable" with since when,
//    seven seconds after the last frame, the state words "as of HH:MM", the
//    clocks stopped. The moment the network is back it reads again what it
//    holds, and says its rows are from before until those reads are in.
//    The asking is cheap: one small frame each way every two seconds while
//    the page is seen and quiet, nothing while it is hidden.
// 2. The same over a link that kills the old socket for good and comes back
//    fast, slow (two seconds each way) or in between: the page reconnects in
//    each, stays connected, never says "Connected" over rows it has not read
//    again, and a message sent meanwhile waits in view and goes out once.
//    A daemon that answers nothing for four seconds is not a lost one.
//    A state says "as of" only while it is from before the loss: one the
//    daemon told since is current before the rest of the catch-up is in.
// 3. A daemon that is down (its port refuses) for twenty seconds to two
//    minutes and starts again on the same port: connected within seconds of
//    its first answer every time, with no socket made while it refused.
// 4. A session of another daemon that finishes or asks gets the unread mark,
//    the alert and the inbox row of a session here, once, on every page and
//    across a restart of that daemon. That daemon stopped: said in the list's
//    count without scrolling, its sessions "as of HH:MM", one alert; started
//    again: still out of reach until it has stayed heard, then gone. The
//    home view counts no session of a machine that does not answer. A link
//    between the daemons that died is heard again within seconds. A message
//    for a session there, or a new session, sent while Keel is not heard
//    stays in its box and goes out once when the owner sends it again.
// Nothing that is being read moves when any of it is said.

const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
// A command that goes on until its gate file is there (at most 100 s).
// `step`: a word the command begins with, so the row's line says which step it is.
const until = (gate: string, step = "") => ({ name: "Bash", input: { command: `${step ? `: ${step}; ` : ""}i=0; until [ -f ${gate} ] || [ $i -ge 100 ]; do i=$((i+1)); sleep 1; done; echo released` } });
const question = { name: "AskUserQuestion", input: { questions: [{ header: "Jitter", question: "Full jitter or equal jitter?", options: [{ label: "Full" }, { label: "Equal" }], multiSelect: false }] } };
const row = (page: Page, id: string) => page.locator(`[data-testid="session-list"] [data-testid="session-row"][data-session="${id}"]`);
const logo = (page: Page) => page.locator(".k-logo");
const top = async (page: Page, testid: string) => Math.round((await page.getByTestId(testid).first().boundingBox())!.y);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// What the page says of its link, as a log of changes with their times.
// `stale`: what the rows that say "as of" say (their reason); `fresh`: what the others say.
type Said = { t: number; band: boolean; sync: string | null; logo: string | null; asof: number; clock: string; stale: string; fresh: string };
const WATCH = `(() => {
  const w = window;
  if (w.__said) return;
  const log = w.__said = [];
  let last = "";
  const look = () => {
    const sync = document.querySelector('[data-testid="sync-state"]');
    const s = { band: !!document.querySelector('[data-testid="daemon-away"]'), sync: sync ? sync.textContent : null, logo: (document.querySelector(".k-logo") || { getAttribute: () => null }).getAttribute("title"),
      asof: document.querySelectorAll('[data-testid="row-asof"]').length, clock: [...document.querySelectorAll('[data-testid="row-time"][data-live]')].map((e) => e.textContent).join(","),
      stale: "", fresh: "" };
    for (const r of document.querySelectorAll('[data-testid="session-row"]')) {
      const why = (r.querySelector('[data-testid="row-why"]') || { textContent: "" }).textContent;
      const words = r.getAttribute("data-watch") + " " + why + " | ";
      if (r.querySelector('[data-testid="row-asof"]')) s.stale += words; else s.fresh += words;
    }
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    log.push({ t: Date.now(), ...s });
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  look();
})()`;
const said = (page: Page): Promise<Said[]> => page.evaluate(() => (window as unknown as { __said?: Said[] }).__said ?? []);

// The network between the page and the daemon, with a hand on it: in the
// hole nothing passes either way and nothing closes; a socket opened in the
// hole opens and stays silent. What the page sends is counted.
async function holeOn(page: Page) {
  const net = { hole: false, sent: [] as { at: number; bytes: number; text: string }[], got: [] as { at: number; bytes: number }[] };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (net.hole) return;
    const server = ws.connectToServer();
    ws.onMessage((m) => { if (net.hole) return; net.sent.push({ at: Date.now(), bytes: String(m).length, text: String(m) }); server.send(m); });
    server.onMessage((m) => { if (net.hole) return; net.got.push({ at: Date.now(), bytes: String(m).length }); ws.send(m); });
  });
  await page.route(/\/api\//, (route) => (net.hole ? route.abort("internetdisconnected") : route.fallback()));
  return net;
}

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

  const net = await holeOn(page);
  // The page's visibility, by hand: a hidden page must ask nothing.
  await page.addInitScript(() => {
    const w = window as unknown as { __hidden?: boolean };
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !!w.__hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (w.__hidden ? "hidden" : "visible") });
  });
  await page.addInitScript(WATCH);
  const hide = (hidden: boolean) => page.evaluate((h) => { (window as unknown as { __hidden?: boolean }).__hidden = h; document.dispatchEvent(new Event("visibilitychange")); }, hidden);

  await page.goto(`/s/${viewed}`);
  await expect(row(page, finisher)).toHaveAttribute("data-watch", "work", { timeout: 30_000 });
  await expect(row(page, asker)).toBeVisible();
  await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon");
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
  await page.waitForTimeout(2500);

  // ---- the silence. Where the list and the reading line stand now is where they stay.
  const listAt = await top(page, "session-list"), paneAt = await top(page, "station-head");
  const clockBefore = await row(page, finisher).getByTestId("row-time").innerText();
  const t0 = Date.now();
  net.hole = true;
  // Meanwhile one session finishes and another asks.
  writeFileSync(gate, "go\n");
  await request.post(`/api/sessions/${asker}/messages`, { data: { text: `Ask. ${script([question])}` } });
  // First the logo says the daemon is slow to answer; then, seven seconds after the last frame, the band.
  await expect(logo(page)).toHaveAttribute("title", "Keel is slow to answer", { timeout: 5500 });
  const slowAfter = Date.now() - t0;
  await expect(page.getByTestId("daemon-away")).toHaveCount(0);
  await expect(page.getByTestId("daemon-away")).toBeVisible({ timeout: 7500 - slowAfter });
  const saidAfter = Date.now() - t0;
  expect(saidAfter).toBeGreaterThanOrEqual(4500);
  // It says so, and since when; never "Connected". And it took no room: nothing moved.
  await expect(page.getByTestId("daemon-away")).toContainText(/Keel is not reachable since \d\d:\d\d/);
  await expect(logo(page)).toHaveAttribute("title", "Reconnecting to the daemon");
  expect([await top(page, "session-list"), await top(page, "station-head")]).toEqual([listAt, paneAt]);
  // The daemon knows what the page cannot: the page's rows are as of the last frame, and say so.
  await expect.poll(async () => {
    const st = (await (await request.get("/api/state")).json()).states as Record<string, { watch: string }>;
    return [st[finisher]?.watch, st[asker]?.watch];
  }, { timeout: 30_000 }).toEqual(["done", "need"]);
  await expect(row(page, finisher)).toHaveAttribute("data-watch", "work");
  await expect(row(page, asker)).not.toHaveAttribute("data-watch", "need");
  await expect(page.getByTestId("stale-marks")).toHaveAttribute("data-stale", "page");
  await expect(row(page, finisher).getByTestId("row-asof")).toHaveText(/^as of \d\d:\d\d$/);
  expect(await page.getByTestId("station-word").first().evaluate((el) => getComputedStyle(el, "::after").content)).toMatch(/as of \d\d:\d\d/);
  // The clocks stand still, where they were when the daemon was last heard.
  const c1 = await row(page, finisher).getByTestId("row-time").innerText();
  await page.waitForTimeout(2500);
  const c2 = await row(page, finisher).getByTestId("row-time").innerText();
  expect(c2).toBe(c1);
  await shoot(page, "connection-truth-01-silent");
  // Stale for the whole silence, and saying so the whole time.
  await page.waitForTimeout(Math.max(0, t0 + 14_000 - Date.now()));
  await expect(page.getByTestId("daemon-away")).toBeVisible();
  await expect(row(page, finisher)).toHaveAttribute("data-watch", "work");

  // ---- the network is back.
  const t1 = Date.now();
  net.hole = false;
  await Promise.all([
    expect(row(page, finisher)).toHaveAttribute("data-watch", "done", { timeout: 1500 }),
    expect(row(page, asker)).toHaveAttribute("data-watch", "need", { timeout: 1500 }),
  ]);
  const rightAfter = Date.now() - t1;
  console.log(`CONNECTION-TRUTH silent: slow word ${slowAfter} ms and band ${saidAfter} ms after the silence began (clock ${clockBefore} then ${c1}); right ${rightAfter} ms after the network was back`);
  await expect(page.getByTestId("daemon-away")).toHaveCount(0);
  await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon");
  await expect(page.getByTestId("stale-marks")).toHaveCount(0);
  await expect(page.getByTestId("row-asof")).toHaveCount(0);
  expect([await top(page, "session-list"), await top(page, "station-head")]).toEqual([listAt, paneAt]);
  // What happened in the silence is all there: the finish's mark, the question's count.
  await expect(row(page, finisher)).toHaveAttribute("data-unread", "true");
  await expect(page.getByTestId("inbox-count")).toHaveText("2");
  await expect(page).toHaveTitle(/^\(1\) /);
  // Never "Connected" over rows it had not read again: from the loss to the last "as of", the logo said something else.
  const log = (await said(page)).filter((e) => e.t >= t0 + saidAfter);
  const lastStale = log.findLast((e) => e.asof > 0)!.t;
  expect(log.filter((e) => e.t <= lastStale && e.logo === "Connected to the daemon")).toEqual([]);
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

// A daemon of the test's own behind a link the test can kill, hold and slow down.
async function behindLink(browser: Browser, dir: string, more: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  const d = await ownDaemon(join(dir, "state"), 0, more);
  const link = tcpLink(d.port);
  const url = await link.listen();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [{ origin: url, localStorage: [{ name: "keel.focus", value: "true" }] }] } });
  const page = await ctx.newPage();
  await page.addInitScript(WATCH);
  // The page's requests that have no answer yet, for the word of a failure.
  const out = new Map<unknown, string>();
  page.on("request", (r) => out.set(r, `${r.method()} ${new URL(r.url()).pathname} since ${new Date().toISOString().slice(14, 23)}`));
  page.on("requestfinished", (r) => out.delete(r));
  page.on("requestfailed", (r) => out.delete(r));
  const waiting = () => [...out.values()];
  const call = async (path: string, data?: unknown, method = "POST") => (await fetch(`${d.url}${path}`, { method, headers: data === undefined ? {} : { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) })).json() as Promise<any>;
  const make = async (title: string, text?: string) => {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
    if (text) await call(`/api/sessions/${session.id}/messages`, { text });
    return session.id as string;
  };
  const close = async () => { await ctx.close(); await link.close(); d.proc.kill("SIGTERM"); await exited(d.proc); };
  return { d, link, url, page, call, make, close, waiting };
}

test("connection truth: a dead socket is left behind over a fast link and a slow one, and nothing is claimed before it is read", async ({ browser }, info) => {
  test.setTimeout(420_000);
  const dir = info.outputPath("link");
  const { link, url, page, call, make, close, waiting } = await behindLink(browser, dir);
  try {
    const gate = (n: number) => join(dir, `gate-${n}`);
    const viewed = await make("Viewed over the link");
    const worker = await make("Works across the losses", `Work. ${script([until(gate(1), "step-1"), until(gate(2), "step-2"), until(gate(3), "step-3")])}`);
    await page.goto(`${url}/s/${viewed}`);
    await expect(row(page, worker)).toHaveAttribute("data-watch", "work", { timeout: 30_000 });
    await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon");
    await page.waitForTimeout(2500);
    const steps = async () => ((await call(`/api/sessions/${worker}`, undefined, "GET")).events as { kind: string }[]).filter((e) => e.kind === "tool_result").length;
    const stored = async (text: string) => ((await call(`/api/sessions/${viewed}`, undefined, "GET")).events as { kind: string; data: { text?: string } }[]).filter((e) => e.kind === "user" && e.data.text === text).length;

    // ---- the socket dies for good (a network that changed); ten seconds later the link is back, fast.
    let t0 = Date.now();
    link.set("dead");
    // A message sent before the page knows: it is on its way into a link that says nothing.
    await page.getByTestId("composer").fill("sent before the page knew");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("daemon-away")).toBeVisible({ timeout: 7500 });
    const band1 = Date.now() - t0;
    // Now the page knows: that message waits in view, and one sent now waits at once.
    const shelf = page.getByTestId("saved-draft");
    await expect(shelf).toHaveCount(1);
    await expect(shelf.first()).toHaveAttribute("data-state", "waiting");
    await page.getByTestId("composer").fill("sent while it was not reachable");
    await page.keyboard.press("Enter");
    await expect(shelf).toHaveCount(2, { timeout: 500 });
    await expect(shelf.nth(1)).toContainText("Waiting for Keel");
    await shoot(page, "connection-truth-06-waiting-sends");
    writeFileSync(gate(1), "go\n");
    await expect.poll(steps, { timeout: 20_000 }).toBe(1);
    await sleep(Math.max(0, t0 + 10_000 - Date.now()));
    let t1 = Date.now();
    link.set("pass");
    // Within a second and a half; when it is not, the requests the page still waits for say why.
    await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon", { timeout: 1500 }).catch((e) => { throw new Error(`${e.message}\nrequests out: ${waiting().join("; ")}`); });
    const fast = Date.now() - t1;
    await expect(page.getByTestId("daemon-away")).toHaveCount(0);
    // Both messages went out, once each, and the shelf is empty.
    await expect.poll(async () => [await stored("sent before the page knew"), await stored("sent while it was not reachable")], { timeout: 20_000 }).toEqual([1, 1]);
    await expect(shelf).toHaveCount(0, { timeout: 5000 });
    await page.waitForTimeout(1500);
    expect([await stored("sent before the page knew"), await stored("sent while it was not reachable")]).toEqual([1, 1]);
    console.log(`CONNECTION-TRUTH dead socket, fast link: band ${band1} ms after the link died; connected and caught up ${fast} ms after it was back`);

    // ---- the same, and the link comes back slow: 1.2 s each way. The page is heard at once on the
    // wire, but its reads take seconds: until they are in, it does not say "Connected", its rows
    // still say "as of", and their clocks do not run.
    await page.waitForTimeout(3000);
    t0 = Date.now();
    link.set("dead");
    await expect(page.getByTestId("daemon-away")).toBeVisible({ timeout: 7500 });
    writeFileSync(gate(2), "go\n");
    await expect.poll(steps, { timeout: 20_000 }).toBe(2);
    await sleep(Math.max(0, t0 + 10_000 - Date.now()));
    link.lag({ ms: 1200, jitter: 100 });
    t1 = Date.now();
    link.set("pass");
    await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon", { timeout: 40_000 }).catch(async (e) => { throw new Error(`${e.message}\nrequests out: ${waiting().join("; ")}\nsaid: ${JSON.stringify((await said(page)).filter((x) => x.t >= t1).map((x) => [x.t - t1, x.band, x.logo, x.sync]))}`); });
    const mid = Date.now() - t1;
    const log = (await said(page)).filter((e) => e.t >= t1);
    const caught = log.find((e) => e.logo === "Connected to the daemon")!;
    const catching = log.filter((e) => e.t < caught.t && !e.band);
    // It was catching up for a while (the band gone, the reads still out), and said so the whole time.
    expect(catching.length).toBeGreaterThan(0);
    expect(caught.t - catching[0]!.t).toBeGreaterThan(1500);
    expect(catching.map((e) => e.logo).filter((w) => w !== "Catching up with the daemon")).toEqual([]);
    // The rows say "as of" from the first frame on, and a row says it exactly while what it shows is
    // from before the loss: the step the worker began in the dead time (it waits for the third gate
    // now) never stands beside "as of", and the step from before never stands without it.
    expect(catching[0]!.asof).toBeGreaterThan(0);
    expect(catching.filter((e) => e.stale.includes("step-3") || e.fresh.includes("step-2")).map((e) => [e.stale, e.fresh])).toEqual([]);
    expect(catching.some((e) => e.stale.includes("step-2"))).toBe(true);
    // A clock that ran would have shown a new second each second; beside "as of" it changes at most when its state does.
    expect(new Set(catching.filter((e) => e.stale.includes("work")).map((e) => e.clock)).size).toBeLessThanOrEqual(2);
    expect(caught.asof).toBe(0);
    // Idle on that link it stays connected: an ask takes 2.4 s to be answered, and that is no loss.
    await page.waitForTimeout(20_000);
    expect((await said(page)).filter((e) => e.t > caught.t && (e.band || e.logo !== "Connected to the daemon"))).toEqual([]);
    console.log(`CONNECTION-TRUTH dead socket, 1.2 s each way: caught up ${mid} ms after the link was back, catching up for ${caught.t - catching[0]!.t} ms of it`);

    // ---- and slower: two seconds each way, where a try needs more than four seconds to be greeted.
    link.lag(null);
    await page.waitForTimeout(3000);
    t0 = Date.now();
    link.set("dead");
    // (The link was slow a moment ago, and the page still gives its asks that link's time.)
    await expect(page.getByTestId("daemon-away")).toBeVisible({ timeout: 25_000 });
    t0 = Date.now() - 7000;
    writeFileSync(gate(3), "go\n");
    await expect.poll(steps, { timeout: 20_000 }).toBe(3);
    await sleep(Math.max(0, t0 + 10_000 - Date.now()));
    const before = link.made();
    link.lag({ ms: 2000, jitter: 200 });
    t1 = Date.now();
    link.set("pass");
    // Heard again within the nine seconds a request waits its turn and two round trips, not never.
    await expect(page.getByTestId("daemon-away")).toHaveCount(0, { timeout: 25_000 });
    const heard = Date.now() - t1;
    await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon", { timeout: 60_000 });
    const slow = Date.now() - t1;
    await expect(row(page, worker)).toHaveAttribute("data-watch", "done", { timeout: 20_000 });
    // And it stays: thirty idle seconds with a round trip of four, no band and no second catch-up.
    const from = Date.now();
    await page.waitForTimeout(30_000);
    expect((await said(page)).filter((e) => e.t > from && (e.band || e.logo !== "Connected to the daemon"))).toEqual([]);
    console.log(`CONNECTION-TRUTH dead socket, 2 s each way: heard ${heard} ms and caught up ${slow} ms after the link was back (${link.made() - before} connections tried); connected 30 s later`);
  } finally {
    await close();
  }
});

test("connection truth: a daemon that answers nothing for four seconds is not a lost one", async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { d, url, page, make, close } = await behindLink(browser, info.outputPath("busy"));
  try {
    const viewed = await make("Viewed while the daemon is busy");
    await page.goto(`${url}/s/${viewed}`);
    await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon");
    await page.waitForTimeout(3000);
    const from = Date.now();
    // Stopped whole for four seconds, eight times, at moments that fall anywhere in the page's beat.
    for (let i = 0; i < 8; i++) {
      await sleep(1500 + ((i * 730) % 2000));
      d.proc.kill("SIGSTOP");
      await sleep(4000);
      d.proc.kill("SIGCONT");
    }
    await sleep(3000);
    const log = (await said(page)).filter((e) => e.t >= from);
    expect(log.filter((e) => e.band || e.asof > 0 || e.sync)).toEqual([]);
    // It was said to be slow, in the logo's tip, and nothing more.
    const slow = log.filter((e) => e.logo === "Keel is slow to answer").length;
    expect(log.map((e) => e.logo).filter((w) => w !== "Keel is slow to answer" && w !== "Connected to the daemon")).toEqual([]);
    await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon");
    // Ten seconds of nothing is a loss, said seven seconds after the last frame, and over the moment it answers.
    const t0 = Date.now();
    d.proc.kill("SIGSTOP");
    await expect(page.getByTestId("daemon-away")).toBeVisible({ timeout: 7500 });
    const band = Date.now() - t0;
    expect(band).toBeGreaterThanOrEqual(4500);
    // On a phone the band says it in the words that fit, whole.
    await page.setViewportSize({ width: 390, height: 844 });
    const words = page.getByTestId("daemon-away").locator("span").first();
    expect(await words.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const tab = (await page.getByTestId("daemon-away").boundingBox())!;
    expect(tab.x).toBeGreaterThanOrEqual(0);
    expect(tab.x + tab.width).toBeLessThanOrEqual(390);
    await shoot(page, "connection-truth-07-band-phone");
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(Math.max(0, t0 + 10_000 - Date.now()));
    d.proc.kill("SIGCONT");
    await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon", { timeout: 3000 });
    console.log(`CONNECTION-TRUTH busy daemon: 0 bands in 8 stops of 4 s (slow word ${slow} times); a stop of 10 s: band after ${band} ms`);
  } finally {
    d.proc.kill("SIGCONT");
    await close();
  }
});

// What the page makes to find the daemon, as a log in the page's own time: each socket (made,
// opened, first frame, closed, given up) and each request that asks whether the daemon answers.
type Made = { t: number; what: string; id?: number; after?: number };
const MADE = `(() => {
  const w = window;
  if (w.__made) return;
  const log = w.__made = [];
  const Real = w.WebSocket;
  let n = 0;
  w.WebSocket = function (url, protocols) {
    const id = ++n, born = Date.now();
    const ws = protocols === undefined ? new Real(url) : new Real(url, protocols);
    log.push({ t: born, what: "socket", id });
    let said = false;
    ws.addEventListener("message", () => { if (!said) { said = true; log.push({ t: Date.now(), what: "greeted", id, after: Date.now() - born }); } });
    ws.addEventListener("close", () => log.push({ t: Date.now(), what: "closed", id, after: Date.now() - born }));
    const close = ws.close.bind(ws);
    ws.close = (...a) => { if (ws.readyState < 2) log.push({ t: Date.now(), what: "given up", id, after: Date.now() - born }); return close(...a); };
    return ws;
  };
  w.WebSocket.prototype = Real.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) w.WebSocket[k] = Real[k];
  const real = w.fetch;
  w.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!String(url).includes("health?link")) return real(input, init);
    const sent = Date.now();
    log.push({ t: sent, what: "ask" });
    return real(input, init).then((r) => { log.push({ t: Date.now(), what: r.ok ? "answered" : "answered " + r.status, after: Date.now() - sent }); return r; }, (e) => { log.push({ t: Date.now(), what: "refused", after: Date.now() - sent }); throw e; });
  };
})()`;
const made = (page: Page): Promise<Made[]> => page.evaluate(() => (window as unknown as { __made?: Made[] }).__made ?? []);

// The reviewer's schedule, with no proxy: the daemon is killed and started again on the same
// port. While its port refuses, a browser counts every socket that fails, and after enough of
// them holds each new one back for seconds (Chrome: sixteen times more failed than opened in its
// window). A page that then gives a try up for the next answer never connects again: it stayed
// "Reconnecting" beside a daemon that answered, for as long as it was watched.
test("connection truth: a daemon that was down for twenty seconds to two minutes is found within seconds of its first answer", async ({ browser }, info) => {
  test.setTimeout(600_000);
  const state = join(info.outputPath("down"), "state");
  mkdirSync(state, { recursive: true });
  let d = await ownDaemon(state);
  const port = d.port;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(MADE);
  await page.addInitScript(WATCH);
  try {
    await page.goto(d.url);
    // (A daemon of the spec's own, just started: its first page reads from a cold store.)
    await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon", { timeout: 30_000 });
    await page.waitForTimeout(3000);
    const table: string[] = [];
    for (const down of [20, 60, 75, 120]) {
      d.proc.kill("SIGKILL");
      await exited(d.proc);
      const t0 = Date.now();
      await expect(page.getByTestId("daemon-away")).toBeVisible({ timeout: 3000 });
      await sleep(Math.max(0, t0 + down * 1000 - Date.now()));
      const t1 = Date.now();
      d = await ownDaemon(state, port);
      const up = Date.now();
      // Within ten seconds of the daemon's first answer; the bound here is from its listen line, which is earlier.
      await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon", { timeout: 10_000 }).catch(async (e) => {
        throw new Error(`${e.message}\ndown ${down} s; the page made: ${(await made(page)).filter((x) => x.t >= t1 - 3000).slice(0, 80).map((x) => `${x.t - up} ${x.what}${x.id ? ` #${x.id}` : ""}${x.after !== undefined ? ` +${x.after}` : ""}`).join(" | ")}`);
      });
      const connected = Date.now() - up;
      const log = await made(page);
      const during = log.filter((x) => x.t >= t0 && x.t < t1), after = log.filter((x) => x.t >= t1);
      const count = (list: Made[], what: string) => list.filter((x) => x.what === what).length;
      const first = after.find((x) => x.what === "answered");
      // While the port refused: requests asked, one each gap (half a second, then a sixtieth of the
      // absence), and no socket was made after the one that found it closed.
      const gaps = 60 + 60 * Math.log(Math.max(1, down / 30));
      expect([down, count(during, "socket") <= 1]).toEqual([down, true]);
      expect([down, count(during, "ask") <= gaps + 6]).toEqual([down, true]);
      expect([down, count(during, "ask") >= gaps / 2]).toEqual([down, true]);
      // After it was back: one socket, made on the first answer and greeted, not one an answer.
      expect([down, count(after, "socket"), count(after, "greeted"), count(after, "given up")]).toEqual([down, 1, 1, 0]);
      expect(first).toBeTruthy();
      table.push(`${down} s down: ${count(during, "socket")} sockets and ${count(during, "ask")} requests while it refused; first answer ${first!.t - up} ms after it listened, connected ${connected} ms after (1 socket)`);
      // And it stays, with nothing more asked by request.
      await page.waitForTimeout(4000);
      await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon");
      expect((await made(page)).filter((x) => x.t > up + connected && x.what !== "closed")).toEqual([]);
    }
    for (const line of table) console.log(`CONNECTION-TRUTH refused port, ${line}`);
  } finally {
    await ctx.close();
    d.proc.kill("SIGTERM");
    await exited(d.proc);
  }
});

test("connection truth: a session on another machine is followed like one here, and a machine out of reach is said", async ({ page, context, request }, info) => {
  test.skip(!SCRIPTED, "the scenario is scripted: a turn that ends and a question asked on cue");
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const dir = info.outputPath("far");
  const root = join(dir, "root");
  mkdirSync(root, { recursive: true });
  const gate = join(dir, `gate-${tag}`);
  await request.post("/api/alerts/read", { data: {} });

  // Another machine: a daemon of the spec's own, which it can stop and start again, behind a
  // link of the spec's own (the two daemons' network), which it can kill.
  let far = await ownDaemon(join(dir, "state"), 0, { KEEL_SERVER_NAME: "farbox" });
  const farLink = tcpLink(far.port);
  const farUrl = await farLink.listen();
  const name = `farbox-${tag}`;
  let machine = "";
  // This page's own network, with a hand on it.
  const net = await holeOn(page);
  try {
    machine = (await (await request.post("/api/fleet/machines", { data: { name, daemon_url: farUrl, workspace_root: root } })).json()).id;
    await expect.poll(async () => (await (await request.get(`/api/fleet/machines/${machine}`)).json()).daemon?.state, { timeout: 20_000 }).toBe("linked");
    const there = async (path: string, data?: unknown, method = "POST") => (await request.fetch(`${far.url}${path}`, { method, data })).json();
    const { session } = await there("/api/sessions", { model: "scripted:stand-in", title: `Far work ${tag}`, workspace: root });
    await there(`/api/sessions/${session.id}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
    const id = `${machine}--${session.id}`;
    type Kept = { kind: string; session_id: string | null; read: boolean; title: string; body: string; data?: any; machine?: { id: string; name: string } };
    const inbox = async () => (await (await request.get("/api/alerts?limit=200")).json()).alerts as Kept[];
    const mine = async () => (await inbox()).filter((a) => a.session_id === id);
    const rowAt = async () => Math.round((await row(page, id).boundingBox())!.y);

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
    expect((await mine()).map((a) => [a.kind, a.read, a.machine])).toEqual([["finished", false, { id: machine, name }]]);
    // A second device sees the same one alert, and it stays one.
    const second = await context.newPage();
    await second.goto("/");
    await expect(second.getByTestId("inbox-count")).toHaveText("1", { timeout: 20_000 });
    await expect(row(second, id)).toHaveAttribute("data-unread", "true");
    expect(await mine()).toHaveLength(1);
    await page.getByTestId("inbox-button").click();
    // One row for it in the inbox (other specs' read rows may stand beside it), and it names the machine.
    const item = page.getByTestId("inbox-item").filter({ hasText: `Far work ${tag}` });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("Done");
    await expect(item).toContainText(`Far work ${tag} on ${name}`);
    await expect(item).toHaveAttribute("data-unread", "true");
    await shoot(page, "connection-truth-03-far-finish");
    await page.keyboard.press("Escape");

    // ---- it asks: the row needs the owner, the title counts it, the alert is a question.
    await there(`/api/sessions/${session.id}/messages`, { text: `Ask. ${script([question])}` });
    await expect(row(page, id)).toHaveAttribute("data-watch", "need", { timeout: 30_000 });
    await expect(page.getByTestId("inbox-count")).toHaveText("2", { timeout: 10_000 });
    await expect(page).toHaveTitle(/^\(1\) /);
    expect((await mine()).map((a) => a.kind).sort()).toEqual(["finished", "question"]);

    // ---- that machine's daemon stops: said in the list's count within seconds, at a laptop's size
    // too, by the machine's name, and nothing in the list moves for it.
    await page.setViewportSize({ width: 1440, height: 900 });
    const listAt = await top(page, "session-list"), was = await rowAt();
    // The home view counts it among what needs the owner, and lists it.
    const needs = async () => ((await page.getByTestId("home-count-need").count()) ? Number((await page.getByTestId("home-count-need").innerText()).match(/\d+/)![0]) : 0);
    const home = page.locator(`[data-testid="home-session"][data-session="${id}"]`);
    await expect(home).toHaveAttribute("data-watch", "need");
    await expect(home.getByTestId("home-asof")).toHaveCount(0);
    const needed = await needs();
    expect(needed).toBeGreaterThanOrEqual(1);
    // The list's line and the tab's title count it too: the same number everywhere.
    const listed = async () => ((await page.getByTestId("sum-need").count()) ? Number((await page.getByTestId("sum-need").locator(".k-sum-n").innerText()).match(/\d+/)![0]) : 0);
    const titled = async () => Number((await page.title()).match(/^\((\d+)\) /)?.[1] ?? 0);
    expect([await listed(), await titled()]).toEqual([needed, needed]);
    const s0 = Date.now();
    far.proc.kill("SIGKILL");
    await exited(far.proc);
    const count = page.getByTestId("sum-offline");
    await expect(count).toBeVisible({ timeout: 8000 });
    const shownAfter = Date.now() - s0;
    await expect(count).toContainText(`${name} offline`);
    await expect(count).toHaveAttribute("title", new RegExp(`${name} since \\d\\d:\\d\\d`));
    const box = (await count.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    expect([await top(page, "session-list"), await rowAt()]).toEqual([listAt, was]);
    // Its sessions' rows say Offline, once, with as of when it last told (the list's own words for it).
    const lastTold = row(page, id).locator('[data-testid="row-why"][data-why="offline"]');
    await expect(lastTold).toHaveText(/^as of \d\d:\d\d$/);
    await expect(row(page, id).getByTestId("row-time")).toHaveText("Offline");
    await expect(row(page, id).getByTestId("row-time")).toHaveAttribute("title", /does not answer: this is the last it told/);
    expect(await row(page, id).evaluate((el) => (el as HTMLElement).innerText.match(/offline/gi)?.length)).toBe(1);
    // The home view does not count a session whose machine does not answer: its row stays, paled,
    // its mark still, saying as of when instead of how long ago.
    await expect.poll(needs).toBe(needed - 1);
    await expect(home.getByTestId("home-asof")).toHaveText(/^Offline, as of \d\d:\d\d$/);
    // Nothing can be answered there: the row's button only opens it, and does not lead.
    await expect(home.getByTestId("home-review")).toHaveText("Open");
    await expect(home.getByTestId("home-review")).toHaveAttribute("data-quiet", "true");
    // The list's line and the tab's title leave it out as well: it is counted as offline, once.
    await expect.poll(async () => [await listed(), await titled()]).toEqual([needed - 1, needed - 1]);
    expect(await home.locator(".k-home-row-mark").evaluate((el) => [getComputedStyle(el).opacity, getComputedStyle(el.querySelector(".k-mark")!).animationPlayState])).toEqual(["0.45", "paused"]);
    await shoot(page, "connection-truth-04-far-offline-1440");
    // One alert says it, once it has stayed out a little while: a notice of its own kind, in plain words.
    const offline = async () => (await inbox()).filter((a) => a.data?.machine_offline === machine);
    await expect.poll(async () => (await offline()).map((a) => [a.kind, a.title, a.read]), { timeout: 40_000 }).toEqual([["machine", `${name} is offline`, false]]);
    expect((await offline())[0]!.body).toMatch(new RegExp(`^${name} does not answer since \\d\\d:\\d\\d\\. Its sessions show as they were then\\.$`));
    await expect(page.getByTestId("inbox-count")).toHaveText("3");
    // A rename is followed in what was already said.
    await request.patch(`/api/fleet/machines/${machine}`, { data: { name: `${name}-b` } });
    expect((await offline())[0]!.title).toBe(`${name}-b is offline`);
    await request.patch(`/api/fleet/machines/${machine}`, { data: { name } });

    // ---- it starts again, on the same state. It is heard within seconds, and still shown out of
    // reach until it has stayed heard half a minute: a machine that comes and goes is said once.
    const port = Number(new URL(far.url).port);
    far = await ownDaemon(join(dir, "state"), port, { KEEL_SERVER_NAME: "farbox" });
    await expect.poll(async () => (await (await request.get(`/api/fleet/machines/${machine}`)).json()).state, { timeout: 60_000 }).toMatch(/ready|busy/);
    const heardAt = Date.now();
    await expect(count).toBeVisible();
    await expect(lastTold).toHaveCount(1);
    await expect(count).toHaveCount(0, { timeout: 60_000 });
    const held = Date.now() - heardAt;
    expect(held).toBeGreaterThan(20_000);
    await expect(lastTold).toHaveCount(0);
    await expect(row(page, id).getByTestId("row-time")).not.toHaveText("Offline");
    await expect.poll(async () => [await needs(), await listed(), await titled()]).toEqual([needed, needed, needed]);
    await expect(page.getByTestId("stale-marks")).toHaveCount(0);
    expect([await top(page, "session-list"), await rowAt()]).toEqual([listAt, was]);
    await page.setViewportSize({ width: 1920, height: 1040 });
    await shoot(page, "connection-truth-05-far-back");
    // The absence is over: its alert is read, it is one row of the activity list, and nothing was told twice.
    await expect.poll(async () => (await offline()).map((a) => a.read), { timeout: 20_000 }).toEqual([true]);
    // Its alert is taken back in place: it says the machine is back and after how long.
    expect((await offline())[0]!.title).toMatch(new RegExp(`^${name} is back after \\d+ (s|min)$`));
    expect((await mine()).map((a) => a.kind).sort()).toEqual(["finished", "question"]);
    await expect.poll(async () => {
      const { items } = await (await request.get("/api/activity?kind=daemon&limit=50")).json();
      return (items as { sub: string; text: string }[]).filter((a) => a.sub === "machine" && a.text.startsWith(`${name} was out of reach for`)).map((a) => /verbose|fetch\(\)|127\.0\.0\.1/.test(a.text));
    }, { timeout: 10_000 }).toEqual([false]);
    console.log(`CONNECTION-TRUTH machine: offline shown ${shownAfter} ms after its daemon stopped; held out of reach ${held} ms after it was heard again`);

    // ---- read here is read there: opening the session reads its alerts on both daemons.
    await page.getByTestId("inbox-button").click();
    await page.getByTestId("inbox-item").filter({ hasText: `Far work ${tag}` }).filter({ hasText: "Done" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/s/${id}`));
    await expect(row(page, id)).not.toHaveAttribute("data-unread", "true", { timeout: 10_000 });
    await expect.poll(async () => ((await (await request.get(`${far.url}/api/alerts?limit=50`)).json()).alerts as { kind: string; read: boolean }[]).filter((a) => a.kind === "finished").map((a) => a.read), { timeout: 10_000 }).toEqual([true]);
    await second.close();

    // ---- this page stops hearing its own daemon while it shows that session. A message for a
    // session of another machine, and a new session, are not sent into a link that is down (the
    // page cannot send them again by itself): each stays in its box with a word, and goes out
    // once when the owner sends it again.
    // (A session there that waits for nothing: the first one has a question open.)
    const { session: chat } = await there("/api/sessions", { model: "scripted:stand-in", title: `Far chat ${tag}`, workspace: root });
    await there(`/api/sessions/${chat.id}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
    const chatId = `${machine}--${chat.id}`;
    await row(page, chatId).click();
    await expect(page).toHaveURL(new RegExp(`/s/${chatId}`));
    const events = async () => ((await there(`/api/sessions/${chat.id}`, undefined, "GET")).events as { kind: string; data: { text?: string } }[]);
    const toFar = `For the other machine while Keel was not heard ${tag}`, fresh = `A new session while Keel was not heard ${tag}`;
    const sessions = async () => ((await (await request.get("/api/sessions")).json()).sessions as { id: string }[]).length;
    const had = await sessions();
    net.hole = true;
    await expect(page.getByTestId("daemon-away")).toBeVisible({ timeout: 9000 });
    await page.getByTestId("composer").fill(toFar);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("composer-notice")).toContainText("Not sent: Keel is not reachable");
    await expect(page.getByTestId("composer")).toHaveValue(toFar);
    await expect(page.getByTestId("saved-draft")).toHaveCount(0);
    await page.getByTestId("new-session").click();
    await expect(page.getByTestId("composer")).toHaveValue("");
    await page.getByTestId("composer").fill(fresh);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("composer-notice")).toContainText("Not sent: Keel is not reachable");
    await expect(page.getByTestId("composer")).toHaveValue(fresh);
    await shoot(page, "connection-truth-08-new-box-not-sent");
    await page.waitForTimeout(1500);
    expect([await sessions(), (await events()).filter((e) => e.data.text === toFar).length]).toEqual([had, 0]);
    // Keel is back: the same press sends each, once.
    net.hole = false;
    await expect(logo(page)).toHaveAttribute("title", "Connected to the daemon", { timeout: 5000 });
    await page.getByTestId("composer").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/s\/[0-9a-f-]+$/, { timeout: 15_000 });
    const newId = new URL(page.url()).pathname.split("/").pop()!;
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${newId}`)).json()).events as { kind: string; data: { text?: string } }[]).filter((e) => e.kind === "user" && e.data.text === fresh).length, { timeout: 15_000 }).toBe(1);
    expect(await sessions()).toBe(had + 1);
    await row(page, chatId).click();
    await expect(page).toHaveURL(new RegExp(`/s/${chatId}`));
    await expect(page.getByTestId("composer")).toHaveValue(toFar);
    await page.getByTestId("composer").focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await events()).filter((e) => e.kind === "user" && e.data.text === toFar).length, { timeout: 20_000 }).toBe(1);
    await page.waitForTimeout(1500);
    expect([(await events()).filter((e) => e.kind === "user" && e.data.text === toFar).length, await sessions()]).toEqual([1, had + 1]);
    await request.delete(`/api/sessions/${newId}`);

    // ---- the link between the two daemons dies for twenty seconds (its connections dead for
    // good), and a session finishes there meanwhile. Its alert is here within seconds of the link:
    // a try made into the dead link gives up after five, and the next is made at once.
    const { session: late } = await there("/api/sessions", { model: "scripted:stand-in", title: `Far in a dead link ${tag}`, workspace: root });
    await there(`/api/sessions/${late.id}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
    farLink.set("dead");
    await there(`/api/sessions/${late.id}/messages`, { text: "script:say Done while the link was dead." });
    await sleep(20_000);
    expect((await inbox()).filter((a) => a.session_id === `${machine}--${late.id}`)).toEqual([]);
    farLink.set("pass");
    const l1 = Date.now();
    await expect.poll(async () => (await inbox()).filter((a) => a.session_id === `${machine}--${late.id}`).map((a) => a.kind), { timeout: 20_000, intervals: [200] }).toEqual(["finished"]);
    const relayed = Date.now() - l1;
    console.log(`CONNECTION-TRUTH dead link between the daemons, 20 s: the finish made in it was here ${relayed} ms after the link`);
    expect(relayed).toBeLessThan(8000);
  } finally {
    if (machine) await request.delete(`/api/fleet/machines/${machine}`).catch(() => {});
    await farLink.close();
    far.proc.kill("SIGTERM");
    await exited(far.proc);
  }
});
