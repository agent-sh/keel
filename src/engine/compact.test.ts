// The context estimate counts what the next request carries: a declined reply
// adds nothing, a note for the model adds its text, an attached text file adds
// its size, and bytes are UTF-8 bytes.
import { expect, test } from "bun:test";
import { contextTokens, utf8Bytes } from "./compact.ts";

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
