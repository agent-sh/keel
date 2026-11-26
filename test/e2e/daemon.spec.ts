import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { specEnv } from "./own-daemon.ts";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, ask, openPanel, scriptBash } from "./shots.ts";

// Feature: the daemon keeps the machine awake while a turn runs, and a restart
// from Settings > Daemon lets the running turn finish first; a restart that
// cannot wait parks the turn and it continues by itself after the start.
const daemon = async (request: APIRequestContext) => {
  try {
    const r = await request.get("/api/daemon", { timeout: 2000 });
    return r.ok() ? await r.json() : null;
  } catch { return null; }
};
const events = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
const inhibitors = (pid: number) => execFileSync("systemd-inhibit", ["--list", "--no-pager"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`daemon pid ${pid})`)).length;

// A dev daemon's page (Bun's hot reload, `development.hmr`) reloads itself
// each time its reload socket finds a server again after the first: after a
// restart, at the moment that socket's next try gets through, which under
// load can be seconds after the daemon is back. A navigation of the test's
// in that time is cut by it ("interrupted by another navigation" to the
// page's old address). So the test waits for that reload before it navigates.
// A built daemon's page has no such socket and does not reload itself.
function selfReload(page: Page, hmr: { on: boolean }): () => Promise<void> {
  if (!hmr.on) return async () => {};
  const main = page.mainFrame();
  const done = new Promise<void>((ok) => {
    const seen = (f: import("@playwright/test").Frame) => { if (f === main) { page.off("framenavigated", seen); ok(); } };
    page.on("framenavigated", seen);
  });
  return async () => {
    await Promise.race([done, new Promise((_, no) => setTimeout(() => no(new Error("the page did not reload itself within 60 s of the restart")), 60_000))]);
    await page.waitForLoadState("load");
  };
}

test("keep awake, restart after turns, a parked turn continues", async ({ page, request }) => {
  test.setTimeout(360_000);
  const hmr = { on: false };
  page.on("websocket", (w) => { if (new URL(w.url()).pathname === "/_bun/hmr") hmr.on = true; });
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const pid0 = (await daemon(request)).pid;
  // A stall of this start (the stand-in's busy loop): two restarts later the Daemon page still lists it with its start.
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  const stalls = models.includes("scripted:stand-in");
  if (stalls) {
    const { session: holds } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Holds the daemon" } })).json();
    await request.post(`/api/sessions/${holds.id}/messages`, { data: { text: "script:block 2500" } });
    await expect.poll(async () => (await daemon(request))?.stalls?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    await request.delete(`/api/sessions/${holds.id}`);
  }

  // A turn that runs for a while.
  const a = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Restart waits for me", text: ask("Run `sleep 12` with your shell tool in the foreground, then reply with the word finished.", scriptBash("sleep 12")) } })).json()).session;
  await expect.poll(async () => (await daemon(request))?.running.includes(a.id), { timeout: 60_000 }).toBe(true);

  await page.goto("/settings/daemon");
  const panel = page.getByTestId("daemon-panel");
  await expect(panel.getByTestId("daemon-running")).toHaveText("1");
  const awake = await (await request.get("/api/awake")).json();
  if (awake.available) {
    await expect(panel.getByTestId("awake-state")).toHaveText("Held");
    expect(inhibitors(pid0)).toBe(1);
  }
  await shoot(page, "daemon-01-turn-running");

  // Restart from the page: the turn's command ends, the turn stops at its next step, and the next daemon continues it.
  const reloaded = selfReload(page, hmr);
  await panel.getByTestId("daemon-restart").click();
  await page.getByTestId("confirm").getByRole("button", { name: "Restart" }).click();
  await expect(panel.getByTestId("daemon-status")).toContainText(/Restarting|Reconnecting/);
  await expect(page.getByTestId("admin-band")).toContainText("Keel is restarting: 1 turn at work.");
  expect((await request.post("/api/sessions", { data: { model: HAIKU, title: "refused" } })).status()).toBe(503);
  await shoot(page, "daemon-02-draining");
  await expect.poll(async () => { const d = await daemon(request); return d && d.pid !== pid0 ? d.pid : 0; }, { timeout: 120_000, intervals: [1000] }).toBeGreaterThan(0);
  // The command ran to its end (its result is no cut), and the continued turn replied.
  await expect.poll(async () => (await events(request, a.id)).some((e) => e.kind === "assistant" && JSON.stringify(e.data.blocks).toLowerCase().includes(ask("finished", "done with 1 call"))), { timeout: 60_000 }).toBe(true);
  const ev = await events(request, a.id);
  expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["restart", "end_turn"]);
  expect(JSON.stringify(ev.filter((e) => e.kind === "tool_result").map((e) => e.data.results))).not.toContain("cut by a daemon restart");
  await expect(panel.getByTestId("daemon-status")).toContainText("pid", { timeout: 30_000 });
  // The page reconnected by itself; a dev daemon's then reloads itself too.
  await reloaded();
  await expect(panel.getByTestId("daemon-status")).toContainText("pid", { timeout: 30_000 });
  await shoot(page, "daemon-03-back");

  // A restart that does not wait: the turn is parked and continues after the start.
  const pid1 = (await daemon(request)).pid;
  const b = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Parked and continued", text: ask("Run `sleep 20` with your shell tool in the foreground, then reply with the word continued.", scriptBash("sleep 20")) } })).json()).session;
  await expect.poll(async () => (await events(request, b.id)).some((e) => e.kind === "assistant"), { timeout: 60_000 }).toBe(true);
  const reloadedAgain = selfReload(page, hmr);
  await request.post("/api/drain", { data: { restart: true, now: true, timeout_seconds: 1 } });
  await expect.poll(async () => { const d = await daemon(request); return d && d.pid !== pid1 ? d.pid : 0; }, { timeout: 120_000, intervals: [1000] }).toBeGreaterThan(0);
  await expect.poll(async () => (await events(request, b.id)).some((e) => e.kind === "user" && e.data.origin === "restart"), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await events(request, b.id)).filter((e) => e.kind === "turn_end").length, { timeout: 120_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${b.id}`)).json()).session.phase, { timeout: 30_000 }).toBe("idle");
  if (awake.available) expect(inhibitors(pid1) + inhibitors(pid0)).toBe(0);

  await reloadedAgain();
  await page.goto(`/s/${b.id}`);
  await expect(page.getByTestId("restart-note")).toBeVisible();
  await shoot(page, "daemon-04-continued");

  // The page keeps the starts before this one with what each began with and the stalls of its life:
  // this start parked a turn; the one before it came from the restart that waited for the command (it parked the
  // turn at its step boundary, and the turn resumed), and the one before that is the first start, with its stall.
  await page.goto("/settings/daemon");
  await expect(page.getByTestId("daemon-last-start")).toContainText("1 turn was cut: 1 resumed");
  const earlier = page.getByTestId("daemon-earlier-start");
  await expect.poll(() => earlier.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect(earlier.nth(0)).toHaveAttribute("data-how", "restart");
  await expect(earlier.nth(0).getByTestId("daemon-earlier-summary")).toContainText("1 turn was cut: 1 resumed");
  if (stalls) await expect(earlier.nth(1).getByTestId("daemon-stall").first()).toContainText("blocked by its own code");
  await page.getByTestId("daemon-earlier-starts").scrollIntoViewIfNeeded();
  await shoot(page, "daemon-05-earlier-starts");

  // The problem report is written from the page.
  await page.getByTestId("report-write").click();
  await expect(page.getByTestId("daemon-panel")).toContainText("Written to");

  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  for (const s of [a, b]) await request.delete(`/api/sessions/${s.id}`);
});

// A drain turns new work away and nothing else. Its own daemon on a scratch
// state and the scripted stand-in, drained while one turn is at work and
// another waits for the owner's approval (a card alone does not hold a
// drain): the open page still asks which paths of a reply are files (a read,
// sent as a POST) and links them, a prompt the daemon turns away waits above
// the box without becoming a record in Errors, the approval given from the
// page lets its turn finish, and the drain ends with the reply on its way.
// The owner's trust of a repository's changed instruction file is taken too:
// it starts nothing, and its card comes with the landing a restart follows. A
// press that is refused says so beside the button, above the diff.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
function ownDaemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], {
    env: specEnv(state, { KEEL_DRAIN_MS: undefined }, join(state, "work")),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); done({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}

test("a draining daemon still answers reads and the answers its running turns wait for", async ({ page }) => {
  const state = join(ROOT, `drain-${Date.now()}`);
  mkdirSync(join(state, "work/notes"), { recursive: true });
  writeFileSync(join(state, "work/notes/plan.md"), "# Plan\nMove the parser.\n");
  const d = await ownDaemon(state);
  const call = (path: string, body?: unknown, method = "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = async (path: string) => (await (await fetch(d.url + path)).json()) as any;
  try {
    // A reply that names a file of the folder, then a turn that asks before it writes.
    const { session } = (await (await call("/api/sessions", { model: "scripted:stand-in", title: "Read while draining", workspace: join(state, "work"), text: "script:render" })).json()) as any;
    await call(`/api/sessions/${session.id}/permissions`, { mode: "ask" }, "PUT");
    await expect.poll(async () => (await get(`/api/sessions/${session.id}`)).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);
    await call(`/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "touch made.txt" } }])}` });
    await expect.poll(async () => (await get(`/api/sessions/${session.id}/approvals`)).approvals.length, { timeout: 30_000 }).toBe(1);
    // A repository whose instruction file changed since it was pinned: held, for the owner to trust.
    const repo = join(state, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "AGENTS.md"), "# Rules\n\nAnswer in one line.\n");
    const inRepo = ((await (await call("/api/sessions", { model: "scripted:stand-in", title: "Held file", workspace: repo })).json()) as any).session;
    const fileOf = async () => (await get(`/api/trust?cwd=${encodeURIComponent(repo)}`)).files.find((f: any) => f.rel === "AGENTS.md");
    expect((await fileOf()).state).toBe("trusted");
    writeFileSync(join(repo, "AGENTS.md"), "# Rules\n\nAnswer in two lines.\n");
    expect((await fileOf()).state).toBe("changed");
    // A card that only waits on the owner does not hold a drain. A turn at work does: another session's reply, until its gate opens.
    const gate = join(state, "gate");
    const busy = ((await (await call("/api/sessions", { model: "scripted:stand-in", title: "At work while draining", workspace: join(state, "work"), text: `script:hold ${gate}` })).json()) as any).session;
    // (Its reply has begun to stream: a drain stops a turn before a request it has not sent, and waits for one on its way.)
    await expect.poll(async () => JSON.stringify((await get(`/api/sessions/${busy.id}`)).draft ?? null).includes("The first half"), { timeout: 30_000 }).toBe(true);
    expect((await call("/api/drain", { timeout_seconds: 120 })).status).toBe(200);
    expect((await get("/api/daemon")).draining).toBeTruthy();

    // New work is turned away; a read is not.
    expect((await call("/api/sessions", { model: "scripted:stand-in", title: "refused" })).status).toBe(503);
    const exist = await call(`/api/sessions/${session.id}/files/exist`, { paths: ["notes/plan.md", "src/parse.ts"] });
    expect(exist.status).toBe(200);
    expect(((await exist.json()) as any).files).toEqual({ "notes/plan.md": "notes/plan.md" });

    // The page opened during the drain links the file the reply names.
    const tracked: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/errors") tracked.push(r.postData() ?? ""); });
    const refused: string[] = [];
    page.on("response", (r) => { if (r.status() === 503) refused.push(`${r.request().method()} ${new URL(r.url()).pathname.replace(session.id, ":id")}`); });
    await page.goto(`${d.url}/s/${session.id}`);
    await expect(page.getByTestId("admin-band")).toContainText(/Keel is stopping: \d turns? at work\./);
    await expect(page.locator('code.k-fileref[data-rel="notes/plan.md"]')).toHaveAttribute("role", "link");
    await expect(page.locator('code.k-fileref[data-path="src/parse.ts"]').first()).toHaveAttribute("data-checked", "1");

    // A prompt sent now is not taken yet: it waits above the box, to go out by itself when Keel takes work again.
    await expect(page.getByTestId("admin-band-note")).toHaveText("New work waits.");
    await page.getByTestId("composer").fill("more work");
    await page.getByTestId("composer").press("Enter");
    const kept = page.getByTestId("saved-draft");
    await expect(kept).toHaveAttribute("data-state", "waiting");
    await expect(kept).toContainText("more work");
    await expect(kept.getByTestId("saved-waiting")).toContainText("goes out by itself, once");
    await expect(page.getByTestId("composer")).toHaveValue("");
    // The band is a row of its own: it covers nothing of the message box.
    const band = (await page.getByTestId("admin-band").boundingBox())!;
    const box = (await page.getByTestId("composer").boundingBox())!;
    expect(band.y + band.height).toBeLessThanOrEqual(box.y);
    // An image dropped on the page is kept with the session's draft.
    await page.evaluate(() => {
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
      dispatchEvent(new CustomEvent("keel:files", { detail: [new File([png], "dot.png", { type: "image/png" })] }));
    });
    await expect.poll(async () => (await get(`/api/sessions/${session.id}/draft`)).attachments.length, { timeout: 10_000 }).toBe(1);
    await shoot(page, "daemon-05-draining-session");
    await page.evaluate(() => fetch("/api/daemon").then((r) => r.text())); // whatever the page was posting has gone out
    // Of all the page sent by itself and for the owner, only the prompt was turned away.
    expect(refused).toEqual(["POST /api/sessions/:id/messages"]);
    expect(tracked.filter((t) => t.includes("no new work"))).toEqual([]);
    expect((await get("/api/errors")).errors.filter((e: any) => /no new work/.test(e.message))).toEqual([]);

    // The approval is taken: the turn runs its command and stops at its next step, its result stored, while the
    // daemon still waits for the reply on its way.
    await page.getByTestId("approval").getByTestId("allow-once").click();
    await expect.poll(() => existsSync(join(state, "work/made.txt")), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await get(`/api/sessions/${session.id}`)).events.some((e: any) => e.kind === "tool_result"), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await get("/api/daemon")).running, { timeout: 30_000 }).toEqual([busy.id]);
    expect(d.proc.exitCode).toBeNull();
    // The message is still kept, and was posted once: the page asks whether Keel takes work before it sends again.
    await expect(kept).toHaveAttribute("data-state", "waiting");
    expect(refused).toEqual(["POST /api/sessions/:id/messages"]);
    // The held file is trusted from its panel while the daemon drains.
    const other = await page.context().newPage();
    // (The workbench, as the specs' own daemon gets it from the config: this daemon is another origin.)
    await other.addInitScript(() => localStorage.setItem("keel.workbench", "true"));
    await other.goto(`${d.url}/s/${inRepo.id}`);
    await openPanel(other, "trust");
    const held = other.getByTestId("trust-panel").getByTestId("held-file");
    await expect(held.getByTestId("diff-view")).toContainText("two lines");
    await held.getByTestId("trust-file").click();
    await expect(other.getByTestId("trust-panel").getByTestId("trust-clear")).toBeVisible();
    expect((await fileOf()).state).toBe("trusted");
    expect((await get("/api/daemon")).draining).toBeTruthy();
    // A press the daemon refuses says so beside the button, above the diff.
    writeFileSync(join(repo, "AGENTS.md"), "# Rules\n\nAnswer in three lines.\n");
    await other.reload();
    await openPanel(other, "trust");
    await expect(held.getByTestId("diff-view")).toContainText("three lines");
    await other.route((u) => u.pathname === "/api/trust", (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "the file changed since it was shown: look at it again" }) })
      : route.fallback());
    await held.getByTestId("trust-file").click();
    const said = held.getByTestId("trust-error");
    await expect(said).toHaveText("Not trusted: the file changed since it was shown: look at it again");
    expect((await said.boundingBox())!.y).toBeLessThan((await held.getByTestId("diff-view").boundingBox())!.y);
    await shoot(other, "daemon-06-trust-refused");
    await other.close();
    // That turn ends, and the drain with it.
    writeFileSync(gate, "");
    await expect.poll(() => d.proc.exitCode, { timeout: 30_000 }).toBe(0);
  } finally {
    d.proc.kill("SIGKILL");
  }
});

// The store's disk does not answer (a sync that never returns: src/core/checkpoint.ts). The page says so
// across its top, with what still works: first that work goes on unsaved, then, once the store takes no
// writes, that sessions can be read, a turn stopped, a card answered and Keel restarted. (The daemon's own
// answer is used with the state a silent disk reports: a spec cannot hang the daemon's disk.)
test("the page says when the store's disk does not answer, and what still works", async ({ page, request }) => {
  let store: { full?: { since_ms: number; free_mb?: number }; silent_since_ms?: number; refusing?: boolean; slow?: { since_ms: number; sync_ms: number; held_ms: number; refusing?: boolean } } | null = { silent_since_ms: Date.now() - 70_000, refusing: false };
  await page.route(/\/api\/bootstrap(\?|$)/, async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { ...(await answer.json()), store } });
  });
  await page.goto("/");
  const band = page.getByTestId("store-silent");
  await expect(band).toContainText(/Keel's disk does not answer since \d/);
  await expect(page.getByTestId("store-silent-note")).toContainText("Work goes on for now");
  await shoot(page, "daemon-06-disk-silent");
  store = { silent_since_ms: Date.now() - 130_000, refusing: true };
  await page.reload();
  await expect(band).toContainText("nothing new is saved");
  await expect(page.getByTestId("store-silent-note")).toContainText("You can still read sessions, stop a turn, answer a card and restart Keel");
  await shoot(page, "daemon-07-store-refusing");
  // A phone: both halves in fewer words, whole (on two lines when one does not hold them).
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = page.getByTestId("store-silent-narrow");
  await expect(narrow).toHaveText("Disk not answering: nothing is saved. Stop, answer and restart still work.");
  expect(await narrow.evaluate((n) => n.scrollWidth <= n.clientWidth && n.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await shoot(page, "daemon-08-store-refusing-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });
  // A disk that answers, slowly (writes wait seconds while the log is started again): said in its own band, and nothing is refused.
  store = { slow: { since_ms: Date.now() - 40_000, sync_ms: 4_100, held_ms: 9_300 } };
  await page.reload();
  const slow = page.getByTestId("store-slow");
  await expect(slow).toContainText(/Keel's disk is slow since \d.*saving waits on it/);
  await expect(page.getByTestId("store-slow-note")).toHaveText("A sync of its store takes 4.1 s. Work goes on; answers come seconds late at times. See Errors.");
  await expect(band).toHaveCount(0);
  await shoot(page, "daemon-09-disk-slow");
  await page.setViewportSize({ width: 390, height: 844 });
  const slowNarrow = page.getByTestId("store-slow-narrow");
  await expect(slowNarrow).toHaveText("Disk slow: saving waits. Work goes on, seconds late at times.");
  expect(await slowNarrow.evaluate((n) => n.scrollWidth <= n.clientWidth && n.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1040 });
  // The store takes no writes for the seconds of a slow start of its log: said as a slow disk, not a silent one.
  // A prompt sent meanwhile is turned away by the daemon; it waits on its shelf and goes out by itself when the band clears.
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Sent while the disk is slow" } })).json();
  store = { slow: { since_ms: Date.now() - 40_000, sync_ms: 4_100, held_ms: 9_300, refusing: true } };
  let turned = 0;
  await page.route(/\/api\/sessions\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== "POST" || !store) return route.continue();
    turned++;
    await route.fulfill({ status: 503, json: { error: "the daemon's disk is slow (a sync of its store takes 4.1 s) and its store takes no writes until its log has started again, seconds from now.", store_refusing: true } });
  });
  await page.goto(`/s/${session.id}`);
  await expect(slow).toContainText("nothing is saved for some seconds");
  await expect(page.getByTestId("store-slow-note")).toHaveText("A sync of its store takes 4.1 s. What you send waits and goes out by itself; running turns wait. See Errors.");
  await page.getByTestId("composer").fill(ask("Reply with the word kept.", "script:render"));
  await page.getByTestId("composer").press("Enter");
  const kept = page.getByTestId("saved-draft");
  await expect(kept).toHaveAttribute("data-state", "waiting");
  await expect(kept.getByTestId("saved-waiting")).toContainText("goes out by itself, once");
  await shoot(page, "daemon-10-disk-slow-refusing");
  expect(turned).toBe(1);
  store = null;
  await expect(kept).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "user").length, { timeout: 30_000 }).toBe(1);
  expect(turned).toBe(1);
  // A disk with no room: said as that, with how much is free.
  store = { full: { since_ms: Date.now() - 20_000, free_mb: 12 }, refusing: true };
  await page.goto("/");
  const full = page.getByTestId("store-full");
  await expect(full).toContainText(/Keel's disk is full since \d.*nothing new is saved/);
  await expect(page.getByTestId("store-full-note")).toHaveText("12 MB free. Free some space: what you send waits and goes out by itself. You can still read sessions, stop a turn, answer a card and restart Keel.");
  await shoot(page, "daemon-11-disk-full");
  // The disk answers again: the band goes.
  store = null;
  await page.reload();
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(band).toHaveCount(0);
  await expect(slow).toHaveCount(0);
  await expect(full).toHaveCount(0);
});
