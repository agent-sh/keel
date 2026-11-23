// What of an agent's MEMORY.md its task carries: the first 200 lines or 25 KB, whichever comes first.
import { expect, test } from "bun:test";
import { memoryHead, MEMORY_BYTES } from "./agent-memory.ts";

test("MEMORY.md is cut at 25 KB on a whole line, never inside a character, and a file read only in part is cut", () => {
  const line = "é".repeat(99); // 198 bytes a line, 199 with its newline
  const head = memoryHead(Array.from({ length: 150 }, () => line).join("\n"));
  expect(head.cut).toBe(true);
  expect(Buffer.byteLength(head.text)).toBeLessThanOrEqual(MEMORY_BYTES);
  expect(head.text.split("\n").every((l) => l === line)).toBe(true);
  expect(memoryHead("short\n\n\n").cut).toBe(false);
  expect(memoryHead("short", true).cut).toBe(true);
});
