// The system prompt on the Responses wire, against a stand-in that renders
// and caches a request the way OpenAI documents it for GPT-6.2 ("Using
// GPT-6.2" and the prompt caching guide, developers.openai.com, 2026-11-17):
// top-level `instructions` are appended after the input, beyond every cache
// breakpoint, so they are billed uncached on every request; a developer
// message at the start of input is part of the cached prefix. A three-step
// exchange (a call, a call, an answer) over HTTP and over the WebSocket.
import { expect, test } from "bun:test";
import type { Message } from "../../core/types.ts";
import { runEvents, httpEvents } from "../drive.ts";
import { ResponsesSockets } from "../responses-ws.ts";
import type { ProviderRequest } from "../types.ts";
import { responsesBody, responsesWire, type ResponsesDialect } from "./responses.ts";

const tokens = (s: string) => Math.ceil(s.length / 4);
const MIN = 1024; // the minimum cacheable prefix, GPT-5.6 and later

// Rendered context: tools, the input items, then the instructions (after the
// input, on 6.2). A breakpoint ends every input item; the instructions end none.
function standIn() {
  const cache = new Set<string>();
  const held = new Map<string, any[]>();
  const bodies: any[] = [];
  let n = 0;
  const answer = (body: any) => {
    bodies.push(body);
    const input = [...(body.previous_response_id ? held.get(body.previous_response_id) ?? [] : []), ...body.input];
    const parts = [JSON.stringify(body.tools ?? []), ...input.map((it) => JSON.stringify(it))];
    let at = 0, cached = 0;
    const ends: number[] = [];
    for (const p of parts) { at += p.length; ends.push(at); }
    const text = parts.join("");
    for (const e of ends.slice(1)) {
      const prefix = text.slice(0, e);
      if (tokens(prefix) < MIN) continue;
      if (cache.has(prefix)) cached = tokens(prefix);
      cache.add(prefix);
    }
    const total = tokens(text) + tokens(body.instructions ?? "");
    const step = ++n;
    const out = step < 3
      ? { type: "function_call", id: `fc_${step}`, call_id: `c${step}`, name: "shell", arguments: JSON.stringify({ command: `ls ${step}` }), status: "completed" }
      : { type: "message", id: "msg_3", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] };
    const id = `resp_${step}`;
    held.set(id, [...input, out]);
    return [
      { type: "response.output_item.done", output_index: 0, item: out },
      { type: "response.completed", response: { id, output: [out], usage: { input_tokens: total, input_tokens_details: { cached_tokens: cached }, output_tokens: 10 } } },
    ];
  };
  const srv = Bun.serve({
    port: 0,
    async fetch(req, s) {
      if (s.upgrade(req, { data: {} })) return undefined;
      const events = answer(await req.json());
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
    websocket: {
      data: {} as Record<string, never>,
      message(ws, raw) {
        const { type: _t, ...body } = JSON.parse(String(raw));
        for (const e of answer(body)) ws.send(JSON.stringify(e));
      },
    },
  });
  return { url: `http://127.0.0.1:${srv.port}`, bodies, stop: () => srv.stop(true) };
}

// A system prompt of about 6,100 tokens, the size of Keel's.
const SYSTEM = Array.from({ length: 400 }, (_, i) => `Rule ${i}: keep the work inside the task and say what changed.`).join("\n");
const TOOLS = [{ name: "shell", description: "Run a command.", input_schema: { type: "object", properties: { command: { type: "string" } } } }];

async function exchange(dialect: ResponsesDialect, transport: "http" | "ws") {
  const s = standIn();
  const socks = new ResponsesSockets("stand-in", () => s.url.replace(/^http/, "ws"));
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "List the files." }] } as Message];
  const steps: { input: number; cached: number; uncached: number }[] = [];
  try {
    for (let step = 1; step <= 3; step++) {
      const req = { model: "gpt-6.2-sol", system: SYSTEM, messages: [...messages], tools: TOOLS, sessionKey: "s1", signal: new AbortController().signal } as unknown as ProviderRequest;
      const ctx = { origin: `stand-in:${req.model}`, sessionKey: "s1", efforts: [] };
      const events = transport === "ws" ? socks.events("k", {}, req) : httpEvents({ label: "stand-in", url: `${s.url}/responses`, headers: {} }, req);
      const res = await runEvents(responsesWire(dialect), req, ctx, () => {}, events);
      steps.push({ input: res.usage.input + res.usage.cache_read, cached: res.usage.cache_read, uncached: res.usage.input });
      messages.push({ role: "assistant", content: res.blocks } as Message);
      const call = res.blocks.find((b) => b.type === "tool_use") as any;
      if (call) messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `file-${step}.txt` }] } as Message);
    }
  } finally { s.stop(); }
  console.log(`${dialect} over ${transport}: ${steps.map((x) => `${x.cached}/${x.input} cached (${x.uncached} uncached)`).join(", ")}`);
  return { steps, bodies: s.bodies };
}

const systemTokens = tokens(SYSTEM);

for (const [dialect, transport] of [["openai", "http"], ["codex", "http"], ["codex", "ws"]] as const) {
  test(`${dialect} over ${transport}: the system prompt is the first developer message and is read from the cache on later steps`, async () => {
    const { steps, bodies } = await exchange(dialect, transport);
    for (const b of bodies) expect(b.instructions).toBeUndefined();
    // The first item, the same bytes on every step that sends it whole.
    const first = bodies[0].input[0];
    expect(first).toEqual({ type: "message", role: "developer", content: [{ type: "input_text", text: SYSTEM }] });
    for (const b of bodies) if (!b.previous_response_id) expect(JSON.stringify(b.input[0])).toBe(JSON.stringify(first));
    // Steps 2 and 3 read the system prompt and the history before them from
    // the cache; what is billed uncached is that step's new items.
    for (const x of steps.slice(1)) {
      expect(x.cached).toBeGreaterThan(systemTokens);
      expect(x.uncached).toBeLessThan(200);
    }
    // A continuation sends only the items the server does not hold.
    if (transport === "ws") {
      expect(bodies.slice(1).map((b) => [b.previous_response_id, b.input.length])).toEqual([["resp_1", 1], ["resp_2", 1]]);
    }
  });
}

test("xai and a configured server keep the system prompt in instructions", () => {
  const req = { model: "m", system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], signal: new AbortController().signal } as unknown as ProviderRequest;
  const ctx = { origin: "p:m", sessionKey: "k", efforts: [] };
  for (const d of ["xai", "compat"] as const) {
    const b = responsesBody(req, ctx, d);
    expect(b.instructions).toBe("sys");
    expect(b.input.map((it: any) => it.role)).toEqual(["user"]);
  }
  for (const d of ["openai", "codex"] as const) {
    const b = responsesBody(req, ctx, d);
    expect("instructions" in b).toBe(false);
    expect(b.input.map((it: any) => it.role)).toEqual(["developer", "user"]);
  }
});
