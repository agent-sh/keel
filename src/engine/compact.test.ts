// What a compaction keeps of the owner's own messages: newest first within the
// text budget, the message that crosses it as a marked excerpt with its files,
// and files newest first within the media budget, older ones named as gone.
// The context estimate counts what the next request carries: a declined reply
// adds nothing, a note for the model adds its text, an attached text file adds
// its size, and bytes are UTF-8 bytes.
import { expect, test } from "bun:test";
import { contextTokens, OWNER_MEDIA_BYTES, OWNER_WORDS_BYTES, ownerMedia, ownerWords, summaryMessage, utf8Bytes } from "./compact.ts";

let seq = 0;
const ev = (kind: string, data: any) => ({ id: `e${++seq}`, session_id: "s", seq, ts: seq, kind, data }) as any;
const measured = [ev("user", { text: "hi" }), ev("assistant", { blocks: [{ type: "text", text: "ok" }], usage: { input: 100, output: 0, cache_read: 0, cache_write: 0 }, stop: "end_turn" })];
const tail = (...e: any[]) => contextTokens([...measured, ...e]).estimated;

test("the estimated tail follows the next request", () => {
  expect(tail(ev("assistant", { blocks: [{ type: "text", text: "x".repeat(4000) }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "refusal" }))).toBe(0);
  expect(tail(ev("note", { text: "x".repeat(4000) }))).toBe(0);
  expect(tail(ev("note", { text: "x".repeat(4000), model: true }))).toBe(1000);
  const file = { type: "attachment", id: "a".repeat(64), name: "log.txt", media_type: "text/plain", size: 96_000 };
  expect(tail(ev("user", { text: "", images: [file] }))).toBeGreaterThan(24_000);
  expect(utf8Bytes("מוכן")).toBe(8);
  expect(utf8Bytes("🌍")).toBe(4);
  expect(tail(ev("user", { text: "ש".repeat(1000) }))).toBe(500);
});

const file = (name: string, size: number) => ({ type: "attachment", id: "0".repeat(64), name, media_type: "application/pdf", size });

test("the message that crosses the text budget keeps a marked excerpt and its file", () => {
  for (const size of [OWNER_WORDS_BYTES - 1, OWNER_WORDS_BYTES, OWNER_WORDS_BYTES + 1]) {
    const paste = "x".repeat(size - 3) + "END";
    const line = [ev("user", { text: "a" }), ev("user", { text: paste, images: [file("ref.txt", 12)] })];
    const words = ownerWords(line);
    const media = ownerMedia(line)!;
    if (size < OWNER_WORDS_BYTES) expect(words).toEqual(["a", paste]);
    else if (size === OWNER_WORDS_BYTES) expect(words).toEqual([paste]);
    else {
      expect(words).toHaveLength(1);
      expect(words[0]).toMatch(/^x+\n\[\.\.\. \d+ bytes of this message were left out of the compacted context \.\.\.\]\nx*END$/);
      expect(Buffer.byteLength(words[0]!)).toBeLessThanOrEqual(OWNER_WORDS_BYTES);
    }
    expect(media.at(-1)).toEqual([file("ref.txt", 12)] as any);
  }
});

test("files travel with their message through repeated compactions, the older one named when it no longer fits", () => {
  const half = OWNER_MEDIA_BYTES / 2;
  const run = (newer: number) => {
    const first = [ev("user", { text: "older caption", images: [file("a.pdf", half)] })];
    const c1 = ev("compaction", { mode: "summary", summary: "s1", owner_messages: ownerWords(first), owner_media: ownerMedia(first) });
    const second = [...first, c1, ev("user", { text: "newer caption", images: [file("b.pdf", newer)] })];
    const c2 = ev("compaction", { mode: "summary", summary: "s2", owner_messages: ownerWords(second), owner_media: ownerMedia(second) });
    const third = [...second, c2];
    const c3 = ev("compaction", { mode: "summary", summary: "s3", owner_messages: ownerWords(third), owner_media: ownerMedia(third) });
    return summaryMessage(c3.data).content.slice(1);
  };
  expect(run(half)).toEqual([file("a.pdf", half), { type: "text", text: "<message>\nolder caption\n</message>" }, file("b.pdf", half), { type: "text", text: "<message>\nnewer caption\n</message>" }] as any);
  const over = run(half + 1);
  expect(over[0]).toEqual({ type: "text", text: "[An attached file (a.pdf) the owner sent with this message is no longer in the context.]" });
  expect(over.slice(1)).toEqual([{ type: "text", text: "<message>\nolder caption\n</message>" }, file("b.pdf", half + 1), { type: "text", text: "<message>\nnewer caption\n</message>" }] as any);
});
