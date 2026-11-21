import { expect, test, type APIRequestContext } from "./isolate.ts";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { shoot } from "./shots.ts";

// Feature: the Keel phone app's side of the daemon. The workbench's pairing
// code opens the Keel app (keel://pair), with the Hermes app's link one click
// away; the /pair page a phone's browser opens hands the code to either app.
// A phone paired through the Keel link sees each chat's state (idle, done,
// needs you) and asks for its own push configuration by package.
const sha = (b: string) => createHash("sha256").update(b).digest("hex");
type Key = { priv: KeyObject; pub: string };
const key = (): Key => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { priv: privateKey, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};

class Phone {
  token = "";
  constructor(private http: APIRequestContext, readonly req = key(), readonly apr = key()) {}
  async call(method: "GET" | "POST" | "DELETE", path: string, data?: unknown, extra: Record<string, string> = {}) {
    const body = data === undefined ? "" : JSON.stringify(data);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign("sha256", Buffer.from(`${method}\n${path}\n${ts}\n${sha(body)}`), { key: this.req.priv, dsaEncoding: "der" }).toString("base64");
    return this.http.fetch(path, { method, data: body || undefined, headers: { authorization: `Bearer ${this.token}`, "x-hm-ts": ts, "x-hm-sig": sig, "content-type": "application/json", ...extra } });
  }
  approve(aid: string, choice: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    const msg = `approve2\n${aid}\n${choice}\n${sha("")}\n${ts}`;
    const asig = sign("sha256", Buffer.from(msg), { key: this.apr.priv, dsaEncoding: "der" }).toString("base64");
    return this.call("POST", `/v1/approvals/${aid}`, { choice }, { "x-hm-ts": ts, "x-hm-asig": asig, "x-hm-asig-v": "2" });
  }
}

test("the Keel app pairs by keel://, sees chat states and asks for its own push config", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models?.map((m: any) => m.id) ?? [];
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");

  // 1. The workbench's code opens the Keel app; the Hermes link is still offered.
  await page.goto("/settings/phone");
  await page.getByTestId("pair-url").fill("https://keel.example.test");
  await page.getByTestId("pair-show").click();
  const bundle = page.getByTestId("pair-bundle");
  await expect(bundle).toContainText("Open Keel on the phone");
  await expect(page.getByTestId("pair-hermes")).toHaveText("Copy the link for the Hermes app");
  await shoot(page, "keel-app-01-pair-code");
  const link = new URL((await bundle.getAttribute("data-link"))!);
  expect(link.protocol).toBe("keel:");
  expect(link.host + link.pathname).toBe("pair");
  expect(link.searchParams.get("u")).toBe("https://keel.example.test");
  const code = link.searchParams.get("c")!;

  // 2. The page a phone's browser opens hands the code to either app.
  await page.goto(`/pair?c=${encodeURIComponent(code)}`);
  const keelHref = new URL((await page.locator('a[data-app="keel"]').getAttribute("href"))!);
  expect(keelHref.protocol).toBe("keel:");
  expect(keelHref.searchParams.get("c")).toBe(code);
  expect((await page.locator('a[data-app="hermes"]').getAttribute("href"))!.startsWith("hermes://pair?")).toBe(true);
  await expect(page.getByRole("link", { name: "Open in Keel" })).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${process.env.KEEL_SHOTS ?? `${process.env.HOME}/.cache/keel-work/bun/shots`}/keel-app-02-pair-page-${scheme}.png` });
  }

  // 3. A phone pairs with the code from the Keel link.
  const phone = new Phone(request);
  const paired = await request.post("/v1/pair", { data: { code, pub: phone.req.pub, apub: phone.apr.pub, device_name: "Keel e2e phone", lock: true } });
  expect(paired.status()).toBe(200);
  const p = await paired.json();
  phone.token = p.token;

  try {
    // 4. Each chat says where it stands: idle before a turn, needs you while a
    // card waits, done after the reply.
    const { chat } = await (await phone.call("POST", "/v1/chats", { title: "Keel app states" })).json();
    // A chat made from the phone takes the daemon's default model, whatever that is on this daemon.
    // The states below are scripted: the chat is put on the stand-in, which makes the one call it is told to.
    expect((await request.patch(`/api/sessions/${chat.id}`, { data: { model: "scripted:stand-in" } })).status()).toBe(200);
    const statusOf = async () => (await (await phone.call("GET", "/v1/chats")).json()).chats.find((c: any) => c.id === chat.id)?.status;
    expect(await statusOf()).toBe("idle");
    const prompt = `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "touch keel-app-state.txt" } }])}`;
    expect((await phone.call("POST", `/v1/chats/${chat.id}/messages`, { text: prompt })).status()).toBe(200);
    await expect.poll(statusOf, { timeout: 30_000 }).toBe("needs_you");
    const sync = await (await phone.call("GET", "/v1/sync?since=0")).json();
    const card = sync.approvals.find((a: any) => a.chat_id === chat.id && a.state === "pending");
    expect(card.actions.map((a: string[]) => a[1])).toContain("once");
    expect((await phone.approve(card.id, "once")).status()).toBe(200);
    await expect.poll(statusOf, { timeout: 30_000 }).toBe("done");

    // 5. Push configuration is asked for by package; without push set up the
    // answer says so instead of handing out another app's entry.
    const cfg = await (await phone.call("GET", "/v1/push-config?app=dev.avifenesh.keel")).json();
    if (!cfg.enabled) expect(typeof cfg.missing).toBe("string");
    else expect(cfg.config.app_id).toBeTruthy();
  } finally {
    await phone.call("DELETE", `/v1/devices/${p.device_id}`);
  }
});
