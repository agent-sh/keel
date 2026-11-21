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
  const s = startLegacyMcp({ declineGet: true });
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

test("updates arrive on the GET stream, a server that declines it still answers, and a replaced connection closes its stream", async () => {
  const s = startLegacyMcp(), plain = startLegacyMcp({ declineGet: true });
  const m = manager({ legacy: { url: s.url }, plain: { url: plain.url } });
  const row = () => m.list().find((x) => x.name === "legacy")!;
  try {
    await m.ensure("legacy");
    await until(async () => (await s.stats()).streams_open === 1, "the GET stream");
    // Reading subscribes; from here no request is in flight, so an update can only come on the stream.
    await m.readResource("legacy", "legacy://one");
    const rev = row().resources_rev;
    expect((await s.control({ emit: "resources/updated" })).sent).toBe(1);
    await until(() => row().resource_updates["legacy://one"] === 1, "the resource update");
    await s.control({ emit: "resources/list_changed" });
    await until(() => row().resources_rev === rev + 1, "the resource list change");
    await s.control({ emit: "tools/list_changed" });
    await until(() => row().tool_names.includes("late"), "the tool list change");

    // A stream the server cut is opened again from the last event it sent, after the wait it named.
    await s.control({ drop_stream: true });
    await until(async () => (await s.stats()).streams_opened === 2, "the stream again");
    let st = await s.stats();
    expect(st.last_event_ids).toEqual([null, "4"]);
    expect(st.streams_closed).toBe(0);
    await s.control({ emit: "resources/updated" });
    await until(() => row().resource_updates["legacy://one"] === 2, "an update on the new stream");

    // A reconnect replaces the connection: the client closes the old stream itself.
    await m.reconnect("legacy");
    await until(async () => (await s.stats()).streams_closed === 1, "the old stream closed");
    await until(async () => (await s.stats()).streams_open === 1, "the new connection's stream");
    st = await s.stats();
    expect(st.streams_opened).toBe(3);
    expect(st.last_event_ids[2]).toBeNull();

    // 405: the server offers no stream. Requests work, and it is not asked again.
    await m.ensure("plain");
    expect((await m.call("plain", "echo", { text: "a" }, ctx())).content).toBe("echo: a");
    await Bun.sleep(200);
    const p = await plain.stats();
    expect(p.gets_declined).toBe(1);
    expect(p.streams_opened).toBe(0);
  } finally {
    m.dispose();
    await until(async () => (await s.stats()).streams_open === 0, "the stream closed with the manager");
    s.stop();
    plain.stop();
  }
});

test("a request that times out aborts its POST and leaves nothing waiting", async () => {
  const s = startLegacyMcp({ declineGet: true });
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
