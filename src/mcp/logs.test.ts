// A server's own log and its argument suggestions, against the echo stand-in over stdio.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConcealer, setConcealer } from "../core/conceal.ts";
import { logLine } from "./logs.ts";
import { McpManager } from "./manager.ts";

const FIXTURE = join(import.meta.dir, "../../test/e2e/fixtures/echo-mcp.ts");
const managers: McpManager[] = [];
afterAll(() => { for (const m of managers) m.dispose(); });

test("a log line keeps its level, its logger and its data, bounded", () => {
  expect(logLine({ level: "warning", logger: "db", data: { host: "x" } }, 5)).toEqual({ ts: 5, level: "warning", logger: "db", text: '{"host":"x"}' });
  expect(logLine({ level: "loud", data: "plain" }, 5)).toEqual({ ts: 5, level: "info", text: "plain" });
  expect(logLine({ level: "error", data: "x".repeat(4010) }, 5).text).toEndWith("... (10 more characters)");
});

test("a value the vault knows is kept from a server's log", () => {
  const was = getConcealer();
  setConcealer({ text: (s) => s.replaceAll("tok-123", "[secret:x]"), pairs: () => [["tok-123", "[secret:x]"]] });
  try {
    expect(logLine({ level: "error", logger: "auth tok-123", data: { token: "tok-123" } }, 5)).toEqual({ ts: 5, level: "error", logger: "auth [secret:x]", text: '{"token":"[secret:x]"}' });
  } finally { setConcealer(was); }
});

test("a server that declares logging is asked for info and up; its failures reach the Errors panel", async () => {
  const captured: { message: string; group?: string }[] = [];
  const m = new McpManager({ capture: (_s: string, e: Error, _c: unknown, at?: { group?: string }) => captured.push({ message: e.message, group: at?.group }) } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  managers.push(m);
  (m as any).addEntry("echo", { command: "bun", args: [FIXTURE, "--extras"] });
  await m.ensure("echo");
  const lines = () => m.log("echo").map((l) => `${l.level} ${l.logger}: ${l.text}`);
  for (let i = 0; i < 100 && !lines().length; i++) await Bun.sleep(20);
  // (Before it was asked it logged at warning and up: the line that says so is the first it sends at info.)
  expect(lines()).toEqual(["info echo: level set to info"]);
  const state = () => m.list().find((s) => s.name === "echo")!;
  expect(state()).toMatchObject({ logging: true, completions: true, log_rev: 1 });
  await m.call("echo", "learn", {}, { sessionId: "s1", cwd: "/", signal: new AbortController().signal, spillDir: "/" } as any);
  expect(lines()).toEqual(["info echo: level set to info", "info echo: added the prompt farewell", 'error echo: {"problem":"farewell has no translation","languages":0}']);
  expect(state().log_rev).toBe(3);
  expect(captured).toEqual([{ message: 'MCP server echo logged an error (echo): {"problem":"farewell has no translation","languages":0}', group: "mcp log\u0000echo\u0000echo\u0000error" }]);
});

test("argument suggestions come from a server that declares completions, and from no other", async () => {
  const m = new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  managers.push(m);
  (m as any).addEntry("echo", { command: "bun", args: [FIXTURE, "--extras"] });
  (m as any).addEntry("plain", { command: "bun", args: [FIXTURE] });
  const greet = { type: "ref/prompt" as const, name: "greet" };
  expect(await m.complete("echo", greet, { name: "who", value: "al" })).toEqual({ values: ["alice", "alfred"], total: 2 });
  expect(await m.complete("plain", greet, { name: "who", value: "al" })).toEqual({ values: [] });
  expect((await m.allPrompts()).filter((p) => p.name === "greet").map((p) => [p.server, !!p.complete])).toEqual([["echo", true], ["plain", false]]);
});
