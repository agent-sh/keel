// ChatGPT's app connectors as the server Keel brings, against a stand-in of the apps server over real HTTP: what
// it is sent (the sign-in, the product and account headers, a call's `_meta`), that it is off until turned on,
// that its listing is kept and it then holds no connection, which session is offered which connector, and how
// each kind of tool reaches the gate. The pure parts (what a tool is, a connector's names) are tested with it.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSettings } from "../admin/settings.ts";
import { APPS_SERVER, appKind, appsBlock, appsHeaders, appsMissing, callMeta, connectorsOf, named, offeredTo, ownWhy, slugOf } from "../mcp/chatgpt-apps.ts";
import type { McpTool } from "../mcp/client.ts";
import { McpManager } from "../mcp/manager.ts";
import { catalogSources, catalogTools } from "../tools/catalog.ts";
import { installChatgptApps } from "./chatgpt-apps.ts";

const tool = (name: string, app: [string, string], annotations: Record<string, boolean>): McpTool => ({
  name, description: `${name} of ${app[1]}`, inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations,
  _meta: { connector_id: app[0], connector_name: app[1], _codex_apps: { resource_uri: `/${app[0]}/link_1/${name.split(".")[1]}` } },
});
const GMAIL: [string, string] = ["connector_g", "Gmail"], SLACK: [string, string] = ["asdk_app_s", "Slack"], CAL: [string, string] = ["connector_c", "Google Calendar"];
const TOOLS = [
  tool("gmail.search_emails", GMAIL, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool("gmail.send_email", GMAIL, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
  tool("gmail.delete_emails", GMAIL, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }),
  tool("gmail.create_label", GMAIL, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }),
  tool("slack.post_message", SLACK, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
  tool("google_calendar.list_events", CAL, { readOnlyHint: true }),
  tool("slack.search_public", SLACK, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
];

test("a tool is a read only when its connector says so outright and names no reach outside; of the rest one deletes, one sends, one writes", () => {
  expect(TOOLS.map(appKind)).toEqual(["read", "send", "delete", "write", "send", "read", "fetch"]);
  // A read or a fetch is nobody's account write.
  expect([ownWhy(TOOLS[0]!), ownWhy(TOOLS[6]!)]).toEqual([undefined, undefined]);
  // Nothing said, or a read hint that is not exactly true, is a write: it asks.
  expect([appKind({}), appKind({ annotations: {} }), appKind({ annotations: { readOnlyHint: "true" as unknown as boolean } })]).toEqual(["write", "write", "write"]);
  // (A read hint beside a destructive one is a read, as the spec says: the others mean nothing beside it.)
  expect(appKind({ annotations: { readOnlyHint: true, destructiveHint: true } })).toBe("read");
  expect(ownWhy(TOOLS[1]!)).toBe("sends from Gmail to people or services outside it (its connector says so), as you, through your ChatGPT account: every write through a ChatGPT app is yours to allow");
  expect(ownWhy(TOOLS[2]!)).toContain("may delete or overwrite data in Gmail");
  expect(ownWhy(TOOLS[3]!)).toContain("changes things in Gmail, as you");
});

test("a connector is named by its id, its name or its tools' prefix; a session is offered only the ones turned on", () => {
  expect(slugOf("AdKit - Ads Manager")).toBe("adkit_ads_manager");
  const cal = { id: "connector_c", name: "Google Calendar" };
  for (const n of ["connector_c", "Google Calendar", "google calendar", "google_calendar", " GOOGLE_CALENDAR "]) expect([n, named(cal, [n])]).toEqual([n, true]);
  for (const n of ["google", "calendar", "connector", ""]) expect([n, named(cal, [n])]).toEqual([n, false]);
  expect(TOOLS.filter(offeredTo(["connector_g"])).map((t) => t.name)).toEqual(["gmail.search_emails", "gmail.send_email", "gmail.delete_emails", "gmail.create_label"]);
  expect(TOOLS.filter(offeredTo(["slack", "Google Calendar"])).map((t) => t.name)).toEqual(["slack.post_message", "google_calendar.list_events", "slack.search_public"]);
  // A tool that names no connector is nobody's.
  expect(offeredTo(["gmail"])({ _meta: {} })).toBe(false);
  expect(connectorsOf(TOOLS)).toEqual([{ id: "connector_g", name: "Gmail", tools: 4, reads: 1 }, { id: "connector_c", name: "Google Calendar", tools: 1, reads: 1 }, { id: "asdk_app_s", name: "Slack", tools: 2, reads: 0 }]);
});

test("a call carries its tool's own routing with the call's id; the headers name the product and the account", () => {
  expect(callMeta(TOOLS[0], "call_7")).toEqual({ _codex_apps: { resource_uri: "/connector_g/link_1/search_emails", call_id: "call_7" } });
  expect(callMeta({ _meta: {} }, "c")).toBeUndefined();
  expect(callMeta({ _meta: { _codex_apps: "text" } }, "c")).toBeUndefined();
  expect(appsHeaders("acct_1")).toEqual({ "X-OpenAI-Product-Sku": "codex", originator: "keel", "chatgpt-account-id": "acct_1" });
  expect(appsHeaders()).toEqual({ "X-OpenAI-Product-Sku": "codex", originator: "keel" });
});

test("an agent definition's connectors are reached only with the server on and the connector listed", () => {
  expect(appsMissing(["connector_g"], undefined)).toContain("only once the owner turns them on");
  expect(appsMissing(["connector_g"], { on: false, why: "not signed in to ChatGPT: run `codex login`" })).toContain("(not signed in to ChatGPT: run `codex login`)");
  // On with no listing taken yet: nothing says it is missing.
  expect(appsMissing(["connector_g"], { on: true })).toBeUndefined();
  expect(appsMissing(["connector_g", "connector_x"], { on: true, connectors: [{ id: "connector_g", name: "Gmail" }] })).toBe("the owner's ChatGPT account does not list connector_x");
  expect(appsBlock(["connector_g"], { on: true, connectors: [{ id: "connector_g", name: "Gmail" }] })).toContain("Gmail (tools named chatgpt-apps__gmail.*)");
  expect(appsBlock([], { on: true })).toBe("");
});

// ---- the server, against a stand-in ----

type Seen = { method: string; auth: string | null; sku: string | null; account: string | null; params?: any };
function standIn() {
  const seen: Seen[] = [];
  let refuse = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const m = (await req.json()) as any;
      const auth = req.headers.get("authorization");
      seen.push({ method: m.method, auth, sku: req.headers.get("x-openai-product-sku"), account: req.headers.get("chatgpt-account-id"), params: m.params });
      if (auth === `Bearer ${refuse}`) return new Response(null, { status: 401 });
      if (m.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown, headers?: Record<string, string>) => Response.json({ jsonrpc: "2.0", id: m.id, result }, { headers });
      if (m.method === "initialize") return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "apps", version: "1" } }, { "mcp-session-id": "s1" });
      if (m.method === "tools/list") return reply({ tools: TOOLS, _meta: { "openai/apps": [] } });
      if (m.method === "tools/call") return reply({ content: [{ type: "text", text: `ran ${m.params?.name}` }] });
      return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/backend-api/ps/mcp`, seen, refuse: (token: string) => void (refuse = token), stop: () => server.stop(true) };
}

const dirs: string[] = [];
const managers: McpManager[] = [];
afterAll(() => { for (const m of managers) m.dispose(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sink = { capture() {} } as any;
const ctx = (sessionId: string, callId: string) => ({ sessionId, callId, cwd: "/", signal: new AbortController().signal, seen: new Map(), spillDir: tmpdir() }) as any;
const AGENT = "agent-session", PLAIN = "plain-session";

function setup(state: string, url: string, tokens: string[] = ["tok-1"]) {
  const m = new McpManager(sink, state, "/");
  managers.push(m);
  const asked: boolean[] = [];
  installChatgptApps(m, {
    available: () => true,
    signIn: async (force) => { asked.push(!!force); return { token: tokens[Math.min(asked.length - 1, tokens.length - 1)]!, account: "acct_1" }; },
    account: () => "acct_1",
    appsUrl: () => url,
  }, (session) => (session === AGENT ? ["connector_g"] : undefined));
  return { m, asked };
}
const row = (m: McpManager) => m.list().find((s) => s.name === APPS_SERVER)!;
const mine = async (session: string) => (await catalogTools(session)).filter((t) => t.server === APPS_SERVER);

test("off until the owner turns it on; then signed in, listed, kept, asleep after a restart, and offered by connector", async () => {
  const state = mkdtempSync(join(tmpdir(), "keel-apps-"));
  dirs.push(state);
  const s = standIn();
  try {
    const { m } = setup(state, s.url);
    // Off: nothing is asked of ChatGPT, nothing is offered to anybody.
    expect([row(m).state, row(m).enabled, row(m).bundled, row(m).tools]).toEqual(["disabled", false, "ChatGPT apps", 0]);
    expect(await mine(AGENT)).toEqual([]);
    expect(s.seen).toEqual([]);

    m.toggle(APPS_SERVER, true);
    await m.ensure(APPS_SERVER);
    // Every request carries the sign-in as a bearer token, the product and the account.
    expect(s.seen.length).toBeGreaterThan(1);
    for (const r of s.seen) expect([r.method, r.auth, r.sku, r.account]).toEqual([r.method, "Bearer tok-1", "codex", "acct_1"]);
    expect([row(m).state, row(m).tools, row(m).transport, row(m).sign_in, row(m).held]).toEqual(["ready", 7, "http", false, undefined]);

    // A session with no connector turned on has no such server: nothing searched, declared or called.
    expect(await mine(PLAIN)).toEqual([]);
    expect(catalogSources(PLAIN).some((c) => c.name === APPS_SERVER)).toBe(false);
    expect(String((await m.call(APPS_SERVER, "gmail.search_emails", {}, ctx(PLAIN, "c0"))).content)).toContain("is not turned on for this session");
    // An agent whose definition turns Gmail on is offered Gmail's tools and no other app's.
    const tools = await mine(AGENT);
    expect(tools.map((t) => t.qualified)).toEqual(["chatgpt-apps__gmail.search_emails", "chatgpt-apps__gmail.send_email", "chatgpt-apps__gmail.delete_emails", "chatgpt-apps__gmail.create_label"]);
    expect(String((await m.call(APPS_SERVER, "slack.post_message", {}, ctx(AGENT, "c1"))).content)).toContain("is not turned on for this session");
    // The owner's own lists name no session and show every tool.
    expect((await catalogTools()).filter((t) => t.server === APPS_SERVER).length).toBe(7);

    // A read is a read to the gate; every other tool is judged a write with the owner's account, whatever it names.
    const [search, send, del, label] = tools as [typeof tools[0], typeof tools[0], typeof tools[0], typeof tools[0]];
    expect([search.readOnly, search.judge]).toEqual([true, undefined]);
    for (const t of [send, del, label]) expect(t.readOnly).toBe(false);
    expect(await send.judge!({ to: "a@example.com" })).toEqual({ kind: "other", hints: { openWorld: true }, account: { server: APPS_SERVER, whole: ownWhy(TOOLS[1]!) } });
    expect(await del.judge!({})).toEqual({ kind: "other", hints: { destructive: true }, account: { server: APPS_SERVER, whole: ownWhy(TOOLS[2]!) } });
    expect(await label.judge!({ owner: "me" })).toEqual({ kind: "other", account: { server: APPS_SERVER, whole: ownWhy(TOOLS[3]!) } });

    // A call goes to the tool by its own name, with its routing and the call's id.
    const before = s.seen.length;
    const out = await search.run({ query: "from:me" }, ctx(AGENT, "call_9"));
    expect([out.is_error, String(out.content)]).toEqual([undefined, "ran gmail.search_emails"]);
    const call = s.seen.slice(before).find((r) => r.method === "tools/call")!;
    expect([call.params.name, call.params.arguments, call.params._meta?._codex_apps]).toEqual(["gmail.search_emails", { query: "from:me" }, { resource_uri: "/connector_g/link_1/search_emails", call_id: "call_9" }]);

    // The owner's list turns an app on for every session.
    expect(patchSettings({ chatgpt_apps: { connectors: ["Slack"] } }).ok).toBe(true);
    try {
      const slack = await mine(PLAIN);
      expect(slack.map((t) => t.name)).toEqual(["slack.post_message", "slack.search_public"]);
      // A read that reaches outside the app is no read to the gate, and no write with the account either: it is
      // judged as a remote server's tool that says it is open-world.
      expect([slack[1]!.readOnly, await slack[1]!.judge!({ query: "x" })]).toEqual([false, { kind: "other", hints: { openWorld: true } }]);
      expect((await mine(AGENT)).length).toBe(6);
    } finally { patchSettings({ chatgpt_apps: null }); }
    expect(patchSettings({ chatgpt_apps: { connectors: [""] } }).ok).toBe(false);

    // A restart: the kept listing is offered with no request made, and the first call connects.
    await m.keptWritten();
    m.dispose();
    const sent = s.seen.length;
    const { m: again } = setup(state, s.url);
    expect([row(again).state, row(again).enabled, row(again).tools]).toEqual(["idle", true, 7]);
    expect((await mine(AGENT)).length).toBe(4);
    expect(s.seen.length).toBe(sent);
    const tool2 = (await mine(AGENT))[0]!;
    expect(String((await tool2.run({ query: "x" }, ctx(AGENT, "call_10"))).content)).toBe("ran gmail.search_emails");
    expect(row(again).state).toBe("ready");

    // Turned off again: nothing is offered, and a start finds it off.
    again.toggle(APPS_SERVER, false);
    expect([row(again).state, row(again).tools, (await mine(AGENT)).length]).toEqual(["disabled", 0, 0]);
    again.dispose();
    expect(row(setup(state, s.url).m).state).toBe("disabled");
  } finally { s.stop(); }
});

test("a sign-in ChatGPT refuses is an error that says what to do, not a sign-in the panel offers, and the next try renews it first", async () => {
  const state = mkdtempSync(join(tmpdir(), "keel-apps-"));
  dirs.push(state);
  const s = standIn();
  try {
    s.refuse("stale");
    const { m, asked } = setup(state, s.url, ["stale", "fresh"]);
    m.toggle(APPS_SERVER, true);
    await m.ensure(APPS_SERVER).catch(() => {});
    expect([row(m).state, row(m).error, row(m).sign_in]).toEqual(["error", "ChatGPT refused the sign-in: run `codex login`, then reconnect it here", false]);
    expect(asked.every((force) => !force)).toBe(true);
    const before = asked.length;
    await m.reconnect(APPS_SERVER);
    // (Renewed once: the requests after the first ask for the sign-in as it is.)
    expect([row(m).state, asked[before], asked.slice(before + 1).some(Boolean)]).toEqual(["ready", true, false]);
  } finally { s.stop(); }
});

test("not signed in, it is missing with what to do, and is found once the sign-in is there", async () => {
  const state = mkdtempSync(join(tmpdir(), "keel-apps-"));
  dirs.push(state);
  const s = standIn();
  try {
    const m = new McpManager(sink, state, "/");
    managers.push(m);
    let signedIn = false;
    installChatgptApps(m, { available: () => signedIn, signIn: async () => ({ token: "tok-1" }), account: () => undefined, appsUrl: () => s.url });
    m.toggle(APPS_SERVER, true);
    expect([row(m).state, row(m).error]).toEqual(["missing", "not signed in to ChatGPT: run `codex login`"]);
    expect(s.seen).toEqual([]);
    signedIn = true;
    await m.reconnect(APPS_SERVER);
    expect([row(m).state, row(m).tools]).toEqual(["ready", 7]);
    expect(s.seen.every((r) => r.account === null)).toBe(true);
  } finally { s.stop(); }
});
