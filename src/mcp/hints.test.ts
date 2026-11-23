// How a server's tool annotations are read, and what a call that failed midway says of a retry.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, RpcError } from "./client.ts";
import { hintsOf } from "./hints.ts";
import { McpManager } from "./manager.ts";

test("only a hint a server states outright is taken, and readOnlyHint voids the write hints", () => {
  expect(hintsOf(undefined)).toBeUndefined();
  // The spec's defaults (destructive and open world when unsaid) are not taken: Keel asks before every unmarked tool.
  expect(hintsOf({})).toBeUndefined();
  expect(hintsOf({ destructiveHint: true, openWorldHint: true, idempotentHint: true })).toEqual({ destructive: true, openWorld: true, idempotent: true });
  expect(hintsOf({ destructiveHint: "yes", openWorldHint: 1 })).toBeUndefined();
  expect(hintsOf({ readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: true })).toEqual({ openWorld: true });
});

test("a call that got no answer says what its server claims of calling it again", async () => {
  const m = new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  (m as any).addEntry("svc", { command: "x", read_tools: ["look"] });
  const e = (m as any).entries.get("svc");
  const client = Object.create(McpClient.prototype) as McpClient;
  Object.assign(client, { pending: new Map(), capabilities: { tools: {} }, closed: false });
  let fail: Error = new Error("tools/call timed out after 600s");
  (client as any).rpc = async () => { throw fail; };
  Object.assign(e, { client, state: "ready", tools: [{ name: "put", annotations: { idempotentHint: true } }, { name: "send" }, { name: "look" }] });
  const call = async (tool: string) => String((await m.call("svc", tool, {}, { sessionId: "s1", cwd: "/", signal: new AbortController().signal, spillDir: "/" } as any)).content);
  expect(await call("put")).toBe("svc__put failed: tools/call timed out after 600s. It may have run before it failed. Its server says a second call with the same arguments changes nothing more (idempotentHint).");
  expect(await call("send")).toBe("svc__send failed: tools/call timed out after 600s. It may have run, or run in part, before it failed: check what it did before calling it again.");
  // A read, and a server's own error answer, say nothing of the kind.
  expect(await call("look")).toBe("svc__look failed: tools/call timed out after 600s");
  fail = new RpcError(-32602, "unknown argument");
  expect(await call("send")).toBe("svc__send failed: unknown argument");
});
