// The owner's ChatGPT app connectors as a server Keel brings (src/mcp/chatgpt-apps.ts says what it is and how
// Codex reaches it). It signs in with the ChatGPT sign-in Keel already holds for the plan's models
// (src/providers/codex.ts: the same file, the same renewal), so it is off until the owner turns it on in
// Customize > MCP servers: using that sign-in for his mail, calendar and files is his to decide. Once on:
// - its listing is the server's own, kept and pinned like an owner's server's, and it holds no connection until
//   a call needs one;
// - a session is offered the connectors turned on for it: the owner's list (`chatgpt_apps.connectors`, by
//   connector id, none by default) for every session, and the ones an agent's definition turns on for that agent;
// - a tool that only reads the app (its connector says so and its name does: src/mcp/chatgpt-apps.ts appKind)
//   runs as a read; one that reads from outside it is judged as a remote server's tool; every other is the
//   owner's card in every mode, and an agent is refused it (src/safety/policy.ts);
// - only its tools are reached, never its resources or prompts;
// - each request is a row of the egress table like any remote server's (the fetch tap, under the call's label).
import { readFileSync } from "node:fs";
import { registerSettings, settings } from "../admin/settings.ts";
import type { McpTool } from "../mcp/client.ts";
import { APPS_LABEL, APPS_SERVER, appReads, appsHeaders, appsNow, callMeta, connectorsOf, offeredTo, ownWhy, type ConnectorRow } from "../mcp/chatgpt-apps.ts";
import type { McpManager } from "../mcp/manager.ts";

registerSettings("chatgpt_apps", { connectors: [] as string[] }, (v) => {
  const list = v.connectors;
  if (!Array.isArray(list) || list.length > 200) return "connectors is a list of at most 200 connector ids";
  for (const c of list) if (typeof c !== "string" || !c.trim() || c.length > 120) return `${JSON.stringify(c)} is not a connector id`;
  return undefined;
});

// The sign-in, as the provider that holds it gives it.
export type AppsSignIn = {
  available(): boolean;
  signIn(force?: boolean): Promise<{ token: string; account?: string }>;
  account(): string | undefined;
  appsUrl(): string;
  // A scratch daemon's stand-in: the file its address is read from.
  standIn?: string;
};

const MISSING = "not signed in to ChatGPT: run `codex login`";
// (The request after a refusal renews the sign-in by itself, so a token that ran out costs one failed call.)
const REFUSED = "ChatGPT refused the sign-in. The next call renews it by itself; if that one is refused too, run `codex login`";
// One line of the prompt of a session that is offered an app (under the 200 characters a server's line is cut at).
export const APPS_LINE = "ChatGPT apps the owner turned on for this session: find a tool by the app's name. One that only reads the app runs; one that changes or sends anything asks the owner.";

// A scratch daemon's stand-in of the sign-in (scripts/scratch-env.ts): the file holds the address of a stand-in
// server on this machine that a spec started. Read only by a daemon on the scripted provider, never the owner's.
export function standInSignIn(env: Record<string, string | undefined> = process.env): AppsSignIn | undefined {
  const file = env.KEEL_CHATGPT_APPS_STANDIN;
  if (env.KEEL_SCRIPTED_PROVIDER !== "1" || !file) return undefined;
  const url = () => { try { const u = readFileSync(file, "utf8").trim(); return /^http:\/\/127\.0\.0\.1:\d+\/\S*$/.test(u) ? u : undefined; } catch { return undefined; } };
  return { standIn: file, available: () => !!url(), signIn: async () => ({ token: "stand-in" }), account: () => "stand-in", appsUrl: () => url() ?? "" };
}

// `agentApps`: the connectors an agent's definition turns on, by its session (none for a session that is no agent).
export function installChatgptApps(m: McpManager, by: AppsSignIn, agentApps: (session: string) => readonly string[] | undefined = () => undefined) {
  const config = () => (by.available() ? { url: by.appsUrl() } : null);
  // A request ChatGPT refused: the next one asks for the sign-in renewed first, once.
  let renew = false;
  // Which tools a list of connectors offers, kept per list.
  const picks = new Map<string, (tool: McpTool) => boolean>();
  const offers = (session: string) => {
    const on = [...(settings().chatgpt_apps.connectors as string[]), ...(agentApps(session) ?? [])];
    if (!on.length) return "none" as const;
    const key = on.join("\u0000");
    let pick = picks.get(key);
    if (!pick) { if (picks.size > 64) picks.clear(); picks.set(key, (pick = offeredTo(on))); }
    return pick;
  };
  // Whose sign-in it is, for what the listing is kept and pinned under: asked of the provider (it reads its file)
  // at most once in five seconds, since the owner's page asks at every poll.
  let who: { at: number; id: string } | undefined;
  const account = () => {
    const now = Date.now();
    if (!who || now - who.at > 5_000) who = { at: now, id: by.account() ?? "" };
    return who.id;
  };
  // The connectors of the listing, counted once a listing.
  let listed: { from: readonly McpTool[]; rows: ConnectorRow[] } | undefined;
  const rows = (tools: readonly McpTool[]): ConnectorRow[] => {
    if (listed?.from !== tools) listed = { from: tools, rows: connectorsOf(tools) };
    return listed.rows;
  };
  m.addBundled(APPS_SERVER, {
    label: APPS_LABEL,
    config: config(),
    configure: config,
    missing: MISSING,
    instructions: APPS_LINE,
    tools: [],
    reads: () => false,
    optIn: true,
    remote: {
      token: async () => { const force = renew; renew = false; return (await by.signIn(force)).token; },
      headers: () => appsHeaders(by.account()),
      reads: appReads,
      account: ownWhy,
      meta: callMeta,
      offers,
      refused: () => { renew = true; return REFUSED; },
      ident: account,
      shown: (tools, on) => ({
        ...(on ? { apps: { connectors: rows(tools), on: [...(settings().chatgpt_apps.connectors as string[])] } } : {}),
        ...(by.standIn ? { stand_in: by.standIn } : {}),
      }),
    },
  });
  // What an agent definition that turns a connector on is decided by (src/automation/codex-agent.ts).
  appsNow.of = () => {
    const state = m.stateOf(APPS_SERVER);
    const on = state !== undefined && state !== "disabled" && state !== "missing";
    const tools = on ? m.toolsOf(APPS_SERVER) : [];
    return { on, ...(state === "missing" ? { why: MISSING } : {}), ...(tools.length ? { connectors: rows(tools) } : {}) };
  };
}
