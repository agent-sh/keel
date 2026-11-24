// MCP client and manager logic no e2e can time: cursors, the halves of a
// resource listing, and what discovery does when the server or the config
// changes under it.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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

test("a browser a server left open is closed when idle only where the owner switched it on, once, and a call during the close waits for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-mcp-idle-"));
  const closes: string[] = [];
  const mk = (tools: string[]) => {
    const c = fake(() => ({}));
    (c as any).callTool = async (name: string) => { closes.push(name); return { content: [] }; };
    return { client: c, tools: tools.map((name) => ({ name })) };
  };
  const pair = ["browser_navigate", "browser_close"];
  const m = new McpManager({ capture() {} } as any, dir, "/", join(dir, "mcp.json"));
  const on = { command: "x", close_idle_browser: true };
  for (const [name, c] of Object.entries({ web: on, off: { command: "x" }, notes: on, fresh: on, busy: on, remote: { url: "http://example.test/mcp", close_idle_browser: true } })) (m as any).addEntry(name, c);
  const set = (name: string, over: Record<string, unknown>) => Object.assign((m as any).entries.get(name), { state: "ready" }, over);
  const t0 = 1_000_000;
  set("web", { ...mk(pair), used: t0 });                                  // switched on, last used long ago
  set("off", { ...mk(pair), used: t0 });                                  // the Playwright pair, switch off (the default)
  set("notes", { ...mk(["echo", "browser_close"]), used: t0 });          // a tool of that name alone is not that server
  set("fresh", { ...mk(pair), used: t0 + 9 * 60_000 });                   // used a minute ago
  set("busy", { ...mk(pair), used: t0, inflight: 1 });                    // a call is under way
  set("remote", { ...mk(pair), used: t0 });                               // a remote server's browser is not Keel's to close
  const told: [string, number][] = [];
  m.onIdleClose = (name, ms) => void told.push([name, ms]);
  const now = t0 + 10 * 60_000;
  expect(await m.closeIdle(now, 10)).toEqual(["web"]);
  expect(closes).toEqual(["browser_close"]);
  expect(told).toEqual([["web", 10 * 60_000]]);
  // Not asked again until a call comes; never when the setting is 0.
  expect(await m.closeIdle(now + 60_000, 10)).toEqual([]);
  (m as any).entries.get("web").used = now;
  expect(await m.closeIdle(now + 20 * 60_000, 0)).toEqual([]);
  expect(await m.closeIdle(now + 20 * 60_000, 10)).toEqual(["web", "fresh"]);
  // A call through the manager is what moves `used`, and holds the close off while it runs.
  const web = (m as any).entries.get("web");
  web.used = t0;
  let release!: () => void;
  web.client.callTool = (name: string) => new Promise((ok) => { closes.push(name); release = () => ok({ content: [{ type: "text", text: "ok" }] }); });
  const running = m.call("web", "browser_navigate", {}, { sessionId: "s", cwd: "/", signal: new AbortController().signal } as any);
  await Bun.sleep(5);
  expect([web.inflight, web.used > t0]).toEqual([1, true]);
  release();
  await running;
  expect(web.inflight).toBe(0);
  // A close under way holds a call that comes meanwhile until it is done: the call opens a browser after the close.
  const order: string[] = [];
  let finish!: () => void;
  web.used = t0;
  web.closedFor = undefined;
  web.client.callTool = (name: string) => new Promise((ok) => { order.push(`${name} started`); finish = () => { order.push(`${name} done`); ok({ content: [{ type: "text", text: "ok" }] }); }; });
  const closing = m.closeIdle(now + 30 * 60_000, 10);
  await Bun.sleep(5);
  expect(order).toEqual(["browser_close started"]);
  const late = m.call("web", "browser_navigate", {}, { sessionId: "s", cwd: "/", signal: new AbortController().signal } as any);
  await Bun.sleep(5);
  expect(order).toEqual(["browser_close started"]);
  finish();
  await closing;
  await Bun.sleep(5);
  expect(order).toEqual(["browser_close started", "browser_close done", "browser_navigate started"]);
  finish();
  await late;
  m.dispose();
});

test("the switch is the owner's per server: kept in its file, refused for a remote server and one without the pair of tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-mcp-idle-"));
  const m = new McpManager({ capture() {} } as any, dir, "/", join(dir, "mcp.json"));
  (m as any).cfg = { servers: { web: { command: "x" }, plain: { command: "x" }, remote: { url: "http://example.test/mcp" } } };
  for (const [n, c] of Object.entries((m as any).cfg.servers)) (m as any).addEntry(n, c);
  const ready = (name: string, tools: string[]) => Object.assign((m as any).entries.get(name), { state: "ready", client: fake(() => ({})), tools: tools.map((t) => ({ name: t })) });
  ready("web", ["browser_navigate", "browser_close"]);
  ready("plain", ["echo"]);
  ready("remote", ["browser_navigate", "browser_close"]);
  const state = (n: string) => m.list().find((x) => x.name === n)!.idle_browser;
  expect(state("web")).toEqual({ on: false, can: true, min: 10 });
  expect(state("plain")!.can).toBe(false);
  expect(state("remote")!.can).toBe(false);
  expect(() => m.setCloseIdleBrowser("plain", true)).toThrow("does not list browser_navigate and browser_close");
  expect(() => m.setCloseIdleBrowser("remote", true)).toThrow("remote server");
  m.setCloseIdleBrowser("web", true);
  expect(state("web")!.on).toBe(true);
  expect(readFileSync(join(dir, "mcp.json"), "utf8")).toContain('"close_idle_browser": true');
  m.setCloseIdleBrowser("web", false);
  expect(readFileSync(join(dir, "mcp.json"), "utf8")).not.toContain("close_idle_browser");
  m.dispose();
});
