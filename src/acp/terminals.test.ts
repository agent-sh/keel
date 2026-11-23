import { expect, test } from "bun:test";
import { servedCall } from "./external.ts";
import { answer } from "./served.ts";
import { commandLine, keepEnd } from "./terminals.ts";
import { splitCommand } from "../safety/shell.ts";

test("a terminal's command is judged as the one text that runs, its variables first", () => {
  const line = commandLine({ command: "sh", args: ["-c", "echo it's here"], env: [{ name: "MODE", value: "a b" }, { name: "bad name", value: "x" }] });
  expect(line).toBe(`MODE='a b' sh -c 'echo it'\\''s here'`);
  expect(splitCommand(line)![0]!.words).toEqual(["MODE=a b", "sh", "-c", "echo it's here"]);
  // A program with no arguments is the command line it is.
  expect(commandLine({ command: "npm test" })).toBe("npm test");
  expect(() => commandLine({ command: " " })).toThrow("command is required");
});

test("a terminal's output keeps its end within the limit, cut at a character", () => {
  expect(keepEnd("abc", 10)).toEqual({ output: "abc", truncated: false });
  expect(keepEnd("abcdef", 3)).toEqual({ output: "def", truncated: true });
  // "é" is two bytes: a cut inside it drops the half.
  expect(keepEnd("aéb", 2)).toEqual({ output: "b", truncated: true });
  expect(keepEnd("aéb", 3)).toEqual({ output: "éb", truncated: true });
});

test("an agent's call of Keel's tools is known only by a field that names it whole", () => {
  const served = new Set(["notes__echo", "mcp__fs__write_file"]);
  expect(servedCall({ kind: "other", title: "mcp__keel__notes__echo" }, served)).toBe("notes__echo");
  expect(servedCall({ kind: "other", title: "x", _meta: { claudeCode: { toolName: "mcp__keel__notes__echo" } } }, served)).toBe("notes__echo");
  // Claude's agent asks about an MCP call as "server: tool", with the server named.
  expect(servedCall({ title: "keel: notes__echo", _meta: { claudeCode: { mcpServer: { name: "keel" } } } }, served)).toBe("notes__echo");
  expect(servedCall({ title: "keel: notes__echo" }, served)).toBeUndefined();
  // A name inside a field is no name: a title is the agent's words.
  for (const title of ['{"query":"see keel/mcp__fs__write_file"}', "Run something; keel: mcp__fs__write_file", "mcp__my_keel__mcp__fs__write_file", "keel/notes__echo", " mcp__keel__notes__echo"])
    expect(servedCall({ kind: "other", title }, served)).toBeUndefined();
  expect(servedCall({ kind: "other", title: "mcp__keel__notes__write" }, served)).toBeUndefined();
  expect(servedCall({ kind: "execute", title: "mcp__keel__notes__echo" }, served)).toBeUndefined();
});

test("the served MCP server answers the lifecycle, the list and a call", async () => {
  const calls: unknown[] = [];
  const deps = {
    list: async () => [{ name: "notes__echo", description: "Echo", inputSchema: { type: "object" }, readOnly: true }],
    call: async (name: string, args: Record<string, unknown>, id: string) => (calls.push([name, args]), { type: "tool_result" as const, tool_use_id: id, content: [{ type: "text" as const, text: "echo: hi" }] }),
  };
  const init = await answer({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, deps);
  expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "keel" } });
  expect((await answer({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, deps)).result.protocolVersion).toBe("2025-11-25");
  expect(await answer({ jsonrpc: "2.0", method: "notifications/initialized" }, deps)).toBeNull();
  expect((await answer({ jsonrpc: "2.0", id: 3, method: "tools/list" }, deps)).result.tools).toEqual([{ name: "notes__echo", description: "Echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
  expect((await answer({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "notes__echo", arguments: { text: "hi" } } }, deps)).result).toEqual({ content: [{ type: "text", text: "echo: hi" }] });
  expect(calls).toEqual([["notes__echo", { text: "hi" }]]);
  expect((await answer({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "x", arguments: [] } }, deps)).error.code).toBe(-32602);
  expect((await answer({ jsonrpc: "2.0", id: 6, method: "resources/list" }, deps)).error.code).toBe(-32601);
});
