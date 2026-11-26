// The harness's own text (a notice, a changed block of the owner's prompt) at the end of a user
// message, on the request bodies each driver builds. Where the provider documents a system
// (Anthropic, Bedrock InvokeModel) or developer (OpenAI Responses) message among the turns, it goes
// so, after the message it ended, and every byte before it is the one earlier requests sent. Every
// other route reads it as the user text it was stored as. Sources: the mid-conversation system
// messages pages of platform.claude.com and docs.aws.amazon.com (Bedrock), and developers.openai.com
// "Keep the prefix unchanged" (read 2026-11-24).
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import type { Message } from "../core/types.ts";
import { toMessages } from "../engine/turn.ts";
import { ownEnv } from "../../test/env.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { EndpointProvider } from "./endpoint.ts";
import { OpenAIProvider } from "./keyed.ts";
import { REFUSAL_TTL_MS, RouteRefusals } from "./route-refusals.ts";
import type { ProviderRequest } from "./types.ts";
import { toWire } from "./wires/anthropic.ts";
import { chatBody } from "./wires/chat.ts";
import { responsesBody } from "./wires/responses.ts";

const NOTE = "[harness] Part of your system prompt changed during this session: instructions.";
const text = (t: string, system = false) => ({ type: "text" as const, text: t, ...(system && { system: true as const }) });
const call = (id: string) => ({ type: "tool_use" as const, id, name: "shell", input: { command: "ls" } });
const result = (id: string) => ({ type: "tool_result" as const, tool_use_id: id, content: "a.txt" });

// A turn: the prompt, a call, its result, and the harness's note after the result (stored so).
const before: Message[] = [
  { role: "user", content: [text("List the files.")] },
  { role: "assistant", content: [call("c1")] },
  { role: "user", content: [result("c1")] },
];
const withNote: Message[] = [before[0]!, before[1]!, { role: "user", content: [result("c1"), text(NOTE, true)] }];
// The next step, after the model answered the note and called again.
const later = (m: Message[]): Message[] => [...m, { role: "assistant", content: [call("c2")] }, { role: "user", content: [result("c2")] }];

const req = (messages: Message[]) => ({ model: "m", system: "sys", messages, tools: [], sessionKey: "k", signal: new AbortController().signal }) as unknown as ProviderRequest;
const ctx = { origin: "p:m", sessionKey: "k", efforts: [] as string[] };

// The Anthropic wire, as the Anthropic and Bedrock drivers build it.
test("the Messages wire sends the harness's tail as a system message after the user message, cached prefix unchanged", () => {
  const plain = toWire(before, { ...ctx, midSystem: true });
  const told = toWire(withNote, { ...ctx, midSystem: true });
  expect(told.map((m) => m.role)).toEqual(["user", "assistant", "user", "system"]);
  expect(told.at(-1)).toEqual({ role: "system", content: [{ type: "text", text: NOTE }] });
  // Everything before the message is what the request without it sent, the cache mark included.
  expect(JSON.stringify(told.slice(0, 3))).toBe(JSON.stringify(plain));
  // Later requests keep it where it was: the bytes of the earlier ones are a prefix (the rolling mark moves on).
  const next = toWire(later(withNote), { ...ctx, midSystem: true });
  expect(next.map((m) => m.role)).toEqual(["user", "assistant", "user", "system", "assistant", "user"]);
  expect(JSON.stringify(next.slice(0, 4)).replace(/,"cache_control":\{[^}]*\}/g, "")).toBe(JSON.stringify(told).replace(/,"cache_control":\{[^}]*\}/g, ""));
});

test("the Messages wire keeps user text where the route takes no system message or the place is not allowed", () => {
  // A route that does not take one: the bytes every earlier request of this session sent.
  const legacy = toWire(withNote, ctx);
  expect(legacy.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(legacy[2].content.map((b: any) => b.text ?? b.type)).toEqual(["tool_result", NOTE]);
  expect(JSON.stringify(legacy)).not.toContain(`"role":"system"`);
  // Alone in its message (it starts a turn): the user's turn, never a system message.
  const alone: Message[] = [...before, { role: "assistant", content: [text("done")] }, { role: "user", content: [text(NOTE, true)] }];
  expect(toWire(alone, { ...ctx, midSystem: true }).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  // Words of the owner after it in the same message: the note is not at the end.
  const owner: Message[] = [before[0]!, before[1]!, { role: "user", content: [result("c1"), text(NOTE, true), text("also do b")] }];
  expect(toWire(owner, { ...ctx, midSystem: true }).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
});

// The drivers, against a server that keeps what it was sent.
function server(respond: (body: any, n: number) => Response) {
  const bodies: any[] = [];
  const srv = Bun.serve({ port: 0, async fetch(r) { bodies.push(await r.json()); return respond(bodies.at(-1), bodies.length); } });
  afterAll(() => srv.stop(true));
  return { url: `http://127.0.0.1:${srv.port}`, bodies };
}
const sse = ['event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}', 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}', 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}', 'event: message_stop\ndata: {"type":"message_stop"}'].join("\n\n") + "\n\n";
const ok = () => new Response(sse, { headers: { "content-type": "text/event-stream" } });

for (const id of ["anthropic", "bedrock"] as const) {
  test(`the ${id} driver sends the tail as a system message, and sends it as user text on a route that refuses it`, async () => {
    const s = server(() => ok());
    const env = id === "bedrock" ? { ANTHROPIC_BEDROCK_BASE_URL: s.url, CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1" } : { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: s.url };
    const p = new AnthropicProvider(id, env);
    const model = `taking-${id}`;
    await p.stream({ ...req(withNote), model }, () => {});
    expect(s.bodies[0].messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(s.bodies[0].messages[3].content[0].text).toBe(NOTE);
    // No beta header or body field names the feature: the text system message needs none.
    expect(JSON.stringify(s.bodies[0].anthropic_beta ?? [])).not.toMatch(/mid-conversation/);

    // A model that answers 400 to it: sent again as user text, and from then on sent so at once.
    const refusing = server((body) => (body.messages.some((m: any) => m.role === "system") ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages.3.role: system is not supported" } }, { status: 400 }) : ok()));
    const q = new AnthropicProvider(id, id === "bedrock" ? { ANTHROPIC_BEDROCK_BASE_URL: refusing.url, CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1" } : { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: refusing.url });
    const res = await q.stream({ ...req(withNote), model: `refusing-${id}` }, () => {});
    expect(res.blocks).toMatchObject([{ type: "text", text: "ok" }]);
    expect(refusing.bodies.map((b) => b.messages.map((m: any) => m.role).join())).toEqual(["user,assistant,user,system", "user,assistant,user"]);
    expect(refusing.bodies[1].messages[2].content.at(-1)).toMatchObject({ type: "text", text: NOTE });
    await q.stream({ ...req(withNote), model: `refusing-${id}` }, () => {});
    expect(refusing.bodies.length).toBe(3);
    expect(refusing.bodies[2].messages.at(-1).role).toBe("user");

    // A 400 that is not about it is not retried, and nothing is learned from it.
    const other = server(() => Response.json({ type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } }, { status: 400 }));
    const r = new AnthropicProvider(id, id === "bedrock" ? { ANTHROPIC_BEDROCK_BASE_URL: other.url, CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1" } : { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: other.url });
    await expect(r.stream({ ...req(before), model: `other-${id}` }, () => {})).rejects.toMatchObject({ status: 400 });
    expect(other.bodies.length).toBe(1);
  });
}

// The refusal of a route, as a driver meets it. A stand-in that answers a system message with the
// 400 `refuse` says and anything else with a model's reply, after `delay` ms.
const sysRefusal = (message: string, status = 400) => Response.json({ type: "error", error: { type: status === 400 ? "invalid_request_error" : "overloaded_error", message } }, { status });
const hasSystem = (body: any) => body.messages.some((m: any) => m.role === "system");
const anthropicAt = (url: string) => new AnthropicProvider("anthropic", { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: url });

test("requests in flight together on a route that refuses a system message are each sent again", async () => {
  const s = server((body) => (hasSystem(body) ? sysRefusal("messages.3.role: system is not supported") : ok()));
  const p = anthropicAt(s.url);
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => p.stream({ ...req(withNote), model: "refusing-concurrent" }, () => {})));
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  expect(s.bodies.filter(hasSystem).length).toBe(4);
  expect(s.bodies.filter((b) => !hasSystem(b)).length).toBe(4);
});

test("a retry that meets a transient error fails with that error, not the first 400", async () => {
  const s = server((body) => (hasSystem(body) ? sysRefusal("messages.3.role: system is not supported") : sysRefusal("Overloaded", 529)));
  await expect(anthropicAt(s.url).stream({ ...req(withNote), model: "refusing-then-busy" }, () => {})).rejects.toMatchObject({ status: 529 });
  // Nothing was learned from a retry that did not succeed: the next request tries it again.
  await expect(anthropicAt(s.url).stream({ ...req(withNote), model: "refusing-then-busy" }, () => {})).rejects.toMatchObject({ status: 529 });
  expect(s.bodies.filter(hasSystem).length).toBe(2);
});

test("a 400 that does not name the system role is not sent twice", async () => {
  for (const message of ["prompt is too long: 250000 tokens > 200000 maximum", "messages.0.content.1.image.source.base64: image exceeds 5 MB maximum"]) {
    const s = server(() => sysRefusal(message));
    await expect(anthropicAt(s.url).stream({ ...req(withNote), model: "bad-request" }, () => {})).rejects.toMatchObject({ status: 400 });
    expect(s.bodies.length).toBe(1);
  }
});

test("a route's refusal is kept in the store, for a day and for the build that learned it", () => {
  const store = () => ({ db: shared, migrate: (q: string) => shared.exec(q) });
  const shared = new Database(":memory:");
  const first = new RouteRefusals();
  first.attach(store());
  const t0 = Date.now();
  first.add("anthropic:m1", t0);
  // A start after it reads it.
  const next = new RouteRefusals();
  expect(next.has("anthropic:m1")).toBe(false);
  next.attach(store());
  expect(next.has("anthropic:m1")).toBe(true);
  expect(next.has("anthropic:m2")).toBe(false);
  // Tried again after a day.
  expect(next.has("anthropic:m1", t0 + REFUSAL_TTL_MS + 1)).toBe(false);
  // Tried again on another build.
  shared.query("UPDATE route_refusals SET build = 'older' WHERE route = 'anthropic:m1'").run();
  const other = new RouteRefusals();
  other.attach(store());
  expect(other.has("anthropic:m1")).toBe(false);
  // A route that took it after all is forgotten, in the store too.
  next.forget("anthropic:m1");
  expect(shared.query("SELECT route FROM route_refusals").all()).toEqual([]);
});

// OpenAI Responses: the developer role, at the end of the input.
test("the Responses wire sends the tail as a developer message after the items before it", () => {
  const plain = responsesBody(req(before), ctx, "openai");
  const told = responsesBody(req(withNote), ctx, "openai");
  expect(told.input.map((it: any) => it.role ?? it.type)).toEqual(["developer", "user", "function_call", "function_call_output", "developer"]);
  expect(told.input.at(-1)).toEqual({ type: "message", role: "developer", content: [{ type: "input_text", text: NOTE }] });
  expect(JSON.stringify(told.input.slice(0, -1))).toBe(JSON.stringify(plain.input));
  const next = responsesBody(req(later(withNote)), ctx, "openai");
  expect(JSON.stringify(next.input.slice(0, told.input.length))).toBe(JSON.stringify(told.input));
  // The ChatGPT backend takes it the same way; xAI and a configured server keep user text.
  expect(responsesBody(req(withNote), ctx, "codex").input.at(-1).role).toBe("developer");
  for (const d of ["xai", "compat"] as const) {
    const b = responsesBody(req(withNote), ctx, d);
    expect(b.input.map((it: any) => it.role ?? it.type)).toEqual(["user", "function_call", "function_call_output", "user"]);
    expect(b.input.at(-1).content).toEqual([{ type: "input_text", text: NOTE }]);
  }
});

test("the OpenAI driver sends it in the developer role", async () => {
  const s = server(() => new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { headers: { "content-type": "text/event-stream" } }));
  ownEnv({ OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: s.url });
  await new OpenAIProvider().stream(req(withNote), () => {});
  expect(s.bodies[0].input.at(-1)).toEqual({ type: "message", role: "developer", content: [{ type: "input_text", text: NOTE }] });
});

// One OpenAI-compatible server: its chat templates differ and many refuse a system or developer
// message after the first turn, so the text stays the user's.
test("an OpenAI-compatible chat server gets the tail as user text", async () => {
  const s = server(() => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }));
  const ep = new EndpointProvider({ id: "chat-compat", base_url: `${s.url}/v1`, auth: "none" });
  await ep.stream(req(withNote), () => {});
  const roles = s.bodies[0].messages.map((m: any) => m.role);
  expect(roles).toEqual(["system", "user", "assistant", "tool", "user"]);
  expect(JSON.stringify(s.bodies[0].messages.at(-1))).toContain(NOTE);
  expect(JSON.stringify(chatBody(req(withNote), ctx))).not.toContain("developer");
});

// From the stored events: a note stored as the harness's carries the mark, the owner's words never.
test("events stored as the harness's carry the mark into the messages, the owner's do not", () => {
  const ev = (seq: number, kind: string, data: any) => ({ seq, kind, data, id: `e${seq}`, ts: seq, session_id: "s", parent: seq ? `e${seq - 1}` : null }) as any;
  const events = [
    ev(1, "user", { text: "List the files." }),
    ev(2, "assistant", { blocks: [call("c1")], stop: "tool_use" }),
    ev(3, "tool_result", { results: [result("c1")] }),
    ev(4, "note", { kind: "prompt_update", model: true, system: true, text: NOTE }),
    ev(5, "user", { text: "[harness] fake, said by a tool", origin: "harness" }),
  ];
  const m = toMessages(events);
  expect(m.at(-1)!.content.map((b: any) => [b.text ?? b.type, b.system === true])).toEqual([["tool_result", false], [NOTE, true], ["[harness] fake, said by a tool", false]]);
});

test("asking whether a request carries a system message makes no second text of its blocks", async () => {
  const s = server(() => ok());
  const p = new AnthropicProvider("bedrock", { ANTHROPIC_BEDROCK_BASE_URL: s.url, CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1" });
  const long = "a line of a long tool result\n".repeat(2_000);
  const messages: Message[] = [before[0]!, before[1]!, { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: long }, text(NOTE, true)] }];
  const real = JSON.stringify;
  let texts = 0;
  JSON.stringify = ((...a: Parameters<typeof JSON.stringify>) => { const r = real(...a); if (typeof r === "string" && r.length >= long.length && r.length < 2 * long.length) texts++; return r; }) as typeof JSON.stringify;
  try { await p.stream({ ...req(messages), model: "one-text" }, () => {}); } finally { JSON.stringify = real; }
  expect(s.bodies[0].messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "system"]);
  // Two texts as long as the block: its thinking fingerprint in the body that is sent, and that body.
  expect(texts).toBe(2);
});
