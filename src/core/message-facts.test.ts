import { expect, test } from "bun:test";
import { requestShape } from "../admin/trace.ts";
import { zoneBytes } from "../admin/zones.ts";
import type { Message } from "./types.ts";
import { blobSize, derived, keyBlocks, markOf, messageFacts } from "./message-facts.ts";

// As the store hands bodies out: frozen all the way down.
const frozen = <T>(v: T): T => {
  if (v && typeof v === "object") { for (const k of Object.keys(v)) frozen((v as any)[k]); Object.freeze(v); }
  return v;
};
const stored = (i: number) => frozen({ type: "tool_result", tool_use_id: `t${i}`, content: `${i} `.repeat(20_000) });
const replies = Array.from({ length: 20 }, (_, i) => frozen({ type: "text", text: `reply ${i} `.repeat(3_000) }));
const history = (blocks: object[]): Message[] => blocks.map((b, i) => (i % 2 ? { role: "assistant", content: [replies[i]] } : { role: "user", content: [b] }) as Message);

// Calls of JSON.stringify whose text is long, while f runs.
function longTexts(f: () => void): number {
  const real = JSON.stringify;
  let n = 0;
  JSON.stringify = ((...a: Parameters<typeof JSON.stringify>) => { const r = real(...a); if (typeof r === "string" && r.length > 10_000) n++; return r; }) as typeof JSON.stringify;
  try { f(); } finally { JSON.stringify = real; }
  return n;
}

test("a stored message is measured once, not again by every request that carries it", () => {
  const blocks = Array.from({ length: 20 }, (_, i) => stored(i));
  const tools = [{ name: "Read", description: "read a file", input_schema: {} }];
  const req = (messages: Message[]) => ({ tools, system: "sys", messages });
  // The first request measures its messages.
  const first = req(history(blocks));
  zoneBytes(first, []);
  requestShape(first);
  // The next step projects the history again (new message objects, the same stored blocks) and adds one.
  const next = req([...history(blocks), { role: "user", content: [stored(99)] } as Message]);
  const made = longTexts(() => { zoneBytes(next, []); requestShape(next); });
  // Only the new message is measured: one text for its mark, one for its size, one for its content.
  expect(made).toBeLessThanOrEqual(3);
});

test("what is kept is what a fresh measure gives, and a message with a new block is measured again", () => {
  const img = frozen({ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(50_000) } });
  const m = { role: "user", content: [stored(1), img] } as Message;
  const fresh = (x: Message) => ({ mark: markOf(x), size: blobSize(x), contentBytes: Buffer.byteLength(JSON.stringify(x.content)) });
  expect(messageFacts(m)).toEqual(fresh(m));
  expect(messageFacts({ role: "user", content: [stored(1), img] } as Message)).toEqual(fresh(m));
  expect(messageFacts(m).size).toBeLessThan(50_000 + 40_000);
  // The same first block merged with another block after it is another message.
  const merged = { role: "user", content: [m.content[0]!, stored(2)] } as Message;
  expect(messageFacts(merged)).toEqual(fresh(merged));
  expect(messageFacts(merged).mark).not.toBe(messageFacts(m).mark);
  // A block made for this request (not frozen) is measured each time: its change is seen.
  const open = { type: "text", text: "a" } as any;
  const live = { role: "user", content: [open] } as Message;
  const before = messageFacts(live).mark;
  open.text = "b";
  expect(messageFacts(live).mark).not.toBe(before);
  expect(messageFacts(live)).toEqual(fresh(live));
  // A role of its own, or a field besides role and content, is not taken from another message.
  const asAssistant = { role: "assistant", content: [stored(1), img] } as unknown as Message;
  expect(messageFacts(asAssistant)).toEqual(fresh(asAssistant));
  const extra = { role: "user", content: [stored(1), img], note: 1 } as unknown as Message;
  expect(messageFacts(extra)).toEqual(fresh(extra));
});

test("a message read again from the table, as new objects of the same text, is still known", () => {
  const text = JSON.stringify({ results: [{ type: "tool_result", tool_use_id: "t1", content: "r ".repeat(20_000) }] });
  const read = () => { const body = frozen(JSON.parse(text)); keyBlocks(body, text); return { role: "user", content: [body.results[0]] } as Message; };
  const first = read();
  const facts = messageFacts(first);
  // The run was given back and read again: other objects, the same text.
  const again = read();
  expect(again.content[0]).not.toBe(first.content[0]);
  expect(longTexts(() => { expect(messageFacts(again)).toBe(facts); })).toBe(0);
  // Another text is another message.
  const other = JSON.stringify({ results: [{ type: "tool_result", tool_use_id: "t1", content: "s ".repeat(20_000) }] });
  const body = frozen(JSON.parse(other)); keyBlocks(body, other);
  expect(messageFacts({ role: "user", content: [body.results[0]] } as Message).mark).not.toBe(facts.mark);
});

test("a body's blocks and its results are known apart", () => {
  const text = JSON.stringify({ blocks: [{ type: "text", text: "b ".repeat(20_000) }], results: [{ type: "tool_result", tool_use_id: "t1", content: "r ".repeat(30_000) }] });
  const body = frozen(JSON.parse(text)); keyBlocks(body, text);
  const block = messageFacts({ role: "user", content: [body.blocks[0]] } as Message);
  const result = messageFacts({ role: "user", content: [body.results[0]] } as Message);
  expect(result).toEqual({ mark: markOf({ role: "user", content: [body.results[0]] }), size: blobSize({ role: "user", content: [body.results[0]] }), contentBytes: expect.any(Number) });
  expect(result.mark).not.toBe(block.mark);
});

test("a prompt's text and a checkpoint's summary, made of a stored body, are the same blocks each request", () => {
  const text = JSON.stringify({ text: "p ".repeat(20_000) });
  const body = frozen(JSON.parse(text)); keyBlocks(body, text);
  const make = () => ({ type: "text", text: body.text });
  const a = derived(body, "text", make), b = derived(body, "text", make);
  expect(b).toBe(a);
  expect(Object.isFrozen(a)).toBe(true);
  const facts = messageFacts({ role: "user", content: [a] } as Message);
  expect(longTexts(() => { expect(messageFacts({ role: "user", content: [derived(body, "text", make)] } as Message)).toBe(facts); })).toBe(0);
  // Read again from the table: a new body of the same text, a new block, the same facts.
  const again = frozen(JSON.parse(text)); keyBlocks(again, text);
  const c = derived(again, "text", () => ({ type: "text", text: again.text }));
  expect(c).not.toBe(a);
  expect(longTexts(() => { expect(messageFacts({ role: "user", content: [c] } as Message)).toBe(facts); })).toBe(0);
});
