// The owner's ChatGPT app connectors as a server Keel brings (src/mcp/chatgpt-apps.ts says what it is and how
// Codex reaches it). It signs in with the ChatGPT sign-in Keel already holds for the plan's models
// (src/providers/codex.ts: the same file, the same renewal), so it is off until the owner turns it on in
// Customize > MCP servers: using that sign-in for his mail, calendar and files is his to decide. Once on:
// - its listing is the server's own, kept and pinned like an owner's server's, and it holds no connection until
//   a call needs one;
// - a session is offered the connectors turned on for it: the owner's list (`chatgpt_apps.connectors`, by name
//   or id, none by default) for every session, and the ones an agent's definition turns on for that agent;
// - a tool whose connector says it only reads the app runs as a read; one that reads from outside it is judged as
//   a remote server's tool; every other is the owner's card in every mode, and an agent is refused it
//   (src/safety/policy.ts);
// - each request is a row of the egress table like any remote server's (the fetch tap, under the call's label).
import { registerSettings, settings } from "../admin/settings.ts";
import type { McpTool } from "../mcp/client.ts";
import { APPS_LABEL, APPS_SERVER, appReads, appsHeaders, appsNow, callMeta, connectorsOf, offeredTo, ownWhy, type Connector } from "../mcp/chatgpt-apps.ts";
import type { McpManager } from "../mcp/manager.ts";

registerSettings("chatgpt_apps", { connectors: [] as string[] }, (v) => {
  const list = v.connectors;
  if (!Array.isArray(list) || list.length > 200) return "connectors is a list of at most 200 app names or connector ids";
  for (const c of list) if (typeof c !== "string" || !c.trim() || c.length > 120) return `${JSON.stringify(c)} is not an app's name or connector id`;
  return undefined;
});

// The sign-in, as the provider that holds it gives it.
export type AppsSignIn = {
  available(): boolean;
  signIn(force?: boolean): Promise<{ token: string; account?: string }>;
  account(): string | undefined;
  appsUrl(): string;
};

const MISSING = "not signed in to ChatGPT: run `codex login`";
const REFUSED = "ChatGPT refused the sign-in: run `codex login`, then reconnect it here";

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
  m.addBundled(APPS_SERVER, {
    label: APPS_LABEL,
    config: config(),
    configure: config,
    missing: MISSING,
    // (One line of every session's prompt while it is on: a session with no app turned on finds none.)
    instructions: "ChatGPT apps the owner turned on for this session, if any (mail, calendar, files, chat, trackers): search for a tool by the app's name. A tool that only reads the app runs; any that changes or sends something asks the owner.",
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
    },
  });
  // What an agent definition that turns a connector on is decided by (src/automation/codex-agent.ts).
  let listed: { from: readonly McpTool[]; connectors: Connector[] } | undefined;
  appsNow.of = () => {
    const state = m.stateOf(APPS_SERVER);
    const on = state !== undefined && state !== "disabled" && state !== "missing";
    const tools = on ? m.toolsOf(APPS_SERVER) : [];
    if (tools.length && listed?.from !== tools) listed = { from: tools, connectors: connectorsOf(tools as McpTool[]).map(({ id, name }) => ({ id, name })) };
    return { on, ...(state === "missing" ? { why: MISSING } : {}), ...(tools.length ? { connectors: listed!.connectors } : {}) };
  };
}
