// What a compaction keeps of the owner's own messages: newest first within the
// text budget, the message that crosses it as a marked excerpt with its files,
// and files newest first within the media budget, older ones named as gone.
// The context estimate counts what the next request carries: a declined reply
// adds nothing, a note for the model adds its text, an attached text file adds
// its size, and bytes are UTF-8 bytes.
import { expect, test } from "bun:test";
import { BYTES_PER_TOKEN, bytesPerToken, capRatio, contextTokens, learnRatio, partPrompt, preparedHolds, replyBytes, transcriptParts, OWNER_MEDIA_BYTES, OWNER_WORDS_BYTES, keptMessages, summarizable, summaryMessage, utf8Bytes } from "./compact.ts";

let seq = 0;
const ev = (kind: string, data: any) => ({ id: `e${++seq}`, session_id: "s", seq, ts: seq, kind, data }) as any;
const measured = [ev("user", { text: "hi" }), ev("assistant", { blocks: [{ type: "text", text: "ok" }], usage: { input: 100, output: 0, cache_read: 0, cache_write: 0 }, stop: "end_turn" })];
const tail = (...e: any[]) => contextTokens([...measured, ...e]).estimated;

test("the estimated tail follows the next request", () => {
  expect(tail(ev("assistant", { blocks: [{ type: "text", text: "x".repeat(4000) }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "refusal" }))).toBe(0);
  expect(tail(ev("note", { text: "x".repeat(4000) }))).toBe(0);
  expect(tail(ev("note", { text: "x".repeat(4000), model: true }))).toBe(4000 / BYTES_PER_TOKEN);
  const file = { type: "attachment", id: "a".repeat(64), name: "log.txt", media_type: "text/plain", size: 96_000 };
  expect(tail(ev("user", { text: "", images: [file] }))).toBeGreaterThan(24_000);
  expect(utf8Bytes("מוכן")).toBe(8);
  expect(utf8Bytes("🌍")).toBe(4);
  expect(tail(ev("user", { text: "ש".repeat(1000) }))).toBe(2000 / BYTES_PER_TOKEN);
});

const file = (name: string, size: number) => ({ type: "attachment", id: "0".repeat(64), name, media_type: "application/pdf", size });

test("the message that crosses the text budget keeps a marked excerpt and its file", () => {
  for (const size of [OWNER_WORDS_BYTES - 1, OWNER_WORDS_BYTES, OWNER_WORDS_BYTES + 1]) {
    const paste = "x".repeat(size - 3) + "END";
    const line = [ev("user", { text: "a" }), ev("user", { text: paste, images: [file("ref.txt", 12)] })];
    const { owner_messages: words, owner_media, owner_messages_shortened } = keptMessages(line);
    const media = owner_media!;
    if (size < OWNER_WORDS_BYTES) expect(words).toEqual(["a", paste]);
    else if (size === OWNER_WORDS_BYTES) expect(words).toEqual([paste]);
    else {
      expect(words).toHaveLength(1);
      expect(words[0]).toMatch(/^x+\n\[\.\.\. \d+ bytes of this message were left out of the compacted context \.\.\.\]\nx*END$/);
      expect(Buffer.byteLength(words[0]!)).toBeLessThanOrEqual(OWNER_WORDS_BYTES);
    }
    expect(owner_messages_shortened).toBe(size > OWNER_WORDS_BYTES ? 1 : undefined);
    expect(media.at(-1)).toEqual([file("ref.txt", 12)] as any);
  }
});

test("files travel with their message through repeated compactions, the older one named when it no longer fits", () => {
  const half = OWNER_MEDIA_BYTES / 2;
  const run = (newer: number) => {
    const first = [ev("user", { text: "older caption", images: [file("a.pdf", half)] })];
    const c1 = ev("compaction", { mode: "summary", summary: "s1", ...keptMessages(first) });
    const second = [...first, c1, ev("user", { text: "newer caption", images: [file("b.pdf", newer)] })];
    const c2 = ev("compaction", { mode: "summary", summary: "s2", ...keptMessages(second) });
    const third = [...second, c2];
    const c3 = ev("compaction", { mode: "summary", summary: "s3", ...keptMessages(third) });
    return summaryMessage(c3.data).content.slice(1);
  };
  expect(run(half)).toEqual([file("a.pdf", half), { type: "text", text: "<message>\nolder caption\n</message>" }, file("b.pdf", half), { type: "text", text: "<message>\nnewer caption\n</message>" }] as any);
  const over = run(half + 1);
  expect(over[0]).toEqual({ type: "text", text: "[An attached file (a.pdf) the owner sent with this message is no longer in the context.]" });
  expect(over.slice(1)).toEqual([{ type: "text", text: "<message>\nolder caption\n</message>" }, file("b.pdf", half + 1), { type: "text", text: "<message>\nnewer caption\n</message>" }] as any);
});

// Only the owner's own words are kept as their: reports, wakes, loop runs,
// tasks, peers, momentum and hooks are kept under their own heading in what
// their words leave of the budget; the harness's own instructions are not kept.
test("delivered inputs never count as the owner's words", () => {
  const report = (k: number) => ev("user", { text: `<subagent_result agent_id="a${k}">${"r".repeat(15_000)}</subagent_result>`, kind: "subagent" });
  const line = [
    ev("user", { text: `the owner's ask ${"o".repeat(2_000)}` }),
    report(1), report(2), report(3), report(4),
    ev("user", { text: "loop run", kind: "loop" }), ev("user", { text: "from a peer", kind: "peer" }), ev("user", { text: "momentum item", origin: "momentum" }),
    ev("user", { text: "said aloud", origin: "voice" }), ev("user", { text: "steered", origin: "steer" }),
    ev("user", { text: "[harness] Continue.", origin: "harness" }), ev("user", { text: "[harness] schema", kind: "harness" }),
  ];
  const kept = keptMessages(line, 50_000);
  expect(kept.owner_messages).toEqual([line[0]!.data.text, "said aloud", "steered"]);
  expect(kept.other_messages!.slice(-3)).toEqual(["loop run", "from a peer", "momentum item"]);
  expect(kept.other_messages!.join("")).not.toContain("[harness]");
  expect(kept.other_messages_shortened).toBe(1);
  const text = (summaryMessage({ summary: "s", ...kept }).content[0] as any).text as string;
  expect(text.indexOf("<subagent_result")).toBeGreaterThan(text.indexOf("[Other messages delivered before the compaction"));
  expect(text.indexOf("[Other messages")).toBeGreaterThan(text.indexOf("said aloud"));
  // A later compaction keeps each side from the first one's record.
  const again = keptMessages([...line, ev("compaction", { mode: "summary", summary: "s", ...kept })], 50_000);
  expect(again.owner_messages).toEqual(kept.owner_messages);
  expect(again.other_messages).toEqual(kept.other_messages);
});

// A compaction at the start of a turn summarizes what came before the prompts
// that opened it, whoever sent them; once the turn has a reply, everything.
test("the prompts that open a turn stay out of its first compaction", () => {
  const old = [ev("user", { text: "old" }), ev("turn_start", {}), ev("assistant", { blocks: [], stop: "end_turn" }), ev("turn_end", {})];
  for (const meta of [{}, { origin: "voice" }, { origin: "momentum" }, { kind: "subagent" }]) {
    const opening = [ev("user", { text: "now", ...meta }), ev("user", { text: "and this", origin: "queued" }), ev("turn_start", {}), ev("note", { text: "memory", model: true })];
    expect(summarizable([...old, ...opening])).toEqual(old);
  }
  const mid = [...old, ev("user", { text: "now" }), ev("turn_start", {}), ev("assistant", { blocks: [], stop: "tool_use" })];
  expect(summarizable(mid)).toEqual(mid);
  expect(summarizable(old)).toEqual(old);
});

// A history no provider has counted (an imported one) is estimated whole at
// the model's bytes a token; a model's ratio follows what its provider reports.
test("an unmeasured history is counted at the model's own bytes a token", () => {
  const big = [ev("user", { text: "go" }), ev("assistant", { blocks: [{ type: "text", text: "x".repeat(100_000) }], stop: "end_turn", imported: true })];
  const t = contextTokens(big, "lab:dense");
  expect(t.measured).toBe(0);
  expect(t.used).toBeGreaterThan(100_000 / BYTES_PER_TOKEN);
  // Too small a request teaches nothing; each real one, the first too, moves the ratio a fifth of the way.
  expect(learnRatio("lab:dense", 3_000, 1_000)).toBeUndefined();
  expect(learnRatio("lab:dense", 400_000, 100_000)).toBeCloseTo(2.8);
  expect(learnRatio("lab:dense", 300_000, 100_000)).toBeCloseTo(2.84);
  expect(bytesPerToken("lab:dense")).toBeCloseTo(2.84);
  expect(bytesPerToken("lab:never-seen")).toBe(BYTES_PER_TOKEN);
  expect(contextTokens(big, "lab:dense").used).toBeLessThan(t.used);
  // A request refused as over the window proves a lower ratio; one that proves nothing new changes nothing.
  expect(capRatio("lab:dense", 400_000, 100_000)).toBeUndefined();
  expect(capRatio("lab:dense", 200_000, 100_000)).toBeCloseTo(1.8);
  expect(contextTokens(big, "lab:dense").used).toBeGreaterThan(t.used);
});

// The ratio counts what the provider tokenizes: a thought's signature and the
// block framing are not in a reply's bytes.
test("a reply counts its words, thinking and calls, not signatures", () => {
  const reply = [{ type: "thinking", thinking: "abcd", signature: "S".repeat(50_000) }, { type: "redacted_thinking", data: "R".repeat(9_000) }, { type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "Bash", input: { c: 1 } }] as any;
  expect(replyBytes(reply)).toBe(4 + 5 + 4 + 7);
});

// An idle summary stays whole when its own request stored a job notice after
// what it covers; an owner's prompt after it makes it partial.
test("a prepared summary holds through notes, not through new words", () => {
  const reply = ev("assistant", { blocks: [{ type: "text", text: "done" }], stop: "end_turn" });
  const line = [ev("user", { text: "go" }), reply, ev("turn_end", {}), ev("note", { kind: "job", text: "job 1 ended", model: true })];
  expect(preparedHolds(line, reply.id, true)).toBe(true);
  expect(preparedHolds([...line, ev("user", { text: "more" })], reply.id, true)).toBe(false);
  expect(preparedHolds([...line, ev("user", { text: "more" })], reply.id, false)).toBe(true);
  expect(preparedHolds(line, "gone", false)).toBe(false);
});

const turn = (n: number, out: string) => [
  { role: "user" as const, content: [{ type: "text" as const, text: `prompt ${n}` }] },
  { role: "assistant" as const, content: [{ type: "thinking", thinking: "hidden", signature: "s" } as any, { type: "tool_use" as const, id: `t${n}`, name: "Bash", input: { command: `run ${n}` } }] },
  { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: `t${n}`, content: out }] },
  { role: "assistant" as const, content: [{ type: "text" as const, text: `done ${n}` }] },
];

test("a history too long for one request: outputs shortened oldest first, then parts", () => {
  const msgs = [1, 2, 3, 4].flatMap((n) => turn(n, `START${n} ${"o".repeat(6_000)} END${n}`));
  // It fits: one part, nothing shortened, no reasoning in it.
  const whole = transcriptParts(msgs, 100_000);
  expect(whole.parts).toHaveLength(1);
  expect(whole.clipped).toBe(0);
  expect(whole.parts[0]).not.toContain("hidden");
  expect(whole.parts[0]).toContain("[assistant called Bash (t3)]");
  // A little over: only the oldest outputs lose their middle, and it is still one part.
  const some = transcriptParts(msgs, 16_000);
  expect(some.parts).toHaveLength(1);
  expect(some.clipped).toBe(3);
  expect(some.parts[0]).toMatch(/START1 o+\n\[\.\.\. \d+ bytes/);
  expect(some.parts[0]).toContain(`START4 ${"o".repeat(6_000)} END4`);
  // Far over: every output shortened and the transcript in parts, oldest first,
  // each within the budget, with every prompt and reply in exactly one of them.
  const long = [...Array(30).keys()].flatMap((n) => turn(n, "o".repeat(6_000)));
  const cut = transcriptParts(long, 20_000);
  expect(cut.clipped).toBe(30);
  expect(cut.parts.length).toBeGreaterThan(2);
  for (const p of cut.parts) expect(utf8Bytes(p)).toBeLessThanOrEqual(20_000);
  const joined = cut.parts.join("");
  for (let n = 0; n < 30; n++) expect(joined.split(`[user]\nprompt ${n}\n`)).toHaveLength(2);
  expect(joined.indexOf("prompt 3\n")).toBeLessThan(joined.indexOf("prompt 17\n"));
  // One message larger than a part goes on in the next parts, all of it read.
  const text = `HEAD ${"g".repeat(25_000)}ש MIDDLE ${"g".repeat(25_000)} TAIL`;
  const giant = transcriptParts([{ role: "user", content: [{ type: "text", text }] }, ...turn(1, "short")], 5_000);
  expect(giant.parts.length).toBeGreaterThan(10);
  for (const p of giant.parts) expect(utf8Bytes(p)).toBeLessThanOrEqual(5_000);
  expect(giant.parts.join("")).toStartWith(`[user]\n${text}\n[user]\nprompt 1`);
  // A later part's request carries the summary so far and says more follows.
  const mid = partPrompt("PART", 1, 3, "SO FAR", 30);
  expect(mid).toContain("<summary>\nSO FAR\n</summary>");
  expect(mid).toContain('<transcript part="2" of="3">');
  expect(mid).toContain("The next part follows");
  expect(partPrompt("PART", 2, 3, "SO FAR", 0, "the port")).toContain("Keep above all: the port");
});
