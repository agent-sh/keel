// What the permission gate is told about MCP tools: a server's own word does
// not make a tool a read, and a name not known yet is not a read either.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCatalog, unregisterCatalog } from "../tools/catalog.ts";
import { toolsFor } from "../tools/registry.ts";
import { validate } from "./config.ts";
import { McpManager } from "./manager.ts";
import { installMcpTools } from "./tools.ts";

test("a server's readOnlyHint is not a read unless the owner marked the tool", () => {
  const m = new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  const entry = { name: "files", config: { command: "x", read_tools: ["list"] } };
  const tool = (name: string) => (m as any).catalogTool(entry, { name, annotations: { readOnlyHint: true } });
  expect(tool("delete_everything").readOnly).toBe(false);
  expect(tool("list").readOnly).toBe(true);
});

test("mcp_call of a name not known yet is refused, not judged a read", async () => {
  installMcpTools({ configured: () => [] } as any);
  registerCatalog({ name: "slow", tools: async () => [], pending: () => ["slow"] });
  try {
    const call = toolsFor("claude").find((t) => t.name === "mcp_call")!;
    const t = await call.target!({ tool: "slow__write", arguments: { a: 1 } });
    expect(t?.readOnly).toBe(false);
    expect(t?.cls?.kind).toBe("refused");
    expect((t?.cls as any).why).toContain("Still connecting: slow");
  } finally {
    unregisterCatalog("slow");
  }
});

test("server names cannot take a built-in's name or make two tools' full names collide", () => {
  for (const n of ["keel", "phone", "parlar", "keel-import", "a__b", "a_"]) expect(validate(n, { command: "x" })).not.toBeNull();
  expect(validate("a_b", { command: "x" })).toBeNull();
});
