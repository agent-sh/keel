// The page's catch-up after a lost socket, where a browser test would depend
// on timing: the real store, a socket and a fetch the test answers by hand,
// so the answers land in the orders that used to go wrong. A reconnect asks
// for a session of this daemon without its transcript, and only once the
// replay and the session list are in.
import { afterAll, expect, test } from "bun:test";
import type { Frame, Session, SocketFrame, StoredEvent } from "../../../src/core/types.ts";

// What the store and the modules it imports touch of a page when they load.
const G = globalThis as any;
const kept = Object.fromEntries(["window", "document", "location", "history", "localStorage", "sessionStorage", "matchMedia", "WebSocket", "fetch", "setTimeout", "setInterval"].map((k) => [k, G[k]]));
const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
};
const classes = { contains: () => false, toggle() {}, add() {}, remove() {} };
G.window = G;
G.addEventListener ??= () => {};
G.document = { hidden: false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: { style: { setProperty() {} }, classList: classes } };
G.location = { pathname: "/", hash: "", search: "", protocol: "http:", host: "keel.test", reload() {} };
G.history = { pushState() {}, replaceState() {} };
G.localStorage = storage();
G.sessionStorage = storage();
G.matchMedia = () => ({ matches: false, addEventListener() {} });
// Timers are kept, not run: the test opens the next socket itself.
const timers: (() => void)[] = [];
G.setTimeout = (f: () => void) => timers.push(f);
G.setInterval = () => 0;
// The sockets the page opens, newest last, and what it sent on each.
class Socket {
  static all: Socket[] = [];
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: () => void;
  constructor() { Socket.all.push(this); }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.onclose?.(); }
}
G.WebSocket = Socket;
// Every request waits until the test answers it.
const waiting: { url: string; done: (body: unknown, status?: number) => void }[] = [];
G.fetch = (url: string) => new Promise<Response>((resolve) => waiting.push({ url: String(url), done: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })) }));
afterAll(() => Object.assign(G, kept));

const { actions, connect, getState, PAGE, setBootLoad, trimmed } = await import("./store.ts");

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const asked = (url: string) => waiting.some((w) => w.url === url);
// Answers the request for `url` when the page has made it. False: it has not.
const answer = async (url: string, body: unknown, status = 200) => {
  const i = waiting.findIndex((w) => w.url === url);
  if (i < 0) return false;
  waiting.splice(i, 1)[0]!.done(body, status);
  await settle();
  return true;
};
const row = (id: string, head: string, more: Partial<Session> = {}): Session =>
  ({ id, title: id, model: "p:m", workspace: "/w", created: 1, updated: 1, phase: "idle", archived: false, usage: {} as Session["usage"], head, settings: {}, ...more });
const event = (session_id: string, seq: number, kind: StoredEvent["kind"] = "note"): StoredEvent =>
  ({ id: `${session_id}-e${seq}`, session_id, seq, parent: seq > 1 ? `${session_id}-e${seq - 1}` : null, kind, data: kind === "assistant" ? { blocks: [] } : { text: `event ${seq}` }, ts: seq });
const snapshot = (s: Session, events: StoredEvent[] | undefined, rev: number, draft: Record<number, { kind: string; text: string }> = {}) =>
  ({ session: s, ...(events ? { events } : {}), running: false, queue: [], held: false, draft, rev });
let sock: Socket;
const frame = async (f: Frame | SocketFrame) => { sock.onmessage!({ data: JSON.stringify(f) }); await settle(); };
// The page's socket is lost and the next one opens. The list and error reloads are answered by `rest`.
let listed: Session[] = [];
const rest = async () => { await answer("/api/sessions", { sessions: listed }); await answer("/api/errors", { errors: [] }); await answer("/api/models", { models: [], default: "", pinned: [], providers: [] }); };
const reconnect = async () => {
  sock.onclose!();
  timers.pop()!();
  sock = Socket.all.at(-1)!;
  sock.onopen!();
  await settle();
};
// A session the page has open, read once (its newest page).
const open = async (s: Session, events: StoredEvent[], rev: number) => {
  listed = [...listed.filter((x) => x.id !== s.id), ...(s.archived ? [] : [s])];
  const p = actions.loadSession(s.id);
  await settle();
  expect(await answer(`/api/sessions/${s.id}?page=${PAGE}`, snapshot(s, events, rev))).toBe(true);
  await p;
};

// The page's first socket: its first loads are the boot's, nothing is asked again.
setBootLoad(Promise.resolve());
connect();
sock = Socket.all.at(-1)!;
sock.onopen!();
await settle();
await frame({ t: "replayed", cursors: {} });

test("a head moved back while the page was away stays where the daemon has it", async () => {
  await open(row("a", "a-e3"), [1, 2, 3].map((n) => event("a", n)), 100);
  // Meanwhile: two events stored, then the head set back to the third.
  listed = [row("a", "a-e3")];
  const now = snapshot(row("a", "a-e3"), undefined, 200);
  await reconnect();
  expect(sock.sent[0]).toEqual({ op: "resume", cursors: { a: 3 } });
  // The answer without a transcript is given the moment the page asks for it.
  const early = [await answer("/api/sessions/a?events=0", now)];
  await rest();
  early.push(await answer("/api/sessions/a?events=0", now));
  await frame({ t: "event", event: event("a", 4) });
  await frame({ t: "event", event: event("a", 5) });
  early.push(await answer("/api/sessions/a?events=0", now));
  const syncedEarly = getState().synced;
  await frame({ t: "replayed", cursors: { a: 5 } });
  const late = await answer("/api/sessions/a?events=0", now);
  expect(getState().events.a!.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(getState().sessions.a!.head).toBe("a-e3");
  // It was asked for only once the replay was through, and the transcript never again.
  expect([early, late, syncedEarly, getState().synced]).toEqual([[false, false, false], true, false, true]);
  expect(asked(`/api/sessions/a?page=${PAGE}`)).toBe(false);
});

test("a reply streaming across the reconnect is whole, in either order of its last delta and the answer", async () => {
  for (const [id, deltaFirst] of [["b", false], ["c", true]] as const) {
    await open(row(id, `${id}-e1`), [event(id, 1)], 250);
    // The daemon replays at rev 300 with "Hello wor" streamed; "ld" follows at
    // 301; the session is read after that, with the whole "Hello world".
    const now = snapshot(row(id, `${id}-e2`), undefined, 301, { 0: { kind: "text", text: "Hello world" } });
    const last = () => frame({ t: "delta", session_id: id, index: 0, kind: "text", text: "ld", rev: 301 } as Frame);
    await reconnect();
    await answer(`/api/sessions/${id}?events=0`, now);
    await rest();
    await frame({ t: "event", event: event(id, 2, "assistant") });
    await frame({ t: "draft", session_id: id, blocks: { 0: { kind: "text", text: "Hello wor" } }, rev: 300 } as SocketFrame);
    await answer(`/api/sessions/${id}?events=0`, now);
    await frame({ t: "replayed", cursors: { [id]: 2 } });
    if (deltaFirst) await last();
    await answer(`/api/sessions/${id}?events=0`, now);
    if (!deltaFirst) await last();
    expect([id, getState().drafts[id]?.[0]?.text]).toEqual([id, "Hello world"]);
  }
});

test("an archived session that is open keeps its row, also when its answer is given before the list", async () => {
  await open(row("d", "d-e1", { archived: true }), [event("d", 1)], 400);
  const now = snapshot(row("d", "d-e1", { archived: true, title: "renamed meanwhile" }), undefined, 450);
  await reconnect();
  // Its own answer first if the page asked for it, the list (which holds no archived row) after.
  await answer("/api/sessions/d?events=0", now);
  await rest();
  await frame({ t: "replayed", cursors: { d: 1 } });
  await answer("/api/sessions/d?events=0", now);
  expect(getState().sessions.d?.title).toBe("renamed meanwhile");
});

test("a daemon that holds less than the page (a restored backup) has the session read whole", async () => {
  await open(row("f", "f-e5"), [1, 2, 3, 4, 5].map((n) => event("f", n)), 500);
  listed = [row("f", "f-e2")];
  await reconnect();
  await rest();
  // Its replay ended at the second event, below the page's cursor.
  await frame({ t: "replayed", cursors: { f: 2 } });
  expect(asked("/api/sessions/f?events=0")).toBe(false);
  expect(getState().events.f).toBeUndefined();
  // A new third event comes live while the whole session is on its way: it is not taken for an old one.
  const third = { ...event("f", 3), id: "f-new3", parent: "f-e2" };
  await frame({ t: "event", event: third, rev: 560 } as Frame);
  expect(await answer(`/api/sessions/f?page=${PAGE}`, snapshot(row("f", "f-e2"), [1, 2].map((n) => event("f", n)), 550))).toBe(true);
  expect(getState().events.f!.map((e) => e.id)).toEqual(["f-e1", "f-e2", "f-new3"]);
});

test("after a socket that closed inside its replay the transcripts are read whole, once", async () => {
  await open(row("g", "g-e2"), [1, 2].map((n) => event("g", n)), 600);
  await reconnect();
  await rest();
  await frame({ t: "event", event: event("g", 3) });
  // It closes before `replayed`: the next one does not wait for a replay that may not get through.
  await reconnect();
  expect(sock.sent[0]).toEqual(expect.objectContaining({ op: "resume" }));
  expect(sock.sent[0].cursors.g).toBe(3);
  expect(await answer(`/api/sessions/g?page=${PAGE}`, snapshot(row("g", "g-e4"), [1, 2, 3, 4].map((n) => event("g", n)), 650))).toBe(true);
  expect(getState().events.g!.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  await rest();
  await frame({ t: "replayed", cursors: { g: 4 } });
  // A socket that never opened (the daemon is down) is no such case: the next catch-up is the light one.
  sock.onclose!();
  timers.pop()!();
  sock = Socket.all.at(-1)!;
  await reconnect();
  await rest();
  expect(asked(`/api/sessions/g?page=${PAGE}`)).toBe(false);
  await frame({ t: "replayed", cursors: { g: 4 } });
  expect(asked(`/api/sessions/g?page=${PAGE}`)).toBe(false);
  expect(await answer("/api/sessions/g?events=0", snapshot(row("g", "g-e4"), undefined, 700))).toBe(true);
});

test("a session that outgrew what the page holds keeps its newest part", () => {
  // Three hundred turns of five events, and a second version of an early prompt on a side branch.
  const list: StoredEvent[] = [];
  const add = (kind: StoredEvent["kind"], parent?: string | null) => {
    const seq = list.length + 1;
    list.push({ id: `t-e${seq}`, session_id: "t", seq, parent: parent === undefined ? list.at(-1)?.id ?? null : parent, kind, data: {}, ts: seq });
    return list.at(-1)!;
  };
  const side = add("user", null);
  const main = add("user", null);
  for (let i = 0; i < 300; i++) {
    if (i) add("user");
    add("turn_start"); add("assistant"); add("note"); add("turn_end");
  }
  const kept = trimmed(list, list.at(-1)!.id);
  const line = kept.filter((e) => e.seq > 2);
  expect(line.length).toBeGreaterThanOrEqual(2 * PAGE);
  expect(line.length).toBeLessThan(3 * PAGE);
  expect(line[0]!.kind).toBe("user"); // from a turn's start
  expect(line.at(-1)).toBe(list.at(-1)!);
  expect(kept.includes(main)).toBe(false);
  expect(kept.includes(side)).toBe(false);
  // The other version of a prompt that stays is kept with it.
  const first = line[0]!;
  const twin = { ...first, id: "t-twin", seq: 1.5 };
  expect(trimmed([list[0]!, twin, ...list.slice(1)], list.at(-1)!.id).includes(twin)).toBe(true);
});
