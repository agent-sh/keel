// The host side of MCP Apps, against a real store and a real MCP manager (its
// server's client stood in): which server an app's call reaches, what the
// session keeps of its pages, and what an app may ask of its server how often.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { Store } from "../../core/store.ts";
import { McpClient } from "../../mcp/client.ts";
import { McpManager } from "../../mcp/manager.ts";
import type { Tool, ToolContext } from "../../tools/types.ts";
import { APP_PAGE_MAX, CALLS_PER_MINUTE, mcpAppRoutes, SESSION_PAGES_MAX } from "./mcp-apps.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "mcp-apps-routes-"));
const store = new Store(dir);
const manager = new McpManager({ capture() {} } as any, mkdtempSync(join(dir, "mcp-")), "/");
const g = globalThis as { __keelMcp?: McpManager };
const wasMcp = g.__keelMcp;
g.__keelMcp = manager;

// The engine's part: each call an app makes, with who asks and the signal it runs under.
type Ran = { asker: string; signal: AbortSignal; tool: string };
const ran: Ran[] = [];
let hold: Promise<void> | undefined;
const engine = {
  async runForApp(sid: string, tool: Tool, input: unknown, callId: string, signal: AbortSignal, asker: string) {
    ran.push({ asker, signal, tool: tool.name });
    if (hold) await hold;
    if (signal.aborted) return { type: "tool_result", tool_use_id: callId, content: "The call was stopped.", is_error: true };
    const ctx = { sessionId: sid, cwd: dir, signal, spillDir: dir, seen: new Map() } as ToolContext;
    const out = await tool.run(input, ctx);
    return { type: "tool_result", tool_use_id: callId, content: out.content, ...(out.is_error ? { is_error: true } : {}) };
  },
  verdictOf: () => undefined,
  message: () => ({ held: false, event: {} }),
};
const routes = mcpAppRoutes({ store, bus: new Bus(), engine, errors: { capture() {} } } as any);
afterAll(() => {
  g.__keelMcp = wasMcp;
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// A server named `name` whose app page is `html` (one page a URI), answering its tools by name.
const PAGE = "ui://board/app.html";
function serve(name: string, config: { command: string; args?: string[] }, pages: Record<string, string>) {
  (manager as any).addEntry(name, config);
  const e = (manager as any).entries.get(name);
  const client = Object.create(McpClient.prototype) as McpClient;
  Object.assign(client, { pending: new Map(), capabilities: { tools: {}, resources: {} }, closed: false });
  (client as any).rpc = async (method: string, params: any) => {
    if (method === "resources/read") return { contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: pages[params.uri] }] };
    if (method === "tools/call") return { content: [{ type: "text", text: `${name} ran ${params.name}` }] };
    throw new Error(`no ${method}`);
  };
  const tools = [
    ...Object.keys(pages).map((uri, i) => ({ name: i ? `board${i}` : "board", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: uri } } })),
    { name: "look", inputSchema: { type: "object" } },
  ];
  Object.assign(e, { client, state: "ready", tools });
  // Its first listing is pinned, as a connect does (the owner added it).
  (manager as any).settle(e, undefined);
}
// The owner removes a server: its pin goes with it.
const unserve = (name: string) => { (manager as any).entries.delete(name); delete (manager as any).pins[name]; };
const ctxOf = (sid: string) => ({ sessionId: sid, cwd: dir, signal: new AbortController().signal, spillDir: dir, seen: new Map() }) as unknown as ToolContext;
// The model calls the server's tool: its app is kept with the result.
async function drawn(name: string, sid: string, tool = "board"): Promise<string> {
  const out = await manager.call(name, tool, {}, ctxOf(sid));
  const id = (out as any).shown?.mcp_app?.id;
  expect(id).toBeString();
  return id;
}
const request = (path: string, method: string, body?: unknown, signal?: AbortSignal, params: Record<string, string> = {}) =>
  Object.assign(new Request(`http://keel${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }), ...(signal ? { signal } : {}) }), { params });
const callApp = (sid: string, app: string, name: string, signal?: AbortSignal) =>
  routes["/api/sessions/:id/mcp-apps/:app/call"].POST(request(`/api/sessions/${sid}/mcp-apps/${app}/call`, "POST", { name, arguments: {} }, signal, { id: sid, app })) as Promise<Response>;
const pageOf = (sid: string, app: string) => routes["/api/sessions/:id/mcp-apps/:app/page"].GET(request("/", "GET", undefined, undefined, { id: sid, app })) as Response;
const pagesKept = () => store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM mcp_app_pages").get()!.n;

test("an app calls the server it came from, never another one given its name since", async () => {
  const s = store.createSession({ workspace: dir, model: "p:m" });
  serve("h", { command: "board-server", args: ["--team", "blue"] }, { [PAGE]: "<p>board</p>" });
  const app = await drawn("h", s.id);
  const first = await (await callApp(s.id, app, "look")).json();
  expect(first.result.content[0].text).toBe("h ran look");
  // The card the gate opens for it says the app asks, not the model.
  expect(ran.at(-1)!.asker).toBe("The h app");

  // The owner removes h and adds another server under the same name: the kept page reaches nothing of it.
  unserve("h");
  serve("h", { command: "other-server" }, { [PAGE]: "<p>other</p>" });
  const before = ran.length;
  const second = await (await callApp(s.id, app, "look")).json();
  expect(second.refused).toBe("this app came from another server named h");
  expect(second.call.state).toBe("refused");
  expect(ran.length).toBe(before);
  // The same server again (its command and arguments as they were) is the app's own.
  unserve("h");
  serve("h", { command: "board-server", args: ["--team", "blue"] }, { [PAGE]: "<p>board</p>" });
  expect((await (await callApp(s.id, app, "look")).json()).result.content[0].text).toBe("h ran look");
  unserve("h");
});

test("a page goes with the last app that points to it, and a session keeps its newest pages within its bytes", async () => {
  const kept0 = pagesKept();
  const a = store.createSession({ workspace: dir, model: "p:m" });
  const b = store.createSession({ workspace: dir, model: "p:m" });
  serve("p", { command: "pages" }, { [PAGE]: "<p>shared</p>" });
  const a1 = await drawn("p", a.id), a2 = await drawn("p", a.id), b1 = await drawn("p", b.id);
  expect(pagesKept()).toBe(kept0 + 1);
  // An app row goes: the page stays while another points to it.
  store.db.query("DELETE FROM mcp_apps WHERE id = ?").run(a1);
  expect(pagesKept()).toBe(kept0 + 1);
  store.deleteSession(a.id);
  expect(pagesKept()).toBe(kept0 + 1);
  expect(pageOf(b.id, b1).status).toBe(200);
  // The last session that held it goes: so does the page.
  store.deleteSession(b.id);
  expect(pagesKept()).toBe(kept0);
  void a2;
  unserve("p");

  // Five distinct pages of the largest size: the oldest is let go, the newest four stay drawn.
  const c = store.createSession({ workspace: dir, model: "p:m" });
  const big = (n: number) => `<p>${String(n).repeat(APP_PAGE_MAX - 8)}</p>`.slice(0, APP_PAGE_MAX);
  const uris = [0, 1, 2, 3, 4].map((n) => `ui://big/${n}.html`);
  serve("big", { command: "big" }, Object.fromEntries(uris.map((u, n) => [u, big(n)])));
  const apps: string[] = [];
  for (const [n] of uris.entries()) apps.push(await drawn("big", c.id, n ? `board${n}` : "board"));
  expect(SESSION_PAGES_MAX).toBe(4 * APP_PAGE_MAX);
  const gone = pageOf(c.id, apps[0]!);
  expect(gone.status).toBe(404);
  expect((await gone.json()).error).toContain("the page was let go: a session keeps at most 32 MB of app pages");
  for (const id of apps.slice(1)) expect(pageOf(c.id, id).status).toBe(200);
  expect(store.db.query<{ n: number }, [string]>("SELECT SUM(p.bytes) AS n FROM mcp_app_pages p WHERE p.hash IN (SELECT page FROM mcp_apps WHERE session_id = ?)").get(c.id)!.n).toBeLessThanOrEqual(SESSION_PAGES_MAX);
  store.deleteSession(c.id);
  expect(pagesKept()).toBe(kept0);
  unserve("big");
});

test("a call stops when the page that asked goes away", async () => {
  const s = store.createSession({ workspace: dir, model: "p:m" });
  serve("w", { command: "waits" }, { [PAGE]: "<p>w</p>" });
  const app = await drawn("w", s.id);
  let release = () => {};
  hold = new Promise((r) => (release = r));
  const page = new AbortController();
  const before = ran.length;
  const answer = callApp(s.id, app, "look", page.signal);
  // (Until the route hands the call to the engine.)
  for (let i = 0; i < 400 && ran.length === before; i++) await Bun.sleep(5);
  const call = ran.at(-1)!;
  expect(call.signal.aborted).toBe(false);
  page.abort();
  expect(call.signal.aborted).toBe(true);
  hold = undefined;
  release();
  expect((await (await answer).json()).call.state).toBe("error");
  unserve("w");
});

test(`an app's server takes ${CALLS_PER_MINUTE} calls a minute from its apps in a session`, async () => {
  const s = store.createSession({ workspace: dir, model: "p:m" });
  serve("r", { command: "rate" }, { [PAGE]: "<p>r</p>" });
  const app = await drawn("r", s.id);
  for (let i = 0; i < CALLS_PER_MINUTE; i++) expect((await callApp(s.id, app, "look")).status).toBe(200);
  const over = await callApp(s.id, app, "look");
  expect(over.status).toBe(429);
  expect((await over.json()).error).toBe(`the app called its server more than ${CALLS_PER_MINUTE} times in a minute`);
  unserve("r");
});
