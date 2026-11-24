import { expect, test } from "bun:test";
import { continuation, ResponsesSockets } from "./responses-ws.ts";
import { woke } from "./wake.ts";
import { outward, setEgressSink } from "../safety/egress.ts";
import { frameBytes, handshakeBytes } from "../safety/egress-count.ts";

// A request continues the previous response only when nothing but its input
// grew: the previous answer's own items are skipped, the new ones are sent.
test("continuation sends only the new input items", () => {
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] };
  const prev = { rest: JSON.stringify({ model: "m", tools: [] }), input: [user], id: "resp_1" };
  const call = { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" };
  const out = { type: "function_call_output", call_id: "c1", output: "1" };
  expect(continuation(prev, { model: "m", tools: [], input: [user, call, out] })).toEqual({ id: "resp_1", input: [out] });
  // A changed field, a shorter or rewritten input: sent whole.
  expect(continuation(prev, { model: "m", tools: [], service_tier: "priority", input: [user, call, out] })).toBeNull();
  expect(continuation(prev, { model: "m", tools: [], input: [] })).toBeNull();
  expect(continuation(prev, { model: "m", tools: [], input: [{ ...user, content: [] }, out] })).toBeNull();
  expect(continuation(undefined, { model: "m", input: [user] })).toBeNull();
});

// A stand-in for the backend: each `response.create` is answered after `ms`
// with a completed response that names the socket it came on.
function backend(ms: number) {
  let sockets = 0;
  const srv = Bun.serve({
    port: 0,
    fetch(req, s) { return s.upgrade(req, { data: { n: ++sockets } }) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      data: {} as { n: number },
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        const n = ws.data.n;
        setTimeout(() => ws.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${n}_${m.input.length}`, socket: n, previous: m.previous_response_id ?? null, sent: m.input.length } })), ms);
      },
    },
  });
  return { url: `ws://127.0.0.1:${srv.port}`, opened: () => sockets, stop: () => srv.stop(true) };
}

async function ask(socks: ResponsesSockets, key: string, body: Record<string, any>) {
  const req = { signal: new AbortController().signal } as any;
  let done: any;
  for await (const e of socks.events(key, {}, req)(body)) done = JSON.parse(e.data).response;
  return done as { socket: number; previous: string | null; sent: number };
}

// The readers of one tool call ask at once on the session's key. Each gets a
// socket of its own; before, the second found the socket busy, the driver
// closed it under the first ("the socket closed during the answer") and the
// session's key went to HTTP for good.
test("requests of one key that overlap each get a socket and all finish", async () => {
  const b = backend(40);
  const socks = new ResponsesSockets("test", () => b.url);
  try {
    const u = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    // One request alone opens the key's socket; three at once then overlap on it.
    const first = await ask(socks, "k", { model: "m", input: [u("a")] });
    const three = await Promise.all(["b", "c", "d"].map((t) => ask(socks, "k", { model: "m", input: [u(t)] })));
    expect(new Set(three.map((r) => r.socket)).size).toBe(3);
    expect(three.map((r) => r.socket)).toContain(first.socket);
    expect(b.opened()).toBe(3);
    expect(socks.usable("k")).toBe(true);
    // Later requests reuse the free sockets; the one that continues an earlier
    // answer goes to the socket that holds it, with only its new items.
    const call = { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" };
    const out = { type: "function_call_output", call_id: "c1", output: "1" };
    const next = await ask(socks, "k", { model: "m", input: [u("c"), call, out] });
    expect(next).toMatchObject({ socket: three[1]!.socket, previous: `resp_${three[1]!.socket}_1`, sent: 1 });
    expect(b.opened()).toBe(3);
    expect(socks.stats).toEqual({ whole: 4, continued: 1, fallback: 0 });
  } finally { b.stop(); }
});

// Codex's requests over the socket are rows of the outward ledger, as its
// requests over HTTP are: the socket's opening once, and each request with the
// bytes its message is on the wire.
test("a socket's opening and each request on it are rows of the outward ledger", async () => {
  const b = backend(5);
  const socks = new ResponsesSockets("test", () => b.url);
  const got: any[] = [];
  setEgressSink((o) => got.push(o));
  try {
    const u = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    await outward({ tool: "model", via: "codex", session: "s1" }, () => ask(socks, "k", { model: "m", input: [u("a")] }));
    await outward({ tool: "model", via: "codex", session: "s1" }, () => ask(socks, "k", { model: "m", input: [u("b")] }));
    const port = Number(new URL(b.url).port);
    expect(got.map((r) => [r.session, r.tool, r.host, r.port, r.status])).toEqual([["s1", "model", "127.0.0.1", port, 101], ["s1", "model", "127.0.0.1", port, null], ["s1", "model", "127.0.0.1", port, null]]);
    expect(got[0].bytes).toBe(handshakeBytes(b.url, {}));
    expect(got[2].bytes).toBe(frameBytes(Buffer.byteLength(JSON.stringify({ type: "response.create", model: "m", input: [u("b")] }))));
  } finally { setEgressSink(undefined); b.stop(); }
});

// A machine's sleep leaves the sockets nobody uses dead on the far side. The wake closes them, so the next
// request opens a new one and does not wait on the old.
test("a wake closes the idle sockets and the next request opens a new one", async () => {
  const b = backend(5);
  const socks = new ResponsesSockets("test", () => b.url);
  try {
    const u = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    await ask(socks, "k", { model: "m", input: [u("a")] });
    await ask(socks, "k", { model: "m", input: [u("b")] });
    expect(b.opened()).toBe(1);
    await woke(async () => true);
    const after = await ask(socks, "k", { model: "m", input: [u("c")] });
    expect(b.opened()).toBe(2);
    expect(after.socket).toBe(2);
  } finally { b.stop(); }
});
