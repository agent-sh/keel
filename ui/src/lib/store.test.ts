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

const { actions, apply, connect, getState, linkRtt, liveNow, PAGE, scope, setBootLoad, staleSince, subscribe, trimmed } = await import("./store.ts");

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
// The daemon greets a socket as it opens: that first frame makes it the page's connection.
const greet = () => sock.onmessage!({ data: JSON.stringify({ t: "hello", pid: 1, started_ms: 1 }) });
const frame = async (f: Frame | SocketFrame) => { sock.onmessage!({ data: JSON.stringify(f) }); await settle(); };
// The page's socket is lost and the next one opens. The list and error reloads are answered by `rest`.
let listed: Session[] = [];
const rest = async () => { await answer("/api/sessions", { sessions: listed }); await answer("/api/errors", { errors: [] }); await answer("/api/models", { models: [], default: "", pinned: [], providers: [] }); };
const reconnect = async () => {
  sock.onclose!(); // the page tries again at once
  sock = Socket.all.at(-1)!;
  greet();
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
greet();
await settle();
await frame({ t: "replayed", cursors: {} });

test("a head moved back while the page was away stays where the daemon has it", async () => {
  await open(row("a", "a-e3"), [1, 2, 3].map((n) => event("a", n)), 100);
  // Meanwhile: two events stored, then the head set back to the third.
  listed = [row("a", "a-e3")];
  const now = snapshot(row("a", "a-e3"), undefined, 200);
  await reconnect();
  expect(sock.sent[0]).toEqual({ op: "resume", cursors: { a: 3 }, only: true });
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
  Socket.all.at(-1)!.onclose!(); // the try made at once is refused
  // Requests ask alone from there, a gap later: no socket is made until the daemon answers one.
  const tried = Socket.all.length, real = Date.now;
  Date.now = () => real() + 1000;
  try { timers.pop()!(); } finally { Date.now = real; }
  expect(Socket.all.length).toBe(tried);
  // Something else on the port is not the daemon; its own answer makes the try, which is greeted.
  expect(await answer("/api/health?link", { hello: "another program" })).toBe(true);
  expect(Socket.all.length).toBe(tried);
  Date.now = () => real() + 2000;
  try { timers.pop()!(); } finally { Date.now = real; }
  expect(await answer("/api/health?link", { ok: true, pid: 1 })).toBe(true);
  expect(Socket.all.length).toBe(tried + 1);
  sock = Socket.all.at(-1)!;
  greet();
  await settle();
  await rest();
  expect(asked(`/api/sessions/g?page=${PAGE}`)).toBe(false);
  await frame({ t: "replayed", cursors: { g: 4 } });
  expect(asked(`/api/sessions/g?page=${PAGE}`)).toBe(false);
  expect(await answer("/api/sessions/g?events=0", snapshot(row("g", "g-e4"), undefined, 700))).toBe(true);
});

// A session that shows an older branch: its head is not its newest event (an
// older version of a prompt is shown, a rewind, an undone clear). The page
// holds the branch shown, so its last event is far below the session's newest.
// Events 1 to 4 are the branch shown; 5 to 12 another branch from event 2.
const older = (id: string) => {
  const ev = (seq: number, parent: number | null, kind: StoredEvent["kind"] = "note"): StoredEvent =>
    ({ id: `${id}-e${seq}`, session_id: id, seq, parent: parent ? `${id}-e${parent}` : null, kind, data: { text: `event ${seq}` }, ts: seq });
  return { ev, shown: [ev(1, null), ev(2, 1), ev(3, 2), ev(4, 3)], head: `${id}-e4` };
};
const paged = (s: Session, events: StoredEvent[], seq: number, rev: number) => ({ ...snapshot(s, events, rev), seq, paged: true });
const openPaged = async (s: Session, events: StoredEvent[], seq: number, rev: number, before?: () => Promise<void>) => {
  listed = [...listed.filter((x) => x.id !== s.id), s];
  const p = actions.loadSession(s.id);
  await settle();
  await before?.();
  expect(await answer(`/api/sessions/${s.id}?page=${PAGE}`, paged(s, events, seq, rev))).toBe(true);
  await p;
};
const shownIds = (id: string) => getState().events[id]!.map((e) => e.seq);

test("a session that shows an older branch resumes from the session's newest seq, not its own last event", async () => {
  const { ev, shown, head } = older("h");
  await openPaged(row("h", head), shown, 12, 900);
  await reconnect();
  // The cursor is what the snapshot said the session's newest seq is.
  expect(sock.sent[0]).toEqual({ op: "resume", cursors: expect.objectContaining({ h: 12 }), only: true });
  // A daemon that replayed from the page's own last event (4) would send 5 to
  // 12 here: they are of the other branch, below the cursor, and are not taken.
  for (let n = 5; n <= 12; n++) await frame({ t: "event", event: ev(n, n === 5 ? 2 : n - 1) });
  expect(shownIds("h")).toEqual([1, 2, 3, 4]);
  expect(getState().sessions.h!.head).toBe(head);
  await frame({ t: "replayed", cursors: { h: 12 } });
  await rest();
  await answer("/api/sessions/h?events=0", { ...snapshot(row("h", head), undefined, 910), seq: 12 });
  expect(getState().sessions.h!.head).toBe(head);
  expect(shownIds("h")).toEqual([1, 2, 3, 4]);
});

test("a replayed event moves no head; the session's row after the replay says where it is", async () => {
  const { ev, shown, head } = older("i");
  await openPaged(row("i", head), shown, 12, 920);
  await reconnect();
  expect(sock.sent[0].cursors.i).toBe(12);
  // While the page was away the other branch grew by one event; the session still shows the older branch.
  await frame({ t: "event", event: ev(13, 12) });
  expect(getState().sessions.i!.head).toBe(head);
  // The replay ends with the row as the daemon has it.
  await frame({ t: "session", session: row("i", head, { rev: 3 }), rev: 930 } as Frame);
  await frame({ t: "replayed", cursors: { i: 13 } });
  await rest();
  await answer("/api/sessions/i?events=0", { ...snapshot(row("i", head, { rev: 3 }), undefined, 935), seq: 13 });
  expect(getState().sessions.i!.head).toBe(head);
  // The next reconnect resumes after it, and a live event (it has a rev) is the new head.
  await reconnect();
  expect(sock.sent[0].cursors.i).toBe(13);
  await frame({ t: "replayed", cursors: { i: 13 } });
  await rest();
  await answer("/api/sessions/i?events=0", { ...snapshot(row("i", head, { rev: 3 }), undefined, 940), seq: 13 });
  await frame({ t: "event", event: ev(14, 4), rev: 950 } as Frame);
  expect(getState().sessions.i!.head).toBe("i-e14");
  expect(shownIds("i")).toEqual([1, 2, 3, 4, 13, 14]);
});

test("events that come before the snapshot lands count toward the cursor, whichever comes first", async () => {
  const { ev, shown, head } = older("j");
  // The socket is ahead of the snapshot: a live event of the branch shown arrives while the request is out.
  await openPaged(row("j", head), shown, 12, 960, async () => { await frame({ t: "event", event: ev(13, 4), rev: 965 } as Frame); });
  expect(shownIds("j")).toEqual([1, 2, 3, 4, 13]);
  await reconnect();
  expect(sock.sent[0].cursors.j).toBe(13);
  await frame({ t: "replayed", cursors: { j: 13 } });
  await rest();
  await answer("/api/sessions/j?events=0", { ...snapshot(row("j", "j-e13"), undefined, 970), seq: 13 });
  // A part read meanwhile may bring an event before its frame: the frame is then not added again.
  const p = actions.page("j", { head: "j-e15" });
  await settle();
  await answer(`/api/sessions/j/page?limit=${PAGE}&head=j-e15`, { events: [ev(14, 13), ev(15, 14)], head: "j-e15", first: "j-e14", last: "j-e15", start: false, end: true, on_head: true });
  await p;
  await frame({ t: "event", event: ev(14, 13), rev: 980 } as Frame);
  await frame({ t: "event", event: ev(15, 14), rev: 981 } as Frame);
  expect(shownIds("j")).toEqual([1, 2, 3, 4, 13, 14, 15]);
  expect(getState().sessions.j!.head).toBe("j-e15");
});

test("a session a daemon answers whole (no page routes) is kept whole", async () => {
  // Fourteen hundred events from a daemon that sends no `paged`: more than a paged session holds.
  const events = Array.from({ length: 1400 }, (_, i) => event("w", i + 1));
  await open(row("w", "w-e1400"), events, 990);
  await frame({ t: "event", event: event("w", 1401), rev: 995 } as Frame);
  expect(getState().events.w!.length).toBe(1401);
  // The same session answered in parts is cut back to its newest part.
  const part = events.slice(-1300);
  await openPaged(row("x", "x-e1400"), part.map((e) => ({ ...e, id: e.id.replace("w-", "x-"), session_id: "x", parent: e.parent?.replace("w-", "x-") ?? null })), 1400, 996);
  await frame({ t: "event", event: event("x", 1401), rev: 997 } as Frame);
  expect(getState().events.x!.length).toBeLessThan(2 * PAGE);
  expect(getState().events.x!.at(-1)!.seq).toBe(1401);
});

test("a prompt at the end reads nothing; another version of an earlier prompt reads the part around it", async () => {
  const events = Array.from({ length: 30 }, (_, i) => event("y", i + 1));
  await openPaged(row("y", "y-e30"), events, 30, 1200);
  const around = (id: string) => `/api/sessions/y/page?limit=${PAGE}&around=${id}`;
  const prompt = (seq: number, parent: string): StoredEvent => ({ ...event("y", seq, "user"), parent });
  // The page's own prompt, its event first.
  await frame({ t: "event", event: prompt(31, "y-e30"), rev: 1201 } as Frame);
  expect(asked(around("y-e31"))).toBe(false);
  // The next one, with the session's row (already at the new head) before its event.
  await frame({ t: "session", session: row("y", "y-e32"), rev: 1202 } as Frame);
  await frame({ t: "event", event: prompt(32, "y-e31"), rev: 1203 } as Frame);
  expect(asked(around("y-e32"))).toBe(false);
  expect(getState().events.y!.map((e) => e.seq).slice(-2)).toEqual([31, 32]);
  // Another version of an early prompt, made elsewhere: the part around it is read.
  await frame({ t: "event", event: prompt(33, "y-e4"), rev: 1204 } as Frame);
  expect(await answer(around("y-e33"), { events: [prompt(33, "y-e4")], head: "y-e33", on_head: true, end: true, last: "y-e33" })).toBe(true);
});

test("what the socket brings is in the state at once, and its readers are told once a frame", async () => {
  await open(row("v", "v-e1", { phase: "working" }), [event("v", 1)], 1100);
  // A page has frames to wait for.
  const frames: (() => void)[] = [];
  G.requestAnimationFrame = (f: () => void) => frames.push(f);
  G.cancelAnimationFrame = () => {};
  let told = 0;
  const off = subscribe(() => told++);
  try {
    const delta = (text: string, rev: number) => frame({ t: "delta", session_id: "v", index: 0, kind: "text", text, rev } as Frame);
    await delta("one ", 1101);
    await delta("two ", 1102);
    await delta("three", 1103);
    await frame({ t: "queue", session_id: "v", queue: [], held: true, rev: 1104 } as Frame);
    // All of it is there, in order; nobody was told yet, and one frame was asked for.
    expect(getState().drafts.v![0]!.text).toBe("one two three");
    expect(getState().queues.v!.held).toBe(true);
    expect(told).toBe(0);
    expect(frames.length).toBe(1);
    frames.pop()!();
    expect(told).toBe(1);
    // A delta of a session this page has not opened is not kept, and tells nobody.
    await frame({ t: "delta", session_id: "nobody", index: 0, kind: "text", text: "x", rev: 1105 } as Frame);
    expect(getState().drafts.nobody).toBeUndefined();
    expect(frames.length).toBe(0);
    // A stored step ends the draft; the readers hear of it with the next frame.
    await frame({ t: "event", event: event("v", 2, "assistant"), rev: 1106 } as Frame);
    expect(getState().drafts.v).toEqual({});
    expect(getState().events.v!.map((e) => e.seq)).toEqual([1, 2]);
    expect(told).toBe(1);
    // A change the page itself makes (not the socket's delivery) tells them there and then, of everything so far.
    apply({ t: "queue", session_id: "v", queue: [], held: false, rev: 1107 } as Frame);
    expect(told).toBe(2);
  } finally {
    off();
    delete G.requestAnimationFrame;
    delete G.cancelAnimationFrame;
    timers.length = 0; // the timers the frames left (the page's fallback and its measure)
  }
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
  expect(line.length).toBeGreaterThanOrEqual(PAGE);
  expect(line.length).toBeLessThan(2 * PAGE);
  expect(line[0]!.kind).toBe("user"); // from a turn's start
  expect(line.at(-1)).toBe(list.at(-1)!);
  expect(kept.includes(main)).toBe(false);
  expect(kept.includes(side)).toBe(false);
  // The other version of a prompt that stays is kept with it.
  const first = line[0]!;
  const twin = { ...first, id: "t-twin", seq: 1.5 };
  expect(trimmed([list[0]!, twin, ...list.slice(1)], list.at(-1)!.id).includes(twin)).toBe(true);
});

// The session list is read by HTTP and can land after frames the socket
// already brought: it was read before them. The answer says what it reflects
// (`rev`), and a row a newer frame told of stands as that frame left it.
test("a session list that lands after newer frames puts no old row back", async () => {
  const had = Object.keys(getState().sessions);
  // The page holds four sessions, as the daemon listed them at rev 5000.
  let p = actions.loadSessions();
  await settle();
  expect(await answer("/api/sessions", { sessions: ["l-renamed", "l-deleted", "l-archived", "l-older"].map((id) => row(id, "")), rev: 5000 })).toBe(true);
  await p;
  // A list is asked for again and read at rev 5001; before its answer lands, the socket brings what came after.
  p = actions.loadSessions();
  await settle();
  await frame({ t: "session", session: row("l-older", "", { title: "an older word" }), rev: 5001 });
  await frame({ t: "session", session: row("l-renamed", "", { title: "renamed after the list was read" }), rev: 5002 });
  await frame({ t: "session", session: row("l-deleted", ""), deleted: true, rev: 5003 });
  await frame({ t: "session", session: row("l-archived", "", { archived: true }), rev: 5004 });
  await frame({ t: "session", session: row("l-made", ""), rev: 5005 });
  expect(await answer("/api/sessions", { sessions: ["l-renamed", "l-deleted", "l-archived"].map((id) => row(id, "")).concat(row("l-older", "", { title: "the list is the newer word" })), rev: 5001 })).toBe(true);
  await p;
  const now = getState().sessions;
  expect(now["l-renamed"]!.title).toBe("renamed after the list was read");
  expect(now["l-deleted"]).toBeUndefined();
  expect(now["l-archived"]!.archived).toBe(true);
  expect(now["l-made"]).toBeDefined();
  // A frame the list already reflects (the same rev) does not outrank it.
  expect(now["l-older"]!.title).toBe("the list is the newer word");
  // A list that is the newer word drops what it leaves out and takes every row as it has it.
  p = actions.loadSessions();
  await settle();
  expect(await answer("/api/sessions", { sessions: [row("l-renamed", "", { title: "renamed again" })], rev: 6000 })).toBe(true);
  await p;
  expect(Object.keys(getState().sessions).filter((id) => !had.includes(id))).toEqual(["l-renamed"]);
  expect(getState().sessions["l-renamed"]!.title).toBe("renamed again");
});

// A network that goes silent closes nothing: the page asks, hears no answer
// twice and says the daemon is not heard. The socket that then speaks again
// is read against like a new one, and a live event that arrives on it before
// the replay is left to the replay: applied first, it would move the cursor
// past the events the silence swallowed.
test("a socket that went silent and speaks again is read against, with no event skipped", async () => {
  await open(row("z", "z-e3"), [1, 2, 3].map((n) => event("z", n)), 7000);
  // The sessions the tests above left open are gone by now: only this one is read again.
  const others = async () => { for (const w of [...waiting]) if (/^\/api\/sessions\/[^/?]+\?events=0$/.test(w.url) && !w.url.startsWith("/api/sessions/z?")) await answer(w.url, { error: "no such session" }, 404); };
  // A socket of its own, so the look at it is armed in this test.
  await reconnect();
  await rest();
  await frame({ t: "replayed", cursors: { z: 3 } });
  expect(await answer("/api/sessions/z?events=0", snapshot(row("z", "z-e3"), undefined, 7050))).toBe(true);
  await others();
  expect(getState().synced).toBe(true);
  listed = [row("z", "z-e6")];
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  const run = (name: string) => timers.findLast((f) => f.name === name)!();
  try {
    const before = t;
    t += 2100; run("onLook");
    expect(sock.sent.at(-1)).toEqual({ op: "ping" });
    expect([getState().connected, getState().slow]).toEqual([true, false]);
    // Two asks unanswered: slow to answer, not lost. Three and a grace: not heard.
    t += 2000; run("onLook");
    expect([getState().connected, getState().slow, staleSince(getState())]).toEqual([true, true, null]);
    t += 2000; run("onLook");
    expect(getState().connected).toBe(true);
    t += 1000; run("onLook");
    expect([getState().connected, getState().slow]).toEqual([false, false]);
    // What the page shows is as of the last frame (a moment before the silence began), and its clocks stand there.
    const lostAt = staleSince(getState())!;
    expect(before - lostAt).toBeGreaterThanOrEqual(0);
    expect(before - lostAt).toBeLessThan(500);
    expect(liveNow()).toBe(lostAt);
    // It tries a new socket at once, and keeps the silent one.
    const tried = Socket.all.at(-1)!;
    expect(tried).not.toBe(sock);
    const at = sock.sent.length;
    // Events 4 and 5 never reached the page; 6 is live and is the first frame back.
    await frame({ t: "event", event: event("z", 6), rev: 7100 } as Frame);
    expect(getState().connected).toBe(true);
    expect(getState().synced).toBe(false);
    // Heard again, not yet caught up: the page still says since when its rows are, and the clocks still stand.
    t += 6500;
    expect(staleSince(getState())).toBe(lostAt);
    expect(liveNow()).toBe(lostAt);
    expect(sock.sent.slice(at).find((m) => m.op === "resume")).toEqual({ op: "resume", cursors: { z: 3 }, only: true });
    expect(Socket.all.at(-1)).toBe(tried); // and no other try was made
    expect(getState().events.z!.map((e) => e.seq)).toEqual([1, 2, 3]);
    for (const n of [4, 5, 6]) await frame({ t: "event", event: event("z", n) });
    await rest();
    await frame({ t: "replayed", cursors: { z: 6 } });
    expect(await answer("/api/sessions/z?events=0", snapshot(row("z", "z-e6"), undefined, 7200))).toBe(true);
    expect(getState().events.z!.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(getState().synced).toBe(true);
    // Caught up: current again, and the clocks run.
    expect(staleSince(getState())).toBeNull();
    expect(liveNow()).toBe(t);
    // After the replay a live event is taken as it comes.
    await frame({ t: "event", event: event("z", 7), rev: 7300 } as Frame);
    expect(getState().events.z!.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // The absence is told to the daemon once the page is right again.
    expect(asked("/api/connection")).toBe(true);
  } finally {
    Date.now = real;
  }
});

// The reviewer's slow link: two seconds each way. The page measures the round trip of its
// asks and gives the next one twice that, so the socket is never taken for lost while it
// answers; and the answers of asks that waited out an absence measure nothing.
test("a link whose answers take four seconds is measured and not taken for lost", async () => {
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  const run = (name: string) => timers.findLast((f) => f.name === name)!();
  try {
    // A socket of this test's own.
    sock.onclose!();
    sock = Socket.all.at(-1)!;
    t += 4200; // its greeting took a round trip and a little
    greet();
    await settle();
    expect(linkRtt()).toBe(4200);
    const asks = () => sock.sent.filter((m) => m.op === "ping").length;
    // Idle: each ask is answered four seconds later, and the next look comes when twice that has passed.
    for (let i = 0; i < 6; i++) {
      t += i === 0 ? 2000 : 4400; run("onLook");
      expect(asks()).toBe(i + 1);
      t += 4000; await frame({ t: "pong" });
      expect([i, getState().connected, getState().slow]).toEqual([i, true, false]);
    }
    expect(linkRtt()).toBe(4000);
    // Lost for good after that: three asks, each given eight seconds.
    for (const step of [4400, 8000, 8000]) { t += step; run("onLook"); expect(getState().connected).toBe(true); }
    t += 8000; run("onLook");
    expect(getState().connected).toBe(false);
    // The silent socket speaks again with the answers of the asks it held: none of them is a measure.
    t += 60_000;
    for (let i = 0; i < 3; i++) await frame({ t: "pong" });
    expect(getState().connected).toBe(true);
    expect(linkRtt()).toBe(4000);
  } finally {
    Date.now = real;
  }
});

test("a state says as of the loss it is from, and one told since the page is heard again says nothing", async () => {
  const { staleOf } = await import("./watch.ts");
  const since = 1_000;
  // The page hears the daemon and has caught up: nothing is stale.
  expect(staleOf("s", null, true, 500, 0)).toBeNull();
  // Lost at 1000 (the only loss): a state from before is as of then, heard again or not.
  expect([staleOf("s", since, false, 900, 1_000), staleOf("s", since, true, 900, 1_000)]).toEqual([1_000, 1_000]);
  // Heard again, catching up: a state the daemon told since is current before the rest is read.
  expect(staleOf("s", since, true, 1_500, 1_000)).toBeNull();
  // Lost again at 2000 before the catch-up ended: what was told between the two losses is as of
  // the second, what was not is still as of the first, and neither is current once it is heard again.
  expect([staleOf("s", since, false, 1_500, 2_000), staleOf("old", since, false, 900, 2_000)]).toEqual([2_000, 1_000]);
  expect([staleOf("s", since, true, 1_500, 2_000), staleOf("old", since, true, 900, 2_000)]).toEqual([2_000, 1_000]);
  expect(staleOf("s", since, true, 2_500, 2_000)).toBeNull();
});

test("a queue count orders by daemon rev without changing the full queue", async () => {
  const { queueCount, tellQueueCounts } = await import("./store.ts");
  const { remoteId } = await import("./fleet-ids.ts");
  const id = "unopened", peer = remoteId("peer", id);
  const count = (key = id) => queueCount(getState(), key);
  const queued = (key: string) => [{ id: "prompt", session_id: key, text: "later", steer: false, pos: 1, created: 1 }];
  apply({ t: "queue", session_id: id, queue: queued(id), held: true, rev: 2_000 });
  apply({ t: "queue", session_id: peer, queue: queued(peer), held: true, rev: 10 });
  tellQueueCounts(undefined, 2_001); // older daemon: no authoritative counts
  expect([count(), count("unknown")]).toEqual([1, undefined]);
  // The restarted daemon's bus rev starts higher. The page missed a clear.
  tellQueueCounts({}, 3_000);
  expect([count(), count(peer)]).toEqual([0, 1]);
  expect(getState().queues[id]).toMatchObject({ queue: queued(id), held: true });
  apply({ t: "queue", session_id: id, queue: [], held: false, rev: 3_002 });
  tellQueueCounts({ [id]: 1 }, 3_001); // a live zero wins over an older nonzero
  expect(count()).toBe(0);
  tellQueueCounts({ [id]: 2 }, 3_003);
  tellQueueCounts({ [id]: 1 }, 3_001); // an older HTTP answer arrives last
  expect(count()).toBe(2);
});

// The list leaves out the sessions of agents at rest and counts them. A row
// of one that this page holds is not taken for deleted because a later list
// does not carry it; the count is of the ones the page does not hold; and
// they are read once when asked for.
test("an agent's session the list leaves out stays, and the rest are read when asked for", async () => {
  // (Reads of the list that earlier tests left unanswered are not this test's.)
  for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i]!.url.startsWith("/api/sessions")) waiting.splice(i, 1);
  const had = Object.keys(getState().sessions);
  // The list at first: the parent and its one working agent; two agents at rest are counted.
  let p = actions.loadSessions();
  await settle();
  expect(await answer("/api/sessions", { sessions: [row("a-top", ""), row("a-works", "", { parent_id: "a-top" })], agents_left: { "a-top": 2 }, rev: 7000 })).toBe(true);
  await p;
  expect(getState().agentsLeft).toEqual({ "a-top": 2 });
  // The agent finishes. The next list leaves it out and counts three: the page holds one of them.
  await frame({ t: "session", session: row("a-works", "", { parent_id: "a-top", title: "finished" }), rev: 7001 });
  p = actions.loadSessions();
  await settle();
  expect(await answer("/api/sessions", { sessions: [row("a-top", "")], agents_left: { "a-top": 3 }, rev: 7002 })).toBe(true);
  await p;
  expect(getState().sessions["a-works"]!.title).toBe("finished");
  expect(getState().agentsLeft).toEqual({ "a-top": 2 });
  // Asked for (the agents are opened): one read, whoever asks while it is on its way.
  const first = actions.loadAgentsOf("a-top"), second = actions.loadAgentsOf("a-top");
  await settle();
  expect(await answer("/api/sessions?agents_of=a-top", { sessions: ["a-works", "a-done-1", "a-done-2"].map((id) => row(id, "", { parent_id: "a-top" })), rev: 7003 })).toBe(true);
  expect(asked("/api/sessions?agents_of=a-top")).toBe(false);
  await Promise.all([first, second]);
  expect(Object.keys(getState().sessions).filter((id) => !had.includes(id)).sort()).toEqual(["a-done-1", "a-done-2", "a-top", "a-works"]);
  expect(getState().agentsLeft).toEqual({});
  await actions.loadAgentsOf("a-top");
  expect(asked("/api/sessions?agents_of=a-top")).toBe(false);
  // A list read later keeps them all and has nothing left to read.
  p = actions.loadSessions();
  await settle();
  expect(await answer("/api/sessions", { sessions: [row("a-top", "")], agents_left: { "a-top": 3 }, rev: 7004 })).toBe(true);
  await p;
  expect(Object.keys(getState().sessions).filter((id) => !had.includes(id)).sort()).toEqual(["a-done-1", "a-done-2", "a-top", "a-works"]);
  expect(getState().agentsLeft).toEqual({});
  // The parent is deleted while the page was away: its agents go with it.
  p = actions.loadSessions();
  await settle();
  expect(await answer("/api/sessions", { sessions: [], agents_left: {}, rev: 7005 })).toBe(true);
  await p;
  expect(Object.keys(getState().sessions).filter((id) => !had.includes(id))).toEqual([]);
});

test("a session opened again while its stream is still heard reads no snapshot; a lost socket reads it again", async () => {
  const s = row("rs", "rs-e3");
  listed = [...listed, s];
  // A page caught up on its socket (what the tests before left on their way is answered).
  await reconnect();
  await rest();
  await frame({ t: "replayed", cursors: sock.sent[0].cursors });
  for (const w of [...waiting]) {
    const [, id, q] = /^\/api\/sessions\/([^/?]+)\?(events=0|page=\d+)$/.exec(w.url) ?? [];
    if (id) await answer(w.url, snapshot(getState().sessions[id] ?? row(id, ""), q === "events=0" ? undefined : getState().events[id] ?? [], 8000));
  }
  expect(getState().synced).toBe(true);
  // A view opens it: its snapshot, then its stream from there.
  const off = scope.show("rs");
  const first = actions.openSession("rs");
  await settle();
  expect(await answer(`/api/sessions/rs?page=${PAGE}`, snapshot(s, [1, 2, 3].map((n) => event("rs", n)), 9000))).toBe(true);
  await first;
  scope.loaded("rs");
  expect(scope.hearing("rs")).toBe(true);
  // A -> B -> A: the view leaves (the linger holds it) and comes back, a frame having come meanwhile.
  off();
  await frame({ t: "event", event: event("rs", 4) });
  const back = scope.show("rs");
  await actions.openSession("rs");
  await settle();
  expect(asked(`/api/sessions/rs?page=${PAGE}`)).toBe(false);
  expect(getState().events.rs!.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  // While the socket is lost the page cannot know what it missed: the open reads the snapshot.
  sock.onclose!();
  sock = Socket.all.at(-1)!;
  const lost = actions.openSession("rs");
  await settle();
  expect(await answer(`/api/sessions/rs?page=${PAGE}`, snapshot(s, [1, 2, 3, 4].map((n) => event("rs", n)), 9100))).toBe(true);
  await lost;
  back();
});
