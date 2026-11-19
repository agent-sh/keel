import { expect, test, type Page, type WebSocketRoute } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

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
  await page.getByTestId("composer").fill("Write the numbers from one to four hundred as English words, separated by commas. Nothing else.");
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
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", state], {
    env: { ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in" },
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

test("the open page catches up across a daemon restart without a reload", async ({ page }) => {
  const state = join(ROOT, `replay-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  const port = Number(new URL(d.url).port);
  try {
    const post = (path: string, body: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const { session } = await post("/api/sessions", { model: "scripted:stand-in" });
    await post(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    await page.goto(`${d.url}/s/${session.id}`);
    await page.getByTestId("composer").fill("script:long-tool");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("tool-call")).toHaveCount(1, { timeout: 15_000 });
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state, port);
    // No reload: the page reconnects, resumes from its cursor and shows the continued turn.
    await expect(page.getByTestId("assistant-text").last()).toHaveText("Continued after the restart.", { timeout: 60_000 });
    const { texts } = await storedText(d.url, session.id);
    const shown = (await page.getByTestId("assistant-text").allInnerTexts()).map((t) => t.trim());
    expect(shown).toEqual(texts);
    const ends = (await (await fetch(`${d.url}/api/sessions/${session.id}`)).json() as any).events.filter((e: any) => e.kind === "turn_end").length;
    await expect(page.getByTestId("turn-end")).toHaveCount(ends);
    await shoot(page, "live-replay-03-after-restart");
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
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

