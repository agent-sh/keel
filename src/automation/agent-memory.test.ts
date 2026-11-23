// What of an agent's MEMORY.md its task carries: the first 200 lines or 25 KB, whichever comes first.
import { expect, test } from "bun:test";
import { agentMemory, memoryDir, memoryHead, MEMORY_BYTES } from "./agent-memory.ts";

test("MEMORY.md is cut at 25 KB on a whole line, never inside a character, and a file read only in part is cut", () => {
  const line = "é".repeat(99); // 198 bytes a line, 199 with its newline
  const head = memoryHead(Array.from({ length: 150 }, () => line).join("\n"));
  expect(head.cut).toBe(true);
  expect(Buffer.byteLength(head.text)).toBeLessThanOrEqual(MEMORY_BYTES);
  expect(head.text.split("\n").every((l) => l === line)).toBe(true);
  expect(memoryHead("short\n\n\n").cut).toBe(false);
  expect(memoryHead("short", true).cut).toBe(true);
});

test("an agent whose name is only dots has no memory folder: it would be the scope's parent folder", () => {
  for (const name of ["..", ".", "...", ""]) {
    expect(memoryDir("user", name, "/w", "/home/o")).toBeNull();
    expect(agentMemory("project", name, "/w")).toEqual({ refused: `the agent's name "${name}" is no name a folder can have` });
  }
  expect(memoryDir("user", "a..b", "/w", "/home/o")).toBe("/home/o/.claude/agent-memory/a..b");
  expect(memoryDir("user", "../x", "/w", "/home/o")).toBe("/home/o/.claude/agent-memory/..-x");
});
