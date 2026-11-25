// One server's JSON as `keel mcp add NAME --json -` reads it: Claude Code's shape and Keel's own, an unknown key refused by name.
import { expect, test } from "bun:test";
import { serverFromJson } from "./config.ts";

test("a program, a remote server and Claude Code's type are read", () => {
  expect(serverFromJson({ command: "npx", args: ["-y", "x"], env: { A: "1" } })).toEqual({ config: { command: "npx", args: ["-y", "x"], env: { A: "1" } } });
  expect(serverFromJson({ type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer t0k" } })).toEqual({ config: { url: "https://h/mcp", headers: { Authorization: "Bearer t0k" } } });
  expect(serverFromJson({ type: "sse", url: "https://h/sse" })).toEqual({ config: { url: "https://h/sse", transport: "sse" } });
});

test("a mistake is named by its key and never echoes a value", () => {
  const typo = serverFromJson({ url: "https://h/mcp", header: { Authorization: "Bearer s3cret" } });
  expect(typo).toEqual({ error: expect.stringContaining("unknown field: header.") });
  expect(JSON.stringify(typo)).not.toContain("s3cret");
  expect(serverFromJson([1])).toEqual({ error: expect.stringContaining("one object") });
  expect(serverFromJson({ command: "x", args: "a b" })).toEqual({ error: "args is a list of words" });
  expect(serverFromJson({ command: "x", env: ["A"] })).toEqual({ error: "env is an object of names and values" });
  expect(serverFromJson({ type: "ftp", url: "https://h" })).toEqual({ error: expect.stringContaining("type is stdio, http or sse") });
});
