// The ledger's rows as its writers make them, with a sink of the test's own
// (the daemon's writes them to the table: src/server/routes/egress.ts).
import { afterEach, expect, test } from "bun:test";
import { noteOutward, outward, setEgressSink, socketRows, tagFor, tagged, type Outward } from "./egress.ts";
import { frameBytes, handshakeBytes } from "./egress-count.ts";

afterEach(() => setEgressSink(undefined));
const rows = () => {
  const got: Outward[] = [];
  setEgressSink((o) => got.push(o));
  return got;
};

test("a row's reason never keeps the address it was for", () => {
  const got = rows();
  noteOutward({ host: "git.example", outcome: "failed", why: "fatal: unable to access 'https://git.example/team/repo.git?token=SECRET/': Could not resolve host" });
  noteOutward({ host: "api.example", outcome: "failed", why: "https://u:pw@api.example/x?y=1" });
  expect(got.map((r) => r.why)).toEqual(["fatal: unable to access 'https://git.example': Could not resolve host", "https://api.example"]);
  expect(JSON.stringify(got)).not.toMatch(/SECRET|team\/repo|pw@|y=1/);
});

test("a call's tag is a random word, the same for the call's life, and names no id", () => {
  const a = { session: "s1", call: "c1", tool: "Bash", turn: null };
  const t1 = tagFor(a), t2 = tagFor({ ...a, turn: "t" });
  expect(t1).toBe(t2);
  expect(tagged(t1)).toMatchObject({ session: "s1", call: "c1", turn: "t" });
  expect(t1).toMatch(/^[0-9a-z]{24}$/);
  // Not worked out from the ids: neither the hash the tag once was, nor the same for the same ids elsewhere.
  expect(t1).not.toBe(Bun.hash("s1\0c1").toString(36));
  const other = tagFor({ session: "s1", call: "c2", tool: "Bash", turn: null });
  expect(other).not.toBe(t1);
  expect(tagged(other)?.call).toBe("c2");
  expect(tagged("nosuchtag")).toBeUndefined();
});

test("a socket's opening is a row in the scope it was opened in; each message is one in the scope that sends it", async () => {
  const srv = Bun.serve({ port: 0, fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 403 })), websocket: { message() {} } });
  try {
    const got = rows();
    const url = `ws://127.0.0.1:${srv.port}/feed`;
    // A monitor's: a label of its own, whoever starts it (a restart starts it with no scope).
    const r = socketRows(url, undefined, { tool: "monitor", via: "websocket", session: "s-mon" });
    const ws = new WebSocket(url);
    await new Promise<void>((ok, bad) => { ws.onopen = () => (r.opened(), ok()); ws.onerror = () => bad(new Error("no socket")); });
    r.opened(); // told once
    ws.close();
    expect(got).toEqual([expect.objectContaining({ tool: "monitor", via: "websocket", session: "s-mon", host: "127.0.0.1", port: srv.port, bytes: handshakeBytes(url), outcome: "sent", status: 101 })]);
    // A model's socket: opened in its request's scope, the handler runs outside it; a message in a later request's.
    got.length = 0;
    const m = outward({ tool: "model", via: "codex", session: "s1" }, () => socketRows(url, { authorization: "Bearer t" }));
    m.opened();
    outward({ tool: "model", via: "codex", session: "s1", turn: "t2" }, () => m.sent(300));
    expect(got).toEqual([
      expect.objectContaining({ tool: "model", via: "codex", session: "s1", bytes: handshakeBytes(url, { authorization: "Bearer t" }), outcome: "sent" }),
      expect.objectContaining({ tool: "model", session: "s1", turn: "t2", bytes: frameBytes(300), outcome: "sent" }),
    ]);
    // One that could not open is a failed row; this machine's loopback with nothing to name is plumbing, no row.
    got.length = 0;
    outward({ session: "s1", tool: "monitor" }, () => socketRows("ws://127.0.0.1:1/x")).failed("the socket could not be opened");
    socketRows(url).opened();
    expect(got).toEqual([expect.objectContaining({ session: "s1", host: "127.0.0.1", port: 1, outcome: "failed", why: "the socket could not be opened" })]);
  } finally { srv.stop(true); }
});
