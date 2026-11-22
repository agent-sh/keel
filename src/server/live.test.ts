// The replay of a resume over a real store: only the events after the cursor,
// and where it ended. A cursor ahead of what is stored (the page outlived a
// restored backup) ends below it, which tells the page to read the session whole.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { Live } from "./live.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "live-"));
const store = new Store(dir);
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a resume replays what came after the cursor and says where it ended", () => {
  const live = new Live(store, new Bus(), () => {});
  const s = store.createSession({ workspace: dir, model: "p:m" });
  const empty = store.createSession({ workspace: dir, model: "p:m" });
  for (let i = 1; i <= 5; i++) store.append(s.id, "note", { text: `note ${i}` });
  const resume = (cursors: Record<string, number>) => {
    const sent: any[] = [];
    live.message({ send: (d: string) => void sent.push(JSON.parse(d)), subscribe() {}, unsubscribe() {} } as any, JSON.stringify({ op: "resume", cursors }));
    return { seqs: sent.filter((f) => f.t === "event").map((f) => f.event.seq), ends: sent.find((f) => f.t === "replayed").cursors };
  };
  expect(resume({ [s.id]: 3 })).toEqual({ seqs: [4, 5], ends: { [s.id]: 5 } });
  expect(resume({ [s.id]: 5 })).toEqual({ seqs: [], ends: { [s.id]: 5 } });
  expect(resume({ [s.id]: 0 })).toEqual({ seqs: [1, 2, 3, 4, 5], ends: { [s.id]: 5 } });
  // The page holds nine events of it, the daemon five: the replay ends at the fifth.
  expect(resume({ [s.id]: 9, [empty.id]: 2, gone: 4 })).toEqual({ seqs: [], ends: { [s.id]: 5, [empty.id]: 0 } });
});

// A replayed event carries no rev (it may be of any branch and moves no head
// in the page); the session's row follows the events with one, so the page
// knows where the head is: also when it shows an older branch than the newest.
test("a replay ends each session with its row, which carries a rev", () => {
  const bus = new Bus();
  const live = new Live(store, bus, () => {});
  const s = store.createSession({ workspace: dir, model: "p:m" });
  const first = store.append(s.id, "note", { text: "one" });
  for (let i = 2; i <= 4; i++) store.append(s.id, "note", { text: `note ${i}` });
  // The session shows the first event again: its head is not its newest event.
  store.updateSession(s.id, { head: first.id });
  const sent: any[] = [];
  live.message({ send: (d: string) => void sent.push(JSON.parse(d)), subscribe() {}, unsubscribe() {} } as any, JSON.stringify({ op: "resume", cursors: { [s.id]: 2 } }));
  const events = sent.filter((f) => f.t === "event");
  expect(events.map((f) => f.event.seq)).toEqual([3, 4]);
  expect(events.every((f) => f.rev === undefined)).toBe(true);
  const row = sent.find((f) => f.t === "session");
  expect(row.session.head).toBe(first.id);
  expect(row.rev).toBe(bus.rev());
  expect(sent.indexOf(row)).toBeGreaterThan(sent.indexOf(events.at(-1)));
  expect(store.lastSeq(s.id)).toBe(4);
});

// What a socket hears: the sessions its resume named, the ones a sub added
// since, less the ones an unsub took away. A sub catches the session up from
// its cursor as a resume does and says no `replayed` (the page's catch-up is
// the resume's alone).
const socket = () => {
  const sent: any[] = [];
  const topics = new Set<string>();
  const ws = { send: (d: string) => void sent.push(JSON.parse(d)), subscribe: (t: string) => void topics.add(t), unsubscribe: (t: string) => void topics.delete(t), get subscriptions() { return [...topics]; } } as any;
  return { ws, sent, topics, on: () => [...topics].sort() };
};

test("a resume names what a socket hears, a sub adds to it and an unsub takes away", () => {
  const bus = new Bus();
  const live = new Live(store, bus, () => {});
  const a = store.createSession({ workspace: dir, model: "p:m" });
  const b = store.createSession({ workspace: dir, model: "p:m" });
  for (let i = 1; i <= 3; i++) store.append(b.id, "note", { text: `note ${i}` });
  const { ws, sent, topics, on } = socket();
  const say = (m: object) => { sent.length = 0; live.message(ws, JSON.stringify(m)); };
  live.open(ws);
  // Before it says anything: what every socket hears, and every row.
  expect(on()).toEqual(["all", "rows"]);
  say({ op: "resume", cursors: { [a.id]: 0 }, only: true, watch: ["m1--far"], feeds: ["activity", "no-such-feed"] });
  expect(on()).toEqual(["all", "f:activity", "rows:list", `s:${a.id}`, "s:m1--far"].sort());
  expect(sent.at(-1)).toEqual({ t: "replayed", cursors: { [a.id]: 0 } });
  // A session opened later: its events after the snapshot's seq, its row, and no `replayed`.
  say({ op: "sub", cursors: { [b.id]: 1 } });
  expect(sent.filter((f) => f.t === "event").map((f) => f.event.seq)).toEqual([2, 3]);
  expect(sent.some((f) => f.t === "session" && f.session.id === b.id)).toBe(true);
  expect(sent.some((f) => f.t === "replayed")).toBe(false);
  expect(topics.has(`s:${b.id}`)).toBe(true);
  say({ op: "unsub", watch: [a.id, "m1--far"], feeds: ["activity"] });
  expect(on()).toEqual(["all", "rows:list", `s:${b.id}`].sort());
  // A second resume says the whole again: what it leaves out is no longer heard.
  say({ op: "resume", cursors: { [a.id]: 0 }, only: true });
  expect(on()).toEqual(["all", "rows:list", `s:${a.id}`].sort());
});

// A client that does not say `only`: the form the API's page documents, and what a tab of an
// earlier build sends at each reconnect. It hears every session, the ones it names included,
// by one topic: on a named session's own topic as well it got every event and every delta of
// that session twice, and such a tab drew a reply doubled as it streamed.
test("a resume that names a session without `only` hears it once, with every other", () => {
  const bus = new Bus();
  // What each topic's subscribers are sent, as Bun's publish delivers it.
  const sockets: ReturnType<typeof socket>[] = [];
  const live = new Live(store, bus, (topic, data) => { for (const s of sockets) if (s.topics.has(topic)) s.sent.push(JSON.parse(data)); });
  const a = store.createSession({ workspace: dir, model: "p:m" });
  const other = store.createSession({ workspace: dir, model: "p:m" });
  for (let i = 1; i <= 2; i++) store.append(a.id, "note", { text: `note ${i}` });
  const open = (first: object) => { const s = socket(); sockets.push(s); live.open(s.ws); live.message(s.ws, JSON.stringify(first)); s.sent.length = 0; return s; };
  const plain = open({ op: "resume", cursors: { [a.id]: 2 } });
  const nothing = open({ op: "resume", cursors: {} });
  const only = open({ op: "resume", cursors: { [a.id]: 2 }, only: true });
  expect(plain.on()).toEqual(["all", "live", "rows"]);
  expect(nothing.on()).toEqual(["all", "live", "rows"]);
  // A sub on such a socket (a client that mixes the two) catches up and adds no topic.
  live.message(plain.ws, JSON.stringify({ op: "sub", cursors: { [other.id]: 0 }, watch: ["m1--far"], feeds: ["activity"] }));
  expect(plain.on()).toEqual(["all", "live", "rows"]);
  plain.sent.length = 0;

  bus.emit({ t: "delta", session_id: a.id, index: 0, kind: "text", text: "one " });
  bus.emit({ t: "delta", session_id: a.id, index: 0, kind: "text", text: "two" });
  bus.emit({ t: "event", event: store.append(a.id, "note", { text: "note 3" }) });
  bus.emit({ t: "delta", session_id: other.id, index: 0, kind: "text", text: "elsewhere" });
  bus.emit({ t: "status", session_id: a.id, status: { kind: "idle" } });
  // A row a list shows (a new title), and one only an open view reads (its tokens).
  bus.emit({ t: "session", session: store.updateSession(a.id, { title: "Named" }) });
  bus.emit({ t: "session", session: store.updateSession(a.id, { usage: { ...store.session(a.id)!.usage, input: 5 } }) });
  bus.emit({ t: "session", session: { ...store.session(other.id)!, archived: true }, deleted: true });
  bus.emit({ t: "queue", session_id: a.id, queue: [], held: false });
  bus.emit({ t: "queue", session_id: a.id, queue: [], held: false });

  const heard = (s: ReturnType<typeof socket>) => s.sent.map((f) => `${f.t}${f.t === "delta" ? `:${f.text}` : f.t === "event" ? `:${f.event.seq}` : f.t === "session" ? `:${f.session.id === a.id ? "a" : "other"}` : ""}`);
  // Every frame once, each in the order it was emitted: what such a client got before sessions had topics.
  const whole = ["delta:one ", "delta:two", "event:3", "delta:elsewhere", "status", "session:a", "session:a", "session:other", "queue"];
  expect(heard(plain)).toEqual(whole);
  expect(heard(nothing)).toEqual(whole);
  // The same day for a page that said `only` and shows the session: its stream, and nothing of the other
  // but that it is gone. (Its own row comes by its topic and, when a list shows the change, with the list's rows.)
  expect(heard(only).filter((f) => !f.startsWith("session"))).toEqual(["delta:one ", "delta:two", "event:3", "status", "queue"]);
  expect(heard(only).filter((f) => f === "session:other")).toHaveLength(1);
});
