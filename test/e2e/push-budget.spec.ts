import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { Phone } from "./fixtures/phone-app.ts";
import { listening, specEnv } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: a budget of interruptions. The phone gets at most N pushes an hour, in
// the order of attention; what is left folds into one digest that has the last of
// the hour's slots, and nothing that needs the owner is dropped. Settings >
// Alerts shows the limit and the hour's count.
// The spec runs its own daemon with a stand-in push service and a paired phone,
// sets the limit to 3, and has eight sessions ask a question within
// a minute (a question is pushed once it has waited 20 s unanswered).
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const ASKS = 8;
const LIMIT = 3;

test("eight questions in a minute give the limit's worth of pushes, the last of them a digest of the rest", async ({ page, playwright }) => {
  test.setTimeout(180_000);
  const state = join(ROOT, `push-budget-${Date.now()}`);
  for (const d of ["state", "work", "config"]) mkdirSync(join(state, d), { recursive: true });
  const sent: any[] = [];
  const fcm: Server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/token") return res.end(JSON.stringify({ access_token: "stand-in", expires_in: 3600 }));
      if (req.url?.endsWith("/messages:send")) { sent.push(JSON.parse(b).message); return res.end(JSON.stringify({ name: "projects/keel-e2e/messages/1" })); }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => fcm.listen(0, "127.0.0.1", r));
  const port = (fcm.address() as AddressInfo).port;
  execFileSync("bun", ["test/e2e/fixtures/fcm-account.ts", join(state, "config/fcm-service-account.json"), String(port)]);
  // (A session id that names no session: the login manager has no screen to call unlocked, so the owner is away.)
  const env = specEnv(state, { KEEL_FCM_URL: `http://127.0.0.1:${port}`, XDG_SESSION_ID: "keel-spec-no-session" }, join(state, "work"));
  const proc: ChildProcess = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const d = await listening(proc);
  const api = await playwright.request.newContext({ baseURL: d.url });
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => (await api.fetch(path, { method, data: body })).json() as Promise<any>;
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    // The default is said. (The page is not open yet: a page in front of the owner holds every push back.)
    expect((await call("/api/alerts/settings")).settings.push_per_hour).toBe(6);
    await call("/api/alerts/settings", { push_per_hour: LIMIT }, "PUT");

    // A phone with a push token.
    const phone = await new Phone(api).pair("Stand-in phone");
    expect((await phone.call("POST", "/v1/fcm", { token: "phone-push-token" })).status()).toBe(200);
    await expect.poll(async () => (await call("/api/alerts/settings")).channels.find((c: any) => c.id === "push")?.available).toBe(true);

    // Eight sessions ask, each its own question.
    const ids: string[] = [];
    for (let i = 0; i < ASKS; i++) {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: `Pick ${i}` });
      await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
      ids.push(session.id);
    }
    const asks = (i: number) => ({ name: "AskUserQuestion", input: { questions: [{ header: `Pick ${i}`, question: `Which of the colors for page ${i}?`, options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } });
    await Promise.all(ids.map((id, i) => call(`/api/sessions/${id}/messages`, { text: `script:calls ${JSON.stringify([asks(i)])}` })));
    const open = async () => ((await call("/api/alerts")).alerts as any[]).filter((a) => a.kind === "question" && a.open);
    await expect.poll(async () => (await open()).length, { timeout: 60_000 }).toBe(ASKS);

    // After the hold the budget has spent its slots: the limit's worth of pushes, no more.
    const budget = () => call("/api/mobile/budget");
    await expect.poll(async () => (await budget()).sent, { timeout: 60_000 }).toBe(LIMIT);
    // (The lasting notification of the running work is not an interruption and is not counted.)
    const pushes = sent.map((m) => m.data).filter((p) => p.t !== "live");
    expect(pushes).toHaveLength(LIMIT);
    const digests = pushes.filter((p) => p.ek === "digest");
    const alone = pushes.filter((p) => p.ek !== "digest");
    expect(digests).toHaveLength(1);
    expect(alone).toHaveLength(LIMIT - 1);
    expect(digests[0].body).toMatch(/^\d+ more: \d+ need you$/);
    expect(digests[0].pri).toBe("high");
    // Each question is in one push alone or counted in the digest, or still held for the next slot: none is lost.
    const folded = Number(digests[0].title.split(" ")[0]);
    expect(new Set(alone.map((p) => p.aid)).size).toBe(alone.length);
    expect(alone.length + folded + (await budget()).held).toBe(ASKS);
    expect((await open()).length).toBe(ASKS);

    // The page says the limit and the hour's count.
    await page.goto(`${d.url}/settings/alerts`);
    const line = page.getByTestId("push-budget-state");
    await expect(line).toContainText(`${LIMIT} of ${LIMIT} pushes in the last hour`);
    await expect(page.getByTestId("push-per-hour")).toHaveValue(String(LIMIT));
    await shoot(page, "push-budget-01-settings");
    // The limit is the owner's to set, in the page.
    await page.getByTestId("push-per-hour").fill("4");
    await page.getByTestId("push-per-hour").press("Enter");
    await expect.poll(async () => (await call("/api/alerts/settings")).settings.push_per_hour).toBe(4);
    await expect(line).toContainText(`${LIMIT} of 4 pushes in the last hour`);
  } finally {
    await api.dispose();
    proc.kill("SIGKILL");
    await new Promise<void>((r) => (proc.exitCode !== null ? r() : proc.once("exit", () => r())));
    fcm.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(`${state}-ws`, { recursive: true, force: true });
  }
});
