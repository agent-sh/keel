// The legacy Streamable HTTP paths, against a local stand-in server over real
// HTTP: what the client and the manager do when the server ends the session.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLegacyMcp } from "../../test/e2e/fixtures/legacy-http-mcp.ts";
import { McpManager } from "./manager.ts";

const dir = () => mkdtempSync(join(tmpdir(), "keel-mcp-http-"));
const manager = (servers: Record<string, any>, errors: unknown[] = []) => {
  const m = new McpManager({ capture: (_k: string, e: unknown) => errors.push(e) } as any, dir(), "/");
  for (const [name, c] of Object.entries(servers)) (m as any).addEntry(name, c);
  return m;
};
const ctx = (extra: Record<string, unknown> = {}) => ({ sessionId: "fixture", cwd: "/", signal: new AbortController().signal, seen: new Map(), spillDir: dir(), ...extra }) as any;
const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
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
