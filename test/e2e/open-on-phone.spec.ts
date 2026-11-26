import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { Phone } from "./fixtures/phone-app.ts";
import { listening, specEnv } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: Open on phone. The session's menu sends this session to the phone already paired with
// the daemon: one push its notification opens, naming the session and the device, carrying no
// pairing code, token or words of the session but its title. The menu says whether the phone
// confirmed it, or that it may be offline; with no phone that can be reached the row is not there.
// The spec runs its own daemon with a stand-in push service and a paired stand-in phone.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

test("open on phone: the session's menu sends this session to the paired phone and says whether it arrived", async ({ page, playwright }) => {
  test.setTimeout(120_000);
  const state = join(ROOT, `open-on-phone-${Date.now()}`);
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
  const env = specEnv(state, { KEEL_FCM_URL: `http://127.0.0.1:${port}` }, join(state, "work"));
  const proc: ChildProcess = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const d = await listening(proc);
  const api = await playwright.request.newContext({ baseURL: d.url });
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => (await api.fetch(path, { method, data: body })).json() as Promise<any>;
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    // This daemon is on an origin of its own, which would open in Focus: the session's menu is the workbench's.
    await page.addInitScript(() => localStorage.setItem("keel.workbench", "true"));
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Fix the release notes" });
    const opens = () => sent.map((m) => m.data).filter((p) => p.t === "open");

    // No phone: the menu has no row, and the route says why nothing goes.
    await page.goto(`${d.url}/s/${session.id}`);
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByTestId("session-menu").click();
    await expect(page.getByTestId("menu-link")).toBeVisible();
    await expect(page.getByTestId("menu-open-phone")).toHaveCount(0);
    await page.keyboard.press("Escape");
    const none = await api.post(`/api/sessions/${session.id}/open-on-phone`);
    expect([none.status(), (await none.json()).error]).toEqual([409, "No phone is paired. Pair one in Settings > Phone."]);

    // A phone with a push token: the row is there.
    const phone = await new Phone(api).pair("Stand-in phone");
    expect((await phone.call("POST", "/v1/fcm", { token: "phone-push-token" })).status()).toBe(200);
    await page.getByTestId("session-menu").click();
    await expect(page.getByTestId("menu-open-phone")).toBeVisible();
    await expect(page.getByTestId("menu-open-phone")).toHaveText(/Open on phone/);
    await shoot(page, "open-on-phone-01-menu");

    // Sent, and the phone does not confirm it: it may be offline.
    await page.getByTestId("menu-open-phone").click();
    const tip = page.locator(".k-tip");
    await expect(tip).toHaveText(/^Sent to Stand-in phone, not confirmed yet: the phone may be offline/, { timeout: 20_000 });
    await shoot(page, "open-on-phone-02-not-confirmed");
    // The push names the session and the device, high, and holds no credential.
    expect(opens()).toHaveLength(1);
    const p = opens()[0];
    expect(p).toMatchObject({ t: "open", c: session.id, d: phone.id, title: "Fix the release notes", pri: "high" });
    expect(Object.keys(p).sort()).toEqual(["body", "c", "d", "ek", "n", "pri", "s", "t", "title"]);
    expect(JSON.stringify(p)).not.toContain(phone.token);

    // The phone confirms the next one as it comes: the menu says so.
    const acking = (async () => {
      await expect.poll(() => opens().length, { timeout: 15_000 }).toBe(2);
      expect((await phone.call("POST", "/v1/push/ack", { id: opens()[1].n })).status()).toBe(200);
    })();
    await page.getByTestId("session-menu").click();
    await page.getByTestId("menu-open-phone").click();
    await acking;
    await expect(tip).toHaveText("Sent to Stand-in phone. Tap the notification there.", { timeout: 20_000 });
    await shoot(page, "open-on-phone-03-confirmed");

    // A session this daemon does not have: nothing is sent.
    const gone = await api.post("/api/sessions/no-such-session/open-on-phone");
    expect([gone.status(), (await gone.json()).error]).toEqual([404, "No such session on this daemon."]);
    // A revoked phone: no row, and nothing goes.
    await call(`/api/mobile/devices/${phone.id}`, undefined, "DELETE");
    await page.reload();
    await page.getByTestId("session-menu").click();
    await expect(page.getByTestId("menu-link")).toBeVisible();
    await expect(page.getByTestId("menu-open-phone")).toHaveCount(0);
    expect((await api.post(`/api/sessions/${session.id}/open-on-phone`)).status()).toBe(409);
    expect(opens()).toHaveLength(2);
  } finally {
    await api.dispose();
    proc.kill("SIGKILL");
    await new Promise<void>((r) => (proc.exitCode !== null ? r() : proc.once("exit", () => r())));
    fcm.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(`${state}-ws`, { recursive: true, force: true });
  }
});
