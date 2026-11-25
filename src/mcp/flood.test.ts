import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "./manager.ts";
import { mcpRows } from "../admin/health-rules.ts";

const FIXTURE = join(import.meta.dir, "../../test/e2e/fixtures/flood-mcp.ts");
const managers: McpManager[] = [];
afterAll(() => { for (const m of managers) m.dispose(); });

test("a stdio server's output is read to a bound: a long line is dropped and said once, a flood closes the server", async () => {
  const m = new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  managers.push(m);
  (m as any).addEntry("wide", { command: "bun", args: [FIXTURE], tool_timeout_secs: 20 });
  await m.ensure("wide");
  const ctx = () => ({ sessionId: "s1", cwd: "/", signal: new AbortController().signal, spillDir: "/" }) as any;
  const run = async (tool: string) => { const t = Date.now(); const r = await m.call("wide", tool, {}, ctx()); return { r, ms: Date.now() - t }; };
  const state = () => m.list().find((s) => s.name === "wide")!;

  // A line over the bound answers its request with the size said, at once, and the next call is served.
  const big = await run("big");
  expect(big.r.is_error).toBe(true);
  expect(String(big.r.content)).toContain("more than the 4194304 Keel reads in one line");
  expect(big.ms).toBeLessThan(5000);
  expect((await run("ok")).r.is_error).toBeFalsy();
  expect(state().dropped_lines).toBe(1);
  expect(m.log("wide").filter((l) => l.text.includes("dropped unread")).length).toBe(1);
  expect(mcpRows([{ name: "wide", enabled: true, state: "ready", dropped: 1 }]).some((r) => r.id === "mcp:wide:lines" && r.level === "warning")).toBe(true);

  // 64 MB with no newline: not held, and the server is closed with its reason.
  let peak = 0;
  const base = process.memoryUsage().rss;
  const watch = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss - base); }, 5);
  const flood = await run("flood");
  clearInterval(watch);
  expect(flood.r.is_error).toBe(true);
  expect(String(flood.r.content)).toContain("characters with no line end");
  expect(state().state).toBe("error");
  expect(state().error).toContain("characters with no line end");
  expect(peak).toBeLessThan(96 * 1024 * 1024);
  // Said once: the flood is the second line dropped, and the log holds the one warning.
  expect(m.log("wide").filter((l) => l.text.includes("dropped unread")).length).toBe(1);
}, 40_000);
