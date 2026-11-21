// The phone API's contract with the unchanged Hermes app: what its sync,
// chat, run and usage answers carry, and what its push health says. These are
// shapes no browser e2e reaches; the app's own reading of them is cited per test.
import { afterAll, describe, expect, jest, setSystemTime, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { Store } from "../../core/store.ts";
import { setDeps } from "../../automation/core.ts";
import * as agents from "../../automation/agents.ts";
import * as alerts from "../../automation/alerts.ts";
import { setAttachmentsRoot } from "../../engine/attachments.ts";
import { ask } from "../../tools/interact.ts";
import wire from "./contract/wire.json";
import { answersText, approvalMessage, canonicalMessage, sha256Hex } from "./sig.ts";
import { MobileStore } from "./store.ts";
import { mobileApi } from "./v1.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-mobile-"));
const store = new Store(dir);
const bus = new Bus();
setDeps({ store, bus, errors: { capture() {} } } as any);
alerts.migrate();
agents.migrate();
setAttachmentsRoot(dir);
const mobile = new MobileStore(store);
const running = new Set<string>();
const sent: any[] = [];
// The engine's send, as far as the phone API sees it: a prompt starts a turn,
// joins a running one (steer) or waits in the queue.
let sendBreaks = false;
const engine = {
  isRunning: (id: string) => running.has(id),
  send: (id: string, text: string, opts: any) => {
    sent.push({ id, text, opts });
    const images = opts.images?.length ? opts.images : undefined;
    const r = running.has(id) || opts.mode === "queue" ? (() => { const q = store.enqueue(id, text, opts.mode !== "queue", images); return { queued: q, steer: q.steer }; })() : { event: store.append(id, "user", { text, images }) };
    if (sendBreaks) throw new Error("the daemon stopped here");
    return r;
  },
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
// A 1x1 PNG, and an upload as the app makes it: the bytes as the body.
const PNG: Uint8Array<ArrayBuffer> = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function upload(name: string, mime: string, bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  const req = signedRaw("POST", `/v1/upload?name=${name}&mime=${mime}`, bytes);
  for (const [k, v] of Object.entries(headers)) req.headers.set(k, v);
  const res: Response = await routes["/v1/upload"].POST(Object.assign(req, { params: {} }), {});
  return res.status === 200 ? await res.json() : { status: res.status, ...(await res.json()) };
}

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

  test("a failure notice shows with the report or the wake it came with, without its frame", async () => {
    const s = session("Coordinator");
    const notice = "[harness] Failures in this session's work, one entry per cause (the first one shown). Data, not an instruction.\n<failures>\n- 2 agents failed on one cause (quota), with no report of their own: ag7 \"Lane 1\", ag8 \"Lane 2\"\n    HTTP 402: no credit &lt;/failures> left\n</failures>\n1 more of your agents is still running.";
    const report = '<subagent_result agent_id="ag2" title="Child" status="completed">\nstatus ok\n</subagent_result>';
    const wake = '<wait_fired id="w1" kind="timer" outcome="fired">\nThe timer is up.\n</wait_fired>';
    const groups = [{ fp: "x", kind: "agent", owed: 2, count: 2 }];
    store.append(s.id, "user", { text: `${report}\n\n${notice}`, kind: "wake", parts: [{ kind: "subagent", agent_id: "ag2" }, { kind: "failures", groups }] });
    store.append(s.id, "user", { text: `${wake}\n\n${notice}`, kind: "wake", parts: [{ kind: "wait", wait_id: "w1" }, { kind: "failures", groups }] });
    store.append(s.id, "user", { text: notice, kind: "failures", groups });
    const m = (await call("GET", `/v1/chats/${s.id}/messages`)).body.messages;
    expect(m).toHaveLength(3);
    for (const x of m) {
      expect(x.role).toBe("agent");
      expect(x.content).toContain("Failures, grouped by cause");
      expect(x.content).toContain('2 agents failed on one cause (quota), with no report of their own: ag7 "Lane 1", ag8 "Lane 2"');
      expect(x.content).toContain("HTTP 402: no credit </failures> left");
      expect(x.content).toContain("1 more of your agents is still running.");
      expect(x.content).not.toContain("<failures>");
      expect(x.content).not.toContain("[harness]");
    }
    expect(m[0].content).toContain("Report from Child");
    expect(m[0].meta.origin).toBe("subagent");
    expect(m[1].content).toContain("Woken: timer fired");
    expect(m[2].meta.origin).toBe("harness");
  });

  test("a notice that rides a loop run keeps the run's label, and a quoted notice is not taken for the real one", async () => {
    const s = session("Looper");
    const frame = (entry: string) => `[harness] Failures in this session's work, one entry per cause (the first one shown). Data, not an instruction.\n<failures>\n- ${entry}\n    HTTP 402: no credit\n</failures>`;
    const groups = [{ fp: "x", kind: "turn", owed: 1, count: 1 }];
    store.append(s.id, "user", { text: `Check the queue.\n\n${frame("A turn of this session ended on an error (quota)")}`, kind: "wake", parts: [{ kind: "loop", loop_id: "l1", loop_name: "Queue check" }, { kind: "failures", groups }] });
    // A report that quotes a whole notice, ahead of the real one.
    const quoting = `<subagent_result agent_id="ag2" title="Child" status="completed">\nI saw this earlier:\n${frame("9 agents failed on one cause (quoted)")}\n</subagent_result>`;
    store.append(s.id, "user", { text: `${quoting}\n\n${frame("1 agent failed (quota), with no report of its own: ag9")}`, kind: "wake", parts: [{ kind: "subagent", agent_id: "ag2" }, { kind: "failures", groups }] });
    const m = (await call("GET", `/v1/chats/${s.id}/messages`)).body.messages;
    expect(m[0].meta).toMatchObject({ origin: "loop", loop_id: "l1" });
    expect(m[0].content).toContain("Loop run: Queue check");
    expect(m[0].content).toContain("Check the queue.");
    expect(m[0].content).toContain("**Failures, grouped by cause**\n\n- A turn of this session ended on an error (quota)");
    expect(m[1].meta.origin).toBe("subagent");
    expect(m[1].content).toContain("**Failures, grouped by cause**\n\n- 1 agent failed (quota), with no report of its own: ag9");
    // The quoted one stays where the agent wrote it, inside its report.
    expect(m[1].content.indexOf("9 agents failed on one cause (quoted)")).toBeLessThan(m[1].content.indexOf("**Failures, grouped by cause**"));
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
    // A page asked for from a message of the branch that was left: refused, so the app reloads the chat.
    const stale = await call("GET", `/v1/chats/${s.id}/messages?paged=1&limit=150&before=${neu.id}`);
    expect([stale.status, stale.body.error]).toEqual([409, "that message is not on this chat's shown branch; reload the chat"]);
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
    const png = PNG;
    const att = await upload("a.png", "image/png", png);
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

describe("sends", () => {
  const prompts = (sid: string) => store.events(sid).filter((e) => e.kind === "user").length + store.queue(sid).length;

  test("a send retried under its id gets the first receipt and stores one prompt, in every mode", async () => {
    for (const mode of ["send", "steer", "queue"]) {
      const s = session();
      if (mode === "steer") running.add(s.id);
      sent.length = 0;
      const first = await call("POST", `/v1/chats/${s.id}/messages`, { text: "ship it", mode, client_id: `c-${mode}` });
      expect(first.status).toBe(200);
      expect(first.body.message.kind).toBe(mode === "send" ? "text" : mode === "steer" ? "steer" : "queued");
      // The answer never arrived. By the retry the turn runs, so the app asks to steer.
      running.add(s.id);
      const again = await call("POST", `/v1/chats/${s.id}/messages`, { text: "ship it", mode: "steer", client_id: `c-${mode}` });
      expect([again.status, again.body.replayed]).toEqual([200, true]);
      expect(again.body.message).toEqual(first.body.message);
      expect([sent.length, prompts(s.id)]).toEqual([1, 1]);
      // The same words on purpose, under ids of their own: two prompts more.
      await call("POST", `/v1/chats/${s.id}/messages`, { text: "ship it", mode, client_id: `c-${mode}-2` });
      await call("POST", `/v1/chats/${s.id}/messages`, { text: "ship it", mode });
      expect([sent.length, prompts(s.id)]).toEqual([3, 3]);
      // Other words under a used id are refused, not taken for the first send.
      expect((await call("POST", `/v1/chats/${s.id}/messages`, { text: "something else", client_id: `c-${mode}` })).status).toBe(409);
      expect(sent.length).toBe(3);
      running.delete(s.id);
    }
  });

  test("a retry after the queue moved says what the prompt became", async () => {
    const s = session();
    sent.length = 0;
    const send = (id: string) => call("POST", `/v1/chats/${s.id}/messages`, { text: `later ${id}`, mode: "queue", client_id: id });
    const a = (await send("q-a")).body.message, b = (await send("q-b")).body.message;
    // The queue ran the first: its prompt is in the history under the receipt's id.
    store.dequeue(a.id);
    store.append(s.id, "user", { text: "later q-a", origin: "queued", queue_id: a.id });
    expect((await send("q-a")).body.message).toMatchObject({ id: a.id, kind: "text", content: "later q-a" });
    // The owner took the second off the queue on the desktop.
    store.dequeue(b.id);
    expect((await send("q-b")).body.message).toMatchObject({ id: b.id, kind: "deleted" });
    expect(sent.length).toBe(2);
  });

  test("a send that fails part way leaves no prompt and no receipt; the retry stores it once", async () => {
    const s = session();
    sendBreaks = true;
    await expect(call("POST", `/v1/chats/${s.id}/messages`, { text: "once", client_id: "c-broken" })).rejects.toThrow("the daemon stopped here");
    sendBreaks = false;
    expect(prompts(s.id)).toBe(0);
    const r = await call("POST", `/v1/chats/${s.id}/messages`, { text: "once", client_id: "c-broken" });
    expect([r.status, r.body.replayed, prompts(s.id)]).toEqual([200, undefined, 1]);
  });
});

describe("uploads", () => {
  test("an image is what its bytes are, whatever the upload calls it", async () => {
    const s = session();
    sent.length = 0;
    // Text that claims to be a JPEG, and a PNG that claims to be text.
    const fake = await upload("holiday.jpg", "image/jpeg", new TextEncoder().encode("not a photo at all"));
    const real = await upload("notes.txt", "text/plain", PNG);
    expect([fake.kind, fake.mime, real.kind, real.mime]).toEqual(["file", "application/octet-stream", "image", "image/png"]);
    // The message may repeat the claim: the model still gets an image only for image bytes.
    const r = await call("POST", `/v1/chats/${s.id}/messages`, { text: "two", attachments: [{ id: fake.id, mime: "image/jpeg", file_name: "holiday.jpg" }, { id: real.id, mime: "text/plain" }] });
    expect(r.status).toBe(200);
    expect(sent[0].opts.images.map((b: any) => [b.type, b.media_type])).toEqual([["attachment", "application/octet-stream"], ["image", "image/png"]]);
    expect(r.body.message.meta.attachments.map((a: any) => [a.kind, a.mime])).toEqual([["file", "application/octet-stream"], ["image", "image/png"]]);
  });

  test("a file over the limit is refused by its declared size, before its bytes are read, and the app is told the limit", async () => {
    const me = (await call("GET", "/v1/me")).body;
    expect(me.uploads).toEqual({ max_bytes: 20 * 1024 * 1024, inline_images: ["image/png", "image/jpeg", "image/gif", "image/webp"] });
    let read = false;
    const req = signedRaw("POST", "/v1/upload?name=big.bin&mime=application/octet-stream", PNG);
    req.headers.set("content-length", String(me.uploads.max_bytes + 1));
    Object.defineProperty(req, "arrayBuffer", { value: async () => { read = true; return PNG.buffer; } });
    const res: Response = await routes["/v1/upload"].POST(Object.assign(req, { params: {} }), {});
    expect([res.status, (await res.json()).error, read]).toEqual([413, "a file can be at most 20 MiB", false]);
    expect((await upload("empty.txt", "text/plain", new Uint8Array())).status).toBe(400);
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
    // Reopened later (a sync), the closed card still says what was picked, question by question.
    const reopened = (await call("GET", "/v1/sync?since=0")).body.approvals.find((a: any) => a.id === "q-call-q");
    expect(reopened).toMatchObject({ state: "approved", answers: { build: { picked: ["Debug"] }, checks: { picked: ["Integration"] } } });
    expect(reopened.questions.map((q: any) => q.id)).toEqual(["build", "checks"]);
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

// The event stream as the app reads it: `read` pulls frames until `until` holds.
async function openStream(since?: number) {
  const path = since === undefined ? "/v1/events" : `/v1/events?since=${since}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign("sha256", Buffer.from(`GET\n${path}\n${ts}\n${sha256Hex("")}`), { key: privateKey, dsaEncoding: "der" }).toString("base64");
  const req: any = new Request(`http://x${path}`, { headers: { authorization: `Bearer ${dev.token}`, "x-hm-ts": ts, "x-hm-sig": sig } });
  req.params = {};
  const res: Response = await routes["/v1/events"].GET(req, { requestIP: () => null, timeout() {} });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: any[] = [];
  let buf = "";
  const read = async (until: (frames: any[]) => boolean) => {
    while (!until(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) frames.push(JSON.parse(buf.slice(6, i)));
    }
    return frames;
  };
  return { frames, read, close: () => reader.cancel() };
}
const texts = (messages: any[], sid: string) => messages.filter((m) => m.chat_id === sid && m.kind !== "deleted").map((m) => m.content);

describe("the event stream", () => {
  test("a stream that falls behind says resync instead of dropping silently", async () => {
    const st = await openStream();
    const s = session();
    for (let i = 0; i < 1100; i++) bus.emit({ t: "delta", session_id: s.id, kind: "text", index: 0, text: "x" } as any);
    let sentAfter = false;
    // The phone read what was queued; the next frame says what it missed.
    await st.read((f) => {
      if (!sentAfter && f.length >= 1000) { sentAfter = true; bus.emit({ t: "delta", session_id: s.id, kind: "text", index: 0, text: "after" } as any); }
      return f.some((x) => x.type === "resync") || f.length > 5000;
    });
    await st.close();
    expect(st.frames.some((x) => x.type === "resync")).toBe(true);
    // An app that names no cursor gets no catch-up in the stream.
    expect(st.frames.filter((x) => x.type === "hello").map((x) => "sync" in x)).toEqual([false]);
  });

  test("a stream opened at the phone's cursor starts with what it missed and goes on live, nothing twice", async () => {
    const s = session();
    store.append(s.id, "user", { text: "one" });
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "call-m", name: "AskUserQuestion", input: { question: "Go?", type: "yesno" } }] });
    const ac = new AbortController();
    const asked = ask({ callId: "call-m", sessionId: s.id, signal: ac.signal } as any);
    // The phone is level here, holding the open card. Then it loses the connection.
    const cursor = (await call("GET", "/v1/sync?since=0")).body.seq;
    const missed = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "missed reply" }] });
    ac.abort();
    await asked;
    const st = await openStream(cursor);
    const [hello] = await st.read((f) => f.length >= 1);
    expect(hello).toMatchObject({ type: "hello", seq: mobile.globalSeq(), cursor: mobile.globalSeq() });
    expect(texts(hello.sync.messages, s.id)).toEqual(["missed reply"]);
    expect(hello.sync.approvals.filter((a: any) => a.id === "q-call-m").map((a: any) => a.state)).toEqual(["expired"]);
    // What is stored next comes live, with the place to reconnect from.
    const live = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "live reply" }, { type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }] });
    bus.emit({ t: "event", event: live } as any);
    await st.read((f) => f.filter((x) => x.type === "message").length >= 2);
    const after = st.frames.slice(1).filter((x) => x.type === "message");
    expect(after.map((x) => [x.message.kind, x.cursor])).toEqual([["text", undefined], ["trace", mobile.gseqOf(live.id)]]);
    expect(st.frames.slice(1).some((x) => x.message?.id === missed.id)).toBe(false);
    await st.close();
    // Reconnecting from the last cursor it got brings nothing again.
    const again = await openStream(after.at(-1).cursor);
    const [h2] = await again.read((f) => f.length >= 1);
    expect(h2.sync.messages).toEqual([]);
    await again.close();
  });

  test("a stream that fell behind catches up on the same stream once the phone reads again", async () => {
    const s = session();
    const st = await openStream(mobile.globalSeq());
    for (let i = 0; i < 1100; i++) bus.emit({ t: "delta", session_id: s.id, kind: "text", index: 0, text: "x" } as any);
    // Stored while the stream drops frames: the phone never gets this one live.
    const lost = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "stored during the lag" }] });
    bus.emit({ t: "event", event: lost } as any);
    let poked = false;
    await st.read((f) => {
      if (!poked && f.length >= 1000) { poked = true; bus.emit({ t: "session", session: store.session(s.id)! } as any); }
      return f.filter((x) => x.type === "hello").length >= 2 || f.length > 5000;
    });
    await st.close();
    const types = st.frames.map((x) => x.type);
    expect(types.indexOf("resync")).toBeGreaterThan(0);
    const recovered = st.frames[types.lastIndexOf("hello")];
    expect(types.lastIndexOf("hello")).toBe(types.indexOf("resync") + 1);
    expect(texts(recovered.sync.messages, s.id)).toEqual(["stored during the lag"]);
    expect(recovered.cursor).toBe(mobile.gseqOf(lost.id));
  });

  test("a cursor this store never gave, or one more than a page behind, is told to reload whole", async () => {
    const s = session();
    store.append(s.id, "user", { text: "kept" });
    const now = mobile.globalSeq();
    // A cursor from another store (a restored backup): above anything given here.
    const ahead = (await call("GET", `/v1/sync?since=${now + 500}`)).body;
    expect([ahead.reload, ahead.seq, ahead.more]).toEqual(["ahead", now, false]);
    expect(texts(ahead.messages, s.id)).toEqual(["kept"]);
    // Deleting the newest session does not put a level phone ahead.
    const gone = session();
    store.append(gone.id, "user", { text: "gone" });
    const level = mobile.globalSeq();
    store.deleteSession(gone.id);
    expect((await call("GET", `/v1/sync?since=${level}`)).body.reload).toBeUndefined();
    // More than a page behind: the newest page of every chat, not the backlog.
    for (let i = 0; i < 2001; i++) store.append(s.id, "user", { text: `row-${i}` });
    const behind = (await call("GET", `/v1/sync?since=${level}`)).body;
    expect([behind.reload, behind.seq, behind.more, texts(behind.messages, s.id).length]).toEqual(["behind", mobile.globalSeq(), false, 40]);
    // The stream says the same in its first frame.
    const st = await openStream(level);
    const [hello] = await st.read((f) => f.length >= 1);
    await st.close();
    expect(hello.sync.reload).toBe("behind");
  }, 30_000); // two thousand stored events: slow on a disk that is busy
});

describe("branches", () => {
  // A chat with two replies to one prompt; the newer one is shown.
  const forked = () => {
    const s = session();
    const base = store.append(s.id, "user", { text: "base" });
    const old = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "old" }] }, base.id);
    const neu = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "new" }] }, base.id);
    return { s, base, old, neu };
  };
  // What the desktop does to show another branch: the head moves, no event is stored.
  const show = (sid: string, head: string) => bus.emit({ t: "session", session: store.updateSession(sid, { head }) } as any);

  test("a branch picked on the desktop replaces the phone's transcript, live", async () => {
    const { s, old, neu } = forked();
    const st = await openStream(mobile.globalSeq());
    show(s.id, old.id);
    await st.read((f) => f.some((x) => x.type === "chat_reset"));
    const reset = st.frames.find((x) => x.type === "chat_reset");
    expect(reset.chat_id).toBe(s.id);
    expect(texts(reset.messages, s.id)).toEqual(["base", "old"]);
    expect(reset.messages.find((m: any) => m.id === neu.id).kind).toBe("deleted");
    expect(reset.older).toBeNull();
    // Stored on the chosen branch after that: an ordinary message, no second reset.
    const next = store.append(s.id, "user", { text: "go on" });
    bus.emit({ t: "event", event: next } as any);
    bus.emit({ t: "session", session: store.session(s.id)! } as any);
    await st.read((f) => f.some((x) => x.type === "message" && x.message.id === next.id));
    await st.close();
    expect(st.frames.filter((x) => x.type === "chat_reset")).toHaveLength(1);
  });

  test("a branch picked while the phone was away comes with the catch-up, in place of the events it missed", async () => {
    const { s, old, neu } = forked();
    const other = session();
    const cursor = mobile.globalSeq();
    // Stored on the branch the owner then left, and in another chat.
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "more on new" }] }, neu.id);
    store.append(other.id, "user", { text: "elsewhere" });
    show(s.id, old.id);
    const body = (await call("GET", `/v1/sync?since=${cursor}`)).body;
    expect(body.reset).toEqual([{ chat_id: s.id, older: null }]);
    expect(texts(body.messages, s.id)).toEqual(["base", "old"]);
    expect(texts(body.messages, other.id)).toEqual(["elsewhere"]);
    expect(body.seq).toBeGreaterThan(cursor);
    // Level again: nothing to reset, and an ordinary append resets nothing.
    store.append(s.id, "user", { text: "go on" });
    const next = (await call("GET", `/v1/sync?since=${body.seq}`)).body;
    expect([next.reset, texts(next.messages, s.id)]).toEqual([undefined, ["go on"]]);
    // A prompt edited into a sibling is a branch change with an event of its own.
    const at = next.seq;
    store.append(s.id, "user", { text: "base, edited" }, null);
    const edited = (await call("GET", `/v1/sync?since=${at}`)).body;
    expect([edited.reset.map((r: any) => r.chat_id), texts(edited.messages, s.id)]).toEqual([[s.id], ["base, edited"]]);
  });
});

// contract/wire.json is the wire written once: the bytes that are signed, and
// per shape the fields the app reads with examples. Here the daemon is held to
// it; the app's build holds the app to the same file (ContractTest.kt).
describe("the wire contract", () => {
  const fields = wire.fields as Record<string, Record<string, string>>;
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const at = (o: any, path: string) => path.split(".").reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o);
  // The shapes inside a shape: where they are and what they are.
  const PARTS: Record<string, [string, string][]> = {
    sync: [["chats", "chat"], ["messages", "message"], ["approvals", "card"], ["working", "working_row"], ["drafts", "draft"], ["reset", "reset"]],
    message: [["meta.steps", "step"], ["meta.attachments", "attachment"]], send: [["attachments", "upload_ref"]], card: [["questions", "question"], ["answers", "picked"]],
    page: [["messages", "message"]], receipt: [["message", "message"]], resolved: [["approval", "card"]],
    hello: [["sync", "sync"]], message_frame: [["message", "message"], ["chat", "chat"]], chat_frame: [["chat", "chat"]],
    chat_reset: [["messages", "message"], ["chat", "chat"]], approval: [["approval", "card"]], seq: [["working", "working_row"]],
  };
  // What a value breaks of its shape's fields, the shapes inside it included; `seen` collects the fields it has.
  function broken(shape: string, v: any, seen = new Set<string>(), out: string[] = []) {
    for (const [path, decl] of Object.entries(fields[shape]!)) {
      const got = at(v, path);
      if (got === undefined) { if (!decl.endsWith("?")) out.push(`${shape}.${path} is missing`); continue; }
      if (!decl.replace("?", "").split("|").includes(typeOf(got))) out.push(`${shape}.${path} is ${typeOf(got)}, not ${decl}`);
      else seen.add(`${shape}.${path}`);
    }
    for (const [path, part] of PARTS[shape] ?? []) {
      const x = at(v, path);
      for (const c of Array.isArray(x) ? x : x && typeof x === "object" ? (part === "picked" ? Object.values(x) : [x]) : []) broken(part, c, seen, out);
    }
    return out;
  }
  const approve = (aid: string, body: any) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const text = body.answers ? answersText(body.answers) : "";
    const asig = sign("sha256", Buffer.from(approvalMessage(aid, body.choice, ts, true, text)), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
    return call("POST", `/v1/approvals/${aid}`, body, body.choice === "deny" ? {} : { "x-hm-asig": asig, "x-hm-asig-v": "2" });
  };
  const QUESTIONS = { questions: [{ id: "build", question: "Build type?", options: [{ label: "Debug" }, { label: "Release" }] }, { id: "checks", question: "Which checks?", multiSelect: true, options: [{ label: "Unit" }, { label: "Integration" }] }] };
  const asks = (sid: string, callId: string) => {
    const e = store.append(sid, "assistant", { blocks: [{ type: "tool_use", id: callId, name: "AskUserQuestion", input: QUESTIONS }] });
    let got: any;
    ask({ callId, sessionId: sid, signal: new AbortController().signal } as any).then((a) => (got = a));
    return { event: e, answer: () => got };
  };

  test("both sides sign the same bytes", () => {
    for (const r of wire.signing.request) {
      expect(sha256Hex(r.body)).toBe(r.body_sha256);
      expect(new TextDecoder().decode(canonicalMessage(r.method, r.path + (r.query === null ? "" : `?${r.query}`), r.ts, r.body))).toBe(r.canonical);
    }
    for (const a of wire.signing.approval) {
      expect(a.answers ? answersText(a.answers) : "").toBe(a.answers_text);
      expect(approvalMessage(a.id, a.choice, a.ts, true, a.answers_text)).toBe(a.message);
    }
  });

  test("the examples are of their shapes", () => {
    for (const [shape, list] of Object.entries(wire.examples)) for (const ex of list) expect(broken(shape, ex)).toEqual([]);
    expect(Object.keys(wire.examples).sort()).toEqual(Object.keys(fields).sort());
  });

  test("what the daemon sends has every field the app reads, under its name and type", async () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const take = (shape: string, v: any) => void broken(shape, v, seen, bad);
    const parent = session("Parent");
    const s = session("Fix the build");
    if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
    store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, s.id);
    const base = store.append(s.id, "user", { text: "Why does the build fail?" });
    const left = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "left behind" }] }, base.id);
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }], model: "fx:saved" }, base.id);
    store.append(s.id, "turn_end", { reason: "interrupted" });
    store.append(s.id, "user", { text: '<subagent_result agent_id="ag2" title="Child" status="done">\nstatus ok\n</subagent_result>', kind: "subagent", agent_id: "ag2" });
    const failed = session("Failed");
    store.append(failed.id, "error", { message: "HTTP 402: no credit" });
    const q = asks(s.id, "call-w");
    running.add(parent.id);
    bus.emit({ t: "delta", session_id: parent.id, kind: "text", index: 0, text: "Looking at the" } as any);

    // Answers to requests.
    take("sync", (await call("GET", "/v1/sync?since=0")).body);
    take("page", (await call("GET", `/v1/chats/${s.id}/messages?paged=1&limit=3`)).body);
    take("receipt", (await call("POST", `/v1/chats/${parent.id}/messages`, { ...wire.examples.send[0], client_id: "contract-receipt" })).body);
    // A prompt that carries a photo and a file.
    const photo = await upload("photo.png", "image/png", PNG), notes = await upload("notes.txt", "text/plain", new TextEncoder().encode("hello notes\n"));
    take("upload", photo);
    take("receipt", (await call("POST", `/v1/chats/${failed.id}/messages`, { text: "look", attachments: [photo, notes] })).body);

    // The stream: its first frame, then one of each kind.
    jest.useFakeTimers();
    const st = await openStream(mobile.globalSeq());
    try {
      const ev = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Fixed." }], model: "fx:saved" });
      bus.emit({ t: "event", event: ev } as any);
      bus.emit({ t: "session", session: store.session(s.id)! } as any);
      bus.emit({ t: "delta", session_id: parent.id, kind: "text", index: 0, text: " build" } as any);
      take("resolved", (await approve("q-call-w", { choice: "once", answers: { build: "Debug", checks: ["Unit", "by hand"] } })).body);
      const res = store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "call-w", content: "answered" }] });
      bus.emit({ t: "event", event: res } as any);
      bus.emit({ t: "session", session: store.updateSession(s.id, { head: left.id }) } as any);
      bus.emit({ t: "session", session: failed, deleted: true } as any);
      jest.advanceTimersByTime(15_000);
    } finally {
      jest.useRealTimers();
    }
    await st.read((f) => f.some((x) => x.type === "seq"));
    await st.close();
    const SHAPE: Record<string, string> = { message: "message_frame", chat: "chat_frame" };
    for (const f of st.frames) take(SHAPE[f.type] ?? f.type, f);
    expect(new Set(st.frames.map((f) => f.type))).toEqual(new Set(["hello", "message", "chat", "working", "delta", "approval", "chat_reset", "chat_removed", "seq"]));

    // Catch-ups that say more than events: a branch that changed, a cursor that cannot be caught up from.
    take("sync", (await call("GET", `/v1/sync?since=${st.frames[0].cursor}`)).body);
    take("sync", (await call("GET", `/v1/sync?since=${mobile.globalSeq() + 9}`)).body);
    running.delete(parent.id);

    expect(bad).toEqual([]);
    // Every field the app reads was sent at least once here, so a renamed optional field fails too.
    const sent = Object.entries(fields).filter(([shape]) => !["send", "answer", "upload_ref"].includes(shape)).flatMap(([shape, f]) => Object.keys(f).map((k) => `${shape}.${k}`));
    expect(sent.filter((k) => !seen.has(k))).toEqual([]);
    expect(q.answer()).toEqual({ build: { picked: ["Debug"] }, checks: { picked: ["Unit"], other: "by hand" } });
  });

  test("the daemon takes what the app sends", async () => {
    const s = session();
    sent.length = 0;
    const [send, withPhoto] = wire.examples.send;
    const first = (await call("POST", `/v1/chats/${s.id}/messages`, send)).body;
    expect(first.message).toMatchObject({ content: send!.text, kind: "queued" });
    expect((await call("POST", `/v1/chats/${s.id}/messages`, send)).body).toMatchObject({ replayed: true, message: { id: first.message.id } });
    expect(sent).toHaveLength(1);
    // A prompt with a photo names the upload by the id its answer gave. The example upload is that answer.
    expect(await upload("photo.png", "image/png", PNG)).toEqual(wire.examples.upload[0]);
    const look = (await call("POST", `/v1/chats/${s.id}/messages`, withPhoto)).body;
    expect(look.message.meta.attachments).toMatchObject([{ kind: "image", mime: "image/png" }]);
    // A card answered by question id, and one dismissed.
    const [answer, dismiss] = wire.examples.answer;
    const a = asks(s.id, "call-x"), b = asks(s.id, "call-y");
    expect((await approve("q-call-x", answer)).status).toBe(200);
    expect((await approve("q-call-y", dismiss)).status).toBe(200);
    await Bun.sleep(0);
    expect(a.answer()).toEqual({ build: { picked: ["Debug"] }, checks: { picked: ["Unit", "Integration"] } });
    expect(b.answer().build.picked).toEqual([]);
  });
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
