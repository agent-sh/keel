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
// turns it on. A read is a tool whose connector says readOnlyHint, whose own name says so too (`appKind`), and
// that does not reach outside the app (openWorldHint): a search of the web, or of what strangers wrote, carries
// the call's words there, so it is judged as any tool of a remote server (a card in the asking modes, the
// provenance rule on what it names).
// Every tool that is no read at all writes with the owner's account in someone else's service, so it is his
// to allow in every mode (src/safety/policy.ts, the account rule). A session is offered a connector only where it is turned on: the
// owner's list for every session (`chatgpt_apps.connectors`), an agent file's `apps` table for its agent, both by
// connector id. Only its tools are reached: its resources and prompts are no connector's, so nobody's.
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

// What a tool does. A connector's annotations are its vendor's word, and a wrong one would let a send run as a read,
// so a read needs three things to agree: the connector says readOnlyHint, it does not say destructiveHint, and the
// tool's own name (what follows `<app>.`) opens with a verb that reads and holds no verb that changes anything, as
// a whole word. Such a tool is a fetch when its connector calls it open-world (it reads, from outside the app).
// Everything else changes things: one its connector calls destructive deletes, one it calls open-world sends, any
// other writes. A read whose name does not pass is a write here: the cost of a wrong guess is a card, never a send.
export type AppKind = "read" | "fetch" | "write" | "send" | "delete";
// (Not "check": check_out and check_item change things.)
const READS = new Set(["search", "list", "get", "read", "find", "fetch", "lookup", "view", "count"]);
const WRITES = new Set([
  "send", "create", "update", "delete", "post", "reply", "share", "forward", "draft", "add", "remove", "set", "edit", "move",
  "archive", "upload", "invite", "comment", "assign", "approve", "merge", "close", "schedule", "cancel", "label", "mark", "apply",
  // (Beside the reviewed list: other words a tool that changes things is named with, and that a read's name rarely holds.)
  "write", "insert", "replace", "rename", "duplicate", "trash", "restore", "publish", "submit", "execute", "trigger", "enable",
  "disable", "grant", "revoke", "accept", "decline", "respond", "react", "subscribe", "unsubscribe", "join", "leave", "resolve",
  "reopen", "transfer", "pay", "purchase", "run", "clear", "purge", "reset", "buy", "import", "sync", "save", "put", "patch",
  "push", "start", "stop", "complete", "toggle", "modify", "change", "copy", "clone", "deploy", "generate", "confirm", "reject",
  "dismiss", "notify", "resend",
  // (Not email, message, call, order, book or sign: a read names them as things, get_email or list_order.)
]);
// Words of a tool that reads a page or an address it is given: a fetch whatever its connector says of the open world.
const WEB = new Set(["url", "urls", "uri", "web", "http", "https", "link", "links", "href", "page", "pages", "webpage", "site", "website", "domain"]);
// Words that say how many, in front of the verb (`batch_read_email`): not the verb.
const MANY = new Set(["batch", "bulk", "multi"]);
// A name as its words: split where it is not a letter or a digit, and where a lower-case letter meets an upper-case one.
export const nameWords = (name: string): string[] =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// The words of a tool's own name: what follows the app's prefix (`gmail.search_emails` is search, emails), without
// the app's name said again in front (`slack.slack_read_channel` is read, channel) and without a word of how many.
function ownWords(name: string): string[] {
  if (typeof name !== "string") return [];
  const dot = name.indexOf(".");
  const app = dot < 0 ? [] : nameWords(name.slice(0, dot));
  let words = nameWords(dot < 0 ? name : name.slice(dot + 1));
  if (app.length && words.length > app.length && app.every((w, i) => words[i] === w)) words = words.slice(app.length);
  while (words.length > 1 && MANY.has(words[0]!)) words = words.slice(1);
  return words;
}
export function readName(name: string): boolean {
  // A name with a letter outside ASCII can hide a write verb behind a look-alike letter: never a read.
  if (/[^\x00-\x7f]/.test(name)) return false;
  const words = ownWords(name);
  // A name that joins two acts (get_and_email, find_or_create, list_then_archive) does more than read, whatever its words.
  if (words.some((w) => w === "and" || w === "or" || w === "then")) return false;
  return words.length > 0 && READS.has(words[0]!) && !words.some((w) => WRITES.has(w));
}
type Judged = Pick<McpTool, "name" | "annotations">;
export function appKind(tool: Judged): AppKind {
  const a = tool.annotations ?? {};
  // An absent openWorldHint means open-world (the MCP default, and how Codex reads it).
  const open = a.openWorldHint !== false || ownWords(tool.name).some((w) => WEB.has(w));
  if (a.readOnlyHint === true && a.destructiveHint !== true && readName(tool.name)) return open ? "fetch" : "read";
  if (a.destructiveHint === true) return "delete";
  if (open) return "send";
  return "write";
}
export const appReads = (tool: Judged) => appKind(tool) === "read";

// Why a call that changes things is the owner's to allow whatever it names, as the gate says it after the tool's
// name; nothing for a tool that only reads or fetches.
export function ownWhy(tool: Pick<McpTool, "name" | "annotations" | "_meta">): string | undefined {
  const app = connectorOf(tool)?.name ?? "an app";
  const kind = appKind(tool);
  if (kind === "read" || kind === "fetch") return undefined;
  const does = kind === "delete" ? `may delete or overwrite data in ${app} (its connector says so)`
    : kind === "send" ? (tool.annotations?.openWorldHint === true ? `sends from ${app} to people or services outside it (its connector says so)` : `may reach people or services outside ${app} (its connector does not say it stays inside)`)
    : `changes things in ${app}`;
  return `${does}, as you, through your ChatGPT account: every write through a ChatGPT app is yours to allow`;
}

// What goes back with a call as its `_meta`: the tool's own `_codex_apps`, with the call's id.
export function callMeta(tool: Pick<McpTool, "_meta"> | undefined, callId?: string): Record<string, unknown> | undefined {
  const own = tool?._meta?._codex_apps;
  if (!own || typeof own !== "object" || Array.isArray(own)) return undefined;
  return { _codex_apps: { ...(own as Record<string, unknown>), ...(callId ? { call_id: callId } : {}) } };
}

// The connectors of a listing, by name, each with how its tools are prefixed, how many it has and how many only
// read, how many read from outside the app (a fetch: judged as any remote server's tool), the rest the owner's to allow.
export type ConnectorRow = Connector & { prefix: string; tools: number; reads: number; fetches: number };
export function connectorsOf(tools: readonly McpTool[]): ConnectorRow[] {
  const by = new Map<string, ConnectorRow>();
  for (const t of tools) {
    const c = connectorOf(t);
    if (!c) continue;
    const dot = t.name.indexOf(".");
    const row = by.get(c.id) ?? { ...c, prefix: dot > 0 ? t.name.slice(0, dot) : slugOf(c.name), tools: 0, reads: 0, fetches: 0 };
    row.tools++;
    const kind = appKind(t);
    if (kind === "read") row.reads++;
    else if (kind === "fetch") row.fetches++;
    by.set(c.id, row);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// Which tools a session is offered: those of the connectors turned on for it, each named by its id (a name is the
// vendor's to choose, and two connectors may share one). A tool of no connector is offered to none.
export function offeredTo(on: readonly string[]): (tool: Pick<McpTool, "_meta">) => boolean {
  const ids = new Set(on.map((id) => id.trim()).filter(Boolean));
  return (tool) => { const c = connectorOf(tool); return !!c && ids.has(c.id); };
}

// What is known of the server now, for what decides without it (an agent file that turns a connector on).
// `connectors`: the ones the account lists, when a listing was taken; none yet otherwise.
export type AppsNow = { on: boolean; why?: string; connectors?: (Connector & { prefix?: string })[] };
export const appsNow: { of?: () => AppsNow } = {};

// Whether the connectors a definition turns on are reached here: nothing when they are, else why not (a clause).
export function appsMissing(ids: readonly string[], now: AppsNow | undefined): string | undefined {
  if (!now?.on) return `Keel reaches ChatGPT apps only once the owner turns them on in Customize > MCP servers${now?.why ? ` (${now.why})` : ""}`;
  if (!now.connectors) return undefined;
  const gone = ids.filter((id) => !now.connectors!.some((c) => c.id === id.trim()));
  return gone.length ? `the owner's ChatGPT account does not list ${gone.join(", ")}` : undefined;
}

// What an agent whose definition turns connectors on is told in its task: which apps, and how their tools are named.
export function appsBlock(ids: readonly string[], now: AppsNow | undefined): string {
  if (!ids.length) return "";
  const apps = (now?.connectors ?? []).filter((c) => ids.some((id) => id.trim() === c.id));
  const names = apps.length ? apps.map((c) => `${c.name} (tools named ${APPS_SERVER}__${c.prefix ?? slugOf(c.name)}.*)`).join(", ") : `the ones your definition names (tools named ${APPS_SERVER}__<app>.*)`;
  return `ChatGPT apps your definition turns on: ${names}. Find a tool with tool search by the app's name. A tool that only reads the app runs; any tool that writes, sends or deletes is the owner's to allow: you are refused it, so say in your report exactly what you wanted to send or change. It can be made only in a session where the owner turned the app on, and he answers its card there.`;
}
