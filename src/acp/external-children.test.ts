import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { AcpRunner, type ChildHost, type ChildPatch } from "./external.ts";
import { Book } from "./v2.ts";
import { MESSAGE_MAX, TITLE_MAX, DESCRIPTION_MAX } from "./children.ts";

// The runner's handling of what an agent says of its children, with no process: updates are fed to it as the
// connection would, and the host that makes the agent rows is a recording stand-in.
function world(limit = 2) {
  const dir = mkdtempSync(join(tmpdir(), "keel-acp-kids-"));
  const store = new Store(join(dir, "state"));
  const parent = store.createSession({ model: "acp:x", workspace: dir, title: "Lead" });
  const rows = new Map<string, { id: string; parent: string; child: string; conv: string; session: string; patches: ChildPatch[]; ended: boolean }>();
  const disconnected: string[] = [];
  const writes: { session: string; kind: string; data: any }[] = [];
  const kids: ChildHost = {
    io: (sid) => ({ append: (kind, data) => { writes.push({ session: sid, kind, data }); return store.append(sid, kind, data); }, delta() {}, status() {} }),
    find: (p, child, conv) => { const r = [...rows.values()].find((x) => x.parent === p && x.child === child && x.conv === conv); return r && { id: r.id, session: store.session(r.session)!, callId: `call-${r.id}` }; },
    create: (p, o) => {
      const s = store.createSession({ model: p.model, workspace: p.workspace, title: o.title || "Agent" });
      const id = `row${rows.size + 1}`;
      rows.set(id, { id, parent: p.id, child: o.child, conv: o.conv, session: s.id, patches: [], ended: false });
      return { id, session: s, callId: o.callId };
    },
    patch: (id, p) => { const r = rows.get(id)!; r.patches.push(p); if (p.status) r.ended = p.status !== "running" && p.status !== "waiting"; },
    disconnect: (id) => { disconnected.push(id); },
    isChild: (sid) => [...rows.values()].some((r) => r.session === sid),
    limit: () => limit,
  };
  const errors: unknown[] = [];
  const runner = new AcpRunner(store, { learn() {}, learned: () => undefined } as any, (async () => undefined) as any, (e) => errors.push(e), undefined, undefined, kids);
  const notified: { method: string; params: any }[] = [];
  const conn: any = { alive: true, notify: (method: string, params: any) => notified.push({ method, params }), request: async () => ({}), close() { this.alive = false; } };
  const live: any = { agent: { id: "x", name: "Codex" }, terms: { closeAll: async () => {}, stopRunning: async () => {} }, conn, acpSession: "root", sid: parent.id, caps: {}, choices: {}, offered: new Set(), children: new Map(), chunks: new Map(), v: 1, book: new Book(), texts: new Map(), pending: new Map(), closed: new AbortController() };
  (runner as any).live.set(parent.id, live);
  const feed = (sessionId: string, update: any) => (runner as any).update(live, { sessionId, update });
  const announce = (id: string, more: any = {}, outer = "root") => feed(outer, { sessionUpdate: "subagent_update", sessionId: id, ...more });
  return { store, parent, rows, disconnected, writes, runner, live, notified, feed, announce, errors, dir };
}

test("announced children past the tree's agent limit are not shown, and the session is told once", () => {
  const { rows, writes, announce, live, errors } = world(2);
  for (let i = 0; i < 50; i++) announce(`c${i}`, { title: `Child ${i}`, state: { state: "running" } });
  expect(rows.size).toBe(2);
  expect(live.children.size).toBe(2);
  expect(writes.filter((w) => w.kind === "note" && /announced more agents/.test(w.data.text))).toHaveLength(1);
  // A child that is over frees its place for the next one; the finished ones count only against the total (16 times the limit).
  announce("c0", { state: { state: "idle", stopReason: "end_turn" } });
  announce("late", { title: "Late", state: { state: "running" } });
  expect(rows.size).toBe(3);
  // The total is of the live and the recent: past it the oldest finished ones are forgotten by the connection (their rows stay).
  for (let i = 0; i < 100; i++) { announce(`d${i}`, { state: { state: "idle", stopReason: "end_turn" } }); }
  expect(live.children.size).toBeLessThanOrEqual(2 * 16);
  expect(rows.size).toBe(3 + 100);
  announce("c1", { state: { state: "idle", stopReason: "end_turn" } });
  announce("last", { title: "Last", state: { state: "running" } });
  expect(rows.size).toBe(3 + 100 + 1);
  expect(errors).toEqual([]);
});

test("the words an agent sends about a child are cut to what a row and a note show", () => {
  const { rows, writes, announce, feed } = world(4);
  announce("c1", { title: "T".repeat(20_000_000), description: "D".repeat(20_000_000), state: { state: "running" } });
  const r = [...rows.values()][0]!;
  const call = writes.find((w) => w.kind === "assistant")!.data.blocks[0].input;
  expect(call.prompt.length).toBeLessThanOrEqual(DESCRIPTION_MAX + 1);
  expect(r.patches.some((p) => (p.title?.length ?? 0) > TITLE_MAX + 1)).toBe(false);
  feed("root", { sessionUpdate: "session_message", messageId: "m", senderSessionId: "root", recipientSessionId: "c1", content: [{ type: "text", text: "x".repeat(5_000_000) }] });
  const task = writes.find((w) => w.kind === "user")!.data;
  expect(task.text.length).toBeLessThanOrEqual(MESSAGE_MAX + 1);
  // The same for a message sent in pieces.
  for (let i = 0; i < 1000; i++) feed("root", { sessionUpdate: "session_message_chunk", messageId: "p", senderSessionId: "root", recipientSessionId: "c1", content: [{ type: "text", text: "y".repeat(100_000) }] });
  feed("c1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "go" } });
  const steer = writes.filter((w) => w.kind === "user").at(-1)!.data;
  expect(steer.kind).toBe("steer");
  expect(steer.text.length).toBeLessThanOrEqual(MESSAGE_MAX + 1);
});

test("a new conversation of the agent that reuses a child id does not take the earlier child's row", () => {
  const { rows, announce, live, parent, runner, store } = world(4);
  announce("same", { title: "First", state: { state: "idle", stopReason: "end_turn" } });
  expect(rows.size).toBe(1);
  // The connection is made again with a new conversation: the same child id is another child.
  live.children.clear();
  live.acpSession = "root2";
  announce("same", { title: "Second", state: { state: "running" } }, "root2");
  expect(rows.size).toBe(2);
  // The same conversation again (resumed) finds its own row.
  live.children.clear();
  announce("same", { state: { state: "running" } }, "root2");
  expect(rows.size).toBe(2);
  void parent; void runner; void store;
});

test("the owner's Stop on the parent's turn asks the agent to cancel each child that offered it, as the owner's", async () => {
  const { announce, live, notified, runner, parent, store, rows, feed } = world(4);
  announce("a", { title: "A", capabilities: { cancel: {} }, state: { state: "running" } });
  announce("b", { title: "B", state: { state: "running" } }); // offered no cancel
  announce("done", { title: "Done", capabilities: { cancel: {} }, state: { state: "idle", stopReason: "end_turn" } });
  const abort = new AbortController();
  let stopper: string | undefined;
  const io: any = { signal: abort.signal, events: () => [{ kind: "user", data: { text: "go" } }], append: (kind: any, data: any) => store.append(parent.id, kind, data), delta() {}, status() {}, stopper: () => stopper, runTool: async () => ({}) };
  let answer: (r: any) => void = () => {};
  live.conn.request = (m: string) => (m === "session/prompt" ? new Promise((res) => { answer = res; }) : Promise.resolve({}));
  const turn = runner.turn(store.session(parent.id)!, io);
  await Bun.sleep(20);
  stopper = "owner";
  abort.abort();
  answer({ stopReason: "cancelled" });
  await turn;
  expect(notified.filter((n) => n.method === "session/cancel").map((n) => n.params.sessionId).sort()).toEqual(["a", "root"]);
  // The agent says it stopped: the row ends as the owner's stop.
  feed("root", { sessionUpdate: "subagent_update", sessionId: "a", state: { state: "idle", stopReason: "cancelled" } });
  const patch = [...rows.values()].find((r) => r.child === "a")!.patches.at(-1)!;
  expect(patch).toMatchObject({ status: "stopped", stopped_by: "owner" });
});

test("a stop that is not the owner's reaches the children as one of an agent above them", async () => {
  const { announce, live, notified, runner, parent, store, feed, rows } = world(4);
  announce("a", { title: "A", capabilities: { cancel: {} }, state: { state: "running" } });
  const abort = new AbortController();
  const io: any = { signal: abort.signal, events: () => [{ kind: "user", data: { text: "go" } }], append: (kind: any, data: any) => store.append(parent.id, kind, data), delta() {}, status() {}, stopper: () => undefined, runTool: async () => ({}) };
  let answer: (r: any) => void = () => {};
  live.conn.request = (m: string) => (m === "session/prompt" ? new Promise((res) => { answer = res; }) : Promise.resolve({}));
  const turn = runner.turn(store.session(parent.id)!, io);
  await Bun.sleep(20);
  abort.abort();
  answer({ stopReason: "cancelled" });
  await turn;
  expect(notified.some((n) => n.method === "session/cancel" && n.params.sessionId === "a")).toBe(true);
  feed("root", { sessionUpdate: "subagent_update", sessionId: "a", state: { state: "idle", stopReason: "cancelled" } });
  expect([...rows.values()][0]!.patches.at(-1)).toMatchObject({ status: "stopped", stopped_by: "ancestor" });
});

test("a child still at work when the parent's prompt ends is ended as incomplete, and its agent may still move it", async () => {
  const { announce, live, runner, parent, store, rows, feed } = world(4);
  announce("a", { title: "A", state: { state: "running" } });
  feed("a", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", kind: "execute", status: "in_progress", rawInput: { command: "sleep 9" } });
  const io: any = { signal: new AbortController().signal, events: () => [{ kind: "user", data: { text: "go" } }], append: (kind: any, data: any) => store.append(parent.id, kind, data), delta() {}, status() {}, runTool: async () => ({}) };
  live.conn.request = async (m: string) => (m === "session/prompt" ? { stopReason: "end_turn" } : {});
  await runner.turn(store.session(parent.id)!, io);
  const row = [...rows.values()][0]!;
  expect(row.patches.at(-1)).toMatchObject({ status: "incomplete", end_reason: "parent_ended" });
  // Its open call was told so.
  const childEvents = store.events(row.session);
  expect(childEvents.filter((e) => e.kind === "tool_result")).toHaveLength(1);
  // A label change alone does not bring it back to work; a state the agent says does.
  announce("a", { title: "A2" });
  expect(row.patches.at(-1)).toEqual({ title: "A2" });
  announce("a", { state: { state: "idle", stopReason: "end_turn" } });
  expect(row.patches.at(-1)).toMatchObject({ status: "completed" });
});

test("when the connection ends a child's words are stored and its open calls end before it is shown as disconnected", () => {
  const { announce, runner, live, store, rows, disconnected, feed } = world(4);
  announce("a", { title: "A", state: { state: "running" } });
  feed("a", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "half a thought" } });
  feed("a", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", kind: "execute", status: "in_progress", rawInput: { command: "sleep 9" } });
  const row = [...rows.values()][0]!;
  (runner as any).closeLive(live);
  const events = store.events(row.session);
  expect(events.some((e) => e.kind === "assistant" && JSON.stringify(e.data).includes("half a thought"))).toBe(true);
  const result = events.find((e) => e.kind === "tool_result")!;
  expect(JSON.stringify(result.data)).toContain("The connection to the agent ended");
  expect(disconnected).toEqual([row.id]);
});

test("no input reaches a child's session through the engine: a prompt, a message or a run is refused", async () => {
  const { Engine } = await import("../engine/turn.ts");
  const { Bus } = await import("../core/bus.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-acp-kid-send-"));
  const store = new Store(join(dir, "state"));
  const engine = new Engine(store, new Bus(), { models: async () => [], current: () => [], resolve: async () => { throw new Error("no model"); } } as any, { capture: () => ({}) } as any, join(dir, "spill"));
  const child = store.createSession({ model: "acp:x", workspace: dir, title: "Kid" });
  const other = store.createSession({ model: "acp:x", workspace: dir, title: "Other" });
  engine.inputRefusals.set("acp-child", (id) => (id === child.id ? "Codex runs this agent: it reads no message from here" : undefined));
  expect(() => engine.send(child.id, "hello")).toThrow("it reads no message from here");
  expect(() => engine.send(child.id, "hello", { key: "k" })).toThrow("reads no message");
  expect(() => engine.message(child.id, "report", { kind: "report" })).toThrow("reads no message");
  expect(store.events(child.id)).toHaveLength(0);
  expect(store.queue(child.id)).toHaveLength(0);
  expect(engine.inputRefused(other.id)).toBeUndefined();
  try { engine.send(child.id, "x"); } catch (e) { expect((e as any).status).toBe(409); }
});

test("an id longer than any id is not taken: an announce with one is left out, a message's ids are cut", () => {
  const { rows, writes, announce, feed, live, errors } = world(4);
  for (let i = 0; i < 4; i++) announce("i".repeat(20_000_000) + i, { title: "Big", state: { state: "running" } });
  expect(rows.size).toBe(0);
  expect(live.children.size).toBe(0);
  expect(writes.filter((w) => w.kind === "note" && /does not read/.test(w.data.text))).toHaveLength(1);
  announce("ok", { title: "Fine", state: { state: "running" } });
  expect(rows.size).toBe(1);
  feed("root", { sessionUpdate: "session_message_chunk", messageId: "m".repeat(20_000_000), senderSessionId: "s".repeat(20_000_000), recipientSessionId: "r".repeat(20_000_000), content: [{ type: "text", text: "hi" }] });
  for (const k of live.chunks.keys()) expect(k.length).toBeLessThan(1000);
  for (const m of live.chunks.values()) { expect(m.to.length).toBeLessThan(1000); expect(m.from.length).toBeLessThan(1000); }
  expect(errors).toEqual([]);
});

test("a child said to be at work again after it was over takes a place at work, and none past the limit", () => {
  const { rows, announce, live, writes } = world(1);
  announce("a", { title: "A", state: { state: "idle", stopReason: "end_turn" } });
  announce("b", { title: "B", state: { state: "running" } });
  expect(rows.size).toBe(2);
  const a = [...rows.values()][0]!;
  const before = a.patches.length;
  announce("a", { state: { state: "running" } });
  expect(a.patches.length).toBe(before);
  expect(readStatus(live, "a")).toBe("completed");
  expect(writes.filter((w) => w.kind === "note" && /more agents than Keel shows/.test(w.data.text))).toHaveLength(1);
  // When the one at work is done, the other may be at work again.
  announce("b", { state: { state: "idle", stopReason: "end_turn" } });
  announce("a", { state: { state: "running" } });
  expect(readStatus(live, "a")).toBe("running");
});

test("a child its parent's end made incomplete is not revived past the limit", async () => {
  const { rows, announce, live, runner } = world(1);
  announce("a", { title: "A", state: { state: "running" } });
  (runner as any).kidsOutlive(live);
  announce("b", { title: "B", state: { state: "running" } });
  expect(rows.size).toBe(2);
  const a = [...rows.values()][0]!;
  const before = a.patches.length;
  announce("a", { state: { state: "running" } });
  expect(a.patches.length).toBe(before);
});

function readStatus(live: any, id: string): string {
  const c = live.children.get(id);
  return c.over ? "over" : c.state.state?.state === "running" ? "running" : c.state.state?.stopReason === "end_turn" ? "completed" : "other";
}
