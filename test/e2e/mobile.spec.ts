import { expect, test, type APIRequestContext } from "./isolate.ts";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the phone. The workbench shows a one-time pairing QR; a simulated
// phone app pairs with it, signing every request as the app does (P-256,
// canonical Base64, replay protected), registers a push token, prompts a
// session and approves its tool call with the separate approval key. A replayed
// request and a replayed approval are refused. A test push from the device row
// reaches a stand-in push service and the phone confirms it; the approval,
// answered within the push hold, is never pushed. Revoking from the workbench
// cuts the phone off.
//
// The daemon runs with KEEL_FCM_URL=http://127.0.0.1:<FCM_PORT> and a
// service-account file whose token_uri points at the same stand-in.
const FCM_PORT = Number(process.env.KEEL_TEST_FCM_PORT ?? 47993);

type Key = { priv: KeyObject; pub: string };
const key = (): Key => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { priv: privateKey, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
const sig = (k: Key, msg: string) => sign("sha256", Buffer.from(msg), { key: k.priv, dsaEncoding: "der" }).toString("base64");
const sha = (b: string) => createHash("sha256").update(b).digest("hex");

// The phone app's request signer: METHOD\npath?query\nts\nsha256(body).
class Phone {
  token = "";
  id = "";
  seq = 0;
  constructor(private http: APIRequestContext, readonly req = key(), readonly apr = key()) {}
  headers(method: string, path: string, body: string, ts = String(Math.floor(Date.now() / 1000))) {
    return { authorization: `Bearer ${this.token}`, "x-hm-ts": ts, "x-hm-sig": sig(this.req, `${method}\n${path}\n${ts}\n${sha(body)}`), "content-type": "application/json" };
  }
  async call(method: "GET" | "POST" | "DELETE", path: string, data?: unknown, extra: Record<string, string> = {}) {
    const body = data === undefined ? "" : JSON.stringify(data);
    const headers = { ...this.headers(method, path, body), ...extra };
    return this.http.fetch(path, { method, headers, data: body || undefined });
  }
}

test("pair a phone, approve from it, push, revoke", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;

  // A stand-in push service: hands out an access token and records messages.
  const sent: any[] = [];
  const fcm: Server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/token") return res.end(JSON.stringify({ access_token: "stand-in", expires_in: 3600 }));
      if (req.url?.endsWith("/messages:send") && req.headers.authorization === "Bearer stand-in") {
        sent.push(JSON.parse(b).message);
        return res.end(JSON.stringify({ name: "projects/keel-e2e/messages/1" }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => fcm.listen(FCM_PORT, "127.0.0.1", r));

  try {
    // 1. The workbench shows a pairing code for the address the phone uses.
    await page.goto("/settings/phone");
    const panel = page.getByTestId("phone-panel");
    await expect(panel).toBeVisible();
    const pushState = page.getByTestId("push-state");
    await expect(pushState).toHaveText(/Push is/);
    test.skip(!/set up/.test(await pushState.innerText()),
      "the daemon runs without push: start it with KEEL_FCM_URL=http://127.0.0.1:<KEEL_TEST_FCM_PORT> and KEEL_CONFIG_DIR holding the account from test/e2e/fixtures/fcm-account.ts");
    await expect(pushState).toHaveText("Push is set up");
    await page.getByTestId("pair-url").fill("https://keel.example.test");
    await page.getByTestId("pair-show").click();
    const bundle = page.getByTestId("pair-bundle");
    await expect(page.getByTestId("pair-qr").locator("svg")).toBeVisible();
    await shoot(page, "mobile-01-pair-qr");
    const link = new URL((await bundle.getAttribute("data-link"))!);
    expect(link.protocol).toBe("hermes:");
    expect(link.searchParams.get("u")).toBe("https://keel.example.test");
    const code = link.searchParams.get("c")!;

    // 2. The phone pairs. Equal request and approval keys are refused.
    const phone = new Phone(request);
    const health = await (await request.get("/v1/health")).json();
    expect(health.security.signature_replay).toBe(2);
    expect((await request.post("/v1/pair", { data: { code, pub: phone.req.pub, apub: phone.req.pub, device_name: "Pixel" } })).status()).toBe(400);
    const pairRes = await request.post("/v1/pair", { data: { code, pub: phone.req.pub, apub: phone.apr.pub, device_name: "Pixel 9 Pro", lock: true } });
    expect(pairRes.status()).toBe(200);
    const paired = await pairRes.json();
    phone.token = paired.token;
    phone.id = paired.device_id;
    // The code was good once.
    expect((await request.post("/v1/pair", { data: { code, pub: key().pub, apub: key().pub } })).status()).toBe(403);
    await expect(page.getByTestId("pair-done")).toContainText("Pixel 9 Pro");
    const row = page.locator(`[data-device="${phone.id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("phone-push")).toContainText("No push token");

    // 3. Signed requests work; the same signed request again is a replay.
    const ts = String(Math.floor(Date.now() / 1000));
    const meHeaders = phone.headers("GET", "/v1/me", "", ts);
    expect((await request.get("/v1/me", { headers: meHeaders })).status()).toBe(200);
    expect((await request.get("/v1/me", { headers: meHeaders })).status()).toBe(401);
    expect((await request.get("/v1/me", { headers: { ...phone.headers("GET", "/v1/me", ""), "x-hm-sig": meHeaders["x-hm-sig"] } })).status()).toBe(401);

    // 4. The phone registers its push token; the row says push is on.
    expect((await phone.call("POST", "/v1/fcm", { token: "phone-push-token" })).status()).toBe(200);
    await expect(row.getByTestId("phone-push")).toContainText("Push on");

    // 5. The phone prompts a session in ask mode; the command asks for approval.
    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `phone-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    const sync0 = await (await phone.call("GET", "/v1/sync?since=0")).json();
    expect(sync0.chats.some((c: any) => c.id === session.id)).toBe(true);
    const cursor = sync0.seq;
    // The live stream starts with hello and carries what follows.
    const base = process.env.KEEL_URL ?? "http://127.0.0.1:47961";
    const stream = await fetch(`${base}/v1/events`, { headers: phone.headers("GET", "/v1/events", "") });
    const frames: any[] = [];
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream.body as any) {
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) frames.push(JSON.parse(buf.slice(0, i).replace(/^data: /, "")));
      }
    })().catch(() => {});
    await expect.poll(() => frames[0]?.type).toBe("hello");
    const posted = await (await phone.call("POST", `/v1/chats/${session.id}/messages`, { text: "Run exactly this Bash command and nothing else: touch phone.txt. Then reply with one word: ok." })).json();
    expect(posted.message.role).toBe("user");
    expect((await phone.call("POST", "/v1/chats/no-such-chat/messages", { text: "hi" })).status()).toBe(404);

    let approval: any;
    await expect.poll(async () => {
      const s = await (await phone.call("GET", `/v1/sync?since=${cursor}`)).json();
      approval = s.approvals.find((a: any) => a.chat_id === session.id);
      return s.messages.some((m: any) => m.id === posted.message.id) && !!approval;
    }, { timeout: 90_000, intervals: [1000] }).toBe(true);
    expect(approval.command).toContain("touch phone.txt");
    expect(frames.some((f) => f.type === "message" && f.message.id === posted.message.id)).toBe(true);
    expect(frames.some((f) => f.type === "approval" && f.approval.id === approval.id)).toBe(true);
    expect(approval.actions.map((a: string[]) => a[1])).toContain("once");

    // The workbench shows the same card.
    await page.goto(`/s/${session.id}`);
    await expect(page.getByTestId("approval")).toBeVisible();
    await shoot(page, "mobile-02-card-waiting-on-phone");

    // 6. Without the approval key's signature it is refused; with it, allowed.
    const path = `/v1/approvals/${approval.id}`;
    expect((await phone.call("POST", path, { choice: "once" })).status()).toBe(403);
    const ats = String(Math.floor(Date.now() / 1000));
    const asig = sig(phone.apr, `approve\n${approval.id}\nonce\n${ats}`);
    const ok = await phone.call("POST", path, { choice: "once" }, { "x-hm-ts": ats, "x-hm-asig": asig, ...signedAt(phone, "POST", path, { choice: "once" }, ats) });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).approval.state).toBe("approved");
    await expect(page.getByTestId("approval")).toHaveCount(0);
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
    expect(existsSync(join(ws, "phone.txt"))).toBe(true);
    // The card was an alert for the phone too, held for 20 s: answered within
    // them, it is never pushed.
    expect(sent.some((m) => m.data.t === "approval")).toBe(false);
    // Replaying the approval signature (in a freshly signed request) is refused.
    const again = await phone.call("POST", path, { choice: "once" }, { "x-hm-ts": ats, "x-hm-asig": asig, ...signedAt(phone, "POST", path, { choice: "once" }, ats) });
    expect(again.status()).toBe(403);
    // The phone reads the reply from its cursor.
    const after = await (await phone.call("GET", `/v1/sync?since=${cursor}`)).json();
    expect(after.messages.some((m: any) => m.role === "agent" && m.chat_id === session.id)).toBe(true);
    expect(after.approvals.some((a: any) => a.id === approval.id)).toBe(false);

    // The session's Loops are the phone's cron jobs; it can pause one.
    const loop = await (await request.post("/api/loops", { data: { session_id: session.id, name: "phone loop", prompt: "say ok", schedule: "daily" } })).json();
    const jobs = (await (await phone.call("GET", "/v1/cron")).json()).jobs;
    expect(jobs.find((j: any) => j.id === loop.id)).toMatchObject({ name: "phone loop", enabled: true });
    expect((await (await phone.call("POST", `/v1/cron/${loop.id}/pause`)).json()).job.enabled).toBe(false);
    await request.delete(`/api/loops/${loop.id}`);

    // 7. A test push from the device row reaches the push service; the phone confirms it.
    await page.goto("/settings/phone");
    await row.getByTestId("phone-test").click();
    await expect(row.getByTestId("phone-note")).toContainText("Sent");
    const t = sent.filter((m) => m.data.t === "test");
    expect(t).toHaveLength(1);
    expect(t[0].token).toBe("phone-push-token");
    expect(t[0].android.priority).toBe("HIGH");
    await expect(row.getByTestId("phone-push")).toContainText("not confirmed yet");
    expect((await phone.call("POST", "/v1/push/ack", { id: t[0].data.n })).status()).toBe(200);
    await expect(row.getByTestId("phone-push")).toContainText("confirmed by the phone");
    await shoot(page, "mobile-03-device-pushed");

    // 8. Revoking from the workbench cuts the phone off.
    await row.getByTestId("phone-revoke").click();
    await page.getByRole("button", { name: "Revoke" }).last().click();
    await expect(row).toHaveCount(0);
    expect((await phone.call("GET", "/v1/me")).status()).toBe(401);
    await stream.body?.cancel().catch(() => {});
    await shoot(page, "mobile-04-revoked");

    const errs = (await (await request.get("/api/errors")).json()).errors;
    expect(errs.length - errorsBefore, JSON.stringify(errs.slice(0, 3))).toBe(0);
  } finally {
    await new Promise((r) => fcm.close(r));
  }
});

// Request signature headers for a given timestamp (the app signs the request
// and the approval with the same X-HM-Ts). ECDSA signatures are randomized, so
// each call is a new request signature.
function signedAt(p: Phone, method: string, path: string, data: unknown, ts: string) {
  const h = p.headers(method, path, JSON.stringify(data), ts);
  return { "x-hm-sig": h["x-hm-sig"] };
}
