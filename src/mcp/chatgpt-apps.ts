// ChatGPT's app connectors (Gmail, Calendar, Drive, Slack, GitHub, Linear...) as Keel offers them. The backend
// serves what an account connects as one MCP server, which Codex reaches as its built-in `codex_apps` server
// (read from codex-rs at rust-v0.172.0):
// - Streamable HTTP at <backend-api>/ps/mcp, signed in with the ChatGPT sign-in as a bearer token, the account
//   id and `X-OpenAI-Product-Sku` (codex-mcp/src/mcp/mod.rs codex_apps_mcp_server_config, mcp_server_config_for_url);
// - tools/list names every tool of every connector the account has, each with its connector in `_meta`
//   (`connector_id`, `connector_name`) and a `_codex_apps` object that goes back with a call as its `_meta`,
//   the call's id added (core/src/mcp_tool_call.rs build_mcp_tool_call_request_meta);
// - a tool whose annotations say readOnlyHint runs with no approval, any other asks when it is destructive or
//   open-world, each taken as true when not said (requires_mcp_tool_approval). A connector is on unless the
//   config says `[apps.<id>] enabled = false`, and an agent file's `apps` table turns one on for its agent
//   (connectors/src/app_tool_policy.rs app_is_enabled).
//
// Keel's reading of it: the server is one Keel brings (src/integrations/chatgpt-apps.ts), off until the owner
// turns it on. A read is a tool whose connector says readOnlyHint and does not say it reaches outside the app
// (openWorldHint): a search of the web, or of what strangers wrote, carries the call's words there, so it is
// judged as any tool of a remote server (a card in the asking modes, the provenance rule on what it names).
// Every tool that is no read at all writes with the owner's account in someone else's service, so it is his
// to allow in every mode (src/safety/policy.ts, the account rule). A session is offered a connector only where it is turned on: the
// owner's list for every session (`chatgpt_apps.connectors`), an agent file's `apps` table for its agent.
// Pure: what a tool is, which a session is offered, what goes with a call.
import type { McpTool } from "./client.ts";

export const APPS_SERVER = "chatgpt-apps";
export const APPS_LABEL = "ChatGPT apps";
// The product the request is for, as Codex names itself to the apps server (DEFAULT_CODEX_APPS_MCP_PRODUCT_SKU).
const PRODUCT_SKU = "codex";

// What goes with every request beside the bearer token. `account`: the ChatGPT account the sign-in is for.
export const appsHeaders = (account?: string): Record<string, string> =>
  ({ "X-OpenAI-Product-Sku": PRODUCT_SKU, originator: "keel", ...(account ? { "chatgpt-account-id": account } : {}) });

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export type Connector = { id: string; name: string };
// The connector a tool belongs to, as its listing says; a tool that names none is nobody's.
export function connectorOf(tool: Pick<McpTool, "_meta">): Connector | undefined {
  const id = text(tool._meta?.connector_id);
  return id ? { id, name: text(tool._meta?.connector_name) ?? text(tool._meta?.connector_display_name) ?? id } : undefined;
}

// A connector's name as its tools are prefixed (Codex's sanitize_name): "Google Calendar" is google_calendar.
export const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// What a tool does, from its connector's own annotations. Only an outright readOnlyHint makes a read, and one
// its connector calls open-world is a fetch: it reads, from outside the app. Of the rest, one its connector calls
// destructive deletes, one it calls open-world sends, any other writes.
export type AppKind = "read" | "fetch" | "write" | "send" | "delete";
export function appKind(tool: Pick<McpTool, "annotations">): AppKind {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === true) return a.openWorldHint === true ? "fetch" : "read";
  if (a.destructiveHint === true) return "delete";
  if (a.openWorldHint === true) return "send";
  return "write";
}
export const appReads = (tool: Pick<McpTool, "annotations">) => appKind(tool) === "read";

// Why a call that changes things is the owner's to allow whatever it names, as the gate says it after the tool's
// name; nothing for a tool that only reads or fetches.
export function ownWhy(tool: Pick<McpTool, "annotations" | "_meta">): string | undefined {
  const app = connectorOf(tool)?.name ?? "an app";
  const kind = appKind(tool);
  if (kind === "read" || kind === "fetch") return undefined;
  const does = kind === "delete" ? `may delete or overwrite data in ${app} (its connector says so)`
    : kind === "send" ? `sends from ${app} to people or services outside it (its connector says so)`
    : `changes things in ${app}`;
  return `${does}, as you, through your ChatGPT account: every write through a ChatGPT app is yours to allow`;
}

// What goes back with a call as its `_meta`: the tool's own `_codex_apps`, with the call's id.
export function callMeta(tool: Pick<McpTool, "_meta"> | undefined, callId?: string): Record<string, unknown> | undefined {
  const own = tool?._meta?._codex_apps;
  if (!own || typeof own !== "object" || Array.isArray(own)) return undefined;
  return { _codex_apps: { ...(own as Record<string, unknown>), ...(callId ? { call_id: callId } : {}) } };
}

// The connectors of a listing, by name, each with how many tools it has and how many only read.
export function connectorsOf(tools: readonly McpTool[]): (Connector & { tools: number; reads: number })[] {
  const by = new Map<string, Connector & { tools: number; reads: number }>();
  for (const t of tools) {
    const c = connectorOf(t);
    if (!c) continue;
    const row = by.get(c.id) ?? { ...c, tools: 0, reads: 0 };
    row.tools++;
    if (appReads(t)) row.reads++;
    by.set(c.id, row);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// Whether a connector is one of the ones named: by its id, its name or its name as its tools are prefixed, case aside.
export function named(c: Connector, names: Iterable<string>): boolean {
  const keys = new Set([c.id.toLowerCase(), c.name.toLowerCase(), slugOf(c.name)]);
  for (const n of names) { const k = n.trim().toLowerCase(); if (k && (keys.has(k) || keys.has(slugOf(k)))) return true; }
  return false;
}

// Which tools a session is offered: those of the connectors turned on for it (each connector asked once). A tool of
// no connector is offered to none.
export function offeredTo(on: readonly string[]): (tool: Pick<McpTool, "_meta">) => boolean {
  const seen = new Map<string, boolean>();
  return (tool) => {
    const c = connectorOf(tool);
    if (!c) return false;
    let is = seen.get(c.id);
    if (is === undefined) seen.set(c.id, (is = named(c, on)));
    return is;
  };
}

// What is known of the server now, for what decides without it (an agent file that turns a connector on).
// `connectors`: the ones the account lists, when a listing was taken; none yet otherwise.
export type AppsNow = { on: boolean; why?: string; connectors?: Connector[] };
export const appsNow: { of?: () => AppsNow } = {};

// Whether the connectors a definition turns on are reached here: nothing when they are, else why not (a clause).
export function appsMissing(ids: readonly string[], now: AppsNow | undefined): string | undefined {
  if (!now?.on) return `Keel reaches ChatGPT apps only once the owner turns them on in Customize > MCP servers${now?.why ? ` (${now.why})` : ""}`;
  if (!now.connectors) return undefined;
  const gone = ids.filter((id) => !now.connectors!.some((c) => named(c, [id])));
  return gone.length ? `the owner's ChatGPT account does not list ${gone.join(", ")}` : undefined;
}

// What an agent whose definition turns connectors on is told in its task: which apps, and how their tools are named.
export function appsBlock(ids: readonly string[], now: AppsNow | undefined): string {
  if (!ids.length) return "";
  const apps = (now?.connectors ?? []).filter((c) => named(c, ids));
  const names = apps.length ? apps.map((c) => `${c.name} (tools named ${APPS_SERVER}__${slugOf(c.name)}.*)`).join(", ") : `the ones your definition names (tools named ${APPS_SERVER}__<app>.*)`;
  return `ChatGPT apps your definition turns on: ${names}. Find a tool with tool search by the app's name. A tool that only reads the app runs; any tool that writes, sends or deletes is the owner's to allow: you are refused it, so say in your report exactly what you wanted to send, and the session that started you makes the call.`;
}
