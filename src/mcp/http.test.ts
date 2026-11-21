// The legacy Streamable HTTP paths, against a local stand-in server over real
// HTTP: what the client and the manager do when the server ends the session.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLegacyMcp } from "../../test/e2e/fixtures/legacy-http-mcp.ts";
import { McpClient } from "./client.ts";
import { McpManager } from "./manager.ts";

const dir = () => mkdtempSync(join(tmpdir(), "keel-mcp-http-"));
const manager = (servers: Record<string, any>, errors: unknown[] = []) => {
  const m = new McpManager({ capture: (_k: string, e: unknown) => errors.push(e) } as any, dir(), "/");
  for (const [name, c] of Object.entries(servers)) (m as any).addEntry(name, c);
  return m;
};
const ctx = (extra: Record<string, unknown> = {}) => ({ sessionId: "fixture", cwd: "/", signal: new AbortController().signal, seen: new Map(), spillDir: dir(), ...extra }) as any;
const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

test("a session the server ended fails the call once, and the next call runs on a new session", async () => {
  const s = startLegacyMcp({ get: "decline" });
  const errors: unknown[] = [];
  const m = manager({ legacy: { url: s.url } }, errors);
  try {
    const first = await m.ensure("legacy");
    expect((await m.call("legacy", "echo", { text: "a" }, ctx())).content).toBe("echo: a");
    await s.control({ expire: true });

    // The final authorization check still runs just before the request goes out.
    let asked = 0;
    const failed = await m.call("legacy", "echo", { text: "b" }, ctx({ authorizationError: () => (asked++, undefined) }));
    expect(asked).toBeGreaterThan(0);
    expect(failed.is_error).toBe(true);

    // The old connection is no one's any more, and discovery ran again by itself on a new session.
    expect(first.isClosed).toBe(true);
    await until(() => m.list()[0]!.state === "ready", "the new session");
    const second = await m.ensure("legacy");
    expect(second).not.toBe(first);
    let st = await s.stats();
    expect(st.initializes).toBe(2);
    const [one, two] = st.sessions as [string, string];
    expect(two).not.toBe(one);
    // The refused call reached the server once and was never repeated.
    expect(st.calls.map((c) => [c.tool, c.status, c.session])).toEqual([["echo", 200, one], ["echo", 404, one]]);
    // The ended session gets no goodbye: the server no longer knows it.
    expect(st.deletes).toBe(0);

    // Said once, with what happens next.
    expect(String(failed.content)).toContain("was not sent again");
    expect(errors.length).toBe(1);

    expect((await m.call("legacy", "echo", { text: "c" }, ctx())).content).toBe("echo: c");
    st = await s.stats();
    expect(st.calls.map((c) => [c.status, c.session])).toEqual([[200, one], [404, one], [200, two]]);
    expect(errors.length).toBe(1);
  } finally {
    m.dispose();
    s.stop();
  }
});

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
