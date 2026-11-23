// MCP client and manager logic no e2e can time: cursors, the halves of a
// resource listing, and what discovery does when the server or the config
// changes under it.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, RpcError } from "./client.ts";
import { McpManager } from "./manager.ts";
import { installMcpTools } from "./tools.ts";
import { catalogTools } from "../tools/catalog.ts";
import { allHooks } from "../engine/hooks.ts";

// Turn hooks are process-wide: the files after this one run without the ones its tests register.
const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

// A client whose requests go to `answer` (no process, no socket).
function fake(answer: (method: string, params: any) => Promise<any> | any, caps: Record<string, any> = { tools: {} }) {
  const c = Object.create(McpClient.prototype) as McpClient;
  Object.assign(c, { pending: new Map(), capabilities: caps, closed: false, closes: 0, retiring: false });
  const calls: [string, any][] = [];
  (c as any).rpc = async (method: string, params: any) => {
    calls.push([method, params]);
    return answer(method, params);
  };
  (c as any).close = function () {
    if (this.closed) return;
    this.closed = true;
    this.closes++;
  };
  return Object.assign(c, { calls });
}
const closes = (c: McpClient) => (c as any).closes as number;

const connect = McpClient.connect;
afterEach(() => { McpClient.connect = connect; });
const manager = (servers: Record<string, any>) => {
  const m = new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  for (const [name, c] of Object.entries(servers)) (m as any).addEntry(name, c);
  return m;
};

test("only a missing cursor ends a listing; the bound says where it stopped", async () => {
  const c = fake((_m, p) => (p.cursor === undefined ? { tools: [{ name: "alpha" }], nextCursor: "" } : { tools: [{ name: "beta" }] }));
  expect((await c.listTools()).map((t) => t.name)).toEqual(["alpha", "beta"]);
  expect(c.calls.map(([, p]) => p)).toEqual([{}, { cursor: "" }]);
  const once = fake(() => ({ tools: [{ name: "alpha" }] }));
  expect((await once.listTools()).length).toBe(1);
  expect(once.calls.length).toBe(1);
  let n = 0;
  const endless = fake(() => ({ resources: [{ uri: `r${++n}` }], nextCursor: `p${n}` }));
  const r = await endless.listResources();
  expect(r.items.length).toBe(50);
  expect(r.next).toBe("p50");
  const on = await endless.listResources(undefined, r.next);
  expect(on.items[0].uri).toBe("r51");
});

test("the two halves of a resource listing stand alone", async () => {
  const m = manager({});
  const put = (answer: (method: string) => any) => {
    const client = fake(answer, { resources: {} });
    (m as any).entries.set("f", { name: "f", config: {}, state: "ready", client, tools: [], failures: 0, resourcesRev: 0, updates: {}, subscribed: new Set() });
  };
  put((method) => (method === "resources/list" ? { resources: [{ uri: "a" }] } : Promise.reject(new RpcError(-32601, "not found"))));
  let r = await m.resources("f");
  expect(r.resources.items.length).toBe(1);
  expect(r.templates).toEqual({ items: [], unsupported: true });
  put((method) => (method === "resources/list" ? { resources: [{ uri: "a" }] } : Promise.reject(new RpcError(-32603, "boom"))));
  r = await m.resources("f");
  expect(r.templates.error).toBe("boom");
  put((method) => (method === "resources/list" ? Promise.reject(new RpcError(-32603, "down")) : { resourceTemplates: [{ uriTemplate: "t/{x}" }] }));
  r = await m.resources("f");
  expect(r.resources.error).toBe("down");
  expect(r.templates.items.length).toBe(1);
  m.dispose();
});

// The rows a failed page keeps and the cursor a retry sends are the e2e's
// (test/e2e/mcp-http.spec.ts); these are the parts it does not reach.
test("a tool list that breaks midway is a failure, and the model is told which page failed", async () => {
  const tools = fake((_m, p) => (p.cursor === undefined ? { tools: [{ name: "a" }], nextCursor: "x" } : Promise.reject(new Error("down"))));
  await expect(tools.listTools()).rejects.toThrow("down");
  // A cursor is its connection's: on a closed one the failure is thrown, with nothing to go on from.
  const closed = fake((_m, p) => { if (p.cursor === undefined) return { resources: [{ uri: "a" }], nextCursor: "c2" }; (closed as any).closed = true; throw new Error("gone"); });
  await expect(closed.listResources()).rejects.toThrow("gone");
  // list_resources: a page that failed is not "cut at 50 pages"; a list the bound stopped is.
  installMcpTools({ configured: () => [], refusal: () => undefined, resources: async () => ({ resources: { items: [{ uri: "a" }], next: "c2", error: "not ready" }, templates: { items: [{ uriTemplate: "t/{x}" }], next: "c9" } }) } as any);
  const list = (await catalogTools()).find((t) => t.qualified === "mcp__list_resources")!;
  const said = String((await list.run({ server: "f" }, {} as any)).content).split("\n");
  expect(said.slice(2)).toEqual(["(listing more resources failed after 1: not ready)", "(the templates were cut at 50 pages: more may exist)"]);
});

test("a server removed during its first tool list is closed, and its waiter fails", async () => {
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  const client = fake(async () => { await held; return { tools: [{ name: "x" }] }; });
  McpClient.connect = async () => client;
  const m = manager({ a: { command: "a" } });
  const waiting = m.ensure("a");
  await Bun.sleep(0);
  (m as any).drop("a");
  release();
  await expect(waiting).rejects.toThrow("changed while it connected");
  expect(closes(client)).toBe(1);
  expect(m.has("a")).toBe(false);
  m.dispose();
  expect(closes(client)).toBe(1);
});

test("a server that exits during discovery is not ready", async () => {
  const client = fake(() => {
    (client as any).closed = true;
    (client as any).onClose?.("exited");
    throw new Error("the connection is closed");
  }, { resources: {} }); // no tools capability: a listing error alone would read as no tools
  McpClient.connect = async () => client;
  const m = manager({ a: { command: "a" } });
  await expect(m.ensure("a")).rejects.toThrow();
  expect(m.list()[0]!.state).toBe("error");
  m.dispose();
});

test("the latest tool list wins, whatever order the replies land in", async () => {
  const replies: ((v: any) => void)[] = [];
  let first = true;
  const client = fake(() => {
    if (first) { first = false; return { tools: [{ name: "base" }] }; }
    return new Promise((res) => replies.push(res));
  });
  McpClient.connect = async () => client;
  const m = manager({ a: { command: "a" } });
  await m.ensure("a");
  client.onListChanged!();
  client.onListChanged!();
  replies[1]!({ tools: [{ name: "new" }] });
  replies[0]!({ tools: [{ name: "old" }] });
  await Bun.sleep(0);
  expect(m.list()[0]!.tool_names).toEqual(["new"]);
  // A resource list change is counted apart from tools.
  const rev = m.list()[0]!.resources_rev;
  client.onResources!({ list: true });
  expect(m.list()[0]!.resources_rev).toBe(rev + 1);
  m.dispose();
});
