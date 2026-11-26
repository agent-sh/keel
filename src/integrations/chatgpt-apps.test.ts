// ChatGPT's app connectors as the server Keel brings, against a stand-in of the apps server over real HTTP: what
// it is sent (the sign-in, the product and account headers, a call's `_meta`), that it is off until turned on,
// that its listing is kept and it then holds no connection, which session is offered which connector, and how
// each kind of tool reaches the gate (a tool whose connector calls it a read against its name included), and that
// its resources and prompts are nobody's. The pure parts (what a tool is, a connector's rows) are tested with it.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSettings } from "../admin/settings.ts";
import { APPS_SERVER, appKind, appsBlock, appsHeaders, appsMissing, callMeta, connectorsOf, offeredTo, ownWhy, readName, slugOf } from "../mcp/chatgpt-apps.ts";
import type { McpTool } from "../mcp/client.ts";
import { McpManager } from "../mcp/manager.ts";
import { catalogReady, catalogSources, catalogTools } from "../tools/catalog.ts";
import { decide, type CallClass, type Facts } from "../safety/policy.ts";
import { APPS_LINE, installChatgptApps, standInSignIn } from "./chatgpt-apps.ts";

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

const named = (name: string, annotations: Record<string, boolean> = { readOnlyHint: true, openWorldHint: false }) => ({ name, annotations });

test("a tool is a read only when its connector says so outright, its name says so too, and it names no reach outside; of the rest one deletes, one sends, one writes", () => {
  expect(TOOLS.map(appKind)).toEqual(["read", "send", "delete", "write", "send", "fetch", "fetch"]);
  // A read or a fetch is nobody's account write.
  expect([ownWhy(TOOLS[0]!), ownWhy(TOOLS[6]!)]).toEqual([undefined, undefined]);
  // Nothing said, or a read hint that is not exactly true, is no read: it asks (open-world unless said otherwise, so it sends).
  expect([appKind({ name: "gmail.search_emails" }), appKind({ name: "gmail.search_emails", annotations: {} }), appKind(named("gmail.search_emails", { readOnlyHint: "true" as unknown as boolean }))]).toEqual(["send", "send", "send"]);
  // A read hint beside a destructive one is no read: it deletes.
  expect(appKind(named("gmail.search_emails", { readOnlyHint: true, destructiveHint: true }))).toBe("delete");
  expect(ownWhy(TOOLS[1]!)).toBe("sends from Gmail to people or services outside it (its connector says so), as you, through your ChatGPT account: every write through a ChatGPT app is yours to allow");
  expect(ownWhy(TOOLS[2]!)).toContain("may delete or overwrite data in Gmail");
  expect(ownWhy(TOOLS[3]!)).toContain("changes things in Gmail, as you");
});

test("a connector's read hint does not make a read of a tool whose own name does not read", () => {
  // The review's cases: tools that change things, each hinted read-only by its connector.
  for (const n of ["gmail.send_email", "gmail.create_draft_and_send", "gmail.forward_emails", "slack.post_message", "github.merge_pull_request", "linear.get_or_create_issue", "google_drive.search_and_share", "gmail.list_then_archive", "gmail.get_draft"]) {
    expect([n, readName(n), appKind(named(n))]).toEqual([n, false, "write"]);
    expect(ownWhy({ ...named(n), _meta: { connector_id: "c", connector_name: "Gmail" } })).toContain("changes things in Gmail, as you");
  }
  // With what else its connector says, it sends or deletes.
  expect([appKind(named("gmail.send_email", { readOnlyHint: true, openWorldHint: true })), appKind(named("gmail.delete_emails", { readOnlyHint: true, destructiveHint: true }))]).toEqual(["send", "delete"]);
  // A name that opens with no verb that reads is no read, whatever follows.
  for (const n of ["gmail.export_file", "github.download_artifact", "context7.query-docs", "atlassian.executeRead", "gmail.", "search_service.web_run", "x.research_topic", "x.listen"]) expect([n, readName(n)]).toEqual([n, false]);
  // Names that read: the verb first, in either spelling; a word that only holds a write verb is not that verb.
  for (const n of ["gmail.search_emails", "gmail.search_email_ids", "google_calendar.list_events", "gmail.get_labels", "linear.list_comments", "atlassian.getJiraIssue", "atlassian.searchJiraIssuesUsingJql", "github.fetch_file", "x.lookup_user", "x.view_page", "x.count_rows", "gmail.read_email_thread", "search_emails"]) expect([n, readName(n)]).toEqual([n, true]);
  // The app's name said again in front of the verb, and a word of how many, are not the verb.
  for (const n of ["slack.slack_read_channel", "slack.slack_search_public", "gmail.batch_read_email", "google_calendar.google_calendar_list_events"]) expect([n, readName(n)]).toEqual([n, true]);
  for (const n of ["slack.slack_send_message", "gmail.batch_delete_emails", "slack.slack_slack_read", "gmail.batch"]) expect([n, readName(n)]).toEqual([n, false]);
});

test("a connector is turned on by its id alone; a session is offered only the ones turned on", () => {
  expect(slugOf("AdKit - Ads Manager")).toBe("adkit_ads_manager");
  expect(TOOLS.filter(offeredTo(["connector_g"])).map((t) => t.name)).toEqual(["gmail.search_emails", "gmail.send_email", "gmail.delete_emails", "gmail.create_label"]);
  expect(TOOLS.filter(offeredTo([" asdk_app_s ", "connector_c"])).map((t) => t.name)).toEqual(["slack.post_message", "google_calendar.list_events", "slack.search_public"]);
  // Not by a name (a vendor's to choose), a prefix or another case.
  for (const n of ["Gmail", "gmail", "CONNECTOR_G", "connector", ""]) expect([n, TOOLS.filter(offeredTo([n])).length]).toEqual([n, 0]);
  // A tool that names no connector is nobody's.
  expect(offeredTo(["connector_g"])({ _meta: {} })).toBe(false);
  // (A fetch is counted apart from the reads and from what asks.)
  expect(connectorsOf(TOOLS)).toEqual([
    { id: "connector_g", name: "Gmail", prefix: "gmail", tools: 4, reads: 1, fetches: 0 },
    { id: "connector_c", name: "Google Calendar", prefix: "google_calendar", tools: 1, reads: 0, fetches: 1 },
    { id: "asdk_app_s", name: "Slack", prefix: "slack", tools: 2, reads: 0, fetches: 1 },
  ]);
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
  // (By id only: a connector of that name under another id is not the one.)
  expect(appsMissing(["Gmail"], { on: true, connectors: [{ id: "connector_g", name: "Gmail" }] })).toBe("the owner's ChatGPT account does not list Gmail");
  const block = appsBlock(["connector_g"], { on: true, connectors: [{ id: "connector_g", name: "Gmail", prefix: "gmail" }] });
  expect(block).toContain("Gmail (tools named chatgpt-apps__gmail.*)");
  // The agent may be the only one with the app: the call is not its parent's to make.
  expect(block).toContain("only in a session where the owner turned the app on");
  expect(block).not.toContain("the session that started you");
  expect(appsBlock([], { on: true })).toBe("");
});

test("a scratch daemon's stand-in of the sign-in is read only on the scripted provider, and only an address on this machine", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-apps-"));
  dirs.push(dir);
  const file = join(dir, "url");
  expect(standInSignIn({ KEEL_CHATGPT_APPS_STANDIN: file })).toBeUndefined();
  expect(standInSignIn({ KEEL_SCRIPTED_PROVIDER: "1" })).toBeUndefined();
  const by = standInSignIn({ KEEL_SCRIPTED_PROVIDER: "1", KEEL_CHATGPT_APPS_STANDIN: file })!;
  expect(by.available()).toBe(false);
  writeFileSync(file, "https://chatgpt.com/backend-api/ps/mcp\n");
  expect(by.available()).toBe(false);
  writeFileSync(file, "http://127.0.0.1:4100/ps/mcp\n");
  expect([by.available(), by.appsUrl(), by.standIn]).toEqual([true, "http://127.0.0.1:4100/ps/mcp", file]);
});

// ---- the server, against a stand-in ----

type Seen = { method: string; auth: string | null; sku: string | null; account: string | null; params?: any };
function standIn(extra: McpTool[] = []) {
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
      if (m.method === "initialize") return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "apps", version: "1" } }, { "mcp-session-id": "s1" });
      if (m.method === "tools/list") return reply({ tools: [...TOOLS, ...extra], _meta: { "openai/apps": [] } });
      if (m.method === "resources/list") return reply({ resources: [{ uri: "gmail://inbox/latest", name: "latest" }] });
      if (m.method === "resources/read") return reply({ contents: [{ uri: m.params.uri, text: "the text of a message" }] });
      if (m.method === "prompts/list") return reply({ prompts: [{ name: "digest" }] });
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

function setup(state: string, url: string, tokens: string[] = ["tok-1"], account = "acct_1") {
  const m = new McpManager(sink, state, "/");
  managers.push(m);
  const asked: boolean[] = [];
  installChatgptApps(m, {
    available: () => true,
    signIn: async (force) => { asked.push(!!force); return { token: tokens[Math.min(asked.length - 1, tokens.length - 1)]!, account }; },
    account: () => account,
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
    expect(String((await m.call(APPS_SERVER, "gmail.search_emails", {}, ctx(PLAIN, "c0"))).content)).toContain("is not a tool this session is offered: its app is not turned on for it");
    // Nor is it named in such a session's prompt; one that is offered an app gets one line of it, short enough to stay whole.
    expect((await m.configured(0, PLAIN)).some((x) => x.name === APPS_SERVER)).toBe(false);
    expect((await m.configured(0, AGENT)).find((x) => x.name === APPS_SERVER)?.instructions).toBe(APPS_LINE);
    expect(APPS_LINE.length).toBeLessThan(200);
    // An agent whose definition turns Gmail on is offered Gmail's tools and no other app's.
    const tools = await mine(AGENT);
    expect(tools.map((t) => t.qualified)).toEqual(["chatgpt-apps__gmail.search_emails", "chatgpt-apps__gmail.send_email", "chatgpt-apps__gmail.delete_emails", "chatgpt-apps__gmail.create_label"]);
    expect(String((await m.call(APPS_SERVER, "slack.post_message", {}, ctx(AGENT, "c1"))).content)).toContain("its app is not turned on for it");
    // A name the server does not list is not sent to it either.
    const unlisted = s.seen.length;
    expect(String((await m.call(APPS_SERVER, "gmail.empty_trash", {}, ctx(AGENT, "c2"))).content)).toContain("the server lists no tool of that name");
    expect(s.seen.length).toBe(unlisted);
    // The owner's page gets the apps with what each reads, not a name a tool.
    expect([row(m).tool_names, (row(m) as any).apps]).toEqual([[], { connectors: connectorsOf(TOOLS), on: [] }]);
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
    // (By its id: its name turns nothing on.)
    expect(patchSettings({ chatgpt_apps: { connectors: ["Slack"] } }).ok).toBe(true);
    expect(await mine(PLAIN)).toEqual([]);
    expect(patchSettings({ chatgpt_apps: { connectors: ["asdk_app_s"] } }).ok).toBe(true);
    try {
      expect((row(m) as any).apps.on).toEqual(["asdk_app_s"]);
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
    // (Asleep, its resources are still nobody's: nothing is started to say so.)
    expect(row(again).resources).toBe(false);
    expect((await mine(AGENT)).length).toBe(4);
    expect(s.seen.length).toBe(sent);
    const tool2 = (await mine(AGENT))[0]!;
    expect(String((await tool2.run({ query: "x" }, ctx(AGENT, "call_10"))).content)).toBe("ran gmail.search_emails");
    expect(row(again).state).toBe("ready");

    // The kept listing and its pin are the account's they were listed with: signed in as another, nothing is
    // offered from them, and that account's listing is taken and accepted anew.
    await again.keptWritten();
    again.dispose();
    const { m: other } = setup(state, s.url, ["tok-2"], "acct_2");
    expect([row(other).state, row(other).tools, (await catalogReady(undefined, AGENT)).filter((t) => t.server === APPS_SERVER).length]).toEqual(["connecting", 0, 0]);
    await other.ensure(APPS_SERVER);
    expect([row(other).state, row(other).tools, row(other).held, (await mine(AGENT)).length]).toEqual(["ready", 7, undefined, 4]);
    await other.keptWritten();
    other.dispose();
    const { m: back } = setup(state, s.url);
    expect(row(back).state).toBe("connecting");
    back.dispose();
    const { m: again2 } = setup(state, s.url, ["tok-2"], "acct_2");
    expect([row(again2).state, row(again2).tools]).toEqual(["idle", 7]);

    // Turned off again: nothing is offered, and a start finds it off.
    again2.toggle(APPS_SERVER, false);
    expect(row(again2).state).toBe("disabled");
    again2.dispose();
    const off = setup(state, s.url).m;
    expect([row(off).state, row(off).tools, (await mine(AGENT)).length, (row(off) as any).apps]).toEqual(["disabled", 0, 0, undefined]);
  } finally { s.stop(); }
});

// The review's case: a connector that calls a tool that sends a read. In every mode it is the owner's card, an
// agent is refused it, and nothing of it runs as a read.
test("a tool its connector calls read-only against its name is the owner's card in every mode, and an agent is refused it", async () => {
  const state = mkdtempSync(join(tmpdir(), "keel-apps-"));
  dirs.push(state);
  const LIES = [
    tool("gmail.send_email_now", GMAIL, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("gmail.purge_emails", GMAIL, { readOnlyHint: true, destructiveHint: true }),
    tool("gmail.create_draft_and_send", GMAIL, { readOnlyHint: true }),
  ];
  const s = standIn(LIES);
  try {
    const { m } = setup(state, s.url);
    m.toggle(APPS_SERVER, true);
    await m.ensure(APPS_SERVER);
    const tools = await mine(AGENT);
    const facts = (mode: Facts["mode"], agent: boolean, t: string): Facts => ({ mode, workspace: "/w", sandboxed: false, rules: [], tool: t, home: "/home/u", ...(agent ? { agent: true } : {}), accounts: { names: [], ...(agent ? { agent: true } : {}) } } as Facts);
    const how = (d: any) => ("allow" in d ? "allow" : "deny" in d ? "deny" : `ask(${d.ask.ownerOnly ? "owner only, " : ""}${d.ask.risk})`);
    // (src/safety/gate.ts: a tool's class is its judge's, else a read's when it is one.)
    const cls = async (t: (typeof tools)[number]): Promise<CallClass> => (t.judge ? await t.judge({ to: "stranger@example.net" }) : t.readOnly ? ({ kind: "read", unnamed: true } as unknown as CallClass) : { kind: "other" });
    for (const name of LIES.map((t) => t.name)) {
      const t = tools.find((x) => x.name === name)!;
      expect([name, t.readOnly, !!t.judge]).toEqual([name, false, true]);
      const c = await cls(t);
      expect((c as any).account?.whole).toContain("as you, through your ChatGPT account");
      for (const mode of ["ask", "auto-edits", "auto", "reviewer", "full-auto"] as Facts["mode"][]) expect([name, mode, how(decide(c, facts(mode, false, t.qualified)))]).toEqual([name, mode, "ask(owner only, high)"]);
      for (const mode of ["read-only", "plan"] as Facts["mode"][]) expect([name, mode, how(decide(c, facts(mode, false, t.qualified)))]).toEqual([name, mode, "deny"]);
      const agent = decide(c, facts("full-auto", true, t.qualified)) as { deny: string };
      expect(agent.deny).toContain("only in a session where the owner turned the app on");
      expect(agent.deny).not.toContain("the session that started you");
    }
    // The tool that does read still runs as a read.
    const search = tools.find((x) => x.name === "gmail.search_emails")!;
    expect([search.readOnly, search.judge]).toEqual([true, undefined]);
    // (One of the lies is counted with what asks, on the owner's page too.)
    expect((row(m) as any).apps.connectors.find((c: any) => c.id === "connector_g")).toEqual({ id: "connector_g", name: "Gmail", prefix: "gmail", tools: 7, reads: 1, fetches: 0 });
  } finally { s.stop(); }
});

// The review's case: the built-in resource and prompt tools (mcp__list_resources, mcp__read_resource, the slash
// menu's prompts) named at the apps server, from a session with no connector. They go through these.
test("its resources and prompts are nobody's: nothing of them is asked of ChatGPT, for a session or the page", async () => {
  const state = mkdtempSync(join(tmpdir(), "keel-apps-"));
  dirs.push(state);
  const s = standIn();
  try {
    const { m } = setup(state, s.url);
    m.toggle(APPS_SERVER, true);
    await m.ensure(APPS_SERVER);
    const before = s.seen.length;
    const said = "ChatGPT apps offers its tools only: its resources and prompts are not reached through Keel";
    await expect(m.resources(APPS_SERVER)).rejects.toThrow(said);
    await expect(m.readResource(APPS_SERVER, "gmail://inbox/latest")).rejects.toThrow(said);
    await expect(m.prompts(APPS_SERVER)).rejects.toThrow(said);
    await expect(m.getPrompt(APPS_SERVER, "digest", {})).rejects.toThrow(said);
    await expect(m.complete(APPS_SERVER, { type: "ref/prompt", name: "digest" }, { name: "a", value: "" })).rejects.toThrow(said);
    await expect(m.readApp(APPS_SERVER, "ui://gmail/app")).rejects.toThrow(said);
    expect([await m.capable("resources"), await m.capable("prompts"), await m.allPrompts()]).toEqual([[], [], []]);
    expect([row(m).resources, row(m).prompts]).toEqual([false, false]);
    expect(s.seen.slice(before).map((r) => r.method)).toEqual([]);
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
    expect([row(m).state, row(m).error, row(m).sign_in]).toEqual(["error", "ChatGPT refused the sign-in. The next call renews it by itself; if that one is refused too, run `codex login`", false]);
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

test("an absent open-world hint, a name of a page or an address, a look-alike letter or a verb that changes things is no plain read", () => {
  // The MCP default for an absent openWorldHint is open-world: a read of that kind is a fetch, judged as a remote tool.
  for (const n of ["web.fetch_url", "x.read_url", "x.get_webpage", "x.search_items"]) expect([n, appKind(named(n, { readOnlyHint: true }))]).toEqual([n, "fetch"]);
  // Said to be closed, a name of an address still reads from outside.
  expect(appKind(named("x.get_page", { readOnlyHint: true, openWorldHint: false }))).toBe("fetch");
  expect(appKind(named("gmail.search_emails", { readOnlyHint: true, openWorldHint: false }))).toBe("read");
  // The review's names that open with a read verb and change things.
  for (const n of ["x.check_item", "x.check_out", "x.fetch_and_run", "x.get_and_clear_notifications", "gmail.get_resend", "x.list_and_sync", "x.get_or_save"]) expect([n, readName(n)]).toEqual([n, false]);
  // A letter outside ASCII can stand for a Latin one: never a read.
  expect(readName("gmail.get_s\u0435nd")).toBe(false);
});

test("a name that joins two acts is never a read, and a send its connector did not call open-world says so", () => {
  for (const n of ["x.get_and_email", "x.find_and_order", "x.view_and_sign", "x.get_and_refund", "x.search_and_destroy", "x.find_or_create", "x.list_then_archive"]) {
    expect([n, readName(n), appKind(named(n))]).toEqual([n, false, "write"]);
  }
  // The nouns a read names stay reads.
  for (const n of ["gmail.get_email", "x.list_orders", "slack.read_message", "x.get_booking"]) expect([n, readName(n)]).toEqual([n, true]);
  // More words of an address: a fetch even when said closed.
  for (const n of ["x.lookup_domain", "x.get_site", "x.read_uri"]) expect([n, appKind(named(n))]).toEqual([n, "fetch"]);
  // A name that is no string is no read, and does not throw.
  expect(appKind({ name: 7 as unknown as string, annotations: { readOnlyHint: true, openWorldHint: false } })).toBe("write");
  const quiet = { name: "gmail.batch_modify", annotations: { readOnlyHint: false }, _meta: { connector_id: "c", connector_name: "Gmail" } };
  expect(ownWhy(quiet)).toContain("may reach people or services outside Gmail (its connector does not say it stays inside)");
  expect(ownWhy(quiet)).not.toContain("its connector says so");
});
