import { expect, test, type Page, type WebSocketRoute } from "./isolate.ts";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionsFolder } from "./own-daemon.ts";
import { HAIKU, ask, shoot } from "./shots.ts";

// Feature: the live feed survives a lost socket. On every reconnect the page
// sends the last seq it holds of each open session; the daemon replays the
// events after it and the reply streamed so far, then goes live, so nothing
// is lost or shown twice. Here the socket is cut three times while a real
// model streams, and then a daemon is stopped mid-turn and started again on
// the same address while the page stays open.

// Every /ws the page opens goes through here, so the test can cut it.
async function cuttable(page: Page) {
  const live: { route?: WebSocketRoute } = {};
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.connectToServer();
    live.route = ws;
  });
  return { cut: async () => { await live.route?.close({ code: 4000, reason: "cut by the test" }); } };
}

const storedText = async (base: string, id: string) => {
  const r = await (await fetch(`${base}/api/sessions/${id}`)).json() as any;
  return { r, texts: r.events.filter((e: any) => e.kind === "assistant").flatMap((e: any) => e.data.blocks.filter((b: any) => b.type === "text" && b.text.trim()).map((b: any) => b.text.trim())) };
};

test("a cut socket loses nothing while a reply streams", async ({ page, baseURL }) => {
  const sock = await cuttable(page);
  const s = (await (await fetch(`${baseURL}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: HAIKU, title: "Replay check" }) })).json() as any).session;
  await page.goto(`/s/${s.id}`);
  await page.getByTestId("composer").fill(ask("Write the numbers from one to four hundred as English words, separated by commas. Nothing else.", "script:count"));
  await page.getByTestId("composer").press("Enter");

  // Cut while the reply streams. After each reconnect the draft is the reply so
  // far with nothing missing: the start of what the model finally wrote (a
  // draft that only went on with the deltas after the gap would not be).
  const draft = page.getByTestId("draft");
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  const after: string[] = [];
  for (let i = 0; i < 3; i++) {
    // The answer streams (or the turn already ended).
    await expect.poll(async () => (await page.getByTestId("turn-end").count()) > 0 || ((await draft.count()) > 0 && (await draft.innerText()).includes("two,")), { timeout: 60_000 }).toBe(true);
    if (await page.getByTestId("turn-end").count()) break;
    await sock.cut();
    if (i === 0) await shoot(page, "live-replay-01-cut-mid-stream");
    await expect(page.getByTestId("turn-end").or(draft)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500); // reconnected, replayed, streaming again
    if (await page.getByTestId("turn-end").count()) break;
    after.push(flat(await draft.innerText()));
  }
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  // The transcript is the stored one: every reply once, whole.
  const { texts } = await storedText(baseURL!, s.id);
  const shown = (await page.getByTestId("assistant-text").allInnerTexts()).map((t) => t.trim());
  expect(shown.length).toBe(texts.length);
  expect(shown.join("\n").replace(/\s+/g, " ")).toBe(texts.join("\n").replace(/\s+/g, " "));
  expect(shown.join(" ")).toContain("three hundred");
  expect(after.length).toBeGreaterThan(0);
  const final = flat(texts.join(" "));
  for (const t of after) {
    // The draft may lead with its thinking; from where the answer starts it is the answer's start, whole.
    const at = t.indexOf(final.slice(0, 30));
    expect(at).toBeGreaterThanOrEqual(0);
    const part = t.slice(at, -12);
    expect(final.slice(0, part.length)).toBe(part);
  }
  await shoot(page, "live-replay-02-complete");
  await fetch(`${baseURL}/api/sessions/${s.id}`, { method: "DELETE" });
});

// Its own daemon on a scratch state, on the scripted stand-in: stopped while a
// tool runs (the turn is parked), started again on the same port.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
function daemon(state: string, port = 0): Promise<{ proc: ChildProcess; url: string }> {
  mkdirSync(state, { recursive: true });
  // Its own config folder too: a spec's daemon reads and writes nothing of the owner's.
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", sessionsFolder(state)], {
    env: { ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_CONFIG_DIR: join(state, "config"), KEEL_DESKTOP_NOTIFY: "off" },
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

// A state folder with sessions that already hold a long transcript (plain notes).
const NOTES = 1200;
const PAGE = 200; // events of a session's branch the page reads at a time (ui/src/lib/store.ts)
function seeded(name: string, ...titles: string[]) {
  const state = join(ROOT, `${name}-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  const ids = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/long-transcript.ts"), state, state, String(NOTES), ...titles], { encoding: "utf8" })) as string[];
  return { state, ids };
}
// What the page downloads of its sessions: every answered GET of a session
// snapshot, with how many events it carried (none: the answer has no transcript).
type Snapshot = { id: string; status: number; events?: number; bytes: number };
function snapshots(page: Page) {
  const got: Snapshot[] = [];
  page.on("response", async (r) => {
    const m = r.request().method() === "GET" && new URL(r.url()).pathname.match(/^\/api\/(?:fleet\/machines\/(\w+)\/api\/)?sessions\/([\w-]+)$/);
    if (!m) return;
    const body = await r.text().catch(() => "");
    let events: number | undefined;
    try { events = JSON.parse(body).events?.length; } catch {}
    got.push({ id: m[1] ? `${m[1]}--${m[2]}` : m[2]!, status: r.status(), events, bytes: body.length });
  });
  return got;
}
const digest = (t: string) => ({ length: t.length, sha: createHash("sha256").update(t).digest("hex").slice(0, 16), end: t.slice(-400) });
const eventsAfter = async (base: string, id: string, seq: number) =>
  ((await (await fetch(`${base}/api/sessions/${id}/events?after=${seq}`)).json()) as any).events as { seq: number; id: string }[];

test("the open page catches up across a daemon restart without a reload", async ({ page }) => {
  // The session already holds a long transcript: the restart must not send it again.
  const { state, ids: [id] } = seeded("replay", "Long before the restart");
  let d = await daemon(state);
  const port = Number(new URL(d.url).port);
  try {
    const post = (path: string, body: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    await post(`/api/sessions/${id}/permissions`, { mode: "full-auto" }, "PUT");
    const got = snapshots(page);
    // The stored events each socket of the page delivered, in order.
    const sockets: number[][] = [];
    page.on("websocket", (ws) => {
      const seqs: number[] = [];
      sockets.push(seqs);
      ws.on("framereceived", ({ payload }) => {
        const f = JSON.parse(String(payload));
        if (f.t === "event" && f.event.session_id === id) seqs.push(f.event.seq);
      });
    });
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByText(`Generated note ${NOTES} of ${NOTES}.`)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("composer").fill("script:long-tool");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("tool-call")).toHaveCount(1, { timeout: 15_000 });
    // Opening it read its newest page, not the 1,200 notes.
    const opening = got.filter((g) => g.id === id).length;
    expect(opening).toBeGreaterThan(0);
    expect(new Set(got.filter((g) => g.id === id).map((g) => g.events))).toEqual(new Set([PAGE]));
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    // What the page holds now: the last event its first socket brought (the stop stored some).
    const held = Math.max(NOTES, ...sockets[0]!);
    d = await daemon(state, port);
    // No reload: the page reconnects, resumes from its cursor and shows the continued turn.
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Continued after the restart.", { timeout: 60_000 });
    const { r, texts } = await storedText(d.url, id!);
    const shown = (await page.getByTestId("assistant-text").allInnerTexts()).map((t) => t.trim());
    expect(shown).toEqual(texts);
    const ends = r.events.filter((e: any) => e.kind === "turn_end").length;
    await expect(page.getByTestId("turn-end")).toHaveCount(ends);
    await expect(page.getByTestId("sync-state")).toHaveCount(0);
    // The catch-up by HTTP carried no transcript, and the sockets after the
    // restart brought each missing event once and nothing the page held.
    const again = got.filter((g) => g.id === id).slice(opening);
    expect(again.length).toBeGreaterThan(0);
    expect(again.map((g) => g.events)).toEqual(again.map(() => undefined));
    for (const g of again) expect(g.bytes).toBeLessThan(20_000);
    const after = sockets.slice(1).flat();
    expect(after).toEqual((await eventsAfter(d.url, id!, held)).map((e) => e.seq));
    await shoot(page, "live-replay-03-after-restart");
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
  }
});

// One scenario on a daemon of its own: two long sessions are open in the page
// when its socket is cut. While it is away a turn streams half a reply and
// holds, a prompt is queued and the other session is deleted. The reconnect
// brings the draft, the queue, the status and the missing events over the
// socket; its snapshot carries no transcript and is held back until the turn
// is over, so it lands late. At each point the page shows what a page loaded
// just then shows.
test("a reconnect sends no transcript the page holds, only what it missed", async ({ page, context }) => {
  const { state, ids: [id, doomed] } = seeded("replay-long", "Long and kept", "Long and deleted while away");
  const d = await daemon(state);
  const origin = d.url;
  const gate = join(state, "release-the-hold");
  try {
    // One station at a time, as the other specs: the transcript on screen is the session's.
    await context.addInitScript(() => localStorage.setItem("keel.focus", "true"));
    const got = snapshots(page);
    let seqs: number[] = [];
    let hold: Promise<void> | undefined;
    let cut: (() => void) | undefined;
    await page.routeWebSocket(/\/ws$/, async (ws) => {
      await hold;
      const server = ws.connectToServer();
      server.onMessage((m) => {
        const f = JSON.parse(String(m));
        if (f.t === "event" && f.event.session_id === id) seqs.push(f.event.seq);
        ws.send(m);
      });
      cut = () => { ws.close({ code: 4000, reason: "cut by the test" }); server.close({ code: 1000 }); };
    });
    const post = (path: string, body: unknown) => fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const row = (sid: string) => page.locator(`[data-testid="session-row"][data-session="${sid}"]`);
    const lastNote = page.getByText(`Generated note ${NOTES} of ${NOTES}.`);
    // What a page shows of the session: the transcript with the reply streamed so far, the queue, the state.
    const flat = (t: string) => t.replace(/\s+/g, " ").trim();
    // The transcript is long: its length, its end and a digest say whether two are the same.
    // (Without the screen reader's line, which only a page that saw the turn end says.)
    // A page holds the newest part of the session, more of it the longer it
    // was open: two pages are compared from a note both hold.
    const shared = `Generated note ${NOTES - 20} of`;
    const view = async (p: Page) => ({
      transcript: digest(flat(await p.getByTestId("transcript").evaluate((el, from) => {
        const copy = el.cloneNode(true) as HTMLElement;
        copy.querySelector('[data-testid="turn-announcer"]')?.remove();
        const text = copy.textContent ?? "";
        return text.slice(Math.max(0, text.indexOf(from)));
      }, shared))),
      draft: (await p.getByTestId("draft").count()) ? flat(await p.getByTestId("draft").innerText()) : "",
      queue: (await p.getByTestId("queue-item").allInnerTexts()).map(flat),
      word: flat(await p.getByTestId("station-word").innerText()),
    });
    // A page loaded now comes to show the same. Its socket opens only once its
    // snapshot is on screen: the reply so far then comes by both, the replay's
    // at the snapshot's rev while the turn holds and nothing is emitted.
    // It answers with the stored events the fresh page's socket replayed to it.
    const sameAsFresh = async () => {
      const p = await context.newPage();
      const replayed: number[] = [];
      // (The page is closed only once its socket is let through: where the snapshot alone shows
      // what the open page shows, the comparison below could pass and close the page while this
      // wait was between two looks at the transcript, and the wait then failed on a closed page.)
      let through!: () => void, failed!: (e: unknown) => void;
      const opened = new Promise<void>((ok, no) => { through = ok; failed = no; });
      opened.catch(() => {}); // (a wait that fails after the test has moved on is reported by the wait itself)
      await p.routeWebSocket(/\/ws$/, async (ws) => {
        try { await expect(p.getByTestId("transcript")).toContainText(shared, { timeout: 30_000 }); } catch (e) { failed(e); throw e; }
        through();
        const server = ws.connectToServer();
        server.onMessage((m) => {
          const f = JSON.parse(String(m));
          if (f.t === "event" && f.event.session_id === id && f.rev === undefined) replayed.push(f.event.seq);
          ws.send(m);
        });
      });
      await p.goto(`${origin}/s/${id}`);
      await expect(p.getByTestId("sync-state")).toHaveCount(0, { timeout: 30_000 });
      const shown = await view(page);
      await expect.poll(() => view(p), { timeout: 10_000 }).toEqual(shown);
      await opened;
      await p.close();
      return replayed;
    };

    // Both sessions are loaded in the page; the kept one is on screen.
    await page.goto(`${origin}/s/${doomed}`);
    await expect(lastNote).toBeVisible({ timeout: 30_000 });
    await row(id!).click();
    await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
    await expect(lastNote).toBeVisible({ timeout: 30_000 });
    // Opening them read the newest page of each.
    expect(new Set(got.map((g) => `${g.id} ${g.events}`))).toEqual(new Set([`${doomed} ${PAGE}`, `${id} ${PAGE}`]));
    const full = got.find((g) => g.id === id)!.bytes;

    // Cut, and kept out. Meanwhile: half a reply, a queued prompt, a deletion.
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    cut!();
    await expect(page.getByTestId("sync-state")).toHaveText("Reconnecting", { timeout: 10_000 });
    expect((await post(`/api/sessions/${id}/messages`, { text: `script:hold ${gate}` })).ok).toBe(true);
    await expect.poll(async () => ((await (await fetch(`${origin}/api/sessions/${id}?events=0`)).json()) as any).draft?.[0]?.text ?? "", { timeout: 15_000 }).toContain("before the hold");
    expect((await post(`/api/sessions/${id}/messages`, { text: "Queued while the page was away", mode: "queue" })).ok).toBe(true);
    expect((await fetch(`${origin}/api/sessions/${doomed}`, { method: "DELETE" })).ok).toBe(true);
    got.length = 0;
    seqs = [];

    // The reconnect's snapshot of the kept session is read now and held back.
    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    const snapshotUrl = new RegExp(`/api/sessions/${id}(\\?.*)?$`);
    await page.route(snapshotUrl, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const old = await route.fetch();
      await landed;
      await route.fulfill({ response: old });
    });
    release();
    // Over the socket alone: the reply so far, the queue, the state, the missed events.
    await expect(page.getByTestId("draft")).toContainText("The first half, streamed before the hold.", { timeout: 15_000 });
    await expect(page.getByTestId("queue-item")).toHaveCount(1);
    await expect(page.getByTestId("sync-state")).toHaveText("Catching up");
    await shoot(page, "live-replay-05-long-catching-up");
    await sameAsFresh();
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs).toEqual((await eventsAfter(origin, id!, NOTES)).map((e) => e.seq));
    // The session deleted meanwhile left the page.
    await expect(row(doomed!)).toHaveCount(0);
    await expect.poll(() => got.find((g) => g.id === doomed)?.status).toBe(404);

    // The turn goes on and the queued prompt runs, all while the snapshot is still out.
    writeFileSync(gate, "");
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Scripted reply.", { timeout: 30_000 });
    await expect(page.getByTestId("turn-end")).toHaveCount(2);
    await expect(page.getByTestId("queue-item")).toHaveCount(0);
    // The late snapshot (a streaming turn, a queued prompt, an older head) changes nothing.
    land();
    await expect(page.getByTestId("sync-state")).toHaveCount(0);
    await page.unroute(snapshotUrl);
    await expect(page.getByTestId("turn-end")).toHaveCount(2);
    await expect(page.getByTestId("draft")).toHaveCount(0);
    await sameAsFresh();
    // Each event after the cut came once, in order, and none from before it.
    const missed = await eventsAfter(origin, id!, NOTES);
    expect(seqs).toEqual(missed.map((e) => e.seq));
    // No answer of the catch-up carried a transcript; the first load did.
    const again = got.filter((g) => g.id === id);
    expect(again.length).toBeGreaterThan(0);
    expect(again.map((g) => g.events)).toEqual(again.map(() => undefined));
    for (const g of again) expect(g.bytes).toBeLessThan(full / 8);

    // A second cut: the head moves to an older branch point meanwhile and
    // nothing new is stored. The page follows the head and is sent no event.
    hold = new Promise<void>((r) => (release = r));
    got.length = 0;
    seqs = [];
    cut!();
    await expect(page.getByTestId("sync-state")).toHaveText("Reconnecting", { timeout: 10_000 });
    const all = ((await (await fetch(`${origin}/api/sessions/${id}`)).json()) as any).events as { id: string; seq: number }[];
    expect((await post(`/api/sessions/${id}/head`, { head_event_id: all.find((e) => e.seq === NOTES - 5)!.id, leaf: false })).ok).toBe(true);
    release();
    await expect(page.getByTestId("sync-state")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("transcript")).not.toContainText(`Generated note ${NOTES} of`);
    await expect(page.getByTestId("transcript")).toContainText(`Generated note ${NOTES - 5} of`);
    // The session's head is now not its newest event. A page loaded in that
    // state, its socket opening after its snapshot, resumes from the session's
    // newest seq: nothing is replayed to it and it shows the branch the head is on.
    expect(await sameAsFresh()).toEqual([]);
    expect(seqs).toEqual([]);
    expect(got.filter((g) => g.id === id).map((g) => g.events)).toEqual([undefined]);
    await shoot(page, "live-replay-06-long-older-head");

    // A third cut in that state, with nothing new: the open page too resumes
    // from the session's newest seq, is sent no event and stays on its branch.
    // The session is not taken for a failed one (its newest held event is not on its branch).
    hold = new Promise<void>((r) => (release = r));
    got.length = 0;
    seqs = [];
    cut!();
    await expect(page.getByTestId("sync-state")).toHaveText("Reconnecting", { timeout: 10_000 });
    release();
    await expect(page.getByTestId("sync-state")).toHaveCount(0, { timeout: 15_000 });
    expect(seqs).toEqual([]);
    await expect(page.getByTestId("transcript")).not.toContainText(`Generated note ${NOTES} of`);
    await expect(page.getByTestId("transcript")).toContainText(`Generated note ${NOTES - 5} of`);
    expect(((await (await fetch(`${origin}/api/sessions/${id}?events=0`)).json()) as any).session.head).toBe(all.find((e) => e.seq === NOTES - 5)!.id);
    await expect(page.getByTestId("station-word")).not.toHaveText(/Failed/);
    expect(await sameAsFresh()).toEqual([]);
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
  }
});

// A session of another daemon is not in this daemon's replay: the page still
// reads its transcript again after a reconnect.
test("a peer's session still catches up by HTTP after a reconnect", async ({ page }) => {
  const here = await daemon(join(ROOT, `replay-here-${Date.now()}`));
  const there = await daemon(join(ROOT, `replay-there-${Date.now()}`));
  try {
    const json = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const machine = (await json(`${here.url}/api/fleet/machines`, { name: "replay peer", daemon_url: there.url })).id as string;
    const { session } = await json(`${there.url}/api/sessions`, { model: "scripted:stand-in", title: "On the peer" });
    const remote = `${machine}--${session.id}`;
    const got = snapshots(page);
    let hold: Promise<void> | undefined;
    let cut: (() => void) | undefined;
    await page.routeWebSocket(/\/ws$/, async (ws) => {
      await hold;
      const server = ws.connectToServer();
      cut = () => { ws.close({ code: 4000, reason: "cut by the test" }); server.close({ code: 1000 }); };
    });
    await page.goto(`${here.url}/s/${remote}`);
    await expect(page.getByTestId("composer")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => got.filter((g) => g.id === remote).length).toBe(1);
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    cut!();
    await expect(page.getByTestId("sync-state")).toHaveText("Reconnecting", { timeout: 10_000 });
    await json(`${there.url}/api/sessions/${session.id}/messages`, { text: "Said while the page was away" });
    await expect.poll(async () => (await storedText(there.url, session.id)).texts, { timeout: 15_000 }).toEqual(["Scripted reply."]);
    got.length = 0;
    release();
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Scripted reply.", { timeout: 20_000 });
    await expect(page.getByTestId("sync-state")).toHaveCount(0);
    const stored = (await storedText(there.url, session.id)).r.events.length;
    expect(got.filter((g) => g.id === remote).map((g) => g.events)).toEqual([stored]);
  } finally {
    for (const d of [here, there]) { d.proc.kill("SIGKILL"); await exited(d.proc); }
  }
});

// A request whose handler works past Bun's 10 s idle timeout answers instead
// of being cut: a session delete waits for a turn that does not stop at once.
test("a delete that waits on a slow turn answers instead of a connection reset", async ({ request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", text: "script:deaf" } })).json();
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).status?.kind, { timeout: 10_000 }).toBe("model");
  const t0 = Date.now();
  const r = await request.delete(`/api/sessions/${session.id}`, { timeout: 30_000 });
  expect(r.status()).toBe(200);
  expect(Date.now() - t0).toBeGreaterThan(10_000);
});


// A reconnect's snapshot can come back after live frames that are newer than
// it: the page keeps the newer head and status, and says it is catching up
// until the replay and the reloads have landed.
test("a late snapshot after a reconnect does not bring back an old head or a retry", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const sock = await cuttable(page);
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Late snapshot" } })).json();
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("composer").fill("script:rate-limit");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("retrying")).toBeVisible({ timeout: 15_000 });

  // The reconnect's snapshot is read now, while the turn waits to retry, and held.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(new RegExp(`/api/sessions/${session.id}(\\?.*)?$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const old = await route.fetch();
    await held;
    await route.fulfill({ response: old });
  });
  await sock.cut();
  await expect(page.getByTestId("sync-state")).toHaveText("Catching up", { timeout: 10_000 });
  // The retry answers over the new socket while the old snapshot is still out.
  await expect(page.getByTestId("assistant-text").last()).toHaveText("Answered after the rate limit passed.", { timeout: 20_000 });
  await shoot(page, "live-replay-04-catching-up");
  release();
  await expect(page.getByTestId("sync-state")).toHaveCount(0);
  await page.unroute(new RegExp(`/api/sessions/${session.id}(\\?.*)?$`));
  // The older snapshot did not move the head back or bring the countdown back.
  await expect(page.getByTestId("assistant-text").last()).toHaveText("Answered after the rate limit passed.");
  await expect(page.getByTestId("retrying")).toHaveCount(0);
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await request.delete(`/api/sessions/${session.id}`);
});
