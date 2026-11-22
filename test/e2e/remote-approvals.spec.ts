import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "./isolate.ts";
import { Phone, sig } from "./fixtures/phone-app.ts";
import { peerProblem } from "./peer.ts";
import { shoot } from "./shots.ts";

// Feature: an approval answered away from the page. The read-first rule is the
// daemon's: every client is given the whole text of a request, what in it can
// mislead and why it is held, and an allow of a request that one line does not
// show whole is taken only with the client's word that it showed all of it.
// A deny is taken from anywhere at once. A notification carries Allow only for
// a request its one line shows whole. The answer keeps who gave it.

const LONG = Array.from({ length: 41 }, (_, i) => `echo step ${i + 1} >> long.txt`).join("\n");
const OTHER = Array.from({ length: 41 }, (_, i) => `echo step ${i + 1} >> other.txt`).join("\n");
const MARKED = "echo txt.r \u202e> marked.txt";
const CALLS = [
  { name: "Bash", input: { command: LONG } },
  { name: "Bash", input: { command: "echo short > short.txt" } },
  { name: "Bash", input: { command: OTHER } },
  { name: "Bash", input: { command: MARKED } },
  { name: "Bash", input: { command: "sudo -n true" } },
];

async function scripted(request: APIRequestContext, base = "") {
  const models = (await (await request.get(`${base}/api/models`)).json()).models as { id: string; provider: string; context: number }[];
  return models.filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0]?.id;
}

// An answer as the app sends it: the request signed, and an allow signed by the approval key too.
function answer(request: APIRequestContext, phone: Phone, aid: string, body: { choice: string; seen?: string; via?: string }) {
  const path = `/v1/approvals/${aid}`, raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
  const empty = createHash("sha256").update("").digest("hex");
  const asig: Record<string, string> = body.choice === "deny" ? {} : { "x-hm-asig": sig(phone.apr, `approve2\n${aid}\n${body.choice}\n${empty}\n${ts}`), "x-hm-asig-v": "2" };
  return request.fetch(path, { method: "POST", data: raw, headers: { ...phone.headers("POST", path, raw, ts), ...asig } });
}

test("a phone, a notification and the API: an allow of unread text is held by the daemon", async ({ page, request }) => {
  const model = await scripted(request);
  test.skip(!model, "requires a scripted scratch daemon");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `remote-approvals-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { title: "Remote approvals", model, workspace: ws } })).json();
  const id = session.id as string;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify(CALLS)}` } });
  const all = async () => (await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as any[];
  await expect.poll(async () => (await all()).length, { timeout: 30_000 }).toBe(CALLS.length);
  const [long, short, other, marked, risky] = await all();
  expect([long.summary, short.summary, risky.risk]).toEqual([LONG, "echo short > short.txt", "high"]);

  // --- the one form, as any client reads it
  const form = async (a: any) => (await (await request.get(`/api/sessions/${id}/approvals/${a.id}`)).json()).card;
  expect(await form(long)).toMatchObject({ text: LONG, lines: 41, chars: LONG.length, risk: "low", hold: ["long"], marks: { hidden: 0, rtl: false, alike: [] } });
  expect(await form(short)).toMatchObject({ text: "echo short > short.txt", lines: 1, hold: [], choices: ["once", "session", "always", "deny"] });
  expect(await form(marked)).toMatchObject({ text: MARKED, hold: ["long", "marked"], marks: { hidden: 1 } });
  expect(await form(risky)).toMatchObject({ hold: ["risk"], choices: ["once", "deny"] });
  expect((await form(risky)).reason).toMatch(/^High risk/);
  expect((await form(long)).machine.far).toBe(false);

  // --- the phone is given the same: the whole text, and why it is held
  const phone = await new Phone(request).pair("Pixel stand-in");
  const cards = Object.fromEntries(((await (await phone.call("GET", `/v1/chats/${id}/run`)).json()).approvals as any[]).map((a) => [a.id, a]));
  expect(cards[long.id]).toMatchObject({ command: LONG, text: LONG, lines: 41, cut: false, hold: ["long"] });
  expect(cards[short.id]).toMatchObject({ text: "echo short > short.txt", hold: [] });
  expect(cards[marked.id]).toMatchObject({ command: "echo txt.r <U+202E>> marked.txt", text: "echo txt.r <U+202E>> marked.txt", hold: ["long", "marked"] });
  expect(cards[marked.id].notes.join(" ")).toContain("characters that do not show as written");
  expect(cards[risky.id].hold).toEqual(["risk"]);

  // --- a notification's actions for each shape, as the daemon would send them
  const alerts = (await (await request.get("/api/alerts?limit=200")).json()).alerts as any[];
  const pushOf = async (a: any) => {
    const alert = alerts.find((x) => x.data?.approval_id === a.id);
    expect(alert, `an alert for ${a.summary.slice(0, 30)}`).toBeTruthy();
    const { push } = await (await request.get(`/api/mobile/alerts/${alert.id}/push`)).json();
    return { opts: JSON.parse(push.data.opts), hold: push.data.hold, body: push.data.body };
  };
  expect(await pushOf(short)).toMatchObject({ opts: ["once", "session", "deny"], hold: "" });
  expect(await pushOf(long)).toMatchObject({ opts: ["deny"], hold: "long" });
  expect(await pushOf(other)).toMatchObject({ opts: ["deny"], hold: "long" });
  expect(await pushOf(marked)).toMatchObject({ opts: ["deny"], hold: "long,marked", body: "Bash: echo txt.r <U+202E>> marked.txt" });
  expect(await pushOf(risky)).toMatchObject({ opts: ["deny"], hold: "risk" });

  // --- a 41-line command cannot be allowed without `seen`: the sentence, and the card stays open
  const held = await answer(request, phone, long.id, { choice: "once" });
  expect(held.status()).toBe(409);
  expect(await held.json()).toMatchObject({ error: "Open the request to read it first: it is 41 lines long.", hold: ["long"], approval: { state: "pending" } });
  // Nor from a notification, whatever it says, nor by a standing answer, nor over the API with no word.
  expect((await answer(request, phone, long.id, { choice: "once", seen: "whole", via: "notification" })).status()).toBe(409);
  expect((await answer(request, phone, long.id, { choice: "session" })).status()).toBe(409);
  const bare = await request.post(`/api/sessions/${id}/approvals/${long.id}`, { data: { choice: "once" } });
  expect([bare.status(), (await bare.json()).hold]).toEqual([409, ["long"]]);
  const many = await request.post(`/api/sessions/${id}/approvals`, { data: { choice: "once", ids: [long.id] } });
  expect((await many.json()).results).toMatchObject([{ id: long.id, status: 409, state: "pending" }]);
  for (const a of [marked, risky]) expect((await answer(request, phone, a.id, { choice: "once" })).status()).toBe(409);
  expect((await all()).filter((a) => a.state === "pending").length).toBe(CALLS.length);
  expect(existsSync(join(ws, "long.txt"))).toBe(false);

  // --- with it, it can
  const ok = await answer(request, phone, long.id, { choice: "once", seen: "whole" });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).approval).toMatchObject({ state: "approved", from: "the phone (Pixel stand-in), its text shown whole" });
  // --- a short one is allowed as before, here from a notification
  expect((await answer(request, phone, short.id, { choice: "once", via: "notification" })).status()).toBe(200);
  // --- deny works at once, from anywhere
  expect((await answer(request, phone, other.id, { choice: "deny", via: "notification" })).status()).toBe(200);
  expect((await request.post(`/api/sessions/${id}/approvals/${marked.id}`, { data: { choice: "deny", reason: "not this one" } })).status()).toBe(200);
  expect((await answer(request, phone, risky.id, { choice: "deny" })).status()).toBe(200);

  // What ran is what was allowed, and each answer keeps who gave it and how.
  await expect.poll(async () => (await (await request.get(`/api/cli/state/${id}`)).json()).running, { timeout: 60_000 }).toBe(false);
  expect(readFileSync(join(ws, "long.txt"), "utf8").trim().split("\n").length).toBe(41);
  expect(existsSync(join(ws, "short.txt"))).toBe(true);
  expect([existsSync(join(ws, "other.txt")), existsSync(join(ws, "marked.txt"))]).toEqual([false, false]);
  const by = Object.fromEntries((await all()).map((a) => [a.id, [a.state, a.by]]));
  expect(by[long.id]).toEqual(["allowed", { client: "phone", device: "Pixel stand-in", seen: "whole" }]);
  expect(by[short.id]).toEqual(["allowed", { client: "notification", device: "Pixel stand-in" }]);
  expect(by[other.id]).toEqual(["denied", { client: "notification", device: "Pixel stand-in" }]);
  expect(by[marked.id]).toEqual(["denied", { client: "api" }]);
  expect(by[risky.id]).toEqual(["denied", { client: "phone", device: "Pixel stand-in" }]);

  // --- the timeline says where each was answered
  const rows = (await (await request.get(`/api/sessions/${id}/timeline`)).json()).rows as { kind: string; text: string }[];
  const said = rows.filter((r) => r.kind === "approval").map((r) => r.text.replace(/ after .*$/, ""));
  expect(said).toEqual(expect.arrayContaining([
    "Approval for Bash allowed once from the phone (Pixel stand-in), its text shown whole",
    "Approval for Bash allowed once from a notification (Pixel stand-in)",
    "Approval for Bash denied from a notification (Pixel stand-in)",
    "Approval for Bash denied from the API",
  ]));
  await page.goto(`/s/${id}`);
  await page.getByTestId("panel-menu").click();
  await page.getByTestId("panel-search").fill("timeline");
  await page.getByTestId("panel-pick-timeline").click();
  const panel = page.getByTestId("timeline-panel");
  await expect(panel.getByTestId("timeline-row").filter({ hasText: "allowed once from the phone (Pixel stand-in), its text shown whole" })).toBeVisible();
  await shoot(page, "remote-approvals-01-timeline");

  await request.delete(`/api/mobile/devices/${phone.id}`);
  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});

// The page keeps working as it did: its card says it showed the text, and that is taken.
test("the page's own Allow carries its word, and the answer says it came from the page", async ({ page, request }) => {
  const model = await scripted(request);
  test.skip(!model, "requires a scripted scratch daemon");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `remote-approvals-page-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { title: "Page approval", model, workspace: ws } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  const command = "echo one > a.txt\necho two >> a.txt\necho three >> a.txt";
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}` } });
  await page.goto(`/s/${session.id}`);
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible();
  const posted = page.waitForRequest((r) => r.method() === "POST" && /\/approvals\/[^/]+$/.test(new URL(r.url()).pathname));
  await expect(async () => { await card.getByTestId("allow-once").click(); await expect(card).toHaveCount(0, { timeout: 1500 }); }).toPass({ timeout: 20_000 });
  expect((await posted).postDataJSON()).toMatchObject({ choice: "once", seen: "whole", via: "page" });
  const [a] = (await (await request.get(`/api/sessions/${session.id}/approvals?all`)).json()).approvals;
  expect([a.state, a.by]).toEqual(["allowed", { client: "page", seen: "whole" }]);
  await expect.poll(() => existsSync(join(ws, "a.txt")), { timeout: 30_000 }).toBe(true);
});

// Two daemons stand in for two machines. A card of a session on the other one, answered here,
// goes through this daemon's forwarder: the daemon that owns the session decides, and the
// forwarder passes the client's word through as it came.
const PEER = process.env.KEEL_PEER_URL ?? "";
const ROOT = process.env.KEEL_PEER_ROOT ?? "";

test("a card of a session on another machine is held by the daemon that owns it", async ({ request }) => {
  test.skip(!PEER || !ROOT, "needs a second daemon: KEEL_PEER_URL and KEEL_PEER_ROOT");
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const model = await scripted(request, PEER);
  test.skip(!model, "the peer runs without the scripted provider");
  const old = (await (await request.get("/api/fleet/machines")).json()).machines.filter((m: any) => m.daemon_url === PEER).map((m: any) => m.id);
  for (const mid of old) await request.delete(`/api/fleet/machines/${mid}`);
  mkdirSync(ROOT, { recursive: true });
  const paired = await request.post("/api/fleet/machines", { data: { name: "approvals-peer", daemon_url: PEER, workspace_root: ROOT } });
  expect(paired.status()).toBe(201);
  const mid = (await paired.json()).id;
  try {
    const { session } = await (await request.post(`${PEER}/api/sessions`, { data: { workspace: ROOT, title: "Far approvals", model } })).json();
    await request.put(`${PEER}/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    await request.post(`${PEER}/api/sessions/${session.id}/messages`, { data: { text: `script:batch ${JSON.stringify([{ name: "Bash", input: { command: "echo a > far-a.txt\necho b > far-b.txt" } }, { name: "Bash", input: { command: "echo c > far-c.txt" } }])}` } });
    const fwd = `/api/fleet/machines/${mid}/api/sessions/${session.id}/approvals`;
    const far = async () => (await (await request.get(`${PEER}/api/sessions/${session.id}/approvals?all`)).json()).approvals as any[];
    await expect.poll(async () => (await far()).length, { timeout: 30_000 }).toBe(2);
    const [long, short] = await far();
    // The relayed card carries the same form: the whole text, and why it is held.
    expect((await (await request.get(`${fwd}/${long.id}`)).json()).card).toMatchObject({ text: long.summary, lines: 2, hold: ["long"] });
    // An allow with no word is held over there; the forwarder adds none.
    const held = await request.post(`${fwd}/${long.id}`, { data: { choice: "once" } });
    expect([held.status(), (await held.json()).hold]).toEqual([409, ["long"]]);
    expect((await far())[0].state).toBe("pending");
    // The client's own word passes through, and the answer says which machine it came through.
    expect((await request.post(`${fwd}/${long.id}`, { data: { choice: "once", seen: "whole", via: "page" } })).status()).toBe(200);
    expect((await request.post(`${fwd}/${short.id}`, { data: { choice: "deny" } })).status()).toBe(200);
    const [a, b] = await far();
    expect([a.state, a.by.client, a.by.seen, typeof a.by.peer]).toEqual(["allowed", "page", "whole", "string"]);
    expect([b.state, b.by.client]).toEqual(["denied", "api"]);
    await request.delete(`${PEER}/api/sessions/${session.id}`);
  } finally {
    await request.delete(`/api/fleet/machines/${mid}`);
  }
});
