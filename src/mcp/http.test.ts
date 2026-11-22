// What no e2e can time, against local stand-in servers over real HTTP and
// stdio: the standalone stream's reconnects, and what a request leaves
// behind and tells the server when it times out or is cancelled.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { startLegacyMcp } from "../../test/e2e/fixtures/legacy-http-mcp.ts";
import { startSseMcp } from "../../test/e2e/fixtures/legacy-sse-mcp.ts";
import { McpClient } from "./client.ts";

const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

test("a cut stream is opened again from its last event, a ping on it is answered, and a server without a stream still answers", async () => {
  const s = startLegacyMcp(), plain = startLegacyMcp({ get: "decline" });
  const c = await McpClient.connect({ kind: "http", url: s.url, headers: {} }, 5000, "legacy");
  const p = await McpClient.connect({ kind: "http", url: plain.url, headers: {} }, 5000, "legacy");
  try {
    await until(async () => (await s.stats()).streams_open === 1, "the GET stream");
    // The server may ask whether the client is there (2025-11-25 Ping: an empty result, promptly).
    await s.control({ emit: "ping" });
    await until(async () => (await s.stats()).responses.length === 1, "the answer to the ping");
    expect((await s.stats()).responses).toEqual([{ id: "ping-1", result: {} }]);
    // Cut by the server: opened again with the ID of the last event it carried.
    await s.control({ drop_stream: true });
    await until(async () => (await s.stats()).streams_opened === 2, "the stream again");
    const st = await s.stats();
    expect(st.last_event_ids).toEqual([null, "2"]);
    expect(st.streams_closed).toBe(0);

    // 405: the server offers no stream. Requests work, and it is not asked again.
    expect((await p.callTool("echo", { text: "a" })).content).toEqual([{ type: "text", text: "echo: a" }]);
    await Bun.sleep(200);
    const ps = await plain.stats();
    expect(ps.gets_declined).toBe(1);
    expect(ps.gets).toBe(1);
  } finally {
    c.close();
    p.close();
    await until(async () => (await s.stats()).streams_open === 0, "the stream closed with the client");
    s.stop();
    plain.stop();
  }
});

test("a server cannot make the stream reconnect without pause, and a wait leaves no listener", async () => {
  // Abort listeners added and removed from JS (the wait between two streams adds one).
  let left = 0;
  const add = AbortSignal.prototype.addEventListener, remove = AbortSignal.prototype.removeEventListener;
  AbortSignal.prototype.addEventListener = function (this: AbortSignal, ...a: any[]) { if (a[0] === "abort") left++; return (add as any).apply(this, a); } as any;
  AbortSignal.prototype.removeEventListener = function (this: AbortSignal, ...a: any[]) { if (a[0] === "abort") left--; return (remove as any).apply(this, a); } as any;
  const s = startLegacyMcp({ get: "retry0" }), flood = startLegacyMcp({ get: "flood" });
  const c = await McpClient.connect({ kind: "http", url: s.url, headers: {} }, 5000, "legacy");
  const f = await McpClient.connect({ kind: "http", url: flood.url, headers: {} }, 5000, "legacy");
  try {
    const before = left;
    await Bun.sleep(1300);
    // `retry: 0` and a closed stream, over and over: the backoff is the floor (one GET, a second, then the next after 1.5 s).
    expect((await s.stats()).gets).toBe(2);
    expect(left - before).toBeLessThanOrEqual(1); // the wait now running
    // An event that never ends is not read without limit: the stream is closed and not asked for again.
    const fs = await flood.stats();
    expect(fs.streams_closed).toBe(1);
    expect(fs.gets).toBe(1);
  } finally {
    AbortSignal.prototype.addEventListener = add;
    AbortSignal.prototype.removeEventListener = remove;
    c.close();
    f.close();
    s.stop();
    flood.stop();
  }
});

test("a request that times out aborts its POST and leaves nothing waiting", async () => {
  const s = startLegacyMcp({ get: "decline" });
  const c = await McpClient.connect({ kind: "http", url: s.url, headers: {} }, 5000, "legacy");
  try {
    // Count what the request leaves on the caller's signal.
    const caller = new AbortController();
    let listeners = 0;
    const add = caller.signal.addEventListener.bind(caller.signal), remove = caller.signal.removeEventListener.bind(caller.signal);
    caller.signal.addEventListener = ((...a: Parameters<typeof add>) => { listeners++; add(...a); }) as typeof add;
    caller.signal.removeEventListener = ((...a: Parameters<typeof remove>) => { listeners--; remove(...a); }) as typeof remove;
    let settled = 0;
    const call = c.callTool("hang", {}, caller.signal, 150);
    call.then(() => settled++, () => settled++);
    await expect(call).rejects.toThrow("tools/call timed out");
    expect(c.inflight).toBe(0);
    expect(listeners).toBe(0);
    // The server sees the response it held open go away, and is told the request was given up.
    await until(async () => (await s.stats()).aborted === 1, "the server to see the POST aborted");
    await until(async () => (await s.stats()).cancelled.length === 1, "the cancellation notice");
    // A caller that gives up later finds nothing left to cancel.
    caller.abort();
    await Bun.sleep(50);
    expect(settled).toBe(1);
    expect((await s.stats()).cancelled.length).toBe(1);
  } finally {
    c.close();
    s.stop();
  }
});

// On stdio there is no response to close: a modern server is told too (2026-07-28 Cancellation).
test("a modern stdio server is told when a request times out or is cancelled", async () => {
  const c = await McpClient.connect({ kind: "stdio", command: "bun", args: [join(import.meta.dir, "../../test/e2e/fixtures/modern-stdio-mcp.ts")], env: process.env as Record<string, string> }, 5000);
  try {
    expect(c.era).toBe("modern");
    await expect(c.callTool("hang", {}, undefined, 150)).rejects.toThrow("tools/call timed out");
    const caller = new AbortController();
    const call = c.callTool("hang", {}, caller.signal);
    caller.abort();
    await expect(call).rejects.toThrow("cancelled");
    const told = JSON.parse(((await c.callTool("cancelled", {})).content![0] as { text: string }).text) as { requestId: number; reason: string }[];
    // The probe (request 1) is not among them: only the two requests given up.
    expect(told).toEqual([{ requestId: 2, reason: "timed out" }, { requestId: 3, reason: "cancelled" }]);
    expect(c.inflight).toBe(0);
  } finally {
    c.close();
  }
});

// The older HTTP with SSE transport (2024-11-05): one event stream for the
// life of the client, whose first event names where messages are posted.
test("the older SSE transport: answers and the server's own messages come on its stream, and its end ends the client", async () => {
  const s = startSseMcp();
  const c = await McpClient.connect({ kind: "http", url: s.url, headers: {}, sse: true }, 5000);
  try {
    expect([c.era, c.version, c.serverInfo?.name]).toEqual(["legacy", "2024-11-05", "legacy-sse"]);
    expect((await c.listTools()).map((t) => t.name)).toEqual(["echo"]);
    expect((await c.callTool("echo", { text: "over the stream" })).content).toEqual([{ type: "text", text: "echo: over the stream" }]);
    // Twenty at once: each answer finds its own request.
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => c.callTool("echo", { text: String(i) })));
    expect(many.map((r) => (r.content![0] as { text: string }).text)).toEqual(Array.from({ length: 20 }, (_, i) => `echo: ${i}`));
    // One stream carried it all, and nothing was posted to the stream's own address.
    expect(await s.stats()).toMatchObject({ streams_opened: 1, streams_open: 1, refused_posts: 0, initializes: 1 });
    // What the server sends by itself: a changed list, and a ping that is answered.
    let changed = 0;
    c.onListChanged = () => changed++;
    await s.control({ changed: true, ping: true });
    await until(async () => changed === 1 && (await s.stats()).pongs.length === 1, "the list change and the answer to the ping");
    expect((await s.stats()).pongs).toEqual([{ id: "ping-1", result: {} }]);
    // The stream ends: the client is closed, says why, and a request out at that moment fails with it.
    let why = "";
    c.onClose = (w) => (why = w);
    await s.control({ close: true });
    await until(() => c.isClosed, "the client to close");
    expect(why).toBe("the server closed its event stream");
    await expect(c.callTool("echo", { text: "late" })).rejects.toThrow("the connection is closed");
  } finally {
    c.close();
    s.stop();
  }
});

test("the older SSE transport: no stream, and an address of another origin, are refused", async () => {
  const s = startSseMcp({ endpoint: "elsewhere" }), plain = startLegacyMcp({ get: "decline" });
  try {
    await expect(McpClient.connect({ kind: "http", url: s.url, headers: {}, sse: true }, 5000)).rejects.toThrow("named another origin for its messages (http://127.0.0.1:9): refused");
    // Its stream was let go.
    await until(async () => (await s.stats()).streams_open === 0, "the stream to be closed");
    await expect(McpClient.connect({ kind: "http", url: plain.url, headers: {}, sse: true }, 5000)).rejects.toThrow(`no event stream at ${plain.url}: HTTP 405`);
  } finally {
    s.stop();
    plain.stop();
  }
});

// A server's headers and the request's body go to the address given and
// nowhere else: a redirect is not followed, on either transport, and the
// refusal says where it pointed. The other origin sees no request.
test("no request to a server follows a redirect, on either transport", async () => {
  const seen: string[] = [];
  const there = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("x-api-key")}`); return new Response("{}"); } });
  const to = `http://127.0.0.1:${there.port}/mcp`;
  const here = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.redirect(`${to}?token=elsewhere`, 307) });
  const origin = `http://127.0.0.1:${here.port}`;
  const said = `${origin} answered with a redirect to ${to}, which is not followed`;
  const headers = { "x-api-key": "the-owner-s-key" };
  const posts = startSseMcp({ moved: to });
  try {
    // Streamable HTTP: the POST.
    await expect(McpClient.connect({ kind: "http", url: `${origin}/mcp`, headers }, 5000, "legacy")).rejects.toThrow(said);
    // The older transport: the stream's GET, and the POST to the address the stream named.
    await expect(McpClient.connect({ kind: "http", url: `${origin}/sse`, headers, sse: true }, 5000)).rejects.toThrow(said);
    await expect(McpClient.connect({ kind: "http", url: posts.url, headers, sse: true }, 5000)).rejects.toThrow(`http://127.0.0.1:${posts.port} answered with a redirect to ${to}, which is not followed`);
    expect(seen).toEqual([]);
    // Where it pointed is named without its query.
    await McpClient.connect({ kind: "http", url: `${origin}/mcp`, headers }, 5000, "legacy").catch((e) => expect(String(e)).not.toContain("elsewhere"));
  } finally {
    here.stop(true);
    there.stop(true);
    posts.stop();
  }
});
