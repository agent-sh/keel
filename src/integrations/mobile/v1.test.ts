// The phone API's contract with the unchanged Hermes app: what its sync,
// chat, run and usage answers carry, and what its push health says. These are
// shapes no browser e2e reaches; the app's own reading of them is cited per test.
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { Store } from "../../core/store.ts";
import { setDeps } from "../../automation/core.ts";
import * as alerts from "../../automation/alerts.ts";
import { setAttachmentsRoot } from "../../engine/attachments.ts";
import { ask } from "../../tools/interact.ts";
import { sha256Hex } from "./sig.ts";
import { MobileStore } from "./store.ts";
import { mobileApi } from "./v1.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-mobile-"));
const store = new Store(dir);
const bus = new Bus();
setDeps({ store, bus, errors: { capture() {} } } as any);
alerts.migrate();
setAttachmentsRoot(dir);
const mobile = new MobileStore(store);
const running = new Set<string>();
const sent: any[] = [];
const engine = {
  isRunning: (id: string) => running.has(id),
  send: (id: string, text: string, opts: any) => { sent.push({ id, text, opts }); return { event: store.append(id, "user", { text, images: opts.images?.length ? opts.images : undefined }) }; },
  interrupt: async () => {},
};
const providers = { models: async () => [], marked: (m: any) => m, defaultModel: async () => "fx:default", resolve: async () => ({}) };
const routes: any = mobileApi({ store, bus, engine, providers, errors: { capture() {} }, workspace: dir, mobile, gate: () => undefined, changed() {} } as any);
afterAll(() => setSystemTime());

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const akey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const apub = akey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const dev = mobile.claimPairCode(mobile.createPairCode(600), "phone", pub, apub, false)!;

// A signed request to a route, as the app signs it.
async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign("sha256", Buffer.from(`${method}\n${path}\n${ts}\n${sha256Hex(raw)}`), { key: privateKey, dsaEncoding: "der" }).toString("base64");
  const pathname = path.split("?")[0]!;
  for (const [pattern, handlers] of Object.entries(routes)) {
    const names: string[] = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`);
    const m = pathname.match(re);
    if (!m || !(handlers as any)[method]) continue;
    const req: any = new Request(`http://x${path}`, { method, body: raw || undefined, headers: { authorization: `Bearer ${dev.token}`, "x-hm-ts": ts, "x-hm-sig": sig, ...extra } });
    req.params = Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
    const res: Response = await (handlers as any)[method](req, { requestIP: () => null, timeout() {} });
    return { status: res.status, body: await res.json() };
  }
  throw new Error(`no route ${method} ${path}`);
}
const session = (title = "") => store.createSession({ model: "fx:saved", workspace: dir, title });

describe("messages", () => {
  test("an unfinished reply keeps its text and says how it ended; harness input is not the owner's", async () => {
    const parent = session("Parent A");
    const s = store.updateSession(session("Review").id, {} as any);
    if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
    store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, s.id);
    store.append(s.id, "user", { text: "status ok" });
    store.append(s.id, "user", { text: "Task:\nstatus ok", kind: "task", agent_id: "ag1" });
    store.append(s.id, "user", { text: '<subagent_result agent_id="ag2" title="Child" status="done">\nstatus ok\n</subagent_result>', kind: "subagent", agent_id: "ag2" });
    store.append(s.id, "user", { text: '<wait_fired id="w1" kind="timer" outcome="fired">\nstatus ok\n</wait_fired>', kind: "wait", wait_id: "w1" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Checked file A." }], stop: "interrupted", model: "p:alpha" });
    store.append(s.id, "turn_end", { reason: "interrupted" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Checked file A." }], stop: "end_turn" });
    store.append(s.id, "turn_end", { reason: "end_turn" });
    store.append(s.id, "turn_end", { reason: "restart" });
    const { body } = await call("GET", `/v1/chats/${s.id}/messages`);
    const m = body.messages;
    expect(m.filter((x: any) => x.role === "user").map((x: any) => x.content)).toEqual(["status ok"]);
    const task = m.find((x: any) => x.meta.origin === "task");
    expect(task).toMatchObject({ role: "agent", meta: { parent_id: parent.id } });
    expect(task.content).toContain("Task from Parent A");
    expect(m.find((x: any) => x.meta.origin === "subagent")).toMatchObject({ role: "agent", meta: { agent_id: "ag2" } });
    expect(m.find((x: any) => x.meta.origin === "wait").content).toContain("Woken: timer fired");
    const replies = m.filter((x: any) => x.kind === "text" && x.role === "agent" && x.content === "Checked file A.");
    expect(replies.map((x: any) => x.meta.stop ?? null)).toEqual(["interrupted", null]);
    expect(m.filter((x: any) => x.kind === "status").map((x: any) => x.meta.outcome)).toEqual(["interrupted", "restart"]);
    // A reply's tool calls follow its words as one trace row.
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] });
    const after = (await call("GET", `/v1/chats/${s.id}/messages`)).body.messages.slice(-2);
    expect(after.map((x: any) => x.kind)).toEqual(["text", "trace"]);
    expect(after[1].meta.steps).toEqual([{ tool: "Bash", what: "ls" }]);
    // The chat names its parent.
    const chats = (await call("GET", "/v1/chats")).body.chats;
    expect(chats.find((c: any) => c.id === s.id).parent_id).toBe(parent.id);
    expect(chats.find((c: any) => c.id === parent.id).parent_id).toBeNull();
  });

  test("a committed queued prompt takes its queue receipt's id; same-millisecond events keep their order", async () => {
    setSystemTime(new Date("2026-01-01T09:00:00Z"));
    const s = session();
    const q = store.enqueue(s.id, "same", false);
    store.append(s.id, "user", { text: "same", origin: "queued", queue_id: q.id });
    store.append(s.id, "user", { text: "question" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "answer" }], stop: "end_turn" });
    setSystemTime();
    const { body } = await call("GET", `/v1/sync?since=0`);
    const mine = body.messages.filter((x: any) => x.chat_id === s.id);
    expect(mine[0].id).toBe(q.id);
    // The app picks its inbox line from the latest ts (first wins on a tie).
    const last = mine.reduce((a: any, b: any) => (b.ts > a.ts ? b : a));
    expect(last.content).toBe("answer");
    const chat = body.chats.find((c: any) => c.id === s.id);
    expect(chat).toMatchObject({ preview: "answer", last_role: "agent" });
  });

  test("only the shown branch reaches the chat; the other branch is marked deleted for the app", async () => {
    const s = session();
    const base = store.append(s.id, "user", { text: "base" });
    const old = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "old" }] }, base.id);
    const neu = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "new" }] }, base.id);
    const shown = async () => (await call("GET", `/v1/chats/${s.id}/messages?limit=150`)).body.messages;
    let m = await shown();
    expect(m.filter((x: any) => x.kind !== "deleted").map((x: any) => x.content)).toEqual(["base", "new"]);
    expect(m.find((x: any) => x.id === old.id).kind).toBe("deleted");
    store.updateSession(s.id, { head: old.id });
    m = await shown();
    expect(m.filter((x: any) => x.kind !== "deleted").map((x: any) => x.content)).toEqual(["base", "old"]);
    expect(m.find((x: any) => x.id === neu.id).kind).toBe("deleted");
  });

  test("a client that pages gets the newest page and the page before it", async () => {
    const s = session();
    for (let i = 1; i <= 301; i++) store.append(s.id, "user", { text: `row-${i}` });
    const all = (await call("GET", `/v1/chats/${s.id}/messages?limit=150`)).body;
    expect(all.messages).toHaveLength(301);
    const p1 = (await call("GET", `/v1/chats/${s.id}/messages?limit=150&paged=1`)).body;
    expect([p1.messages[0].content, p1.messages.at(-1).content]).toEqual(["row-152", "row-301"]);
    const p2 = (await call("GET", `/v1/chats/${s.id}/messages?limit=150&before=${p1.older}`)).body;
    const p3 = (await call("GET", `/v1/chats/${s.id}/messages?limit=150&before=${p2.older}`)).body;
    expect([p2.messages[0].content, p2.messages.at(-1).content, p3.messages.map((x: any) => x.content), p3.older]).toEqual(["row-2", "row-151", ["row-1"], null]);
    // A phone starting from nothing gets this chat's newest page, at the current cursor, and pages the rest.
    const first = (await call("GET", "/v1/sync?since=0")).body;
    const mine = first.messages.filter((x: any) => x.chat_id === s.id).map((x: any) => x.content);
    expect([mine.length, mine.at(-1), first.seq, first.more, first.complete]).toEqual([40, "row-301", mobile.globalSeq(), false, true]);
  });

  test("a sync page is never filled with events the app does not show", async () => {
    const s = session();
    const from = mobile.globalSeq();
    for (let i = 0; i < 2001; i++) store.append(s.id, "note", { text: "n" });
    store.append(s.id, "user", { text: "sentinel" });
    const { body } = await call("GET", `/v1/sync?since=${from}`);
    expect(body.messages.map((x: any) => x.content)).toEqual(["sentinel"]);
    expect(body.more).toBe(false);
  });
});

describe("chats", () => {
  test("read is shared with the workbench, pin is kept, an unknown profile makes no chat", async () => {
    const a = session("A"), b = session("B");
    for (const sid of [a.id, b.id]) store.db.query("INSERT INTO alerts (id, ts, kind, session_id, title, body, read, data, channels) VALUES (?, ?, 'approval', ?, 't', 'b', 0, '{}', '[]')").run(`al-${sid}`, Date.now(), sid);
    const unread = async () => Object.fromEntries((await call("GET", "/v1/chats")).body.chats.map((c: any) => [c.id, c.unread]));
    expect([(await unread())[a.id], (await unread())[b.id]]).toEqual([1, 1]);
    expect((await call("POST", `/v1/chats/${a.id}/read`)).status).toBe(200);
    expect([(await unread())[a.id], (await unread())[b.id], alerts.unreadCounts().sessions[a.id] ?? 0]).toEqual([0, 1, 0]);

    expect((await call("PATCH", `/v1/chats/${a.id}`, { pinned: 1 })).body.chat.pinned).toBe(1);
    expect(store.session(a.id)!.settings.pinned_ms).toBeNumber();
    expect((await call("PATCH", `/v1/chats/${a.id}`, { pinned: 0 })).body.chat.pinned).toBe(0);

    const before = store.sessions().length;
    const r = await call("POST", "/v1/chats", { title: "x", profile: "retired-fixture" });
    expect(r.status).toBe(409);
    expect(store.sessions().length).toBe(before);
    expect((await call("POST", "/v1/chats", { title: "x", profile: "default" })).status).toBe(200);
  });

  test("a photo goes with its caption or the message is refused", async () => {
    const s = session();
    const png: Uint8Array<ArrayBuffer> = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const up: any = await routes["/v1/upload"].POST(Object.assign(signedRaw("POST", "/v1/upload?name=a.png&mime=image/png", png), { params: {} }), {});
    const att = await up.json();
    sent.length = 0;
    expect((await call("POST", `/v1/chats/${s.id}/messages`, { text: "", attachments: [{ id: "f".repeat(64) }] })).status).toBe(400);
    expect((await call("POST", `/v1/chats/${s.id}/messages`, { text: "look", attachments: [{ id: "f".repeat(64) }] })).status).toBe(400);
    expect(sent).toHaveLength(0);
    expect((await call("POST", `/v1/chats/${s.id}/messages`, { text: "look", attachments: [att] })).status).toBe(200);
    const back = await call("POST", `/v1/chats/${s.id}/messages`, { text: "", attachments: [att] });
    expect(back.status).toBe(200);
    // The owner's bubble shows the photo it carried: named in the message, served by /v1/media.
    const shown = back.body.message.meta.attachments[0];
    expect(shown).toMatchObject({ kind: "image", mime: "image/png" });
    const img: Response = await routes["/v1/media/:id"].GET(Object.assign(signedRaw("GET", `/v1/media/${shown.media}`, new Uint8Array()), { params: { id: shown.media } }), {});
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(png);
    expect(sent.map((x) => [x.text, x.opts.images?.[0]?.type, x.opts.images?.[0]?.data === Buffer.from(png).toString("base64")])).toEqual([["look", "image", true], ["", "image", true]]);
  });
});

describe("questions", () => {
  test("a pending question keeps its words however far back; several questions need one answer each", async () => {
    const s = session();
    const input = { questions: [{ id: "build", question: "Build type?", options: [{ label: "Debug" }, { label: "Release" }] }, { id: "checks", question: "Which checks?", options: [{ label: "Unit" }, { label: "Integration" }] }] };
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "call-q", name: "AskUserQuestion", input }] });
    let got: any;
    ask({ callId: "call-q", sessionId: s.id, signal: new AbortController().signal } as any).then((a) => (got = a));
    for (let i = 0; i < 45; i++) store.append(s.id, "note", { text: "later" });
    const card = (await call("GET", `/v1/chats/${s.id}/run`)).body.approvals.find((a: any) => a.id === "q-call-q");
    expect(card.command).toBe("Build type?\nWhich checks?");
    expect(card.questions.map((q: any) => q.options)).toEqual([["Debug", "Release"], ["Unit", "Integration"]]);
    // The card has its place in the chat, where the app answers it.
    const inChat = (await call("GET", `/v1/chats/${s.id}/messages`)).body.messages.find((m: any) => m.kind === "approval");
    expect(inChat.meta).toMatchObject({ approval_id: "q-call-q", card: "question", state: "pending" });
    // Answers are signed with the approval key over what they say.
    const answer = (body: any, text: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const asig = sign("sha256", Buffer.from(`approve2\nq-call-q\nonce\n${sha256Hex(text)}\n${ts}`), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
      return call("POST", "/v1/approvals/q-call-q", { choice: "once", ...body }, { "x-hm-asig": asig, "x-hm-asig-v": "2" });
    };
    // One scalar for two questions is refused, and so is an answer that leaves one out.
    expect((await answer({ answer: "Debug" }, "Debug")).status).toBe(400);
    const partial = { build: "Debug" };
    expect((await answer({ answers: partial }, JSON.stringify([["build", "Debug"]]))).status).toBe(400);
    expect(got).toBeUndefined();
    const both = { build: "Debug", checks: ["Integration"] };
    expect((await answer({ answers: both }, JSON.stringify([["build", "Debug"], ["checks", ["Integration"]]]))).status).toBe(200);
    await Bun.sleep(0);
    expect(got).toEqual({ build: { picked: ["Debug"] }, checks: { picked: ["Integration"] } });
  });

  test("a question answered elsewhere comes back closed in the next sync", async () => {
    const s = session();
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "call-c", name: "AskUserQuestion", input: { question: "Go?", type: "yesno" } }] });
    const ac = new AbortController();
    const p = ask({ callId: "call-c", sessionId: s.id, signal: ac.signal } as any);
    const from = mobile.globalSeq();
    let cards = (await call("GET", `/v1/sync?since=${from}`)).body.approvals.filter((a: any) => a.id === "q-call-c");
    expect(cards.map((c: any) => c.state)).toEqual(["pending"]);
    ac.abort();
    await p;
    cards = (await call("GET", `/v1/sync?since=${from}`)).body.approvals.filter((a: any) => a.id === "q-call-c");
    expect(cards.map((c: any) => c.state)).toEqual(["expired"]);
  });
});

describe("run, usage and pulse", () => {
  test("Run lists the latest turn's calls and names the saved model; usage counts every input token", async () => {
    const s = session();
    running.add(s.id);
    store.append(s.id, "user", { text: "go" });
    store.append(s.id, "turn_start", {});
    const steps = async () => (await call("GET", `/v1/chats/${s.id}/run`)).body;
    expect((await steps()).steps).toHaveLength(0);
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "t1", name: "fixture_lookup", input: { query: "q" } }], model: "fx:saved" });
    store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "t1", content: "secret output" }] });
    const mid = await steps();
    expect(mid.steps.map((x: any) => [x.tool, x.what])).toEqual([["fixture_lookup", "q"]]);
    expect(JSON.stringify(mid)).not.toContain("secret output");
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "done" }], model: "fx:saved" });
    store.append(s.id, "turn_end", { reason: "end_turn", usage: { input: 200, output: 5, cache_read: 30, cache_write: 4 } });
    running.delete(s.id);
    const idle = await steps();
    expect([idle.steps.length, idle.session.model]).toEqual([1, "fx:saved"]);
    store.updateSession(s.id, { usage: { input: 300, output: 15, cache_read: 50, cache_write: 4 } as any });
    const u = (await call("GET", `/v1/chats/${s.id}/usage`)).body;
    expect(u.session.prompt_tokens + u.session.output_tokens).toBe(369);
    expect([u.turn.prompt_tokens, u.turn.output_tokens, u.turn.calls]).toEqual([234, 5, 2]);
    store.append(s.id, "turn_start", {});
    running.add(s.id);
    expect((await steps()).steps).toHaveLength(0);
    running.delete(s.id);
  });

  test("the elapsed time counts from the turn's start, not its newest event", async () => {
    setSystemTime(new Date("2026-02-01T10:00:00Z"));
    const s = session();
    store.append(s.id, "turn_start", {});
    running.add(s.id);
    setSystemTime(new Date("2026-02-01T10:00:40Z"));
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x" }] });
    setSystemTime(new Date("2026-02-01T10:00:50Z"));
    const w = (await call("GET", "/v1/sync?since=0")).body.working.find((x: any) => x.chat_id === s.id);
    expect(Date.now() / 1000 - w.since).toBe(50);
    // The next turn, before its start is stored: it counts from now, not from the previous turn.
    store.append(s.id, "turn_end", { reason: "end_turn" });
    setSystemTime(new Date("2026-02-01T10:02:00Z"));
    store.append(s.id, "user", { text: "next" });
    const w2 = (await call("GET", "/v1/sync?since=0")).body.working.find((x: any) => x.chat_id === s.id);
    expect(Date.now() / 1000 - w2.since).toBe(0);
    running.delete(s.id);
    setSystemTime();
  });

  test("Pulse: seven day bars, unpriced turns apart, cron fails from failed runs only", async () => {
    store.db.run("PRAGMA foreign_keys = OFF");
    store.db.run("CREATE TABLE IF NOT EXISTS loop_runs (id TEXT PRIMARY KEY, loop_id TEXT, session_id TEXT, due_ms INTEGER, started_ms INTEGER, ended_ms INTEGER, ok INTEGER, detail TEXT, skip_reason TEXT, stop INTEGER NOT NULL DEFAULT 0)");
    const before = (await call("GET", "/v1/pulse")).body;
    const s = session();
    // A manual turn that failed is not a cron failure.
    store.append(s.id, "turn_start", {});
    store.append(s.id, "error", { message: "boom" });
    store.append(s.id, "turn_end", { reason: "error", usage: { cost: 1 } });
    store.append(s.id, "turn_end", { reason: "end_turn", usage: {} });
    const now = Date.now();
    store.db.query("INSERT INTO loop_runs (id, loop_id, session_id, due_ms, ended_ms, ok) VALUES ('run-f', 'l1', ?, ?, ?, 0)").run(s.id, now, now);
    store.db.query("INSERT INTO loop_runs (id, loop_id, session_id, due_ms, ended_ms, ok, skip_reason) VALUES ('run-s', 'l1', ?, ?, ?, 0, 'busy')").run(s.id, now, now);
    const p = (await call("GET", "/v1/pulse")).body;
    expect(p.spend_7d).toHaveLength(7);
    expect(p.spend_7d[6] - before.spend_7d[6]).toBeCloseTo(1);
    expect(p.spend_7d_unpriced[6] - before.spend_7d_unpriced[6]).toBe(1);
    expect(p.failures_today - before.failures_today).toBe(1);
    expect(p.failed_runs_today.map((r: any) => r.id)).toContain("run-f");
  });
});

test("a live stream that falls behind says resync instead of dropping silently", async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign("sha256", Buffer.from(`GET\n/v1/events\n${ts}\n${sha256Hex("")}`), { key: privateKey, dsaEncoding: "der" }).toString("base64");
  const req: any = new Request("http://x/v1/events", { headers: { authorization: `Bearer ${dev.token}`, "x-hm-ts": ts, "x-hm-sig": sig } });
  req.params = {};
  const res: Response = await routes["/v1/events"].GET(req, { requestIP: () => null, timeout() {} });
  const s = session();
  for (let i = 0; i < 1100; i++) bus.emit({ t: "delta", session_id: s.id, kind: "text", index: 0, text: "x" } as any);
  const reader = res.body!.getReader();
  let text = "", sentAfter = false;
  while (!text.includes('"resync"')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    // The phone read what was queued; the next frame says what it missed.
    if (!sentAfter && text.split("data: ").length > 1000) { sentAfter = true; bus.emit({ t: "delta", session_id: s.id, kind: "text", index: 0, text: "after" } as any); }
    if (text.length > 2_000_000) break;
  }
  await reader.cancel();
  expect(text).toContain('"type":"resync"');
});

describe("push health", () => {
  const rec = (id: string, device: string, token: string, ms: number) => ({ id, device_id: device, kind: "test", sent_ms: ms, ok: true, token_hash: sha256Hex(token) });
  test("receipts order by send, a new token starts untested, an early receipt is kept, an app without receipts is not warned", () => {
    const d = mobile.claimPairCode(mobile.createPairCode(600), "p2", pub, apub, false)!.device_id;
    mobile.setPushToken(d, "tok-1");
    // Four sends in one millisecond; a receipt for the first leaves three.
    for (const id of ["a", "b", "c", "e"]) mobile.recordPush({ ...rec(`p-${id}`, d, "tok-1", Date.now()), ok: false, error: "sending" });
    expect(mobile.ackPush(d, "p-a")).toBe(true); // before the push service answered
    for (const id of ["a", "b", "c", "e"]) mobile.recordPush(rec(`p-${id}`, d, "tok-1", Date.now()));
    let st = mobile.pushStatus(d);
    expect([st.unacknowledged, st.warning, st.receipts]).toEqual([3, true, true]);
    // The same token again keeps the warning; a new one starts untested.
    mobile.setPushToken(d, "tok-1");
    expect(mobile.pushStatus(d).warning).toBe(true);
    mobile.setPushToken(d, "tok-2");
    st = mobile.pushStatus(d);
    expect([st.last, st.unacknowledged, st.warning, st.previous?.id]).toEqual([null, 0, false, "p-e"]);
    // A device that never confirmed anything: unknown, not a warning.
    const d3 = mobile.claimPairCode(mobile.createPairCode(600), "p3", pub, apub, false)!.device_id;
    mobile.setPushToken(d3, "tok-3");
    for (const id of ["x", "y", "z"]) mobile.recordPush(rec(`p-${id}`, d3, "tok-3", Date.now()));
    st = mobile.pushStatus(d3);
    expect([st.unacknowledged, st.receipts, st.warning]).toEqual([3, false, false]);
  });
});

function signedRaw(method: string, path: string, bytes: Uint8Array<ArrayBuffer>) {
  const ts = String(Math.floor(Date.now() / 1000));
  const h = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const sig = sign("sha256", Buffer.from(`${method}\n${path}\n${ts}\n${h}`), { key: privateKey, dsaEncoding: "der" }).toString("base64");
  return new Request(`http://x${path}`, { method, body: bytes, headers: { authorization: `Bearer ${dev.token}`, "x-hm-ts": ts, "x-hm-sig": sig } });
}

describe("pairing", () => {
  // The app signs every network attempt of its pairing POST with the request
  // key and names the server in the body (Api.pair, PairSigner).
  const k2 = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub2 = k2.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  async function pair(code: string, signed = true) {
    const raw = JSON.stringify({ code, device_name: "p", pub: pub2, apub, lock: true, server: "http://x" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign("sha256", Buffer.from(`POST\n/v1/pair\n${ts}\n${sha256Hex(raw)}`), { key: k2.privateKey, dsaEncoding: "der" }).toString("base64");
    const req: any = new Request("http://x/v1/pair", { method: "POST", body: raw, headers: signed ? { "x-hm-ts": ts, "x-hm-sig": sig } : {} });
    const res: Response = await routes["/v1/pair"].POST(req, { requestIP: () => ({ address: "10.0.0.9" }) });
    return { status: res.status, body: await res.json() };
  }
  const me = (token: string) => routes["/v1/devices"].GET(Object.assign(signedAs(token, "GET", "/v1/devices"), { params: {} }), {});
  function signedAs(token: string, method: string, path: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign("sha256", Buffer.from(`${method}\n${path}\n${ts}\n${sha256Hex("")}`), { key: k2.privateKey, dsaEncoding: "der" }).toString("base64");
    return new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-hm-ts": ts, "x-hm-sig": sig } });
  }

  test("a phone that lost the answer pairs again with the same code and keeps one device; a used token ends retries", async () => {
    const code = mobile.createPairCode(600);
    const first = await pair(code);
    expect(first.status).toBe(200);
    const before = mobile.devices().length;
    // The answer never arrived: the same code again, signed afresh.
    const again = await pair(code);
    expect(again.status).toBe(200);
    expect(again.body.device_id).toBe(first.body.device_id);
    expect(mobile.devices().length).toBe(before);
    expect((await me(first.body.token)).status).toBe(401);
    // Unsigned, a used code stays used.
    expect((await pair(code, false)).status).toBe(403);
    // Once the token has been used, no retry replaces it.
    expect((await me(again.body.token)).status).toBe(200);
    expect((await pair(code)).status).toBe(403);
    expect((await me(again.body.token)).status).toBe(200);
  });
});
