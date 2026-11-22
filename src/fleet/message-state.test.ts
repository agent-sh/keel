// A message between sessions has one true state in the store. (Queued, then delivered, then
// handled, and the list a session shows of it, are checked through the daemon in
// test/e2e/past-truth.spec.ts. Here: what that workload does not reach.)
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { migrate } from "./db.ts";
import { MessageStates, peerMessageLines, peerMessages } from "./message-state.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "keel-msgstate-"));
  dirs.push(dir);
  const store = new Store(dir);
  migrate(store);
  const bus = new Bus();
  const running = new Set<string>();
  const states = new MessageStates({
    store, bus, isRunning: (id) => running.has(id), capture: (e) => { throw e; }, dropCheckMs: 20,
    read: async (sql, args) => store.db.query<any, any[]>(sql).all(...args),
  });
  const a = store.createSession({ model: "m", workspace: "/", title: "Sender" }), b = store.createSession({ model: "m", workspace: "/", title: "Receiver busy" });
  const stateOf = (id: string) => store.db.query<{ state: string; reason: string | null; state_ms: number | null }, [string]>("SELECT state, reason, state_ms FROM fleet_messages WHERE id = ?").get(id)!;
  // A message as the fleet stores it (messages.ts): the row, and its queued row in the receiver's queue.
  const queued = (id: string, text: string) => {
    const meta = { kind: "peer", from: { session_id: a.id, title: "Sender", daemon_id: "d" }, message_id: id };
    const q = store.enqueue(b.id, `<external_input message_id="${id}">\n\n${text}\n</external_input>`, false, undefined, meta);
    store.db.query("INSERT INTO fleet_messages (id, created_ms, state, to_session, text, wake, sender) VALUES (?, ?, 'queued', ?, ?, 1, ?)").run(id, Date.now(), b.id, text, JSON.stringify(meta.from));
    bus.emit({ t: "queue", session_id: b.id, queue: store.queue(b.id), held: false });
    return { q, meta };
  };
  // The engine reads a queued row: it leaves the queue and enters the history in one write, then both are told.
  const read = (q: { id: string; text: string }, meta: object) => {
    store.dequeue(q.id);
    running.add(b.id);
    bus.emit({ t: "queue", session_id: b.id, queue: store.queue(b.id), held: false });
    bus.emit({ t: "event", event: store.append(b.id, "user", { text: q.text, origin: "queued", ...meta }) });
  };
  const end = (reason: string) => { running.delete(b.id); bus.emit({ t: "event", event: store.append(b.id, "turn_end", { reason }) }); };
  const settle = () => new Promise((r) => setTimeout(r, 80));
  return { store, bus, states, a, b, stateOf, queued, read, end, settle, done: () => { states.stop(); store.db.close(); } };
}

test("a message read by a turn that failed is handled, with how that turn ended", async () => {
  const { stateOf, queued, read, end, done } = fresh();
  try {
    const { q, meta } = queued("m1", "And the tests?");
    read(q, meta);
    expect(stateOf("m1").state).toBe("delivered");
    end("error");
    expect([stateOf("m1").state, stateOf("m1").reason]).toEqual(["handled", "the turn that read it failed"]);
  } finally { done(); }
});

test("a row that leaves the queue unread is dropped, with the engine's reason where it gives one", async () => {
  const { store, bus, b, states, stateOf, queued, settle, done } = fresh();
  try {
    // The owner removed the row: nothing was stored in the history.
    const one = queued("m1", "Anyone there?");
    store.dequeue(one.q.id);
    bus.emit({ t: "queue", session_id: b.id, queue: store.queue(b.id), held: false });
    expect(stateOf("m1").state).toBe("queued");
    await settle();
    expect([stateOf("m1").state, stateOf("m1").reason]).toEqual(["dropped", "it left that session's queue before it was read"]);
    // Where the engine tells why (a hook), the reason is its own and the state is set at once.
    const two = queued("m2", "Still there?");
    states.dropped([{ ...two.q, meta: two.meta }], "archived");
    expect([stateOf("m2").state, stateOf("m2").reason]).toEqual(["dropped", "its session was archived before it was read"]);
    // A message still in the queue stays queued, whatever else changes in the queue.
    queued("m3", "Third");
    bus.emit({ t: "queue", session_id: b.id, queue: store.queue(b.id), held: true });
    await settle();
    expect(stateOf("m3").state).toBe("queued");
  } finally { done(); }
});

test("a start settles what the daemon before it left: read and idle is handled, a turn that still runs is waited for", async () => {
  const { store, bus, b, stateOf, queued, done } = fresh();
  const { q, meta } = queued("m1", "Before the restart");
  // The daemon before this one stored the prompt and went down before it could say so.
  store.dequeue(q.id);
  store.append(b.id, "user", { text: q.text, origin: "queued", ...meta });
  expect(stateOf("m1").state).toBe("queued");
  const running = new Set<string>([b.id]);
  const again = new MessageStates({ store, bus, isRunning: (id) => running.has(id), capture: (e) => { throw e; }, read: async (sql, args) => store.db.query<any, any[]>(sql).all(...args) });
  try {
    await new Promise((r) => setTimeout(r, 30));
    // Its turn was resumed and still runs: delivered, until that turn ends.
    expect(stateOf("m1").state).toBe("delivered");
    running.delete(b.id);
    bus.emit({ t: "event", event: store.append(b.id, "turn_end", { reason: "end_turn" }) });
    expect(stateOf("m1").state).toBe("handled");
  } finally { again.stop(); done(); }
});
