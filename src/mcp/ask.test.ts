// Which call a server's own request reaches, over stdio, where nothing names
// the call: timing two calls of two sessions against one server is not
// something a page can be made to do on cue.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { McpClient, type CallInput, type InputRequest } from "./client.ts";

const FIXTURE = join(import.meta.dir, "../../test/e2e/fixtures/ask-mcp.ts");
const text = (r: { content?: unknown[] }) => (r.content![0] as { text: string }).text;

test("a server's request is never guessed between two calls, and goes to a call that is alone", async () => {
  const c = await McpClient.connect({ kind: "stdio", command: "bun", args: [FIXTURE], env: { ...(process.env as Record<string, string>), ASK_MCP_HOLD: "3500" } }, 10_000, "legacy", undefined, undefined, async () => ({ roots: [] }));
  try {
    const seen: string[] = [];
    const input = (session: string, name: string): CallInput => ({
      session,
      ask: async (q: InputRequest) => { seen.push(`${name} asked ${q.method}`); return q.method === "roots/list" ? { roots: [{ uri: `file:///${name}` }] } : { action: "accept", content: { ok: true } }; },
      dropped: (method) => { seen.push(`${name} dropped ${method}`); },
    });
    const call = (tool: string, i: CallInput) => c.callTool(tool, {}, undefined, 10_000, undefined, undefined, i);
    // The stand-in asks for the folders as soon as it is connected: that one is over before the calls start.
    for (let i = 0; i < 50 && text(await c.callTool("start", {})) !== 'start: {"roots":[]}'; i++) await Bun.sleep(50);

    // Two sessions in flight: the folders are refused and the question gets no card; each call is told.
    const held = call("hold", input("s2", "b-hold"));
    expect(text(await call("roots", input("s1", "a-roots")))).toContain("not answered: calls of 2 sessions were in flight on this server");
    expect(text(await call("later", input("s1", "a-later")))).toBe('later: {"action":"cancel"}');
    expect(seen).toEqual(["b-hold dropped roots/list", "a-roots dropped roots/list", "b-hold dropped elicitation/create", "a-later dropped elicitation/create"]);
    expect(text(await held)).toBe('hold: "held"');

    // One session, two calls: the call that started first is not the one
    // that asks, so no card is guessed, and both are told. The folders are the
    // session's, whichever call the server meant.
    seen.length = 0;
    const holder = call("hold", input("s1", "first"));
    expect(text(await call("ask", input("s1", "second")))).toBe('ask: {"action":"cancel"}');
    expect(seen).toEqual(["first dropped elicitation/create", "second dropped elicitation/create"]);
    expect(text(await call("roots", input("s1", "folders")))).toBe('roots: {"roots":[{"uri":"file:///first"}]}');
    expect(text(await holder)).toBe('hold: "held"');
    // A call alone that asks twice gets both.
    seen.length = 0;
    expect(text(await call("twice", input("s1", "alone")))).toContain('"action":"accept"');
    expect(seen).toEqual(["alone asked elicitation/create", "alone asked elicitation/create"]);
    expect(c.inflight).toBe(0);
  } finally {
    c.close();
  }
}, 30_000);
