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

// An owner's answer is for the server source it was given for: a server
// replaced under the same name, with the same description, schema and read
// flag but another endpoint or credentials, does not inherit it.
test("an answer waiting on a card runs only on the source it was given for (native and mcp_call)", async () => {
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Gate } = await import("../safety/gate.ts");
  const { withCatalog } = await import("../tools/defer.ts");
  installMcpTools({ configured: () => [] } as any);
  const results: Record<string, { error: boolean; runs: string[]; text: string }> = {};
  for (const profile of ["native", "dispatcher"] as const)
    for (const change of ["unchanged", "source", "schema", "removed"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "keel-mcp-bind-"));
      const store = new Store(join(dir, "state")), bus = new Bus(), g = new Gate(store, bus);
      const s = store.createSession({ workspace: dir, model: "fixture", title: "bind" });
      g.setPerm(s.id, { mode: "ask" });
      const runs: string[] = [];
      // Every catalog read makes new objects, as the manager does.
      const make = (src: string, type = "number") => ({
        server: "fixture", name: "act", qualified: "fixture__act", mcp: true, source: src, description: "Synthetic operation", readOnly: false,
        input_schema: { type: "object", properties: { value: { type } }, required: ["value"] },
        run: async () => { runs.push(src); return { content: src }; },
      });
      const put = (src: string, type?: string) => registerCatalog({ name: "fixture", tools: async () => [make(src, type)], known: () => [make(src, type)] });
      put("A");
      const tool = profile === "native" ? (await withCatalog([], "claude", [])).find((t) => t.name === "mcp__fixture__act")! : toolsFor("gpt").find((t) => t.name === "mcp_call")!;
      const input = profile === "native" ? { value: 1 } : { tool: "fixture__act", arguments: { value: 1 } };
      const ctx = { sessionId: s.id, cwd: dir, signal: new AbortController().signal, seen: new Map(), spillDir: join(dir, "spill") };
      const shown = new Promise<any>((res) => { const off = bus.on((f: any) => { if (f.name === "approval" && f.data?.state === "pending") { off(); res(f.data); } }); });
      const pending = g.beforeTool(s, { id: crypto.randomUUID(), tool, input, ctx } as any);
      const card = await shown;
      if (change === "removed") unregisterCatalog("fixture");
      else if (change === "source") put("B");
      else if (change === "schema") put("B", "string");
      else put("A"); // a no-op refresh or a reconnect of the same server
      expect(g.resolve(card.id, s.id, { choice: "once" })).toEqual({ ok: true });
      expect(await pending).toBeUndefined();
      const out = await tool.run(input, ctx as any);
      results[`${profile}/${change}`] = { error: !!out.is_error, runs, text: String(out.content) };
      unregisterCatalog("fixture");
      store.db.close();
    }
  for (const p of ["native", "dispatcher"]) {
    expect(results[`${p}/unchanged`]).toMatchObject({ error: false, runs: ["A"] });
    expect(results[`${p}/source`]).toMatchObject({ error: true, runs: [] });
    expect(results[`${p}/source`]!.text).toContain("another source");
    expect(results[`${p}/schema`]).toMatchObject({ error: true, runs: [] });
    expect(results[`${p}/removed`]).toMatchObject({ error: true, runs: [] });
  }
});

test("an always grant for an MCP tool covers the source it was given for, not a replacement", async () => {
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Gate } = await import("../safety/gate.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-mcp-bind-"));
  const store = new Store(join(dir, "state")), bus = new Bus(), g = new Gate(store, bus);
  const s = store.createSession({ workspace: dir, model: "fixture", title: "bind" });
  g.setPerm(s.id, { mode: "ask" });
  const on = (source: string) => ({ name: "mcp_call", readOnly: false, input_schema: {}, run: async () => ({ content: "" }), target: async (input: any) => ({ name: "fixture__act", readOnly: false, input, source }) });
  const ctx = { sessionId: s.id, cwd: dir, signal: new AbortController().signal, seen: new Map(), spillDir: dir };
  const cards: any[] = [];
  bus.on((f: any) => { if (f.name === "approval" && f.data?.state === "pending") cards.push(f.data); });
  const first = g.beforeTool(s, { id: "1", tool: on("A"), input: {}, ctx } as any);
  await Bun.sleep(0);
  g.resolve(cards[0].id, s.id, { choice: "always" });
  await first;
  expect(await g.beforeTool(s, { id: "2", tool: on("A"), input: {}, ctx } as any)).toBeUndefined();
  void g.beforeTool(s, { id: "3", tool: on("B"), input: {}, ctx } as any);
  await Bun.sleep(0);
  expect(cards.length).toBe(2);
  store.db.close();
});

test("both catalog dispatchers recheck permission after resolving a tool", async () => {
  const { withCatalog } = await import("../tools/defer.ts");
  installMcpTools({ configured: () => [] } as any);
  const workspace = mkdtempSync(join(tmpdir(), "keel-mcp-dispatch-"));
  let runs = 0;
  const fixture = { server: "dispatch_fixture", name: "note", qualified: "dispatch_fixture__note", mcp: true,
    input_schema: { type: "object" }, description: "Inert fixture", run: async () => (runs++, { content: "ok" }) };
  let beforeLookup = async () => {};
  registerCatalog({ name: "dispatch_fixture", known: () => [fixture], tools: async () => { await beforeLookup(); return [fixture]; } });
  try {
    const native = (await withCatalog([], "claude", [])).find((t) => t.name === "mcp__dispatch_fixture__note")!;
    const dispatcher = toolsFor("gpt").find((t) => t.name === "mcp_call")!;
    for (const [tool, input] of [[native, {}], [dispatcher, { tool: fixture.qualified, arguments: {} }]] as const) {
      let allowed = true;
      beforeLookup = async () => {};
      await tool.target!(input);
      const ctx = { sessionId: "fixture", cwd: workspace, signal: new AbortController().signal, seen: new Map(), spillDir: workspace,
        authorizationError: () => allowed ? undefined : "Permission changed" };
      expect(await tool.run(input, ctx)).toEqual({ content: "ok" });
      beforeLookup = async () => { allowed = false; };
      expect(await tool.run(input, ctx)).toEqual({ content: "Permission changed", is_error: true });
    }
    expect(runs).toBe(2);
  } finally {
    unregisterCatalog("dispatch_fixture");
  }
});

test("a server's source binding follows its endpoint, program and credentials, not Keel's own choices", async () => {
  const { binding } = await import("./sources.ts");
  const key = new Uint8Array(32);
  const b = (c: any) => binding(c, key);
  const base = { command: "/usr/bin/node", args: ["server.js"], env: { TOKEN: "a" } };
  expect(b({ ...base })).toBe(b(base));
  expect(b({ ...base, enabled: false, read_tools: ["x"], sync: { source: "claude", name: "n" } })).toBe(b(base));
  expect(b({ ...base, command: "/opt/other/node" })).not.toBe(b(base));
  expect(b({ ...base, args: ["other.js"] })).not.toBe(b(base));
  expect(b({ ...base, env: { TOKEN: "b" } })).not.toBe(b(base));
  expect(b({ url: "https://A.example/mcp", headers: { Authorization: "x" } })).toBe(b({ url: "https://a.example:443/mcp", headers: { authorization: "x" } }));
  expect(b({ url: "https://a.example/mcp", headers: { Authorization: "y" } })).not.toBe(b({ url: "https://a.example/mcp", headers: { Authorization: "x" } }));
  expect(b({ url: "https://a.example/mcp" })).not.toBe(b({ url: "https://b.example/mcp" }));
});

// A retry the owner let through after the reviewer refused a call is for that
// call on that source in that shape: the same server read again keeps it, a
// changed endpoint, account or schema gets judged anew.
test("a reviewer retry covers the refused call's source and shape only", async () => {
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Gate } = await import("../safety/gate.ts");
  const { withCatalog } = await import("../tools/defer.ts");
  const { binding } = await import("./sources.ts");
  const out: Record<string, { judged: number; let: boolean }> = {};
  for (const change of ["same", "endpoint", "account", "schema"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-retry-"));
    const store = new Store(join(dir, "state")), g = new Gate(store, new Bus());
    const s = store.createSession({ workspace: dir, model: "fixture", title: "retry" });
    g.setPerm(s.id, { mode: "reviewer" });
    let judged = 0;
    g.judge = async () => (judged++, { allow: false, risk: "medium", reason: "needs the owner", model: "inert" } as any);
    const put = (changed: boolean) => {
      const c = { url: `https://fixture.invalid/${changed && change === "endpoint" ? "B" : "A"}`, headers: { "X-Account": changed && change === "account" ? "B" : "A" } };
      const source = binding(c, new Uint8Array(32).fill(7));
      const make = () => ({ server: "fixture", name: "act", qualified: "fixture__act", mcp: true, source, description: "Synthetic operation", readOnly: false, input_schema: { type: "object", properties: { value: { type: changed && change === "schema" ? "string" : "number" } } }, run: async () => ({ content: "ok" }) });
      registerCatalog({ name: "fixture", tools: async () => [make()], known: () => [make()] });
    };
    const ctx = { sessionId: s.id, cwd: dir, signal: new AbortController().signal, seen: new Map(), spillDir: dir };
    const tool = async () => (await withCatalog([], "claude", [])).find((t) => t.name === "mcp__fixture__act")!;
    try {
      put(false);
      expect("deny" in (await g.check(s, { id: "1", tool: await tool(), input: { value: 1 }, ctx } as any))).toBe(true);
      g.allowRetry(s.id, g.blocked(s.id)[0]!.id);
      put(true);
      const second = await g.check(s, { id: "2", tool: await tool(), input: { value: 1 }, ctx } as any);
      out[change] = { judged, let: !("deny" in second) };
    } finally {
      unregisterCatalog("fixture");
      store.db.close();
    }
  }
  expect(out).toEqual({ same: { judged: 1, let: true }, endpoint: { judged: 2, let: false }, account: { judged: 2, let: false }, schema: { judged: 2, let: false } });
});
