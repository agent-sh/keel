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

// One timeout bounds a call, however often its server asks: the time the
// server works counts, the time the owner takes to answer does not.
test("a call's timeout counts the server's time across its questions, and not the owner's", async () => {
  const env = process.env as Record<string, string>;
  const legacy = await McpClient.connect({ kind: "stdio", command: "bun", args: [FIXTURE], env }, 10_000, "legacy", undefined, undefined, async () => ({ roots: [] }));
  const modern = await McpClient.connect({ kind: "stdio", command: "bun", args: [FIXTURE, "--modern"], env }, 10_000, undefined, undefined, undefined, async () => ({ roots: [] }));
  try {
    const answering = (ms: number): CallInput => ({ session: "s", ask: async () => { await Bun.sleep(ms); return { action: "accept", content: { ok: true } }; } });
    // The stand-in works 400 ms before each of five questions: two seconds of its own.
    // A timer that started over at each question would never fire at 1.2 s.
    const t0 = Date.now();
    await expect(legacy.callTool("slow", {}, undefined, 1200, undefined, undefined, answering(0))).rejects.toThrow("tools/call timed out after 1s");
    expect(Date.now() - t0).toBeLessThan(2000);
    // The owner takes 600 ms a question, three seconds in all: within a timeout of 2.8 s, because that time is not the server's.
    expect(text(await legacy.callTool("slow", {}, undefined, 2800, undefined, undefined, answering(600)))).toBe('slow: ["accept","accept","accept","accept","accept"]');
    // The newer protocol's rounds share the call's timeout, and a late round says the call's, not what was left of it.
    await expect(modern.callTool("slowly", {}, undefined, 1000, undefined, undefined, answering(0))).rejects.toThrow("tools/call timed out after 1s, in round 3 of the call");
    // A server of the newer protocol that asks to be called again whatever it is answered: the call ends.
    await expect(modern.callTool("loop", {}, undefined, 10_000, undefined, undefined, answering(0))).rejects.toThrow("the server asked to be called again 64 times in one call");
  } finally {
    legacy.close();
    modern.close();
  }
}, 30_000);

// A call that was ended does not stop its server from asking. What it asks
// then has no call to go to: a few are answered, and a server that goes on
// loses its connection instead of being answered for as long as it likes.
test("a server that keeps asking after its call ended loses its connection", async () => {
  const c = await McpClient.connect({ kind: "stdio", command: "bun", args: [FIXTURE], env: { ...(process.env as Record<string, string>), ASK_MCP_FOREVER: "100000" } }, 10_000, "legacy", undefined, undefined, async (q) => (q.method === "roots/list" ? { roots: [] } : { action: "cancel" }));
  let why = "";
  c.onClose = (w) => { why = w; };
  const stop = new AbortController();
  let asked = 0;
  const call = c.callTool("forever", {}, stop.signal, 10_000, undefined, undefined, { session: "s", ask: async () => { if (++asked === 3) stop.abort(); return { action: "decline" }; } });
  await expect(call).rejects.toThrow("cancelled");
  for (let i = 0; i < 100 && !c.isClosed; i++) await Bun.sleep(50);
  expect([c.isClosed, why, asked]).toEqual([true, "the server made more than 120 requests of its own in a minute that no call was waiting for", 3]);
}, 30_000);

// A call that runs past its timeout while its server reports progress goes on (basic/utilities/progress).
test("a tool call that reports progress is not ended by its timeout", async () => {
  const c = await McpClient.connect({ kind: "stdio", command: "bun", args: [`${import.meta.dir}/../../test/e2e/fixtures/progress-mcp.ts`], env: process.env as Record<string, string> }, 10_000, "legacy");
  try {
    const r = await c.callTool("work", {}, undefined, 400);
    expect(r.content).toEqual([{ type: "text", text: "worked" }]);
  } finally {
    c.close();
  }
});
