// The request builder leaves out exactly the sent-back thinking whose prefix
// changed (Anthropic's preserved-thinking rules), and nothing else.
import { expect, test } from "bun:test";
import type { Message, StoredEvent } from "../../core/types.ts";
import { toMessages } from "../../engine/turn.ts";
import type { ProviderRequest, ToolSpec } from "../types.ts";
import { anthropicWire } from "./anthropic.ts";

const ctx = { origin: "bedrock:claude", sessionKey: "s", efforts: [] };
const eager: ToolSpec = { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } };
const req = (messages: Message[], tools: ToolSpec[] = [eager]): ProviderRequest => ({ model: "claude", system: "Frozen system", messages, tools, signal: new AbortController().signal });

// One model reply through the real parser: its thinking gets its fingerprint there.
function reply(r: ProviderRequest, thought: string, text: string) {
  const body = anthropicWire.body(r, ctx);
  const p = anthropicWire.parser(r, ctx, () => {});
  const ev = (o: unknown) => p.event({ data: JSON.stringify(o) } as any);
  ev({ type: "message_start", message: { usage: {}, input_transformations: [] } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${thought}` } });
  ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } });
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
  ev({ type: "message_stop" });
  return { body, res: p.result() };
}
const sent = (r: ProviderRequest) => (anthropicWire.body(r, ctx).messages as any[]).flatMap((m) => m.content).filter((b) => b.type === "thinking").map((b) => b.thinking);
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

test("append-only: every thought goes back, and the reply's input_transformations are read", () => {
  const h: Message[] = [user("one")];
  const a = reply(req(h), "T1", "R1");
  expect(a.res.input_transformations).toEqual([]);
  expect(a.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  h.push({ role: "assistant", content: a.res.blocks }, user("two"));
  const b = reply(req(h), "T2", "R2");
  h.push({ role: "assistant", content: b.res.blocks }, user("three"));
  expect(sent(req(h))).toEqual(["T1", "T2"]);
});

test("a summary the harness wrote: the kept turn's thinking goes, thinking written after it stays", () => {
  let seq = 0;
  const ev = (id: string, parent: string | null, kind: StoredEvent["kind"], data: any): StoredEvent => ({ id, session_id: "s", seq: ++seq, parent, kind, data, ts: 0 });
  const line: StoredEvent[] = [ev("u1", null, "user", { text: "old prefix" })];
  const r1 = reply(req(toMessages(line)), "OLD", "old reply");
  line.push(ev("a1", "u1", "assistant", { blocks: r1.res.blocks }), ev("u2", "a1", "user", { text: "kept prompt" }));
  const r2 = reply(req(toMessages(line)), "KEPT", "kept reply");
  line.push(ev("a2", "u2", "assistant", { blocks: r2.res.blocks }));
  expect(sent(req([...toMessages(line), user("next")]))).toEqual(["OLD", "KEPT"]);
  // Everything up to the first reply is summarized; the kept prompt and its reply stay verbatim.
  line.push(ev("c1", "a2", "compaction", { mode: "summary", summary: "SUMMARY", covered: "a1" }), ev("u3", "c1", "user", { text: "after" }));
  expect(sent(req(toMessages(line)))).toEqual([]);
  const r3 = reply(req(toMessages(line)), "NEW", "new reply");
  line.push(ev("a3", "u3", "assistant", { blocks: r3.res.blocks }), ev("u4", "a3", "user", { text: "later" }));
  expect(sent(req(toMessages(line)))).toEqual(["NEW"]);
  // The kept turn's reply text is still there; only its thinking left.
  expect(JSON.stringify(anthropicWire.body(req(toMessages(line)), ctx).messages)).toContain("kept reply");
});

test("tools: a referenced deferred tool that changed drops the thinking; an unreferenced one never does", () => {
  const act = (v: string): ToolSpec => ({ name: "mcp__x__act", description: `version ${v}`, input_schema: { type: "object", properties: {} }, defer: true });
  const unused = (v: string): ToolSpec => ({ name: "mcp__x__unused", description: `version ${v}`, input_schema: { type: "object", properties: {} }, defer: true });
  const h: Message[] = [
    user("find it"),
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "act" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "mcp__x__act" }] }] },
  ];
  const a = reply(req(h, [eager, act("A"), unused("A")]), "LOADED", "ok");
  h.push({ role: "assistant", content: a.res.blocks }, user("go"));
  expect(sent(req(h, [eager, act("A"), unused("A")]))).toEqual(["LOADED"]);
  expect(sent(req(h, [eager, act("A"), unused("B")]))).toEqual(["LOADED"]);
  expect(sent(req(h, [eager, act("A")]))).toEqual(["LOADED"]);
  expect(sent(req(h, [eager, act("B"), unused("A")]))).toEqual([]);
  // A loaded tool that left the catalog is a change too, and so is any eager tool's text.
  expect(sent(req(h, [eager]))).toEqual([]);
  expect(sent(req(h, [{ ...eager, description: "Run a shell command" }, act("A")]))).toEqual([]);
});

test("thinking leaves as a run: the last stale block and every one before it", () => {
  const h: Message[] = [user("one")];
  const a = reply(req(h), "T1", "R1");
  h.push({ role: "assistant", content: a.res.blocks }, user("two"));
  const b = reply(req(h), "T2", "R2");
  h.push({ role: "assistant", content: b.res.blocks }, user("three"));
  // "two" changed after T2's prefix was read: T2 is stale, and T1 before it leaves with it.
  const edited = h.map((m) => (m === h[2] ? user("two, edited") : m));
  expect(sent(req(edited))).toEqual([]);
  // A change before T1 only: T1 and T2 both stale.
  expect(sent(req(h.map((m, i) => (i === 0 ? user("one, edited") : m))))).toEqual([]);
  // The same history with another system prompt: all of it.
  expect(sent({ ...req(h), system: "Another system" })).toEqual([]);
  // A stored thought with no fingerprint (written before fingerprints) is sent as before.
  const legacy = h.map((m) => (m.role === "assistant" ? { ...m, content: m.content.map((x: any) => ({ ...x, bind: undefined })) } : m));
  expect(sent(req(legacy as Message[]))).toEqual(["T1", "T2"]);
});

test("the binding setting is sent only when the driver asks for it", () => {
  const r = { ...req([user("x")]), blockBinding: "drop_block" as const };
  expect(anthropicWire.body(r, ctx).thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
});
