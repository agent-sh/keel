// A task its server says to look at constantly (pollInterval 0, a status
// notification after every look) is looked at no more often than the floor.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "./client.ts";

const FLOOR_MS = 250; // TASK_POLL_FLOOR_MS in client.ts

const SERVER = `
const { appendFileSync } = require("node:fs");
const log = process.env.SRV_LOG;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  const task = { taskId: "t1", status: "working", pollInterval: 0 };
  switch (m.method) {
    case "initialize": return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {}, tasks: { cancel: {}, requests: { tools: { call: {} } } } }, serverInfo: { name: "stub", version: "1" } });
    case "tools/list": return reply({ tools: [{ name: "job", inputSchema: { type: "object" }, execution: { taskSupport: "required" } }] });
    case "tools/call": return reply({ task });
    case "tasks/get":
      appendFileSync(log, "get\\n");
      reply(task);
      return send({ jsonrpc: "2.0", method: "notifications/tasks/status", params: task });
    case "tasks/cancel": appendFileSync(log, "cancel\\n"); return reply({ ...task, status: "cancelled" });
  }
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
process.stdin.on("end", () => process.exit(0));
`;

test("a task is looked at no more often than the floor, whatever its server asks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-mcp-tasks-"));
  try {
    writeFileSync(join(dir, "srv.js"), SERVER);
    const log = join(dir, "srv.log");
    writeFileSync(log, "");
    const c = await McpClient.connect({ kind: "stdio", command: "bun", args: [join(dir, "srv.js")], env: { PATH: process.env.PATH!, SRV_LOG: log } }, 10_000, "legacy");
    const ac = new AbortController();
    const ms = 1_500;
    setTimeout(() => ac.abort(), ms);
    await expect(c.callTool("job", {}, ac.signal, 60_000, undefined, undefined, undefined, undefined, "required")).rejects.toThrow();
    await Bun.sleep(300);
    c.close();
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const gets = lines.filter((l) => l === "get").length;
    expect(gets).toBeGreaterThan(0);
    expect(gets).toBeLessThanOrEqual(Math.ceil(ms / FLOOR_MS) + 1);
    expect(lines).toContain("cancel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
