// A reply that is not a result or an error ends its call at once, naming the server and what it sent.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "./manager.ts";

const FIXTURE = join(import.meta.dir, "../../test/e2e/fixtures/malformed-mcp.ts");
const managers: McpManager[] = [];
afterAll(() => { for (const m of managers) m.dispose(); });

test("a malformed reply fails the call within a second, naming the server and the bytes; a string id still matches", async () => {
  const m = new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  managers.push(m);
  (m as any).addEntry("odd", { command: "bun", args: [FIXTURE], tool_timeout_secs: 3 });
  await m.ensure("odd");
  const ctx = () => ({ sessionId: "s1", cwd: "/", signal: new AbortController().signal, spillDir: "/" }) as any;
  const run = async (tool: string) => { const t = Date.now(); const r = await m.call("odd", tool, {}, ctx()); return { r, ms: Date.now() - t }; };
  const ok = await run("ok");
  expect(ok.r.is_error).toBeFalsy();
  const none = await run("noresult");
  expect(none.ms).toBeLessThan(1000);
  expect(none.r.is_error).toBe(true);
  expect(String(none.r.content)).toContain("odd__noresult failed: the server sent a malformed reply");
  expect(String(none.r.content)).toContain('{"id":');
  const bad = await run("baderror");
  expect(bad.ms).toBeLessThan(1000);
  expect(bad.r.is_error).toBe(true);
  expect(String(bad.r.content)).toContain('"error":"boom"');
  const str = await run("stringid");
  expect(str.r.is_error).toBeFalsy();
  expect(String(str.r.content)).toContain("fine");
  // A null error beside a result is a result.
  const nul = await run("nullerror");
  expect(nul.r.is_error).toBeFalsy();
  expect(String(nul.r.content)).toContain("fine");
  // A padded id is no call's: the call waits out its time and fails, never taking another's answer.
  const pad = await run("paddedid");
  expect(pad.r.is_error).toBe(true);
}, 10_000);
