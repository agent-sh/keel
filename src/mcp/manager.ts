// One MCP manager per daemon: the configured servers, their connections and
// states, and one catalog source per server so search_tools finds their tools.
// Servers connect in the background after startup and on first use; a reload
// restarts only the servers whose config changed, and never touches a session's
// request prefix (MCP tools are deferred, so the eager tool list is fixed).
import { fitReport, type SchemaFitRow } from "../providers/wires/schema-fit.ts";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { rename as renameAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { basename, dirname, join } from "node:path";
import { spelled } from "../safety/chars.ts";
import { detached, type ErrorTracker } from "../core/errors.ts";
import { registerCatalog, unregisterCatalog, type CatalogTool } from "../tools/catalog.ts";
import type { CallClass } from "../safety/policy.ts";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import { networkFailure, RETRY, retryDelay } from "./retry.ts";
import { AuthRequired, McpAuthorizationError, McpClient, RpcError, SessionExpired, type InputHandler, type InputRequest, type McpCallResult, type McpTool, type Transport } from "./client.ts";
import { formOf, linkOf, linksRequired, plain, URL_REQUIRED, type ElicitResult } from "./elicit.ts";
import { cardText, samplingOf, stopReason, type SampleRequest } from "./sampling.ts";
import { withoutHidden } from "../core/hidden-chars.ts";
import { allHooks } from "../engine/hooks.ts";
import { askFor, DECLINED } from "../tools/interact.ts";
import type { Asked } from "../core/types.ts";
import { canon, expand, importable, mergeServers, parseConfig, RESERVED, validate, writeConfig, type McpConfigFile, type McpServerConfig } from "./config.ts";
import { binding, endpoint, maskedServer, maskedTarget, readSources, sourceFiles, sourced } from "./sources.ts";
import { ClientRefused, OAuthStore, type Forgotten } from "./oauth.ts";
import { reapLeft, track } from "./procs.ts";
import { chunksUntil } from "../core/proc.ts";
import { toOutput } from "./result.ts";
import { appUriOf, visibleTo } from "./apps.ts";
import { base64Bytes as b64Bytes } from "../tools/blob.ts";
import { hintsOf, hintWords } from "./hints.ts";
import { ASKED, LOG_KEPT, logLine, severe, type LogLine } from "./logs.ts";
import { conceal } from "../core/conceal.ts";
import { STATUS_CAP, STATUS_METHOD, type Pushed } from "./channel.ts";
import { runMode } from "../core/runmode.ts";
import { serverName } from "../plugins/manifest.ts";
import { changeDigest, defOf, diffTools, instructionsChange, offered, readPins, type InstructionsChange, type Pin, type ToolChange } from "./pins.ts";
import { envHint, maskProxy, proxyCredentials, serverEnv } from "./env.ts";
import { classify, type ClassKey, type ServerClass } from "./class.ts";
import { registerSettings, settings } from "../admin/settings.ts";

// How often one call's server may ask (2025-11-25 client/elicitation, security
// considerations: "Clients SHOULD implement rate limiting"). A question past
// a bound is not answered again and again: the call ends with what the bound
// was, so a server that keeps asking cannot hold its session (it would get
// "no choice" as fast as it can ask, for as long as the turn runs).
// - 20 questions in one call, each counted when it arrives;
// - 5 that the owner declined;
// - 10 that Keel had to answer by itself, because there was no card to ask
//   on, the form could not be answered, or too many came at once.
const QUESTIONS_MAX = 20;
const DECLINES_MAX = 5;
const SELF_MAX = 10;
// The questions that wait behind the one on the card.
const QUEUED_MAX = 5;
// `end`: stops the call (its request is cancelled); `ended`: why it was.
// `client`: the connection the call runs on (a page's completion is said on it).
type CallAsks = { asked: number; declined: number; queued: number; self: number; roots: number; notes: Set<string>; readOnly: boolean; client?: McpClient; end?: () => void; ended?: string };
// Declines are counted when the owner answers, so that bound is looked at
// again when a queued question's turn comes; the count of questions is
// looked at once, before the question is counted (the twentieth is shown).
const declinedOut = (server: string, c: CallAsks): string | undefined =>
  c.declined >= DECLINES_MAX ? `${server} went on asking after the owner declined ${DECLINES_MAX} of its questions in this call.` : undefined;
const overLimit = (server: string, c: CallAsks): string | undefined =>
  declinedOut(server, c) ?? (c.asked >= QUESTIONS_MAX ? `${server} asked more than ${QUESTIONS_MAX} questions in this call.` : undefined);

// A folder as the roots a server is told (2025-11-25 client/roots): one root,
// a file URI of the real path, named by the folder.
const rootsOf = (dir: string) => {
  let real = dir;
  try { real = realpathSync(dir); } catch {} // a folder that is gone is named as it was
  return { roots: [{ uri: pathToFileURL(real).href, name: basename(real) || real }] };
};

// armed, not_armed, unreachable: phone control, whose state is the gateway's answer.
export type McpState = "disabled" | "connecting" | "ready" | "error" | "needs_auth" | "idle" | "missing" | "armed" | "not_armed" | "unreachable";

// A server Keel brings itself: not in mcp.json, cannot be removed, offered to
// every session. Its tool list ships with Keel, so search starts nothing; the
// process starts at the first call ("idle" until then). `reads` is Keel's own
// list of the tools that only read; `call` wraps each call (tab ownership).
export type BundledServer = {
  label: string;
  config: McpServerConfig | null;   // null: not installed on this machine
  // The command as it is now, asked at every connect (it can follow a setting).
  configure?: () => McpServerConfig | null;
  missing?: string;                 // what to install
  tools: McpTool[];
  instructions?: string;
  reads: (tool: string) => boolean;
  // `meta` goes with the call as MCP `_meta` (a server serving every session from one process tells them apart by it).
  call?: (tool: string, input: any, ctx: ToolContext, run: (tool: string, input: any, meta?: Record<string, unknown>) => Promise<ToolOutput>) => Promise<ToolOutput>;
  released?: (session: string) => void;
  // A server with no process (phone control): its state comes from here, a
  // reload asks it again, and `call` answers every call itself.
  live?: { state(): { state: McpState; error?: string }; check(): Promise<void>; target?: string };
  // Why a session may not reach this server at all (its tools, resources and
  // prompts alike), or nothing: memory turned off in that session, for the store's.
  refuses?: (session: string) => string | undefined;
  // What a call does, for the gate, before any card (phone control refuses an unarmed phone here).
  judge?: (tool: string, input: any) => Promise<CallClass>;
};

export type McpServerState = {
  session?: string;        // the one session this server is for (an editor's own)
  name: string;
  transport: "stdio" | "http" | "socket";
  target: string;
  enabled: boolean;
  state: McpState;
  error?: string;
  tools: number;
  tool_names: string[];
  read_tools: string[];   // the tools the owner marked as reads (they run without asking)
  hinted_reads: string[]; // the tools the server itself calls read-only (its word, not a read until marked)
  tool_hints: Record<string, ("destructive" | "open_world" | "idempotent")[]>; // what else the server says of a tool (src/mcp/hints.ts)
  // Tools it lists that the owner has not accepted (src/mcp/pins.ts): held from the model, a changed one
  // offered as accepted meanwhile. `digest` names this set of changes; accepting names it back.
  // `instructions`: its instructions changed too (the system prompt keeps the accepted ones meanwhile).
  held?: { digest: string; changes: ToolChange[]; instructions?: InstructionsChange };
  // Other entries of the owner's list that are this server under another name: the same command and
  // arguments (or address), or the same tools. One server configured twice.
  same_as?: string[];
  pinned_at?: number; // when its tool definitions were last accepted
  pinned_at_upgrade?: boolean; // pinned as it was when this build first ran, and the owner has not looked yet
  class?: ServerClass; // what kind of server it is (src/mcp/class.ts); not of a server Keel brings
  // Its tools as offered (the accepted definitions) whose input schema a provider would refuse as it is:
  // left out where it cannot be made to fit, changed where it can (src/providers/wires/schema-fit.ts).
  // Tools that fit everywhere are not named.
  schema_fit: SchemaFitRow[];
  last_connected?: number;
  era?: "modern" | "legacy";
  version?: string;
  sse?: true;         // it speaks the older HTTP with SSE transport (its config says so, or it was found to)
  server_info?: { name?: string; version?: string };
  sign_in: boolean;   // the server can take an OAuth sign-in (HTTP)
  signed_in: boolean;
  bundled?: string;   // the label of a server Keel brings itself
  resources: boolean; // the connected server offers resources
  prompts: boolean;   // the connected server offers prompt templates
  resources_rev: number; // goes up when its resource list changed (a list read again shows it)
  prompts_rev: number;   // goes up when its prompt list changed or it connected again
  logging: boolean;      // the connected server sends its log (src/mcp/logs.ts)
  log_rev: number;       // goes up with each line of its log
  completions: boolean;  // the connected server suggests prompt and template arguments (completion/complete)
  resource_updates: Record<string, number>; // per subscribed URI: goes up when its body changed
  retry?: { attempt: number; next_ms: number; until_ms: number }; // a failed remote server is tried again at next_ms, for a day from its first failure
  sync?: { source: string; name: string; label: string; gone: boolean }; // follows another agent's entry
  plugin?: string; // the installed plugin it comes with (it goes and stops with the plugin)
  endpoint?: string; // what the server is, whatever it is called (sources.ts endpoint)
  // Its pushed events (src/mcp/channel.ts): taken at all (the owner's switch, off by default),
  // whether the connected server declares the capability, and whether it asks to be told what became of each.
  // (The daemon's route adds the sessions that take them and the latest events, with what became of each.)
  // The browser it opened, closed when idle (the owner's switch, off by default): `can` when the server is one
  // Keel starts and lists the pair of tools that close it; `min` the idle minutes (the setting `mcp_idle`).
  idle_browser?: { on: boolean; can: boolean; min: number };
  channel: { on: boolean; declared: boolean; status: boolean; sessions?: { id: string; title: string }[]; recent?: Pushed[] };
};

// Where a pushed event came from: the server's name as sessions know it, its
// entry, the one session it is for (an editor's own), and whether the owner takes its events.
// `ident`: what the server is, whatever it is called (a hash of its endpoint), so a later server under the name is not taken for it.
export type ChannelFrom = { server: string; entry: string; session?: string; on: boolean; ident: string };

// One item of a resources/read result, as the server gave it (a body is never fetched beyond it).
export type ResourceItem = { uri: string; mimeType?: string; text?: string; bytes?: number };
// One half of a resource listing: its entries, or why it failed. `next` is where to go on from: the bound
// stopped it there, or (with `error`) that page failed and can be asked for again.
export type ResourceHalf = { items: any[]; error?: string; unsupported?: boolean; next?: string };
// A prompt message as the server returned it, its role kept apart from its content.
export type PromptMessage = { role: string; type: string; text: string };

function promptPart(c: any): { type: string; text: string } {
  const type = String(c?.type ?? "unknown");
  if (type === "text") return { type, text: String(c.text ?? "") };
  if (type === "resource") {
    const r = c.resource ?? {};
    return { type, text: r.text !== undefined ? String(r.text) : `[embedded ${r.mimeType ?? "binary"}, ${b64Bytes(String(r.blob ?? ""))} bytes: ${r.uri ?? "no URI"}]` };
  }
  if (type === "resource_link") return { type, text: `[resource link ${c.name ?? c.title ?? ""}: ${c.uri ?? "no URI"}]`.replace("link : ", "link: ") };
  if (type === "image" || type === "audio") return { type, text: `[${type} ${c.mimeType ?? ""}, ${b64Bytes(String(c.data ?? ""))} bytes]`.replace(" ,", ",") };
  return { type, text: `[${type}]` };
}

export type McpReloadedServer = { name: string; change: "added" | "removed" | "changed" | "unchanged" | "checked" };

type Entry = {
  name: string;
  config: McpServerConfig;
  // A plugin's server: its config with only what may be shown filled in.
  shown?: McpServerConfig;
  state: McpState;
  error?: string;
  client?: McpClient;
  tools: McpTool[];
  connecting?: Promise<McpClient>;
  last?: number;
  era?: "modern" | "legacy";
  // Found to speak only the older HTTP with SSE transport (its config does not say so).
  sse?: boolean;
  // The older transport was tried at this address and did not open: it is
  // not tried again until the owner reconnects the server or its config
  // changes (a server that refuses the POST and holds a GET open would cost
  // every connection attempt the wait for an address it never names).
  noSse?: boolean;
  www?: string | null;
  failures: number;
  // A remote server that failed on the network is tried again at `next` (src/mcp/retry.ts); `since` is its first failure.
  retry?: { attempt: number; since: number; next: number; timer: ReturnType<typeof setTimeout> };
  bundled?: BundledServer;
  // The calls under way, and when the last one began or ended (the idle close of a browser the server opened).
  inflight?: number;
  used?: number;
  // The `used` of the call whose browser was closed for idleness: not closed again until a call comes.
  closedFor?: number;
  // The close under way: a call that comes meanwhile waits for it, so it opens a browser after the close, not into it.
  closing?: Promise<void>;
  resourcesRev: number;
  // Goes up when its prompt list changed (or it connected again): a cached list of an older one is not used.
  promptsRev: number;
  // Its prompts as last listed, for the composer's slash menu.
  prompts?: { client: McpClient; rev: number; at: number; list: any[] };
  // The latest lines of its own log (src/mcp/logs.ts), kept across its reconnects; `logRev` goes up with each.
  log: LogLine[];
  logRev: number;
  // When a line of it last went to the Errors panel.
  logCaptured?: number;
  updates: Record<string, number>;
  subscribed: Set<string>;
  // A session's own server (an editor passed it with the session, over ACP):
  // the session it is for, and the name that session knows it by. Its key in
  // `entries` is `label@session`, which no name in the owner's file can be.
  session?: string;
  label?: string;
  given?: string; // as the editor named it
  // Whose it is while that one is connected: the editor's own socket to the
  // daemon. When the socket closes, the server ends with it.
  holder?: string;
  // The session's sandbox the command was started in (its profile and network).
  sandbox?: string;
  // Ends a connection attempt under way when the server is dropped.
  abort?: AbortController;
  // It connected at least once: its end is told.
  ran?: boolean;
  // A server an installed plugin brought: the plugin's id (`given` is the plugin's name for the server).
  plugin?: string;
  // A session's own server: its events go into its session (the owner's switch, kept in memory with it).
  channel?: boolean;
  // A session's own server from its project's .mcp.json (the owner approved it), not from its editor.
  project?: string;
  // What the model is offered of `tools` (src/mcp/pins.ts), made again when the listing or a pin changes.
  view?: { from: McpTool[]; rev: number; tools: McpTool[] };
  // What of `tools` and `instr` the owner has not accepted, made again on the same terms (the panel asks every second or two).
  diff?: { from: McpTool[]; rev: number; instr: string | null; changes: ToolChange[]; instructions?: InstructionsChange };
  // The instructions it gave at its last connect, as a prompt would carry them (concealed); null: none.
  instr?: string | null;
  // Its first call since it connected has not ended yet: a failure of it says what of the environment it went without.
  firstCall?: boolean;
  // A command server with no process: its tools, instructions and capabilities are the kept ones of its last run
  // (`toolCache`), the next call or a search that finds one of its tools starts it, and what it lists then replaces them.
  cold?: boolean;
  caps?: { resources: boolean; prompts: boolean };
};

// What is kept of a command server's last listing: for the config it was listed under (`key`), what its tools,
// instructions and capabilities were and its prompts as last listed.
type Kept = { key: string; tools: McpTool[]; instructions: string | null; caps: { resources: boolean; prompts: boolean }; prompts?: any[] };

// What a session's own server is: the session, the name it knows it by, the editor's name for it, who holds it.
type Own = { session: string; label: string; given: string; holder?: string; project?: string };

// A server an editor named, as a name Keel's tools can carry: the characters a
// server name takes, and never one a shared server already has.
function sessionLabel(name: string, taken: (n: string) => boolean): string {
  let label = String(name ?? "").trim().replace(/[^\w.-]+/g, "-").replace(/_{2,}/g, "_").replace(/^[-_.]+|[-_.]+$/g, "").slice(0, 56) || "editor";
  if (RESERVED.has(label.toLowerCase()) || taken(label)) label += "-editor";
  for (let n = 2; taken(label); n++) label = `${label.replace(/-\d+$/, "")}-${n}`;
  return label;
}

// Credential-shaped variables stay out of tool servers' environments unless
// the config names them; a server gets what it was configured with.
export const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|BEARER|SESSION)|^(AWS_|ANTHROPIC_|OPENAI_|CLAUDE_CODE_|GEMINI_|GOOGLE_|AZURE_|KEEL_)/i;

// A server as it is shown: its command and arguments, or its address without
// a user, a password or what follows a `?` (a key is often passed there).
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

// What a kept listing is for: the command, its arguments and the names of the environment it is given (a value is
// the owner's secret and no part of the key). Another program, arguments or set of names is another server.
const keptKey = (c: McpServerConfig) => digest(canon({ command: c.command, args: c.args ?? [], env: Object.keys(c.env ?? {}).sort(), env_vars: [...(c.env_vars ?? [])].sort() }));

// What a kept listing is signed over: its server's name and everything it holds, with Keel's own key (the one that
// binds an app to its server). A listing that was edited, or moved to another name, no longer matches its signature.
const keptSig = (key: Uint8Array, name: string, k: Kept) => createHmac("sha256", key).update(canon({ name, key: k.key, tools: k.tools, instructions: k.instructions, caps: k.caps, prompts: k.prompts ?? null })).digest("hex");

// The kept listings as a file holds them, whole or not at all (a file that is not this build's gives none); a listing
// whose signature does not match is left out, so that server connects as one with no kept listing does.
function readKept(text: string, key: Uint8Array): Record<string, Kept> {
  const f = JSON.parse(text);
  if (!f || f.version !== 1 || !f.servers || typeof f.servers !== "object" || Array.isArray(f.servers)) throw new Error("it is not a tool list file of this build");
  const out: Record<string, Kept> = {};
  for (const [name, k] of Object.entries<any>(f.servers)) {
    const ok = k && typeof k.key === "string" && Array.isArray(k.tools) && k.tools.every((t: any) => t && typeof t.name === "string")
      && (k.instructions === null || typeof k.instructions === "string") && k.caps && typeof k.caps.resources === "boolean" && typeof k.caps.prompts === "boolean"
      && (k.prompts === undefined || Array.isArray(k.prompts)) && typeof k.sig === "string";
    if (!ok) continue;
    const { sig, ...kept } = k as Kept & { sig: string };
    const want = Buffer.from(keptSig(key, name, kept));
    const have = Buffer.from(sig);
    if (want.length === have.length && timingSafeEqual(want, have)) out[name] = kept;
  }
  return out;
}

export function shownTarget(c: McpServerConfig): string {
  if (c.command) return maskedTarget(c);
  try {
    const u = new URL(c.url ?? "");
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(c.url ?? "").split("?")[0]!;
  }
}

// What a command an editor passed inherits from the daemon: what the MCP
// SDKs let a stdio server inherit (HOME, LOGNAME, PATH, SHELL, TERM, USER:
// DEFAULT_INHERITED_ENV_VARS in modelcontextprotocol/python-sdk), the locale,
// the time zone and the temp folder. Nothing the daemon was configured with:
// no provider's key, address or setting, whatever its name.
const INHERITED = /^(HOME|LOGNAME|PATH|SHELL|TERM|USER|LANG|LC_[A-Z_]+|TZ|TMPDIR)$/;
// What the sandbox's own launcher needs to reach the user's service manager.
const LAUNCHER = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

// The environment of a session's own command: the few inherited variables
// and the editor's, each as given. Nothing in a value is expanded: `${NAME}`
// stays those characters, so a server cannot be handed a daemon variable by naming it.
export function sessionEnv(c: McpServerConfig, confined: boolean, from: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && (INHERITED.test(k) || (confined && LAUNCHER.includes(k)))) env[k] = v;
  for (const [k, v] of Object.entries(c.env ?? {})) env[k] = String(v);
  return env;
}

// A server Keel brings (the memory store, the Chrome bridge, voice) is Keel's
// own program and is started as it always was: the daemon's environment
// without credential-shaped names. An owner's server gets serverEnv (env.ts).
function bundledEnv(c: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET.test(k)) env[k] = v;
  for (const k of c.env_vars ?? []) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(c.env ?? {})) env[k] = expand(String(v));
  return env;
}

// A headers helper prints a JSON object of header names and values (Claude
// Code's headersHelper, Codex's http_headers_helper). Run at each connect;
// the values never reach a log.
// What is read of a helper's output: headers are a few kilobytes.
const HELPER_OUTPUT_MAX = 1_000_000;
// `run`: where and how a project's helper runs (its folder, an environment of
// its own, the session's sandbox); the owner's own helpers run as the daemon.
export async function helperHeaders(cmd: string, timeoutMs = 10_000, run: { argv?: string[]; cwd?: string; env?: Record<string, string> } = {}): Promise<Record<string, string>> {
  // A group of its own: what it starts in the background goes with it. Its
  // pipes are read until every writer is gone, and not past its time.
  const p = Bun.spawn(run.argv ?? ["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true, ...(run.cwd ? { cwd: run.cwd } : {}), ...(run.env ? { env: run.env } : {}) });
  const group = () => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone already */ } } };
  let late = false;
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const timer = setTimeout(() => { late = true; group(); stop(); }, timeoutMs);
  const read = async (pipe: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let text = "";
    for await (const c of chunksUntil(pipe, stopped)) if (text.length < HELPER_OUTPUT_MAX) text += dec.decode(c, { stream: true });
    return text + dec.decode();
  };
  const reading = Promise.all([read(p.stdout), read(p.stderr)]);
  const code = await p.exited;
  clearTimeout(timer);
  // It ended: what it left running is stopped, so the pipes end with what was written.
  group();
  // (A process that left the group holds a pipe open: it is not waited for past a moment more.)
  const grace = setTimeout(stop, 1000);
  const [out, err] = await reading.finally(() => { clearTimeout(grace); stop(); });
  if (late) throw new Error(`the headers helper did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`);
  if (code !== 0) throw new Error(`the headers helper exited with ${code}${err.trim() ? `: ${err.trim().slice(0, 200)}` : ""}`);
  let h: unknown;
  try { h = JSON.parse(out); } catch { throw new Error("the headers helper did not print a JSON object"); }
  if (!h || typeof h !== "object" || Array.isArray(h) || Object.values(h).some((v) => typeof v !== "string")) throw new Error("the headers helper did not print a JSON object of strings");
  return h as Record<string, string>;
}

const pluginWord = (plugin: string) => `it comes with the plugin ${plugin}: turn the plugin off or remove it in Settings > Plugins`;

// (Whether it is on and whether its events are taken are not what the server is: neither restarts it.)
const same = (a: McpServerConfig, b: McpServerConfig) => JSON.stringify({ ...a, enabled: undefined, channel: undefined, class: undefined, close_idle_browser: undefined }) === JSON.stringify({ ...b, enabled: undefined, channel: undefined, class: undefined, close_idle_browser: undefined });

// How long the prompt list of a server that does not say when it changes is
// used before it is read again: the composer's own window before it asked
// the daemon each time its slash menu opens.
const PROMPTS_FRESH_MS = 30_000;

// How long a server that refused the Streamable HTTP request is given to name
// its address the older way, when nothing says it speaks that transport.
const SSE_TRY_MS = 4000;

// How often servers are looked at for a browser left open, and the bound before one is closed: the same ten
// minutes a job scope of an ended session idles before it is stopped (src/automation/leftover-rules.ts), long
// enough for the next step of a task and short of holding a browser's memory for hours.
const IDLE_PASS_MS = 60_000;
// The minutes a command server may sit with no call before its process is ended (its tool list stays, the next call
// starts it again): 30. Long enough that a server a task uses now and then is not started again in the middle of it,
// short enough that one used once is not held for the rest of the day. A server called every few minutes would restart
// many times a day at a shorter bound, for little memory held back (the call counts per server and hour are the
// owner's own, and stay at home).
registerSettings("mcp_idle", { close_browser_min: 10, stop_min: 30 }, (v) =>
  typeof v.close_browser_min !== "number" || !Number.isFinite(v.close_browser_min) || v.close_browser_min < 0 ? "close_browser_min is a number of minutes, 0 or more (0: never)"
    : typeof v.stop_min !== "number" || !Number.isFinite(v.stop_min) || v.stop_min < 0 ? "stop_min is a number of minutes, 0 or more (0: never)" : undefined);

// Where the owner published Keel's client metadata document (the MCP authorization spec's Client ID Metadata
// Documents). An authorization server that supports them is signed in to with this URL as the client id; one that does
// not, or none set, registers a client as before. The document is the owner's to host: its client_id is this URL and
// its redirect_uris list the daemon's callback (http://127.0.0.1:<port>/api/mcp/oauth/callback; a loopback port may differ).
registerSettings("mcp_oauth", { client_metadata_url: "" }, (v) => {
  const u = v.client_metadata_url;
  if (typeof u !== "string") return "client_metadata_url is an https address, or empty for none";
  if (!u) return undefined;
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" || x.pathname === "/" || x.hash || x.username || x.password) return "client_metadata_url is an https address with a path and no fragment or credentials (https://example.com/client.json)";
  } catch { return "client_metadata_url is an https address, or empty for none"; }
  return undefined;
});

// A call an app made: its server's result as it came (structured content and all).
export type AppCall = { raw(r: McpCallResult): void };

export class McpManager {
  private entries = new Map<string, Entry>();
  private cfg: McpConfigFile = { servers: {} };
  readonly oauth: OAuthStore;
  private disposed = false;

  private bundledOffPath: string;
  // What each server last published as its instructions, kept in the state so
  // a session's prompt can carry them while the server is still connecting
  // (a daemon start) or down. Held per config: another command or address is
  // another server.
  private publishedPath: string;
  private published: Record<string, { key: string; instructions: string | null }> = {};
  // The last listing of each command server, so a daemon start holds no process for one nobody calls.
  private toolsPath: string;
  private kept: Record<string, Kept> = {};
  // The key of each server's source binding (sources.ts binding), kept in the
  // state so an owner's grant for a server outlives a restart.
  private bindKey: Uint8Array;

  // The servers as this manager last read them from its file or wrote them
  // there, and the file's text then (null: no file; undefined: not read, or
  // read for one server only). A save compares the file with it.
  private base: Record<string, McpServerConfig> = {};
  private fileText: string | null | undefined;

  // `configFile` is the server list this manager reads and writes: the
  // owner's mcp.json for the daemon's own manager (the route names it), a
  // scratch file for any other. One built without it holds only what it is
  // given and cannot save: it never falls back to the owner's file.
  constructor(private errors: ErrorTracker, private stateDir: string, private workspace: string, private configFile?: string) {
    this.oauth = new OAuthStore(stateDir, () => (settings().mcp_oauth.client_metadata_url as string) || "");
    this.bundledOffPath = join(stateDir, "mcp-bundled-off.json");
    this.publishedPath = join(stateDir, "mcp-instructions.json");
    this.toolsPath = join(stateDir, "mcp-tools.json");
    this.askedPath = join(stateDir, "mcp-asked.json");
    this.pinsPath = join(stateDir, "mcp-pins.json");
    this.loadPins();
    // (Entries of sessions that are gone are never asked about: only the newest are kept.)
    try { this.asked = new Set((JSON.parse(readFileSync(this.askedPath, "utf8")) as string[]).slice(-200)); } catch {} // none kept
    try { this.published = JSON.parse(readFileSync(this.publishedPath, "utf8")); } catch {} // none kept yet
    // A file kept by an older build holds each config whole as its key (a
    // plugin's setting filled in among it): the key becomes its digest, the
    // same one configKey makes now, and the file is written again without it.
    const old = Object.values(this.published).filter((p) => p && typeof p.key === "string" && !/^[0-9a-f]{64}$/.test(p.key));
    if (old.length) {
      for (const p of old) p.key = digest(p.key);
      this.writePublished();
    }
    const keyPath = join(stateDir, "mcp-bind.key");
    if (!existsSync(keyPath)) {
      mkdirSync(stateDir, { recursive: true });
      try { writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" }); } catch {} // another manager wrote it first
    }
    this.bindKey = readFileSync(keyPath);
    try { this.kept = readKept(readFileSync(this.toolsPath, "utf8"), this.bindKey); } catch {} // none kept yet, or a file that is not this build's: every server connects
  }

  // Register a server Keel brings itself; call before start().
  addBundled(name: string, b: BundledServer) {
    const off = this.bundledOff().includes(name);
    const e = this.addEntry(name, b.config ?? { command: "" }, b);
    e.state = off ? "disabled" : b.config || b.live ? "idle" : "missing";
    e.error = b.config || b.live ? undefined : b.missing;
  }

  isOff(name: string) {
    return this.entries.get(name)?.state === "disabled";
  }

  // Bundled servers with no process (phone control) asked again: what a reload reports as checked.
  async checkLive(only?: string): Promise<McpReloadedServer[]> {
    const out: McpReloadedServer[] = [];
    for (const e of this.entries.values()) {
      if (!e.bundled?.live || e.state === "disabled" || (only && e.name !== only)) continue;
      await e.bundled.live.check().catch((err) => this.errors.capture("server", err, { mcp: e.name }));
      out.push({ name: e.name, change: "checked" });
    }
    return out;
  }

  private bundledOff(): string[] {
    try { return JSON.parse(readFileSync(this.bundledOffPath, "utf8")); } catch { return []; }
  }

  isBundled(name: string) {
    return !!this.entries.get(name)?.bundled;
  }

  // A session ended: what a bundled server held for it (tabs) is let go.
  releaseSession(session: string) {
    for (const e of this.entries.values()) e.bundled?.released?.(session);
    for (const e of [...this.entries.values()]) if (e.session === session) this.drop(e.name);
  }

  // How a session's own command is held to the session's sandbox: the argv
  // that runs it confined and what it is confined as, or why it is not
  // started at all. Set by whoever knows the session's permissions (the
  // daemon's route); without it nothing is confined.
  sessionSandbox?: (session: string, argv: string[]) => { argv: string[]; as: string } | { refuse: string };

  // What became of a session's own server: it started, it did not connect (or
  // went away), it ended. `target` is its command and arguments, or its
  // address without what follows a `?`: never an environment or header value.
  // Whether a session's tools run on another machine (set where the sessions are known).
  elsewhere?: (sessionId: string) => boolean;
  onSessionServer?: (e: { session: string; name: string; what: "started" | "failed" | "ended"; target: string; error?: string; project?: string }) => void;
  private told(e: Entry, what: "started" | "failed" | "ended", error?: string) {
    if (!e.session) return;
    // The reason in one line: what a failed command printed is not passed on.
    const why = error?.split("\nstderr:")[0]!.split("\n")[0];
    try { this.onSessionServer?.({ session: e.session, name: e.label ?? e.name, what, target: shownTarget(e.config), ...(why ? { error: why } : {}), ...(e.project ? { project: e.project } : {}) }); } catch (err) { this.errors.capture("server", err, { at: "mcp session server", mcp: e.name }); }
  }

  // The servers an editor passed with a session. They run with the session's
  // permissions and nothing more:
  // - offered to that session alone, under a name no server of the owner has;
  // - a command starts in the session's folder, inside the session's sandbox
  //   when that is on, with an environment that holds none of the daemon's
  //   own settings (sessionEnv), and nothing in what the editor gave is
  //   expanded against the daemon's environment;
  // - kept in memory only, never in the owner's file;
  // - ended when the session is archived or deleted, when its editor closes
  //   it or goes away (`holder`: the editor's socket), or by another list.
  // The whole list each time: one not named again goes, one named again
  // unchanged keeps its connection. `cwd` is the session's folder; `remote`
  // names the machine the session's tools run on, when it is not this one.
  // `project`: the servers are the ones the owner approved of the session's
  // project's .mcp.json (src/mcp/project.ts), its root named: they are a list
  // of their own, beside the editor's, and the editor's list leaves them be.
  setSessionServers(session: string, servers: { name: string; config: McpServerConfig }[], opts: { cwd?: string; remote?: string; holder?: string; project?: string } = {}): { name: string; label?: string; error?: string }[] {
    const mine = () => [...this.entries.values()].filter((e) => e.session === session && e.project === opts.project);
    const keep = new Set<string>();
    const out: { name: string; label?: string; error?: string }[] = [];
    for (const s of servers.slice(0, 32)) {
      // Only what an editor may give: nothing that reads the daemon's environment, keyring or sign-ins.
      const c = s.config;
      if (!!c.command === !!c.url) { out.push({ name: s.name, error: "give either command or url" }); continue; }
      // A project's entry also keeps its call time limit and its headers helper
      // (the owner approved the entry whole, the helper with it: Claude Code runs a
      // project's helper once its folder is trusted). An editor gives neither.
      const project = opts.project ? { ...(c.tool_timeout_secs ? { tool_timeout_secs: c.tool_timeout_secs } : {}), ...(c.tool_max_secs ? { tool_max_secs: c.tool_max_secs } : {}) } : {};
      const config: McpServerConfig = c.command
        ? { command: String(c.command), ...(c.args ? { args: c.args.map(String) } : {}), ...(c.env ? { env: c.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}), ...project }
        : { ...(c.url ? { url: String(c.url) } : {}), ...(c.headers ? { headers: c.headers } : {}), ...(c.transport ? { transport: c.transport } : {}), ...project,
          ...(opts.project && c.headers_helper ? { headers_helper: String(c.headers_helper), ...(opts.cwd ? { cwd: opts.cwd } : {}) } : {}) };
      const had = mine().find((e) => e.given === s.name && !keep.has(e.name) && same(e.config, config));
      if (had) { keep.add(had.name); had.holder = opts.holder; out.push({ name: s.name, label: had.label }); continue; }
      const label = sessionLabel(s.name, (n) => [...this.entries.values()].some((e) => (e.label ?? e.name) === n && (!e.session || e.session === session)));
      // An editor is told Keel takes its servers over Streamable HTTP (ACP's mcpCapabilities); a project's SSE server is spoken to.
      const bad = config.transport === "sse" && !opts.project ? "it uses the older SSE transport, which Keel does not take from an editor (its ACP capabilities say so): give its Streamable HTTP address"
        // The session's tools run on another machine: the command would start on this one, outside what the session reaches.
        : (config.command || config.headers_helper) && opts.remote ? `the session's tools run on another machine (${opts.remote}), and this command would start on this one`
        // A session whose folder was deleted: a command has nowhere to start.
        : config.command && config.cwd && !existsSync(config.cwd) ? `the session's folder ${config.cwd} is not on this machine, so the command cannot start there`
        : validate(label, config);
      if (bad) { out.push({ name: s.name, error: bad }); continue; }
      // A sandbox the session asks for and this machine cannot give: said now, with the others, not found out at the first call.
      const held = config.command ? this.sessionSandbox?.(session, [config.command, ...(config.args ?? [])]) : undefined;
      if (held && "refuse" in held) { out.push({ name: s.name, error: held.refuse }); continue; }
      const key = `${label}@${session}`;
      this.addEntry(key, config, undefined, { session, label, given: s.name, holder: opts.holder, ...(opts.project ? { project: opts.project } : {}) });
      keep.add(key);
      out.push({ name: s.name, label });
      this.ensure(key).catch(() => {}); // its state says why it failed
    }
    for (const e of mine()) if (!keep.has(e.name)) this.drop(e.name);
    return out;
  }

  // The MCP servers of an installed plugin: the whole list each time (none
  // when it is disabled or removed). They run as the owner's own servers do,
  // under the name the installer gave each, and are kept in memory only: the
  // owner's file is never written for them. One named again unchanged keeps
  // its connection.
  // `shown`: the config as the owner may see it (a sensitive setting not
  // filled in); `config` is what runs.
  setPluginServers(plugin: string, servers: { name: string; label: string; config: Record<string, unknown>; shown?: Record<string, unknown> }[]) {
    const keep = new Set<string>();
    for (const s of servers) {
      const config = s.config as McpServerConfig;
      const had = [...this.entries.values()].find((e) => e.plugin === plugin && e.given === s.name);
      if (had && same(had.config, config) && (had.name === s.label || this.entries.get(s.label)?.plugin !== plugin)) { had.shown = s.shown as McpServerConfig | undefined; keep.add(had.name); continue; }
      if (had) this.drop(had.name);
      // A name taken since the install (the owner added a server by it): the plugin's id goes before it.
      const taken = (n: string) => RESERVED.has(n.toLowerCase()) || n in this.cfg.servers || (this.entries.has(n) && !keep.has(n) && this.entries.get(n)!.plugin !== plugin) || keep.has(n);
      let label = s.label;
      for (let n = 1; taken(label); n++) label = serverName(`${plugin}-${s.name}${n > 1 ? `-${n}` : ""}`);
      if (validate(label, config)) continue;
      const e = this.addEntry(label, config, undefined, undefined, plugin);
      e.given = s.name;
      if (s.shown) e.shown = s.shown as McpServerConfig;
      keep.add(label);
      if (!runMode.client && config.enabled !== false && !e.cold) this.ensure(label).catch(() => {});
    }
    for (const e of [...this.entries.values()]) if (e.plugin === plugin && !keep.has(e.name)) this.drop(e.name);
  }

  // Every server name in use now (the owner's, the built-in ones, every plugin's but `except`'s).
  takenNames(except?: string): Set<string> {
    const out = new Set<string>([...RESERVED, ...Object.keys(this.cfg.servers)]);
    for (const e of this.entries.values()) if (!e.session && (!e.plugin || e.plugin !== except)) out.add(e.name);
    return out;
  }

  // The server a plugin's own reference names (plugin:<id>:<server>), by the name it has now.
  pluginServer(ref: string): string | undefined {
    const m = /^plugin:([^:]+):(.+)$/.exec(ref);
    if (!m) return undefined;
    return [...this.entries.values()].find((e) => e.plugin === m[1] && e.given === m[2])?.name;
  }

  // The plugin a server came with, if it did.
  pluginOf(name: string): string | undefined {
    return this.entries.get(name)?.plugin;
  }

  // A plugin's server whose name the owner's file now gives to one of the
  // owner's: it goes on under the plugin's id as a prefix.
  private movePlugin(name: string) {
    const e = this.entries.get(name);
    if (!e?.plugin) return;
    const { plugin, given, config } = e;
    this.drop(name);
    let label = serverName(`${plugin}-${given ?? name}`);
    for (let n = 2; this.entries.has(label) || label in this.cfg.servers || label === name; n++) label = serverName(`${plugin}-${given ?? name}-${n}`);
    const moved = this.addEntry(label, config, undefined, undefined, plugin);
    moved.given = given;
    if (config.enabled !== false && !moved.cold) this.ensure(label).catch(() => {});
    this.errors.capture("server", new Error(`MCP server ${name} of the plugin ${plugin} is now ${label}: your own server has the name ${name}`), { at: "mcp plugin", mcp: label });
  }

  // The editor that passed them is gone (its socket closed): its servers end.
  releaseHolder(holder: string) {
    for (const e of [...this.entries.values()]) if (e.holder === holder) this.drop(e.name);
  }

  // The session's sandbox changed: a command started under the old one is
  // started again under the new one.
  sessionPermChanged(session: string) {
    for (const e of [...this.entries.values()]) {
      if (e.session !== session || !e.config.command || e.sandbox === undefined) continue;
      const now = this.sessionSandbox?.(session, [e.config.command]);
      if (now && "as" in now && now.as === e.sandbox) continue;
      // The attempt under way, if any, is ended and is not this entry's any more.
      e.abort?.abort();
      e.abort = undefined;
      e.connecting = undefined;
      e.client?.close();
      e.client = undefined;
      e.tools = [];
      e.state = "connecting";
      this.ensure(e.name).catch(() => {});
    }
  }

  // A shared server took a name a session's own server answers to: the
  // session's is renamed, so the owner's server is the one that name means.
  private unshadow(name: string) {
    for (const e of this.entries.values()) {
      if (!e.session || e.label !== name) continue;
      e.label = sessionLabel(e.given ?? name, (n) => [...this.entries.values()].some((x) => x !== e && (x.label ?? x.name) === n && (!x.session || x.session === e.session)));
    }
  }

  private readFile(): { cfg: McpConfigFile; text: string | null } {
    const text = this.configFile && existsSync(this.configFile) ? readFileSync(this.configFile, "utf8") : null;
    return { cfg: text === null ? { servers: {} } : parseConfig(text), text };
  }

  // Writes `next` as the server list; the one way the list changes. Memory
  // follows the file: until the write is done nothing in this manager has
  // changed, so a save that fails leaves it as it was, and a writer touches
  // its entries only after this returned.
  // A file that changed since this manager last read or wrote it (a hand
  // edit, another process) is merged by server name, not replaced: what this
  // manager changed is its own, the rest is the file's, and what the file
  // changed is taken up as a reload would. A file that is gone is no edit:
  // the list is written whole. A file that no longer parses is left alone:
  // the save fails with the parser's reason.
  private save(next: Record<string, McpServerConfig>) {
    const file = this.mustSave();
    let text: string | null = null;
    try { text = readFileSync(file, "utf8"); } catch {} // no file
    let theirs: string[] = [];
    if (text !== null && text !== this.fileText) {
      let disk: Record<string, McpServerConfig>;
      try { disk = parseConfig(text).servers; } catch (e) {
        throw new Error(`${file} was changed and cannot be read, so it is left as it is: ${(e as Error).message}`);
      }
      ({ servers: next, theirs } = mergeServers(this.base, next, disk));
    }
    this.fileText = writeConfig({ ...this.cfg, servers: next }, file);
    this.cfg = { ...this.cfg, servers: next };
    this.base = { ...next };
    for (const name of theirs) this.adopt(name, next[name]);
  }

  // Asked before a writer changes anything, so one that cannot save changes nothing.
  private mustSave(): string {
    if (!this.configFile) throw new Error("this MCP manager was given no config file: it cannot save its servers");
    return this.configFile;
  }

  // What the file says about one server now, taken up: added, restarted with
  // its new config, or dropped. Null for a name that is not the file's to set.
  private adopt(name: string, now: McpServerConfig | undefined): McpReloadedServer["change"] | null {
    // A plugin's server is not the file's; one the file now names gives way under the plugin's prefix.
    if (this.entries.get(name)?.plugin) {
      if (!now) return null;
      this.movePlugin(name);
    }
    const e = this.entries.get(name);
    if (e?.bundled || e?.session) return null;
    if (!now) return e ? (this.drop(name), "removed") : null;
    if (e && same(e.config, now) && (e.config.enabled === false) === (now.enabled === false)) { e.config = now; return "unchanged"; }
    const bad = validate(name, now);
    if (bad) {
      this.errors.capture("server", new Error(`mcp.json server ${name} is not used: ${bad}`), { at: "mcp config" });
      return null;
    }
    if (e) this.drop(name);
    else this.ownerAdded.add(name);
    this.addEntry(name, now);
    if (now.enabled !== false && !this.entries.get(name)?.cold) this.ensure(name).catch(() => {});
    return e ? "changed" : "added";
  }

  start() {
    // Servers the daemon before left running (it was killed, or they ignored its end) are ended first.
    try {
      const left = reapLeft(this.stateDir);
      if (left.length) this.errors.capture("server", new Error(`ended ${left.length} MCP server process${left.length === 1 ? "" : "es"} the daemon before left running: ${left.join(", ")}`), { at: "mcp start" });
    } catch (e) {
      this.errors.capture("server", e, { at: "mcp start" });
    }
    try {
      const { cfg, text } = this.readFile();
      this.cfg = cfg;
      this.base = { ...cfg.servers };
      this.fileText = text;
    } catch (e) {
      this.errors.capture("server", e, { at: "mcp config" });
    }
    for (const [name, c] of Object.entries(this.cfg.servers)) {
      if (this.entries.get(name)?.bundled) {
        this.errors.capture("server", new Error(`mcp.json names ${name}, a server Keel brings itself; the entry is not used`), { at: "mcp config" });
        continue;
      }
      const bad = validate(name, c);
      if (bad) {
        this.errors.capture("server", new Error(`mcp.json server ${name} is not used: ${bad}`), { at: "mcp config" });
        continue;
      }
      this.addEntry(name, c);
    }
    this.markUpgrade();
    // A kept listing of a server that is no longer here and was never accepted (no pin) is of no use: dropped.
    // (A plugin's server is added later and is kept; one gone later is dropped when it goes.)
    if (!runMode.client && Object.keys(this.kept).some((n) => !this.entries.has(n) && !this.pins[n])) {
      for (const n of Object.keys(this.kept)) if (!this.entries.has(n) && !this.pins[n]) delete this.kept[n];
      this.writeKept();
    }
    if (!runMode.client) {
      try { this.syncSources(); } catch (e) { this.errors.capture("server", e, { at: "mcp sources sync" }); }
      this.watchSources();
    }
    // Connect in the background so the panel shows real states; nothing waits on it.
    // A command's own daemon connects a server only when a turn uses it.
    if (!runMode.client) setTimeout(() => {
      // (A command server with a kept listing waits for its first call.)
      for (const e of this.entries.values()) if (e.state !== "disabled" && !e.bundled && !e.cold) this.ensure(e.name).catch(() => {});
    }, 50);
    // (The pass over the servers for a browser left open: once a minute, off the loop's way.)
    if (!runMode.client) {
      clearInterval(this.idleTimer);
      this.idleTimer = setInterval(() => {
        void this.closeIdle().catch((err) => this.errors.capture("server", err, { at: "idle browser close" }));
        try { this.stopIdle(); } catch (err) { this.errors.capture("server", err, { at: "idle server stop" }); }
      }, IDLE_PASS_MS);
      (this.idleTimer as { unref?: () => void }).unref?.();
    }
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.idleTimer);
    for (const { w } of this.watchers.values()) w.close();
    this.watchers.clear();
    clearTimeout(this.syncTimer);
    for (const e of this.entries.values()) {
      this.clearRetry(e);
      e.abort?.abort(); // one still connecting ends with the manager
      e.client?.close();
      unregisterCatalog(e.name);
    }
    this.entries.clear();
    // Owed to the file, or being written: written whole now, before the process can end.
    if (this.keptOwed || this.keptWriting) {
      this.keptOwed = false;
      try { writeFileSync(this.toolsPath + ".tmp", this.keptText(), { mode: 0o600 }); renameSync(this.toolsPath + ".tmp", this.toolsPath); } catch (err) { this.errors.capture("server", err, { at: "mcp tool lists" }); }
    }
  }

  private addEntry(name: string, config: McpServerConfig, bundled?: BundledServer, own?: Own, plugin?: string) {
    const e: Entry = { name, config, state: config.enabled === false ? "disabled" : "connecting", tools: [], failures: 0, bundled, resourcesRev: 0, promptsRev: 0, log: [], logRev: 0, updates: {}, subscribed: new Set(), ...own, ...(plugin ? { plugin } : {}) };
    this.entries.set(name, e);
    if (!own) this.unshadow(name);
    this.useKept(e);
    registerCatalog({
      name,
      session: e.session,
      tools: async () => {
        // Phone control turned off leaves search, and a call still gets the plain reason.
        if (e.state === "disabled" && e.bundled?.live) return e.bundled.tools.map((t) => ({ ...this.catalogTool(e, t), hidden: true }));
        if (e.state === "disabled" || e.state === "needs_auth" || e.state === "missing") return [];
        // A bundled server's shipped list: searching it starts nothing. Nor does the kept list of a command server.
        if (e.bundled) return (e.client ? e.tools : e.bundled.tools).map((t) => this.catalogTool(e, t));
        if (this.listed(e)) return this.forModel(e).map((t) => this.catalogTool(e, t));
        try {
          await this.ensure(name, 8_000);
        } catch {
          return [];
        }
        return this.forModel(e).map((t) => this.catalogTool(e, t));
      },
      pending: () => (e.state === "connecting" && !e.cold ? [e.label ?? name] : []),
      // Found by a search: a command server with no process is started now, as its tool is likely called next.
      warm: () => { if (e.cold && e.state === "idle" && this.entries.get(name) === e && !this.disposed) this.ensure(name).catch(() => {}); },
      failed: () => {
        const live = e.bundled?.live && e.state !== "disabled" ? e.bundled.live.state() : null;
        const state = live?.state ?? e.state;
        if (state === "needs_auth") return [{ name: e.label ?? name, why: "it needs a sign-in, which the owner gives in Settings > MCP servers" }];
        if (state !== "error" && state !== "unreachable") return [];
        return [{ name: e.label ?? name, why: (live?.error ?? e.error ?? "it failed to start").split("\nstderr:")[0]!.split("\n")[0]! }];
      },
      known: () => {
        if (e.state === "disabled" && e.bundled?.live) return e.bundled.tools.map((t) => ({ ...this.catalogTool(e, t), hidden: true }));
        if (e.state === "disabled" || e.state === "needs_auth" || e.state === "missing") return [];
        if (e.bundled) return (e.client ? e.tools : e.bundled.tools).map((t) => this.catalogTool(e, t));
        return e.state === "ready" || this.listed(e) ? this.forModel(e).map((t) => this.catalogTool(e, t)) : [];
      },
    });
    return e;
  }

  // Whether a command server's tools are the kept ones, offered with no process: asleep, or starting from sleep.
  private listed(e: Entry): boolean {
    return !!e.cold && (e.state === "idle" || e.state === "connecting");
  }

  // A command server of the owner's or a plugin's that may have no process: not one Keel brings, not a session's,
  // not one the owner keeps running, not one whose events the owner takes (it must be there to push them).
  private sleeps(e: Entry): boolean {
    return !e.bundled && !e.session && !!e.config.command && !e.config.url && !e.config.keep_running && !this.channelOn(e);
  }

  // Whether a listing is one the owner already accepted: every tool it names is pinned as it is, and its instructions are
  // the pinned ones. Only such a listing is a server's while it has no process: a change is the owner's to review from
  // what the server itself lists, never from a file.
  private accepted(e: Entry, tools: McpTool[], instructions: string | null): boolean {
    const p = this.pinOf(e);
    return !!p && !diffTools(p.tools, tools).changes.length && !instructionsChange(p.instructions, instructions);
  }

  // A server with a kept listing under this config that the owner accepted (a pin): it starts asleep.
  private useKept(e: Entry) {
    if (e.state === "disabled" || !this.sleeps(e)) return;
    const k = this.kept[e.name];
    if (!k || k.key !== keptKey(e.config) || !this.accepted(e, k.tools, k.instructions)) return;
    e.tools = k.tools;
    e.instr = k.instructions;
    e.caps = k.caps;
    e.cold = true;
    e.state = "idle";
  }

  // The listing just taken, kept for the next start. Written only when it changed.
  private keep(e: Entry, prompts?: any[]) {
    if (e.bundled || e.session || !e.config.command || e.config.url || !e.client) return;
    const caps = { resources: !!e.client.capabilities.resources, prompts: !!e.client.capabilities.prompts };
    const was = this.kept[e.name];
    const key = keptKey(e.config);
    const next: Kept = { key, tools: e.tools, instructions: e.instr ?? null, caps, ...((prompts ?? (was?.key === key ? was.prompts : undefined)) ? { prompts: prompts ?? was!.prompts } : {}) };
    if (was && canon(was) === canon(next)) return;
    this.kept[e.name] = next;
    this.writeKept(e.name);
  }

  // The file is written off the loop, one write at a time: a change that comes while one is under way is written
  // after it, whole (the file always holds every listing). `dispose` finishes what is owed.
  private keptOwed = false;
  private keptWriting?: Promise<void>;
  private keptAt?: string;
  private writeKept(at?: string) {
    this.keptOwed = true;
    if (at) this.keptAt = at;
    if (this.keptWriting) return;
    this.keptWriting = (async () => {
      try {
        while (this.keptOwed) {
          this.keptOwed = false;
          const text = this.keptText();
          mkdirSync(this.stateDir, { recursive: true });
          await writeFileAsync(this.toolsPath + ".tmp", text, { mode: 0o600 });
          if (this.disposed) return; // the manager's end wrote the file itself
          await renameAsync(this.toolsPath + ".tmp", this.toolsPath);
        }
      } catch (err) {
        // (A manager that ended while this one was under way wrote the file itself: its rename finds the file taken.)
        if (!(this.disposed && (err as NodeJS.ErrnoException).code === "ENOENT")) this.errors.capture("server", err, { at: "mcp tool lists", ...(this.keptAt ? { mcp: this.keptAt } : {}) });
      } finally {
        this.keptWriting = undefined;
      }
    })();
  }
  private keptText() {
    const servers = Object.fromEntries(Object.entries(this.kept).map(([n, k]) => [n, { ...k, sig: keptSig(this.bindKey, n, k) }]));
    return JSON.stringify({ version: 1, servers });
  }
  // The listings written, as far as they were asked for (a test waits on it).
  keptWritten(): Promise<void> {
    return this.keptWriting ?? Promise.resolve();
  }

  private catalogTool(e: Entry, t: McpTool): CatalogTool {
    const server = e.label ?? e.name;
    const readOnly = e.bundled ? e.bundled.reads(t.name) : !!e.config.read_tools?.includes(t.name);
    // (A server Keel brings is judged by Keel's own word: its `reads` and `judge`.)
    const hints = e.bundled ? undefined : hintsOf(t.annotations);
    // A tool the owner marked as a read is a read whatever its server says; any other call carries what raises its care.
    const careful = !readOnly && (hints?.destructive || hints?.openWorld) ? { ...(hints.destructive ? { destructive: true as const } : {}), ...(hints.openWorld ? { openWorld: true as const } : {}) } : undefined;
    // A tool that writes, on a server that holds the owner's account: his to allow in every mode (src/safety/accounts.ts).
    // Whether the server holds one is read when the call is judged (a sign-in made since counts), by the server's class
    // (src/mcp/class.ts: the owner's word, else the credential its config sends). A tool whose accepted definition says
    // it only reads (readOnlyHint, taken here for this and nothing else) is not held.
    const account = !readOnly && !e.bundled && t.annotations?.readOnlyHint !== true;
    // A tool its server marks as one the owner answers on every call (tools/list _meta, exactly true: any other value
    // is ignored). It is a rule the gate holds the call to (src/safety/policy.ts), so it is part of what the call is
    // judged by and of the shape a card's answer is for.
    const interaction = !e.bundled && t._meta?.["anthropic/requiresUserInteraction"] === true;
    return {
      server,
      name: t.name,
      // The name every place shows and `mcp_call` takes. A server names its own tools: a character in
      // a name that hides or reorders text is written out, so the name reads the same on a card, in
      // the transcript, in the timeline and in a rule. The call still goes out under the server's own name.
      qualified: spelled(`${server}__${t.name}`, ""),
      mcp: true,
      source: binding(sourced(e.config), this.bindKey),
      description: t.description ?? t.title ?? "",
      input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
      readOnly,
      ...(hints || interaction ? { hints: { ...hints, ...(interaction ? { interaction: true as const } : {}) } } : {}),
      judge: e.bundled?.judge ? (input: any) => e.bundled!.judge!(t.name, input)
        : interaction ? async (input: any) => ({ kind: "other" as const, hints: { ...careful, interaction: true as const }, ...(readOnly ? { reads: true as const } : {}), ...(account && this.classOf(e.name)?.account.yes ? { account: { server, name: e.name, tool: t.name, input } } : {}) })
        : careful || account ? async (input: any) => ({ kind: "other" as const, ...(careful ? { hints: careful } : {}), ...(account && this.classOf(e.name)?.account.yes ? { account: { server, name: e.name, tool: t.name, input } } : {}) }) : undefined,
      run: (input: any, ctx: ToolContext) => this.call(e.name, t.name, input, ctx),
    };
  }

  // How a project server's headers helper runs (Claude Code's rules for a
  // helper a repository supplies): in the project's folder, told the server's
  // name and address (CLAUDE_CODE_MCP_SERVER_NAME, _URL), with no credential
  // of the daemon's environment (what a session's command inherits, and no
  // more), inside the session's sandbox as its command would be. Nothing in
  // its text is expanded here: its shell reads the variables it was given.
  private projectHelper(e: Entry, url: string): { argv?: string[]; cwd?: string; env: Record<string, string> } {
    const cmd = e.config.headers_helper!;
    const held = this.sessionSandbox?.(e.session!, ["sh", "-c", cmd]);
    if (held && "refuse" in held) throw new Error(held.refuse);
    const confined = !!held && held.as !== "off";
    const env = { ...sessionEnv({}, confined), CLAUDE_CODE_MCP_SERVER_NAME: e.given ?? e.label ?? e.name, CLAUDE_CODE_MCP_SERVER_URL: url };
    return { ...(confined ? { argv: held!.argv } : {}), ...(e.config.cwd ? { cwd: e.config.cwd } : {}), env };
  }

  private transport(e: Entry): Transport {
    const c = e.config;
    // A session's own server: every value as the editor gave it. Nothing is
    // expanded against the daemon's environment, no header comes from it, and
    // no sign-in of the owner's is sent along.
    if (e.session) {
      if (c.command) return { kind: "stdio", command: c.command, args: c.args ?? [], env: sessionEnv(c, false), cwd: c.cwd ?? this.workspace, started: (p) => track(this.stateDir, p, e.label ?? e.name) };
      return { kind: "http", url: c.url!, headers: Object.fromEntries(Object.entries(c.headers ?? {}).map(([k, v]) => [k, String(v)])), ...(c.transport === "sse" || e.sse ? { sse: true } : {}) };
    }
    if (c.command) {
      return { kind: "stdio", command: expand(c.command), args: (c.args ?? []).map((a) => expand(a)), env: e.bundled ? bundledEnv(c) : serverEnv(c), cwd: c.cwd ? expand(c.cwd) : this.workspace, started: (p) => track(this.stateDir, p, e.name) };
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.headers ?? {})) headers[k] = expand(String(v));
    for (const [k, v] of Object.entries(c.headers_env ?? {})) if (process.env[v]) headers[k] = process.env[v]!;
    const bearer = c.bearer_env ? process.env[c.bearer_env] : undefined;
    return {
      kind: "http",
      url: expand(c.url!),
      headers,
      token: bearer ? async () => bearer : () => this.oauth.token(e.name),
      ...(c.transport === "sse" || e.sse ? { sse: true } : {}),
    };
  }

  // Connect once; concurrent callers share the attempt. `wait` bounds how long
  // a caller waits (search keeps going without a slow server).
  ensure(name: string, wait?: number): Promise<McpClient> {
    const e = this.entries.get(name);
    if (!e) return Promise.reject(new Error(`no MCP server named ${name}`));
    if (e.bundled?.live) return Promise.reject(new Error(`${name} has no MCP process`));
    if (e.state === "disabled") return Promise.reject(new Error(`${name} is turned off`));
    if (e.state === "missing") return Promise.reject(new Error(e.error ?? `${name} is not installed`));
    if (e.client && e.state === "ready") return Promise.resolve(e.client);
    if (!e.connecting) {
      e.state = "connecting";
      e.error = undefined;
      if (e.bundled?.configure) e.config = e.bundled.configure() ?? e.config;
      const t = this.transport(e);
      const abort = (e.abort = new AbortController());
      // One connection for every session: a turn that happens to open it does
      // not own it, so what it fails with later is no turn's.
      e.connecting = detached(() => (async () => {
        // A session's own command runs inside the session's sandbox, as its shell commands do.
        if (e.session && t.kind === "stdio") {
          const held = this.sessionSandbox?.(e.session, [t.command, ...t.args]);
          // (Refused is a state of its own: a change of the session's sandbox tries again.)
          e.sandbox = !held ? "off" : "refuse" in held ? "refused" : held.as;
          if (held && "refuse" in held) throw new Error(held.refuse);
          if (held && held.as !== "off") {
            [t.command, ...t.args] = held.argv as [string, ...string[]];
            t.env = sessionEnv(e.config, true);
          }
        }
        if (t.kind === "http" && e.config.headers_helper) {
          const h = await helperHeaders(e.session ? e.config.headers_helper : expand(e.config.headers_helper), undefined, e.session ? this.projectHelper(e, t.url) : {});
          Object.assign(t.headers, h);
          // The helper's own Authorization wins over a stored sign-in.
          if (Object.keys(h).some((k) => k.toLowerCase() === "authorization")) t.token = undefined;
        }
        const timeout = (e.config.timeout_secs ?? 30) * 1000;
        // What the server asks outside any call is answered for the folder it was started in.
        const outside = (q: InputRequest) => this.inputOutside(t.kind === "stdio" && t.cwd ? t.cwd : this.workspace, q);
        let client: McpClient;
        try {
          client = await McpClient.connect(t, timeout, e.era, abort.signal, undefined, outside);
        } catch (err) {
          // A server that refuses the request with a 4xx may speak only the
          // older HTTP with SSE transport, at the same address: asked that
          // way once (the transports' own rule for a client that knows
          // neither). What the first try said stands when that fails too.
          if (t.kind !== "http" || t.sse || e.noSse || abort.signal.aborted || !/^HTTP 4\d\d/.test((err as Error).message)) throw err;
          try {
            client = await McpClient.connect({ ...t, sse: true }, timeout, undefined, abort.signal, Math.min(timeout, SSE_TRY_MS), outside);
          } catch {
            if (!abort.signal.aborted) e.noSse = true;
            throw err;
          }
          e.sse = true;
        }
        // Removed, turned off or replaced meanwhile: this client is nobody's.
        const stale = () => this.entries.get(name) !== e || e.abort !== abort || e.state === "disabled" || this.disposed;
        if (stale()) {
          client.close();
          throw new Error(`${name} was changed while it connected`);
        }
        // Heard from the start: an event sent while its tools are listed is not lost.
        client.onChannel = (params) => {
          if (this.entries.get(name) !== e || e.state === "disabled") return;
          try { this.onChannel?.(this.channelFrom(e), params); } catch (err) { this.errors.capture("server", err, { mcp: name, at: "mcp channel event" }); }
        };
        // Its log, from the start too: what it says while it starts is often why it fails.
        client.onLog = (p) => {
          if (this.entries.get(name) !== e || e.abort !== abort) return;
          const line = logLine(p);
          e.log.push(line);
          if (e.log.length > LOG_KEPT) e.log.splice(0, e.log.length - LOG_KEPT);
          e.logRev++;
          // A failure it logs is the Errors panel's too, one row per logger and level. At most one a second is
          // written: the row counts them anyway, and a server that logs fast would make a write of every line.
          if (!severe(line.level) || Date.now() - (e.logCaptured ?? 0) < 1000) return;
          e.logCaptured = Date.now();
          this.errors.capture("server", new Error(`MCP server ${e.label ?? name} logged ${line.level === "error" ? "an error" : `a ${line.level} line`}${line.logger ? ` (${line.logger})` : ""}: ${line.text.slice(0, 500)}`), { mcp: name, at: "mcp log", level: line.level, ...(line.logger ? { logger: line.logger } : {}) }, { group: `mcp log\u0000${name}\u0000${line.logger ?? ""}\u0000${line.level}` });
        };
        // Watched from the start: a server that exits during discovery is not ready.
        let gone: string | undefined;
        client.onClose = (why) => {
          gone = why;
          if (e.client !== client) return;
          e.client = undefined;
          // A legacy HTTP session the server ended: a new one starts at once
          // (a new initialize, discovery again). Only the handshake and the
          // listing are sent; the request that found out is not.
          if (client.expired) {
            e.state = "connecting";
            e.error = undefined;
            this.ensure(name).catch(() => {});
            return;
          }
          e.state = "error";
          e.error = why;
          this.told(e, "failed", why);
        };
        // An answer to a request of the server's own that it did not take: its failure, in the scope of the call that asked.
        client.onAnswerRefused = (r) => this.errors.capture("server", new Error(`MCP server ${name} did not take Keel's answer to its ${r.method}: ${r.why}`), { mcp: name, at: "mcp answer", ...(r.session ? { session: r.session } : {}) });
        // A server without the tools capability may still answer; one that
        // does not just has no tools (unless it went away meanwhile).
        let tools: McpTool[];
        try {
          tools = await client.listTools().catch((err) => {
            if (client.capabilities.tools === undefined && !client.isClosed) return [];
            throw err;
          });
        } catch (err) {
          client.close();
          throw err;
        }
        if (stale()) {
          client.close();
          throw new Error(`${name} was changed while it connected`);
        }
        if (gone !== undefined || client.isClosed) throw new Error(`${name} closed during discovery: ${gone ?? "the connection is closed"}`);
        e.tools = tools;
        e.cold = false;
        e.firstCall = true;
        this.settle(e, client.instructions);
        e.client = client;
        e.era = client.era;
        e.state = "ready";
        e.ran = true;
        this.clearRetry(e);
        this.told(e, "started");
        this.publish(e, client.instructions);
        this.keep(e);
        e.last = Date.now();
        e.failures = 0;
        e.resourcesRev++;
        e.promptsRev++;
        e.subscribed.clear();
        // The latest list wins: an older reply that lands last is dropped.
        let asked = 0;
        client.onListChanged = () => {
          const mine = ++asked;
          client.listTools().then(
            (t) => { if (mine === asked && e.client === client) { e.tools = t; this.settle(e, client.instructions); this.keep(e); } },
            (err) => { if (mine === asked && e.client === client) this.errors.capture("server", err, { mcp: name, at: "tools/list after a change" }); },
          );
        };
        client.onPrompts = () => { if (e.client === client) e.promptsRev++; };
        // (A modern server is not asked: the 2026-07-28 revision deprecates logging.)
        if (client.era === "legacy" && client.capabilities.logging)
          client.rpc("logging/setLevel", { level: ASKED }).catch((err) => { if (e.client === client) this.errors.capture("server", err, { mcp: name, at: "logging/setLevel" }); });
        client.onResources = (c) => {
          if (e.client !== client) return;
          if ("list" in c) e.resourcesRev++;
          else e.updates = { ...e.updates, [c.uri]: (e.updates[c.uri] ?? 0) + 1 };
        };
        return client;
      })()
        .catch((err) => {
          // Dropped, or started again meanwhile: this attempt's end is not the server's state.
          if (this.entries.get(name) !== e || e.abort !== abort) throw err;
          if (err instanceof AuthRequired) {
            e.state = "needs_auth";
            e.www = err.wwwAuthenticate;
            e.error = "Sign in to use this server.";
          } else if (e.state !== "disabled") {
            e.state = "error";
            e.error = this.withEnvHint(e, err.message);
            if (e.failures++ === 0) {
              this.errors.capture("server", err, { mcp: name });
              this.told(e, "failed", err.message);
            }
            this.retryLater(e, name, err);
          }
          if (this.upgradePending.has(name)) this.tellUpgrade();
          throw err;
        })
        .finally(() => { if (e.abort === abort) e.connecting = undefined; }));
    }
    if (!wait) return e.connecting;
    return Promise.race([
      e.connecting,
      new Promise<McpClient>((_, rej) => setTimeout(() => rej(new Error(`${name} is still connecting`)), wait)),
    ]);
  }

  // A remote server that failed on the network is connected again after a wait that doubles (src/mcp/retry.ts),
  // for a day from its first failure. Nothing else is retried: a refusal or a bad answer would only fail again.
  private retryLater(e: Entry, name: string, err: Error) {
    if (this.disposed || !e.config.url || e.bundled || !networkFailure(err)) return this.clearRetry(e);
    const now = Date.now();
    const attempt = (e.retry?.attempt ?? 0) + 1;
    const since = e.retry?.since ?? now;
    this.clearRetry(e);
    if (now - since >= RETRY.giveUp) return void (e.error = `${e.error ?? err.message} (Keel stopped trying again after a day; reconnect it from here.)`);
    const wait = retryDelay(attempt);
    const timer = setTimeout(() => {
      if (this.disposed || this.entries.get(name) !== e || e.state !== "error" || e.retry?.timer !== timer) return;
      this.ensure(name).catch(() => {}); // a failure schedules the next try
    }, wait);
    timer.unref?.();
    e.retry = { attempt, since, next: now + wait, timer };
  }
  private clearRetry(e: Entry) {
    if (e.retry) clearTimeout(e.retry.timer);
    e.retry = undefined;
  }

  // Why a session may not reach a server Keel brings, or nothing.
  refusal(name: string, session: string | undefined): string | undefined {
    return session ? this.entries.get(name)?.bundled?.refuses?.(session) : undefined;
  }

  // `app`: a call an MCP App made of its own server's tool (src/server/routes/mcp-apps.ts): told the
  // server's result as it came, and keeps no app of its own (the app that called is drawn already).
  call(name: string, tool: string, input: unknown, ctx: ToolContext, app?: AppCall): Promise<ToolOutput> {
    const e = this.entries.get(name);
    const b = e?.bundled;
    const no = this.refusal(name, ctx.sessionId);
    if (no) return Promise.resolve({ content: no, is_error: true });
    if (e) { e.inflight = (e.inflight ?? 0) + 1; e.used = Date.now(); }
    const done = () => { if (e) { e.inflight = Math.max(0, (e.inflight ?? 1) - 1); e.used = Date.now(); } };
    const run = () => (b?.call ? b.call(tool, input, ctx, (t, i, m) => this.callRaw(name, t, i, ctx, m)) : this.callRaw(name, tool, input, ctx, undefined, app));
    // (A call that comes while the server's browser is being closed goes on after the close.)
    return (e?.closing ? e.closing.then(run) : run()).finally(done);
  }

  // A read of a server's resources or prompts is a use of it as a tool call is: it is not idle for the bound after it.
  private used(name: string) {
    const e = this.entries.get(name);
    if (e) e.used = Date.now();
  }

  // Whether a server's browser may be closed by Keel: one Keel starts (a command; never a remote URL, whose
  // browser may be somebody else's or a shared one), not a plugin's or a session's, that lists the Playwright
  // server's pair of tools, `browser_navigate` with `browser_close`. A name alone is not enough.
  private browserClose(e: Entry): boolean {
    if (e.bundled || e.session || e.plugin || !e.config.command || e.config.url) return false;
    const names = new Set(e.tools.map((t) => t.name));
    return names.has("browser_close") && names.has("browser_navigate");
  }

  // The owner's switch for one server: close its browser once no call has used it for `mcp_idle.close_browser_min`
  // minutes. Playwright's server keeps its Chrome (and a dozen helper processes) open after the call that used it,
  // until the server ends, and its `browser_close` ends the whole browser context, a headed one a person may be
  // signing in to included: so it is the owner's to choose per server, never done by a name match.
  setCloseIdleBrowser(name: string, on: boolean) {
    const e = this.entries.get(name);
    if (!e || e.session) throw Object.assign(new Error(`no MCP server named ${name}`), { status: 404 });
    if (e.bundled) throw Object.assign(new Error(`${name} is built in: it opens no browser of its own`), { status: 409 });
    if (e.plugin) throw Object.assign(new Error(pluginWord(e.plugin)), { status: 409 });
    if (on && (e.config.url || !e.config.command)) throw Object.assign(new Error(`${name} is a remote server: Keel does not close a browser it did not start`), { status: 409 });
    if (on && e.state === "ready" && !this.browserClose(e)) throw Object.assign(new Error(`${name} does not list browser_navigate and browser_close: there is no browser to close`), { status: 409 });
    if (!!e.config.close_idle_browser === on) return;
    const c: McpServerConfig = { ...e.config };
    if (on) c.close_idle_browser = true;
    else delete c.close_idle_browser;
    this.save({ ...this.cfg.servers, [name]: c });
    e.config = c;
    e.closedFor = undefined;
  }

  // The browser of each server that has the switch on, closed when nobody used it for `minutes`: through the
  // server's own `browser_close` tool, the one a model would call. The server stays; the next browser call opens
  // a browser again. Never while a call is under way, once per idle stretch (not again until a call comes), and a
  // call that comes during the close waits for it. Each close is told to `onIdleClose` (the activity feed).
  async closeIdle(now = Date.now(), minutes = settings().mcp_idle.close_browser_min as number): Promise<string[]> {
    if (!(minutes > 0)) return [];
    const closed: string[] = [];
    for (const e of [...this.entries.values()]) {
      if (!e.config.close_idle_browser || !e.client || e.state !== "ready" || e.used === undefined || e.closedFor === e.used || (e.inflight ?? 0) > 0 || e.closing) continue;
      if (now - e.used < minutes * 60_000 || !this.browserClose(e)) continue;
      const client = e.client;
      e.closedFor = e.used;
      const idle = now - e.used;
      const close = (async () => {
        try {
          await client.callTool("browser_close", {}, AbortSignal.timeout(30_000), 30_000);
          closed.push(e.name);
          try { this.onIdleClose?.(e.name, idle); } catch { /* the feed is not the close */ }
        } catch (err) {
          this.errors.capture("server", err, { mcp: e.name, at: "idle browser close" });
        }
      })();
      e.closing = close;
      try { await close; } finally { if (e.closing === close) e.closing = undefined; }
    }
    return closed;
  }
  // A command server with a kept listing and no call for `minutes` loses its process (its tools stay listed, and the
  // next call starts it again). Never one with a call under way, a browser Keel may not close (the owner's switch
  // decides that, above), a resource it is told about, or a task it runs. Each stop is told to `onIdleStop`.
  stopIdle(now = Date.now(), minutes = settings().mcp_idle.stop_min as number): string[] {
    if (!(minutes > 0)) return [];
    const stopped: string[] = [];
    for (const e of [...this.entries.values()]) {
      const c = e.client;
      if (!c || e.state !== "ready" || e.cold || !this.sleeps(e) || e.closing || (e.inflight ?? 0) > 0 || c.inflight > 0 || e.subscribed.size > 0) continue;
      // A listing the owner has not accepted stays held with its process, where it is read from the server itself.
      if (!this.accepted(e, e.tools, e.instr ?? null)) continue;
      // (Its browser is the owner's to close: a server that opens one stops only when the owner chose to close it when idle.)
      if (this.browserClose(e) && !e.config.close_idle_browser) continue;
      const since = Math.max(e.used ?? 0, e.last ?? 0);
      if (!since || now - since < minutes * 60_000) continue;
      // What it lists now is what is kept: it sleeps on that.
      this.keep(e);
      e.client = undefined;
      e.connecting = undefined;
      e.abort = undefined;
      c.onClose = undefined;
      c.retire();
      e.state = "idle";
      e.cold = true;
      e.error = undefined;
      stopped.push(e.name);
      try { this.onIdleStop?.(e.name, now - since); } catch { /* the feed is not the stop */ }
    }
    return stopped;
  }
  onIdleStop?: (name: string, idleMs: number) => void;

  // Told once for each browser closed for idleness: the server's name and how long it had been idle.
  onIdleClose?: (name: string, idleMs: number) => void;
  private idleTimer?: ReturnType<typeof setInterval>;

  private async callRaw(name: string, tool: string, input: unknown, ctx: ToolContext, meta?: Record<string, unknown>, app?: AppCall): Promise<ToolOutput> {
    const e = this.entries.get(name);
    const shown = e?.label ?? name; // the name the session knows it by
    const config = e?.config;
    let tools = e?.tools;
    const asleep = !!e?.cold;
    let client: McpClient;
    try {
      client = await this.ensure(name);
      // A server that started for this call: the listing it gave is the one this call is checked against (the kept one was not its own).
      if (asleep && e) tools = e.tools;
    } catch (err) {
      const msg = e?.state === "needs_auth" ? (e.session ? `${shown} asks for a sign-in, which a server the editor passed cannot do here: the editor passes its credentials in the server's headers.` : `${shown} needs sign-in: the owner signs in from the MCP servers panel.`) : e?.state === "error" ? this.withEnvHint(e, (err as Error).message) : (err as Error).message;
      return { content: `MCP server ${shown} is not available: ${msg}`, is_error: true };
    }
    // A tool the owner has not accepted is not sent, however the call was made.
    const held = this.withheld(e, tool);
    if (held) return { content: held, is_error: true };
    // Keep the same entry and listing across connection setup and (for HTTP)
    // header preparation. Those awaits are still before the request is sent.
    const authorize = ctx.authorizationError ? () => ctx.authorizationError!() ??
      (!e || this.entries.get(name) !== e || e.client !== client || e.config !== config || e.tools !== tools
        ? "Refused: the MCP server or tool changed before invocation. Look up the tool again." : undefined) : undefined;
    // A call a program made has no card of its own: its questions get no answer.
    const card = ctx.callId && !ctx.nestedIn ? `${ctx.sessionId}:${ctx.callId}` : undefined;
    // A call that asks past a bound is ended here: its own stop, beside the session's.
    const limit = new AbortController();
    const signal = AbortSignal.any([ctx.signal, limit.signal]);
    const call: CallAsks = { asked: 0, declined: 0, queued: 0, self: 0, roots: 0, notes: new Set(), end: () => {
      limit.abort();
      // A server that asks while its call runs, on a connection where nothing
      // names the call, goes on asking after the call was ended: its next
      // question would reach this session's next call on it. The connection
      // goes with the call; the next call starts the server again.
      if (client.era === "legacy" && client.unnamedRequests) client.drop(`a call of ${shown}__${tool} was ended because of the questions it asked, and the server may still be asking`);
    }, client, readOnly: e ? (e.bundled ? e.bundled.reads(tool) : !!e.config.read_tools?.includes(tool)) : false };
    // What the model is told besides the result: what the server asked that got no answer, and why.
    // The first call since it connected, when the server itself failed it (an error it answered, or a
    // failure on the way: not Keel's end of the call, not the owner's), says what of the environment it went without.
    const first = e?.firstCall && e.client === client;
    if (e && first) e.firstCall = false;
    const envNote = () => { if (first && e && this.stdioOwn(e)) call.notes.add(envHint(e.label ?? e.name, e.config, serverEnv(e.config))); };
    const noted = (out: ToolOutput): ToolOutput => {
      if (!call.notes.size) return out;
      const text = [...call.notes].map((n) => `[keel] ${n}`).join("\n");
      return { ...out, content: typeof out.content === "string" ? `${out.content}\n\n${text}` : [...out.content, { type: "text", text }] };
    };
    // A server that keeps the folders it was told is told they changed when this call's session has others.
    client.rootsChange(this.rootsFor(ctx), ctx.sessionId);
    let r: McpCallResult | undefined;
    const taskSupport = tools?.find((t) => t.name === tool)?.execution?.taskSupport;
    // (Again after the owner finished a step a server asked for in its browser: see firstSteps.)
    while (!r) try {
      r = await client.callTool(tool, input, signal, (e?.config.tool_timeout_secs ?? 600) * 1000, meta, authorize, {
        session: ctx.sessionId,
        // (By the name the session knows the server by: the card and the notes show it.)
        ask: (q) => this.input(shown, q, ctx, card, call),
        dropped: (method, why) => call.notes.add(`${shown} ${method === "roots/list" ? "asked for the session's folder" : "asked the owner a question"} while this call ran and got no answer: ${why}. If the result depends on it, run the call again when no other call is using ${shown}.`),
      }, e?.config.tool_max_secs ? e.config.tool_max_secs * 1000 : undefined, taskSupport);
    } catch (err) {
      const steps = err instanceof RpcError && err.code === URL_REQUIRED && !call.ended && !ctx.signal.aborted ? linksRequired(err.data) : [];
      if (steps.length) {
        const why = await this.firstSteps(shown, tool, steps, ctx, card, call);
        if (!why) continue;
        this.callEnded(ctx.sessionId, card);
        return noted({ content: why, is_error: true });
      }
      this.callEnded(ctx.sessionId, card);
      // Ended for a bound on its questions: the result says which, and that the call did not finish.
      if (call.ended) return noted({ content: `${shown}__${tool} was ended: ${call.ended} Its work may be half done: check before calling it again.`, is_error: true });
      if (err instanceof McpAuthorizationError) return { content: err.message, is_error: true };
      if (err instanceof AuthRequired && e) {
        e.state = "needs_auth";
        e.www = err.wwwAuthenticate;
        return { content: `${shown} needs sign-in again: the owner signs in from the MCP servers panel.`, is_error: true };
      }
      // A call the owner's stop or a daemon stop ended did not fail.
      if (!ctx.signal.aborted) this.errors.capture("tool", err, { mcp: name, tool, session: ctx.sessionId });
      if (err instanceof SessionExpired) return { content: `${shown}__${tool} did not run: ${err.message}. Keel opens a new session; the call was not sent again. Look the tool up again and call it if it is still needed.`, is_error: true };
      // A call that went out and got no answer (a timeout, a connection that ended) may have done its work, or
      // part of it: what its server says of calling it again is the model's to weigh (src/mcp/hints.ts). A
      // server's error answer and the owner's stop say nothing of the kind.
      const again = err instanceof RpcError || ctx.signal.aborted || call.readOnly ? ""
        : hintsOf(tools?.find((t) => t.name === tool)?.annotations)?.idempotent
          ? " It may have run before it failed. Its server says a second call with the same arguments changes nothing more (idempotentHint)."
          : " It may have run, or run in part, before it failed: check what it did before calling it again.";
      const said = (err as Error).message;
      if (!ctx.signal.aborted) envNote();
      return noted({ content: `${shown}__${tool} failed: ${again ? `${said.replace(/[.\s]+$/, "")}.${again}` : said}`, is_error: true });
    }
    this.callEnded(ctx.sessionId, card);
    // The schema of the tool as it was listed when the call went out (a list that changed meanwhile is the next call's).
    const declared = tools?.find((t) => t.name === tool)?.outputSchema;
    const schema = declared && typeof declared === "object" && !Array.isArray(declared) ? declared : undefined;
    if (r.isError) envNote();
    // A proxy's user and password the base passed it are masked in what its text says, as in its stderr and log lines.
    if (e && this.stdioOwn(e)) r = maskedText(r);
    app?.raw(r);
    const out = noted(await toOutput(r, ctx, `${shown}__${tool}`, schema));
    // A tool that names an app (src/mcp/apps.ts): its page is read now, once, and kept with this result.
    const def = tools?.find((t) => t.name === tool);
    const uri = !app && def ? appUriOf(def) : undefined;
    if (uri && e && this.apps) {
      const kept = await this.apps.keep({ server: name, source: binding(sourced(e.config), this.bindKey), shown, tool: def!, uri, input, result: r, ctx }).catch((err) => { this.errors.capture("tool", err, { mcp: name, tool, at: "mcp app", session: ctx.sessionId }); return undefined; });
      if (kept !== undefined) out.shown = { mcp_app: kept };
    }
    return out;
  }

  // MCP Apps: what keeps a tool's app with its result (src/server/routes/mcp-apps.ts sets it).
  // `source`: which server it is (src/mcp/sources.ts binding), so a later call of the app goes to that server only.
  apps?: { keep(at: { server: string; source: string; shown: string; tool: McpTool; uri: string; input: unknown; result: McpCallResult; ctx: ToolContext }): Promise<unknown> };

  // A tool an app of this server may call: one the owner accepted (as the
  // model is offered it), that its server does not keep from apps. `name` is
  // the server's own entry; nothing of another server is looked at. `source`
  // is the server the app came from, as it was when its page was kept: a
  // server under the same name with another command, address or account is
  // another server, and the app reaches nothing of it.
  async appTool(name: string, source: string, tool: string, session?: string): Promise<{ tool: CatalogTool; def: McpTool } | { refused: string }> {
    const e = this.entries.get(name);
    if (!e || e.bundled) return { refused: `the server ${e?.label ?? name} is not connected any more` };
    const shown = e.label ?? name;
    if (binding(sourced(e.config), this.bindKey) !== source) return { refused: `this app came from another server named ${shown}` };
    if (e.session && e.session !== session) return { refused: `${shown} is another session's server` };
    const no = this.refusal(name, session);
    if (no) return { refused: no };
    try { await this.ensure(name, 8_000); } catch (err) { return { refused: `${shown} is not available: ${(err as Error).message.split("\n")[0]}` }; }
    const def = this.view(e).find((t) => t.name === tool);
    if (!def) return { refused: `${shown} offers no tool ${tool}: an app calls only its own server's tools` };
    if (!visibleTo(def, "app")) return { refused: `${shown} keeps its tool ${tool} from its apps` };
    return { tool: this.catalogTool(e, def), def };
  }

  // An app's page as its server gives it: each content item whole, with its `_meta`.
  async readApp(name: string, uri: string, signal?: AbortSignal): Promise<{ uri?: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }[]> {
    const c = await this.ensure(name, 15_000);
    this.used(name);
    const r = await c.readResource(uri, signal);
    return Array.isArray(r?.contents) ? r.contents : [];
  }

  // ---- what a server asks while it works on a call ----

  // Calls whose question is open on a card now.
  private asking = new Set<string>();
  // Calls of tools the owner marked as reads (read_tools; a server's own
  // readOnlyHint is the server's word and does not count) that have a card
  // open, kept in a file. A daemon that stops or dies with such a card open
  // runs the call again, so the server asks again and the card is back
  // (callOutcome "waiting"): a call that only reads loses nothing by that.
  // Any other call that asked ends as a call a restart cut, which may have
  // partly run: the server had begun its work before it asked, and running
  // it again would do that work twice.
  private asked = new Set<string>();
  private askedPath: string;
  private parked = new Set<string>();
  private queue = new Map<string, Promise<unknown>>();
  private keepAsked() {
    try { writeFileSync(this.askedPath, JSON.stringify([...this.asked])); } catch (e) { this.errors.capture("server", e, { at: "mcp asked calls" }); }
  }
  awaitsOwner(sessionId: string, callId: string) { return this.asking.has(`${sessionId}:${callId}`); }
  askedBefore(sessionId: string, callId: string) { return this.asked.has(`${sessionId}:${callId}`); }
  park(sessionId: string) { this.parked.add(sessionId); }
  private callEnded(sessionId: string, card?: string) {
    if (card && !this.parked.has(sessionId) && this.asked.delete(card)) this.keepAsked();
  }

  private input(server: string, q: InputRequest, ctx: ToolContext, card: string | undefined, call: CallAsks): Promise<unknown> {
    // The folders of the session whose call the server works on.
    if (q.method === "roots/list") {
      // The folder does not change under a call: a server that asks for it over and over is ended like one that keeps asking the owner.
      if (++call.roots > QUESTIONS_MAX) {
        call.ended ??= `${server} asked for the session's folder more than ${QUESTIONS_MAX} times in this call.`;
        call.end?.();
        throw new RpcError(-32603, call.ended);
      }
      return Promise.resolve(this.rootsFor(ctx));
    }
    const sampling = q.method === "sampling/createMessage";
    if (q.method !== "elicitation/create" && !sampling) throw new RpcError(-32601, `keel does not support ${q.method}`);
    const mode = q.params?.mode ?? "form";
    // 2025-11-25 elicitation, Error Handling: a mode the client did not declare is invalid params.
    if (!sampling && mode !== "form" && mode !== "url") throw new RpcError(-32602, `keel offers form and url elicitation, not ${plain(mode, 40)} mode`);
    // Past a bound: the call ends, here and for every question it still sends.
    const end = (why: string): never => {
      call.ended ??= why;
      call.end?.();
      throw new RpcError(-32603, call.ended);
    };
    if (call.ended) end(call.ended);
    // Answered by Keel itself, as if the owner made no choice: a few times, then the call ends.
    // (A sampling request no one could allow is refused: its model is not asked.)
    const unasked = (why: string) => {
      if (++call.self > SELF_MAX) end(`${why} It asked ${call.self} questions that could not be put to the owner.`);
      call.notes.add(`${why} ${sampling ? "Its model was not asked." : "It was answered as if the owner made no choice."}`);
      if (sampling) return Promise.reject(new RpcError(-1, why));
      return Promise.resolve<ElicitResult>({ action: "cancel" });
    };
    const over = overLimit(server, call);
    if (over) end(over);
    call.asked++;
    if (!card) return unasked(`${server} asked the owner ${sampling ? "to let it use the session's model" : "a question"}, and a call a program made has no card to show it on: call the tool directly.`);
    if (call.queued >= QUEUED_MAX + 1) return unasked(`${server} asked more than ${QUEUED_MAX} questions at once: one card is shown at a time, and no more than that wait behind it.`);
    call.queued++;
    // One card per call: a second question waits for the first.
    const run = (this.queue.get(card) ?? Promise.resolve()).then(() => {
      const out = call.ended ?? declinedOut(server, call);
      return out ? end(out) : sampling ? this.sample(server, q.params, ctx, card, call) : mode === "url" ? this.elicitLink(server, q.params, ctx, card, call) : this.elicit(server, q.params, ctx, card, call, unasked);
    }).finally(() => { call.queued--; });
    const tail = run.catch(() => {});
    this.queue.set(card, tail);
    void tail.then(() => { if (this.queue.get(card) === tail) this.queue.delete(card); });
    return run;
  }

  // The folders a call of this session is answered with.
  // (None for a session whose tools run on another machine: its folder is a path there, and this server runs here.)
  private rootsFor(ctx: ToolContext) {
    return this.elsewhere?.(ctx.sessionId) ? { roots: [] } : rootsOf(ctx.cwd);
  }

  // A server that asks outside any call (many ask for the roots as soon as
  // they are connected): the folder the server itself was started in. A
  // question then has no card to be asked on, so no choice was made.
  private inputOutside(dir: string, q: InputRequest): Promise<unknown> {
    if (q.method === "roots/list") return Promise.resolve(rootsOf(dir));
    if (q.method === "elicitation/create") return Promise.resolve<ElicitResult>({ action: "cancel" });
    if (q.method === "sampling/createMessage") return Promise.reject(new RpcError(-1, "the owner allows a sampling request on a card under a call, and no call is running"));
    throw new RpcError(-32601, `keel does not support ${q.method}`);
  }

  // The session's model, for a server's sampling request (the daemon sets it):
  // its name for the card, and one reply with no tools and no history.
  sampler?: {
    // The model's name, the request's size in tokens, its window and the most it can cost (null: no price known).
    size(sessionId: string, req: SampleRequest): Promise<{ model: string; tokens: number; window: number; cost: number | null }>;
    run(sessionId: string, req: SampleRequest, signal: AbortSignal): Promise<{ text: string; model: string; stop: string }>;
  };

  // A server asks for a reply of the session's model (client/sampling). The
  // owner sees the whole request on the call's card and allows it or not;
  // only then is the model asked. The reply is shown on the card again: sent
  // as it is, or as the owner typed it, or not at all. A declined card is the
  // protocol's rejection (-1); a stopped turn is too.
  private async sample(server: string, params: unknown, ctx: ToolContext, card: string, call: CallAsks): Promise<unknown> {
    const req = samplingOf(params);
    if ("refuse" in req) throw new RpcError(req.code, req.refuse);
    if (!this.sampler) throw new RpcError(-32603, "no model answers sampling requests here");
    const size = await this.sampler.size(ctx.sessionId, req).catch((e) => { throw new RpcError(-32603, `the session's model cannot answer: ${(e as Error).message}`); });
    const model = size.model;
    // One the model cannot read is refused before the owner is asked.
    if (size.window && size.tokens + req.maxTokens > size.window) throw new RpcError(-32602, `the request is about ${size.tokens} tokens, and with its reply of up to ${req.maxTokens} it is over ${model}'s window of ${size.window}`);
    const cost = size.cost === null ? "no price is known for it" : `it costs at most about $${size.cost < 0.01 ? size.cost.toFixed(4) : size.cost.toFixed(2)} at the list price`;
    const send = await this.onCard(server, ctx, card, call, `${server} asks to use this session's model`, {
      from: server, label: `What ${server} would send to ${model}`,
      message: req.shown,
      questions: [{ id: "send", question: `Send this to ${model}?`, options: [{ label: "Send" }] }],
      notes: [`About ${size.tokens} tokens of ${size.window ? `the model's window of ${size.window}` : "input"}; ${cost}.`, ...req.notes],
    });
    if (send === null) throw new RpcError(-1, "the owner made no choice: the request was not sent");
    if (send === DECLINED) { call.declined++; throw new RpcError(-1, "the owner rejected the sampling request"); }
    let r: { text: string; model: string; stop: string };
    try { r = await this.sampler.run(ctx.sessionId, req, ctx.signal); } catch (e) {
      if (ctx.signal.aborted) throw new RpcError(-1, "the owner stopped the turn while the model answered");
      throw new RpcError(-32603, `${model} could not answer: ${(e as Error).message}`);
    }
    // What goes to the server is what the card shows: the reply without the characters a reader cannot see.
    const text = withoutHidden(r.text);
    const seen = cardText(text, "The reply");
    const reply = await this.onCard(server, ctx, card, call, `${model} answered ${server}`, {
      from: server, label: `${model}'s reply, for ${server}`,
      message: seen.shown || "(an empty reply)",
      questions: [{ id: "reply", question: `Send this reply to ${server}, or type the reply to send instead`, options: [{ label: "Send" }] }],
      notes: [...(seen.note ? [seen.note] : []), `It stopped with ${r.stop}.`],
    });
    if (reply === null) throw new RpcError(-1, "the owner made no choice: the reply was not sent");
    if (reply === DECLINED) { call.declined++; throw new RpcError(-1, "the owner rejected the reply"); }
    const typed = typeof reply.reply?.other === "string" ? reply.reply.other.trim() : "";
    return { role: "assistant", content: { type: "text", text: typed || text }, model: r.model, stopReason: typed ? "endTurn" : stopReason(r.stop) };
  }

  // One card on a call, as a server's question is shown: the owner's answer,
  // DECLINED, or null when no choice was made (a stopped turn).
  private async onCard(server: string, ctx: ToolContext, card: string, call: CallAsks, said: string, asked: Omit<Asked, "id">) {
    const id = `${Date.now().toString(36)}-${++this.questions}`;
    if (call.readOnly && !this.asked.has(card)) {
      this.asked.add(card);
      this.keepAsked();
    }
    this.asking.add(card);
    const tell = (f: (h: ReturnType<typeof allHooks>[number]) => void) => { for (const h of allHooks()) try { f(h); } catch (e) { this.errors.capture("server", e, { hook: "ownerAsked", session: ctx.sessionId, server }); } };
    tell((h) => h.ownerAsked?.(ctx.sessionId, ctx.callId!, said, id));
    let answered = false;
    try {
      const a = await askFor(ctx, { id, ...asked });
      answered = a !== null && a !== DECLINED;
      return a;
    } finally {
      this.asking.delete(card);
      if (!this.parked.has(ctx.sessionId) && this.asked.delete(card)) this.keepAsked();
      tell((h) => h.ownerAnswered?.(ctx.sessionId, ctx.callId!, answered, id));
    }
  }

  // The owner answers on the call's question card. An answer the schema does
  // not take is asked again with what was wrong; a declined card is the
  // protocol's decline; a stopped turn (or a stopping daemon) is its cancel.
  private questions = 0;
  private async elicit(server: string, params: unknown, ctx: ToolContext, card: string, call: CallAsks, unasked: (why: string) => Promise<ElicitResult>): Promise<ElicitResult> {
    const form = formOf(params);
    if (form.unanswerable) return unasked(`${server} asked the owner a form that cannot be answered: ${form.unanswerable}.`);
    // One id per question, so the card knows a new question from the last one on the same call.
    const id = `${Date.now().toString(36)}-${++this.questions}`;
    if (call.readOnly && !this.asked.has(card)) {
      this.asked.add(card);
      this.keepAsked();
    }
    this.asking.add(card);
    const tell = (f: (h: ReturnType<typeof allHooks>[number]) => void) => { for (const h of allHooks()) try { f(h); } catch (e) { this.errors.capture("server", e, { hook: "ownerAsked", session: ctx.sessionId }); } };
    tell((h) => h.ownerAsked?.(ctx.sessionId, ctx.callId!, `${server} asks: ${form.message}`, id));
    let answered = false;
    try {
      for (let round = 0, note: string | undefined; ; round++) {
        const a = await askFor(ctx, {
          id, from: server, message: form.message, questions: form.questions,
          ...(form.notes.length ? { notes: form.notes } : {}), ...(form.sensitive ? { sensitive: true } : {}), ...(note ? { note, round } : {}),
        });
        if (a === null) return { action: "cancel" };
        if (a === DECLINED) { call.declined++; return { action: "decline" }; }
        const r = form.content(a);
        if ("content" in r) { answered = true; return { action: "accept", content: r.content }; }
        note = r.problems.join(" ");
      }
    } finally {
      this.asking.delete(card);
      // The card closed: a restart from here on finds a call that may have gone on.
      if (!this.parked.has(ctx.sessionId) && this.asked.delete(card)) this.keepAsked();
      tell((h) => h.ownerAnswered?.(ctx.sessionId, ctx.callId!, answered, id));
    }
  }

  // A server sends the owner to a page (URL mode). The card shows the
  // server's words, the whole address and its site, and what to know before
  // opening it; the owner opens it from the card in their own browser, which
  // is the protocol's accept, or declines. A stopped turn is its cancel.
  // Nothing of Keel's opens or fetches the address. A server that says the
  // step is done while the card is still open closes the card: the owner
  // went there another way.
  private async elicitLink(server: string, params: unknown, ctx: ToolContext, card: string, call: CallAsks): Promise<ElicitResult> {
    const link = linkOf(params);
    if ("refuse" in link) throw new RpcError(-32602, `keel did not show the page: ${link.refuse}`);
    const watch = link.id ? call.client?.watchLink(link.id) : undefined;
    try {
      const a = await this.onCard(server, watch ? { ...ctx, signal: AbortSignal.any([ctx.signal, watch.signal]) } : ctx, card, call, `${server} asks you to open a page at ${link.host}`, {
        from: server, message: link.message, questions: [], link: { url: link.url, host: link.host },
        ...(link.notes.length ? { notes: link.notes } : {}),
      });
      if (watch?.signal.aborted && !ctx.signal.aborted) return { action: "accept" };
      if (a === null) return { action: "cancel" };
      if (a === DECLINED) { call.declined++; return { action: "decline" }; }
      return { action: "accept" };
    } finally {
      watch?.drop();
    }
  }

  // A server answered a call with -32042: it runs only after the owner
  // finished a step on each page it names (2025-11-25 elicitation, URL
  // Elicitation Required Error). Each page is put to the owner as a server's
  // question is, with its bounds. After the owner went to a page, the card
  // waits for the step: it closes when the server says the step is done
  // (notifications/elicitation/complete), or when the owner says so (I finished),
  // and the call is made again. Says why the call did not run, or nothing
  // when it is to be made again.
  private async firstSteps(server: string, tool: string, steps: Record<string, unknown>[], ctx: ToolContext, card: string | undefined, call: CallAsks): Promise<string | undefined> {
    const name = `${server}__${tool}`;
    for (const step of steps) {
      const link = linkOf(step);
      const host = "refuse" in link ? "a page" : link.host;
      const said = (what: string) => `${name} did not run: ${server} needs the owner to finish a step at ${host} in their browser first (an MCP URL elicitation), and ${what} Ask the owner before calling it again.`;
      const watch = "refuse" in link ? undefined : call.client?.watchLink(link.id!);
      try {
        let a: ElicitResult;
        try {
          a = (await this.input(server, { method: "elicitation/create", params: { ...step, mode: "url" } }, ctx, card, call)) as ElicitResult;
        } catch (e) {
          return said(`the page could not be put to the owner: ${(e as Error).message}`);
        }
        if (a.action === "decline") return said("the owner declined it.");
        if (a.action !== "accept" || "refuse" in link) return said(call.notes.size ? "it was not put to the owner." : "the owner made no choice.");
        if (watch?.signal.aborted) continue;
        const done = await this.onCard(server, watch ? { ...ctx, signal: AbortSignal.any([ctx.signal, watch.signal]) } : ctx, card!, call, `${server} waits for you to finish at ${link.host}`, {
          from: server, message: link.message, questions: [], link: { url: link.url, host: link.host, waiting: true },
        });
        if (watch?.signal.aborted && !ctx.signal.aborted) continue;
        if (done === null) return said("the owner made no choice.");
        if (done === DECLINED) { call.declined++; return said("the owner cancelled it."); }
      } finally {
        watch?.drop();
      }
    }
    return undefined;
  }

  // ---- owner actions ----

  // The owner's servers and the ones Keel brings; with a session, that
  // session's own too (`session` on each), under the names it knows them by.
  list(session?: string): McpServerState[] {
    const twins = this.twinNames();
    return [...this.entries.values()].filter((e) => !e.session || e.session === session).sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name)).map((e) => {
      const live = e.bundled?.live && e.state !== "disabled" ? e.bundled.live.state() : null;
      // A plugin's server is shown as its plugin wrote it, a sensitive setting not filled in.
      const shown = e.shown ?? e.config;
      return {
      name: e.label ?? e.name,
      ...(e.session ? { session: e.session } : {}),
      transport: e.bundled?.live ? "socket" : e.config.url ? "http" : "stdio",
      target: e.bundled?.live?.target ?? (e.session ? shownTarget(e.config) : maskedTarget(shown)),
      enabled: e.state !== "disabled",
      state: live?.state ?? e.state,
      // (Of a session's own server, the reason in one line: what its command printed is not shown.)
      error: live ? live.error : e.session ? e.error?.split("\nstderr:")[0]!.split("\n")[0] : e.error,
      tools: (e.bundled && !e.client ? e.bundled.tools : e.tools).length,
      tool_names: (e.bundled && !e.client ? e.bundled.tools : e.tools).map((t) => t.name),
      read_tools: e.bundled ? [] : (e.config.read_tools ?? []),
      hinted_reads: e.bundled ? [] : e.tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
      // (What the model is offered: a changed tool the owner has not accepted is offered as accepted.)
      schema_fit: e.bundled ? [] : fitReport(this.view(e)),
      tool_hints: e.bundled ? {} : Object.fromEntries(e.tools.map((t) => [t.name, hintWords(hintsOf(t.annotations))] as const).filter(([, w]) => w.length)),
      ...this.heldOf(e),
      ...(twins.get(e.name) ? { same_as: twins.get(e.name) } : {}),
      ...(e.bundled ? {} : { class: classify(shown, !!e.config.url && this.oauth.signedIn(e.name)) }),
      last_connected: e.last,
      era: e.client?.era,
      version: e.client?.version,
      ...(e.config.transport === "sse" || e.sse ? { sse: true as const } : {}),
      // Name, title and version; icons (data URIs of kilobytes) stay out of a list polled every second or two.
      server_info: e.client?.serverInfo ? { name: e.client.serverInfo.name, title: (e.client.serverInfo as any).title, version: e.client.serverInfo.version } : undefined,
      endpoint: e.bundled ? undefined : endpoint(maskedServer(shown)),
      sign_in: !!e.config.url && !e.config.bearer_env && !e.config.headers_helper,
      ...(e.plugin ? { plugin: e.plugin } : {}),
      ...(e.retry && e.state === "error" ? { retry: { attempt: e.retry.attempt, next_ms: e.retry.next, until_ms: e.retry.since + RETRY.giveUp } } : {}),
      sync: e.config.sync ? { ...e.config.sync, label: this.labels.get(e.config.sync.source) ?? e.config.sync.source, gone: this.gone.has(e.name) } : undefined,
      signed_in: !!e.config.url && this.oauth.signedIn(e.name),
      bundled: e.bundled?.label,
      resources: !!(e.client ? e.client.capabilities.resources : e.cold && e.caps?.resources),
      prompts: !!(e.client ? e.client.capabilities.prompts : e.cold && e.caps?.prompts),
      resources_rev: e.resourcesRev,
      prompts_rev: e.promptsRev,
      logging: !!e.client?.capabilities.logging,
      log_rev: e.logRev,
      completions: !!e.client?.capabilities.completions,
      resource_updates: e.updates,
      ...(e.bundled ? {} : { idle_browser: { on: !!e.config.close_idle_browser, can: this.browserClose(e), min: settings().mcp_idle.close_browser_min as number } }),
      channel: { on: this.channelOn(e), declared: !!e.client?.channel, status: !!e.client?.capabilities.experimental?.[STATUS_CAP] },
    } as McpServerState;
    });
  }

  // A server the owner's routes can name. A session's own is not one: it is
  // set and dropped with its session and never written to the owner's file.
  has(name: string) {
    const e = this.entries.get(name);
    return !!e && !e.session;
  }

  add(name: string, config: McpServerConfig): string | null {
    const bad = validate(name, config);
    if (bad) return bad;
    this.save({ ...this.cfg.servers, [name]: config });
    this.ownerAdded.add(name);
    if (this.entries.get(name)?.plugin) this.movePlugin(name);
    this.drop(name);
    this.addEntry(name, config);
    if (config.enabled !== false) this.ensure(name).catch(() => {});
    return null;
  }

  // Pushed events (src/mcp/channel.ts). The daemon's route takes them.
  onChannel?: (from: ChannelFrom, params: unknown) => void;
  // A plugin's server is not the owner's file's: whether its events are taken is kept in the state.
  private pluginChannelsPath = () => join(this.stateDir, "mcp-plugin-channels.json");
  private pluginOn?: Set<string>;
  private pluginChannels(): Set<string> {
    if (!this.pluginOn) try { this.pluginOn = new Set(JSON.parse(readFileSync(this.pluginChannelsPath(), "utf8")) as string[]); } catch { this.pluginOn = new Set(); } // none on yet
    return this.pluginOn;
  }
  private channelOn(e: Entry) {
    return e.session ? !!e.channel : e.plugin ? this.pluginChannels().has(e.name) : !!e.config.channel;
  }
  private channelFrom(e: Entry): ChannelFrom {
    return { server: e.label ?? e.name, entry: e.name, ...(e.session ? { session: e.session } : {}), on: this.channelOn(e), ident: createHash("sha256").update(endpoint(e.config)).digest("hex").slice(0, 16) };
  }
  // The entry a name means: the owner's server, else the session's own under that name.
  private named(name: string, session?: string): Entry | undefined {
    const e = this.entries.get(name);
    if (e && !e.session) return e;
    return session ? [...this.entries.values()].find((x) => x.session === session && x.label === name) : undefined;
  }
  channelOf(name: string, session?: string): ChannelFrom | undefined {
    const e = this.named(name, session);
    return e && !e.bundled ? this.channelFrom(e) : undefined;
  }
  // The owner takes a server's events or stops taking them. The owner's server
  // keeps it in its file; a session's own keeps it as long as it lives.
  setChannel(name: string, on: boolean, session?: string): ChannelFrom {
    const e = this.named(name, session);
    if (!e) throw Object.assign(new Error(`no MCP server named ${name}`), { status: 404 });
    if (e.bundled) throw Object.assign(new Error(`${name} is built in: it sends no events`), { status: 409 });
    if (e.session) e.channel = on;
    else if (e.plugin) {
      const set = new Set(this.pluginChannels());
      if (on) set.add(e.name);
      else set.delete(e.name);
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.pluginChannelsPath(), JSON.stringify([...set]));
      this.pluginOn = set; // only once it is written
    } else if (!!e.config.channel !== on) {
      const c: McpServerConfig = { ...e.config };
      if (on) c.channel = true;
      else delete c.channel;
      this.save({ ...this.cfg.servers, [name]: c });
      e.config = c;
    }
    // A server that takes events must be there to push them: one with no process starts now.
    if (on && e.cold && !this.sleeps(e)) {
      e.cold = false;
      this.ensure(e.name).catch(() => {}); // its state says why it failed
    }
    return this.channelFrom(e);
  }
  // What became of an event, to a server that asked to be told (STATUS_CAP).
  tellChannel(entry: string, params: Record<string, unknown>) {
    const c = this.entries.get(entry)?.client;
    if (!c?.capabilities.experimental?.[STATUS_CAP] || c.isClosed) return;
    c.notify(STATUS_METHOD, params).catch((err) => this.errors.capture("server", err, { mcp: entry, at: "mcp channel status" }));
  }

  // ---- tool definitions on a leash (src/mcp/pins.ts) ----

  private pinsPath: string;
  private pins: Record<string, Pin> = {};
  // Servers set up before pins were kept that have not listed yet: each is
  // pinned as it is at its first listing, marked so, and told in one alert.
  private upgradePending = new Set<string>();
  // No pins file when this manager began, in a state an older build kept MCP
  // servers in (it wrote what they published): every server of the owner's
  // that lists in this run, but one the owner adds in it, was set up before pins.
  private pinsFresh = false;
  private pinsMissing = false;
  private upgradeRun = false;
  private ownerAdded = new Set<string>();
  // The pins file could not be read: no server is pinned anew from what it
  // lists (that would accept whatever it lists now); each is held whole until
  // the owner accepts it again.
  private pinsBroken = false;
  // Goes up with every change of a pin: an offered view of an older one is made again.
  private pinsRev = 0;
  // The owner is told of a set of changes once (the daemon's route raises the alert).
  onToolsHeld?: (server: string, changes: ToolChange[], instructions?: InstructionsChange) => void;
  // Servers set up before this build were pinned as they are: told once a batch.
  onUpgradePinned?: (servers: string[]) => void;

  private loadPins() {
    let text: string;
    try {
      text = readFileSync(this.pinsPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return this.pinsFailed(err as Error);
      this.pinsMissing = true;
      this.pinsFresh = this.upgradeRun = existsSync(this.publishedPath);
      return;
    }
    try {
      const f = readPins(text);
      this.pins = f.servers;
      this.upgradePending = new Set(f.upgrade ?? []);
    } catch (err) {
      this.pinsFailed(err as Error);
    }
  }

  // The file stays as it was, beside the one written next, for the owner to look at.
  private pinsFailed(err: Error) {
    this.pinsBroken = true;
    let kept = "";
    try {
      const to = `${this.pinsPath}.broken-${Date.now()}`;
      renameSync(this.pinsPath, to);
      kept = ` It is kept as ${to}.`;
    } catch {} // nothing to keep: the file could not be read at all
    this.errors.capture("server", new Error(`The MCP pins file ${this.pinsPath} cannot be read (${err.message}): every server of the owner's is held until its tools are accepted again in Settings > MCP servers.${kept}`), { at: "mcp pins" });
  }

  // The first start after pins began: every server of the owner's it finds
  // was set up before. A start with no pins file writes one at once, empty
  // or not: a server added in this run that has not listed by the next is
  // the owner's new one, not one set up before pins.
  private markUpgrade() {
    if (!this.pinsMissing || runMode.client) return;
    this.pinsMissing = false;
    if (this.pinsFresh) for (const e of this.entries.values()) if (this.leashed(e) && !this.pins[e.name]) this.upgradePending.add(e.name);
    this.pinsFresh = false;
    this.writePins();
  }

  // Pinned: the owner's servers. A server Keel brings ships its own list; a
  // session's own is the editor's or a project's, and lives with its session.
  private leashed(e: Entry) {
    return !e.bundled && !e.session;
  }
  private pinIdent(e: Entry) {
    return digest(endpoint(e.config)).slice(0, 16);
  }
  private pinOf(e: Entry): Pin | undefined {
    const p = this.leashed(e) ? this.pins[e.name] : undefined;
    return p && p.ident === this.pinIdent(e) ? p : undefined;
  }

  private writePins(at?: string) {
    this.pinsRev++;
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const f = { version: 1, servers: this.pins, ...(this.upgradePending.size ? { upgrade: [...this.upgradePending] } : {}) };
      writeFileSync(this.pinsPath + ".tmp", JSON.stringify(f), { mode: 0o600 });
      renameSync(this.pinsPath + ".tmp", this.pinsPath);
    } catch (err) {
      this.errors.capture("server", err, { at: "mcp pins", ...(at ? { mcp: at } : {}) });
    }
  }

  // A listing came: the first one of a server the owner added is what the
  // owner accepted with it; a later one that differs is held, and the owner
  // is told once of each set of changes. A tool the server no longer lists
  // stays pinned (it is not offered): one that comes back as it was needs no
  // second look. `instructions` are the ones it gave at its connect.
  private settle(e: Entry, instructions: string | undefined) {
    if (!this.leashed(e)) return;
    const instr = instructions === undefined ? null : conceal(instructions);
    e.instr = instr;
    const ident = this.pinIdent(e);
    let p = this.pins[e.name];
    if (!p || p.ident !== ident) {
      if (!p && this.pinsBroken) p = this.pins[e.name] = { ident, at: Date.now(), tools: [], instructions: null };
      else {
        const upgrade = this.upgradePending.delete(e.name) || (this.upgradeRun && !p && !this.ownerAdded.has(e.name));
        this.pins[e.name] = { ident, at: Date.now(), tools: e.tools.map(defOf), instructions: instr, ...(upgrade ? { upgrade: "untold" as const } : {}) };
        this.writePins(e.name);
        if (upgrade) this.tellUpgrade();
        return;
      }
    }
    const { changes, instructions: changed } = this.changesOf(e);
    const told = changes.length || changed ? changeDigest(changes, changed) : undefined;
    if (told === p.told) return;
    if (told) p.told = told;
    else delete p.told;
    this.writePins(e.name);
    if (told) {
      try { this.onToolsHeld?.(e.name, changes, changed); } catch (err) { this.errors.capture("server", err, { at: "mcp tools held", mcp: e.name }); }
    }
  }

  // The servers pinned as they were when this build first ran are told in one
  // alert, once none of those still waiting to list is connecting.
  private tellUpgrade() {
    if ([...this.upgradePending].some((n) => this.entries.get(n)?.state === "connecting")) return;
    const untold = Object.entries(this.pins).filter(([, p]) => p.upgrade === "untold").map(([n]) => n);
    if (!untold.length) return;
    for (const n of untold) this.pins[n]!.upgrade = "told";
    this.writePins();
    try { this.onUpgradePinned?.(untold); } catch (err) { this.errors.capture("server", err, { at: "mcp pinned at upgrade" }); }
  }

  // The owner looked at a server pinned at the upgrade.
  pinSeen(name: string) {
    const p = this.pins[name];
    if (!p?.upgrade) return;
    delete p.upgrade;
    this.writePins(name);
  }

  // What the model is offered of a server's listing.
  // What the model is offered of a server: its accepted tools less those its
  // server keeps for its apps (`_meta.ui.visibility` without "model").
  private forModel(e: Entry): McpTool[] {
    const all = this.view(e);
    return all.some((t) => !visibleTo(t, "model")) ? all.filter((t) => visibleTo(t, "model")) : all;
  }

  private view(e: Entry): McpTool[] {
    if (!this.leashed(e)) return e.tools;
    if (e.view && e.view.from === e.tools && e.view.rev === this.pinsRev) return e.view.tools;
    const p = this.pinOf(e);
    // A listing not settled yet (none came) offers what is pinned of it: nothing.
    const tools = p ? offered(p.tools, e.tools) : [];
    e.view = { from: e.tools, rev: this.pinsRev, tools };
    return tools;
  }

  // The instructions a session's prompt carries of an owner's server: the
  // accepted ones. Before its first listing, what it last published (that is
  // what its first listing pins); none while the pins file could not be read.
  private pinnedInstructions(e: Entry): string | undefined {
    const p = this.pinOf(e);
    if (p) return p.instructions ?? undefined;
    return this.pinsBroken ? undefined : this.lastPublished(e)?.instructions;
  }

  private changesOf(e: Entry): { changes: ToolChange[]; instructions?: InstructionsChange } {
    // Asleep it lists what the owner accepted (that is the only listing that sleeps): nothing it could change is read from a file.
    if (e.cold) return { changes: [] };
    const instr = e.instr ?? null;
    if (e.diff && e.diff.from === e.tools && e.diff.rev === this.pinsRev && e.diff.instr === instr) return e.diff;
    const p = this.pinOf(e);
    const changes = p ? diffTools(p.tools, e.tools).changes : [];
    // (Instructions are compared once it has connected: before that there is nothing of its own to compare.)
    const instructions = p && e.instr !== undefined ? instructionsChange(p.instructions, instr) : undefined;
    e.diff = { from: e.tools, rev: this.pinsRev, instr, changes, ...(instructions ? { instructions } : {}) };
    return e.diff;
  }
  // The owner's entries that are one server under several names (what the page says, and what one alert names):
  // by entry name, the other names. The same command and arguments or address, or the same listed tools.
  private twinNames(): Map<string, string[]> {
    const by = new Map<string, string[]>();
    for (const e of this.entries.values()) {
      if (!this.leashed(e)) continue;
      const keys = [`e:${endpoint(e.config)}`, ...(e.tools.length ? [`t:${digest(canon(e.tools.map(defOf).sort((a, b) => a.name.localeCompare(b.name))))}`] : [])];
      for (const k of keys) (by.get(k) ?? by.set(k, []).get(k)!).push(e.name);
    }
    const out = new Map<string, string[]>();
    for (const names of by.values()) {
      if (names.length < 2) continue;
      for (const n of names) out.set(n, [...new Set([...(out.get(n) ?? []), ...names.filter((m) => m !== n)])]);
    }
    return out;
  }
  // The names of this server's twins, for a notice that names them all.
  twinsOf(name: string): string[] {
    return this.twinNames().get(name) ?? [];
  }

  private heldOf(e: Entry): Pick<McpServerState, "held" | "pinned_at" | "pinned_at_upgrade"> {
    const p = this.pinOf(e);
    if (!p) return {};
    const { changes, instructions } = this.changesOf(e);
    return {
      pinned_at: p.at,
      ...(p.upgrade ? { pinned_at_upgrade: true } : {}),
      ...(changes.length || instructions ? { held: { digest: changeDigest(changes, instructions), changes, ...(instructions ? { instructions } : {}) } } : {}),
    };
  }

  // Why a call of this tool is not sent: the owner has not accepted it.
  private withheld(e: Entry | undefined, tool: string): string | undefined {
    if (!e || !this.leashed(e) || e.state !== "ready") return;
    const c = this.changesOf(e).changes.find((x) => x.name === tool);
    if (c?.kind === "added") return `${e.name}__${tool} is new and the owner has not accepted it yet; it is not offered until then.`;
  }

  // An owner's command, started with serverEnv (env.ts).
  private stdioOwn(e: Entry) {
    return this.leashed(e) && !!e.config.command && !e.config.url;
  }
  // A failure of an owner's command, with what of the environment it went
  // without in its first line (the panel and the model read that line; what
  // it printed stays after it).
  private withEnvHint(e: Entry, message: string): string {
    if (!this.stdioOwn(e)) return message;
    if (message.includes("Keel passes a base set of variables")) return message;
    const at = message.indexOf("\n");
    const head = at < 0 ? message : message.slice(0, at), tail = at < 0 ? "" : message.slice(at);
    return `${head.replace(/[.\s]+$/, "")}. ${envHint(e.label ?? e.name, e.config, serverEnv(e.config))}${tail}`;
  }

  // The owner accepts what the server lists now. `digest` is the set of
  // changes the owner was shown: one the server changed again since is not
  // taken on the strength of the older look.
  acceptTools(name: string, digest: string) {
    const e = this.entries.get(name);
    if (!e || !this.leashed(e)) throw Object.assign(new Error(`no MCP server of the owner's named ${name}`), { status: 404 });
    // With no process there is nothing of the server's own to accept: it starts, and its listing is reviewed as it comes.
    if (e.cold) {
      this.ensure(name).catch(() => {});
      throw Object.assign(new Error(`${name} has no process: it is starting, look at its tools again`), { status: 409 });
    }
    const { changes, instructions } = this.changesOf(e);
    if (!changes.length && !instructions) return;
    if (!digest) throw Object.assign(new Error("an acceptance names the change set the owner was shown (held.digest)"), { status: 400 });
    if (changeDigest(changes, instructions) !== digest) throw Object.assign(new Error(`${name} changed its tools again since: look at them again`), { status: 409 });
    this.pins[name] = { ident: this.pinIdent(e), at: Date.now(), tools: e.tools.map(defOf), instructions: e.instr ?? null };
    this.writePins(name);
  }

  // What kind of server it is, for the guards that weigh where content comes
  // from and where it goes. None for a server Keel brings (it is judged by its own word).
  classOf(name: string): ServerClass | undefined {
    const e = this.entries.get(name);
    if (!e || e.bundled) return;
    return classify(e.shown ?? e.config, !!e.config.url && !e.session && this.oauth.signedIn(e.name));
  }

  // The owner answers what kind of server it is; null forgets an answer (the config's reading stands again).
  setClass(name: string, answers: Partial<Record<ClassKey, boolean | null>>) {
    const e = this.entries.get(name)!;
    if (e.bundled) throw new Error(`${name} is built in: it is judged by Keel's own word`);
    if (e.plugin) throw new Error(pluginWord(e.plugin));
    const k: Partial<Record<ClassKey, boolean>> = { ...e.config.class };
    for (const key of ["outside", "sends", "account"] as const) {
      if (!(key in answers)) continue;
      const v = answers[key];
      if (v === null) delete k[key];
      else if (typeof v === "boolean") k[key] = v;
    }
    const c: McpServerConfig = { ...e.config, class: k };
    if (!Object.keys(k).length) delete c.class;
    this.save({ ...this.cfg.servers, [name]: c });
    e.config = c;
  }

  // The owner marks which of a server's tools are reads (they run without asking).
  setReads(name: string, tools: string[]) {
    const e = this.entries.get(name)!;
    if (e.bundled) throw new Error(`${name} is built in: its reads are its own`);
    if (e.plugin) throw new Error(pluginWord(e.plugin));
    const c: McpServerConfig = { ...e.config, read_tools: [...new Set(tools.map(String))] };
    if (!c.read_tools!.length) delete c.read_tools;
    this.save({ ...this.cfg.servers, [name]: c });
    e.config = c;
  }

  // One more tool the owner marks as a read (a card's one press), the rest as they are.
  addRead(name: string, tool: string) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`no server ${name}`);
    this.setReads(name, [...(e.config.read_tools ?? []), tool]);
  }

  remove(name: string) {
    if (this.entries.get(name)?.bundled) throw new Error(`${name} is built in: turn it off instead`);
    const by = this.entries.get(name)?.plugin;
    if (by) throw new Error(pluginWord(by));
    const { [name]: _gone, ...rest } = this.cfg.servers;
    this.save(rest);
    this.drop(name);
    if (this.kept[name]) {
      delete this.kept[name];
      this.writeKept(name);
    }
    this.revoked(name, this.oauth.forget(name));
    if (this.pins[name]) {
      delete this.pins[name];
      this.writePins(name);
    }
  }

  // A call still running on the old client finishes there (its result is
  // the old server's); the client closes when nothing waits on it.
  private drop(name: string) {
    const e = this.entries.get(name);
    if (!e) return;
    const c = e.client;
    e.client = undefined;
    this.entries.delete(name);
    this.clearRetry(e);
    unregisterCatalog(name);
    // One still connecting ends now: its process is not left to the handshake's own limit.
    e.abort?.abort();
    if (c) c.retire();
    if (e.ran) this.told(e, "ended");
    // Gone, not replaced (a change of its config adds it again at once): whatever named it for its events goes.
    if (!e.session && !e.bundled) queueMicrotask(() => {
      if (this.entries.has(name) || this.disposed) return;
      // Its kept listing goes with it (a server added again lists afresh).
      if (this.kept[name]) {
        delete this.kept[name];
        this.writeKept(name);
      }
      if (this.pluginChannels().has(name)) {
        const set = new Set(this.pluginChannels());
        set.delete(name);
        try { writeFileSync(this.pluginChannelsPath(), JSON.stringify([...set])); this.pluginOn = set; } catch (err) { this.errors.capture("server", err, { mcp: name, at: "mcp channel forget" }); }
      }
      try { this.onServerGone?.(name); } catch (err) { this.errors.capture("server", err, { mcp: name, at: "mcp server gone" }); }
    });
  }
  // A server of the owner's or of a plugin that is gone (not one replaced by its new config).
  onServerGone?: (name: string) => void;

  toggle(name: string, enabled: boolean) {
    const e = this.entries.get(name)!;
    if (e.plugin) throw new Error(pluginWord(e.plugin));
    if (e.bundled) {
      const off = new Set(this.bundledOff());
      if (enabled) off.delete(name);
      else off.add(name);
      mkdirSync(dirname(this.bundledOffPath), { recursive: true });
      writeFileSync(this.bundledOffPath, JSON.stringify([...off]));
      e.client?.close();
      e.client = undefined;
      e.state = !enabled ? "disabled" : e.bundled.config || e.bundled.live ? "idle" : "missing";
      e.error = enabled && !e.bundled.config && !e.bundled.live ? e.bundled.missing : undefined;
      if (enabled) void e.bundled.live?.check();
      return;
    }
    const c = { ...e.config };
    if (enabled) delete c.enabled;
    else c.enabled = false;
    this.save({ ...this.cfg.servers, [name]: c });
    e.config = c;
    if (!enabled) {
      e.client?.close();
      e.client = undefined;
      e.tools = [];
      e.cold = false;
      e.state = "disabled";
      this.clearRetry(e);
      e.error = undefined;
    } else {
      e.state = "connecting";
      this.ensure(name).catch(() => {});
    }
  }

  // A server Keel brings whose command changed (a setting it follows): the
  // running process ends once its calls are done, and the next call starts it
  // with the new command. Nothing is started now.
  restartBundled(name: string) {
    const e = this.entries.get(name);
    if (!e?.bundled || e.bundled.live) return;
    if (e.bundled.configure) e.config = e.bundled.configure() ?? e.config;
    e.abort?.abort();
    e.abort = undefined;
    const c = e.client;
    e.client = undefined;
    e.connecting = undefined;
    if (e.state !== "disabled" && e.state !== "missing") { e.state = "idle"; e.error = undefined; }
    if (c) { c.onClose = undefined; c.retire(); }
  }

  async reconnect(name: string) {
    const e = this.entries.get(name)!;
    if (e.bundled?.live) {
      if (e.state !== "disabled") await e.bundled.live.check();
      return;
    }
    e.client?.close();
    e.client = undefined;
    this.clearRetry(e); // asked for by the owner: the count of tries starts again
    e.era = undefined;
    e.noSse = undefined; // asked for by the owner: the older transport is tried again
    if (e.state === "disabled" || e.state === "missing") return;
    e.state = "connecting";
    await this.ensure(name, 15_000).catch(() => {});
  }

  // Read the file again; only what changed restarts.
  reload(only?: string): { servers: McpReloadedServer[] } {
    const { cfg: next, text } = this.readFile(); // throws with the parser's reason: nothing changes
    const out: McpReloadedServer[] = [];
    const names = new Set([...Object.keys(next.servers), ...this.entries.keys()]);
    for (const name of [...names].sort()) {
      if (only && name !== only) continue;
      const change = this.adopt(name, next.servers[name]);
      if (change) out.push({ name, change });
    }
    if (!only) {
      this.cfg = next;
      this.base = { ...next.servers };
      this.fileText = text;
      return { servers: out };
    }
    // One server read again: the rest of the file was not, so the next save compares.
    this.cfg = { ...this.cfg, servers: { ...this.cfg.servers } };
    if (next.servers[only]) this.cfg.servers[only] = this.base[only] = next.servers[only];
    else { delete this.cfg.servers[only]; delete this.base[only]; }
    this.fileText = undefined;
    return { servers: out };
  }

  async signIn(name: string, redirectUri: string): Promise<string> {
    const e = this.entries.get(name)!;
    if (!e.config.url) throw new Error(`${name} is a local command; it has no sign-in`);
    return this.oauth.begin(name, expand(e.config.url), e.www ?? null, redirectUri, e.config.oauth);
  }

  // `retry` is the address to send the owner on to when the server no longer knew Keel's client: it was registered
  // again and the sign-in starts over, once (`line` says so). A second refusal throws.
  async finishSignIn(query: URLSearchParams): Promise<{ server: string; retry?: string; line?: string }> {
    let name: string;
    try {
      name = await this.oauth.finish(query);
    } catch (e) {
      if (!(e instanceof ClientRefused) || e.again || !this.entries.has(e.server)) throw e;
      const entry = this.entries.get(e.server)!;
      if (!entry.config.url) throw e;
      const retry = await this.oauth.begin(e.server, expand(entry.config.url), entry.www ?? null, e.redirectUri, entry.config.oauth, true);
      return { server: e.server, retry, line: e.message };
    }
    if (this.entries.has(name)) await this.reconnect(name);
    return { server: name };
  }

  // The tokens are forgotten here already; the authorization server is told in
  // the background, and a refusal is said once.
  private revoked(name: string, gone: Forgotten | undefined) {
    if (!gone) return;
    detached(() => void this.oauth.revoke(gone).then((failed) => {
      if (failed.length) this.errors.capture("server", new Error(`MCP server ${name}: its tokens are forgotten here, but the authorization server did not confirm revoking them (${failed.join("; ")})`), { at: "mcp oauth revoke", mcp: name });
    }));
  }

  signOut(name: string) {
    this.revoked(name, this.oauth.signOut(name));
    const e = this.entries.get(name);
    if (e) {
      e.client?.close();
      e.client = undefined;
      e.tools = [];
      if (e.state !== "disabled") { e.state = "needs_auth"; e.error = "Sign in to use this server."; }
    }
  }

  // ---- other agents' servers: import, and keep the copies in step ----

  importable(failed?: { file: string; error: string }[]) {
    this.watchSources();
    return importable(this.workspace, this.cfg.servers, failed);
  }

  // An import follows its source from then on (sync), under the name given.
  importFrom(source: string, name: string, as = name): string | null {
    const hit = this.importable().find((i) => i.source === source && i.name === name);
    if (!hit) return `${source} has no server named ${name}`;
    if (as in this.cfg.servers) return `Keel already has a server named ${as}`;
    return this.add(as, { ...hit.config, sync: { source, name } });
  }

  // Everything the other agents hold that Keel does not, in one step: one
  // copy per endpoint and account, from the first agent that has it (this folder's own
  // files stay a per-server choice, since Keel's mcp.json serves every folder).
  importAll(): { imported: string[]; skipped: { name: string; source: string; why: string }[] } {
    const imported: string[] = [], skipped: { name: string; source: string; why: string }[] = [];
    const seen = new Set<string>();
    for (const i of this.importable()) {
      if (i.configured || i.project || seen.has(i.group)) continue;
      seen.add(i.group);
      const err = this.importFrom(i.source, i.name);
      if (err) skipped.push({ name: i.name, source: i.label, why: err });
      else imported.push(i.name);
    }
    return { imported, skipped };
  }

  private gone = new Set<string>();
  private labels = new Map<string, string>();

  // Read the sources again; a copy whose source changed takes the change
  // (only what the source decides; on/off and reads stay the owner's), and
  // restarts. A copy whose source no longer has it stays, marked.
  syncSources(): McpReloadedServer[] {
    const failed: { file: string; error: string }[] = [];
    const src = readSources(this.workspace, failed);
    for (const f of failed) this.errors.capture("server", new Error(`${f.file}: ${f.error}`), { at: "mcp sources" });
    for (const s of src) this.labels.set(s.source, s.label);
    const changed: Record<string, McpServerConfig> = {};
    for (const [name, c] of Object.entries(this.cfg.servers)) {
      if (!c.sync) continue;
      const hit = src.find((s) => s.source === c.sync!.source && s.name === c.sync!.name);
      // A source file that failed to read says nothing about its servers.
      if (!hit) { if (!failed.length) this.gone.add(name); continue; }
      this.gone.delete(name);
      // The variables a server is passed are the source's and the owner's both: a name the owner
      // added in Keel (env_vars) stays when the source changes, and is no change of the source.
      const vars = [...new Set([...(c.env_vars ?? []), ...(hit.config.env_vars ?? [])])];
      const next: McpServerConfig = { ...sourced(hit.config), sync: c.sync };
      if (vars.length) next.env_vars = vars; else delete next.env_vars;
      if (canon(sourced(c)) === canon(sourced(next))) continue;
      if (c.enabled === false) next.enabled = false;
      if (c.read_tools) next.read_tools = c.read_tools;
      if (c.channel) next.channel = true;
      if (c.class) next.class = c.class;
      if (validate(name, next)) continue;
      changed[name] = next;
    }
    const names = Object.keys(changed);
    if (!names.length) return [];
    this.save({ ...this.cfg.servers, ...changed });
    for (const name of names) {
      this.drop(name);
      this.addEntry(name, changed[name]!);
      if (changed[name]!.enabled !== false) this.ensure(name).catch(() => {});
    }
    return names.map((name) => ({ name, change: "changed" }));
  }

  // Agents replace their files by rename: watch the folders, debounced. A
  // folder that appears later (an agent installed since) is watched from the
  // next listing of importable servers on.
  private watchers = new Map<string, { w: FSWatcher; ino: string }>();
  private syncTimer?: ReturnType<typeof setTimeout>;
  watchSources() {
    if (runMode.client || this.disposed) return;
    const byDir = new Map<string, Set<string>>();
    for (const f of sourceFiles(this.workspace)) (byDir.get(dirname(f)) ?? byDir.set(dirname(f), new Set()).get(dirname(f))!).add(basename(f));
    for (const [dir, names] of byDir) {
      // A folder removed or made anew since is watched again (a new folder often
      // gets the old one's inode back; its birth time tells them apart).
      const ino = (() => { try { const st = statSync(dir); return `${st.ino}:${st.birthtimeMs}`; } catch { return null; } })();
      const had = this.watchers.get(dir);
      if (had && had.ino === ino) continue;
      had?.w.close();
      this.watchers.delete(dir);
      if (ino === null) continue;
      try {
        const w = watch(dir, (_ev, file) => {
          if (!file || !names.has(String(file)) || this.disposed) return;
          clearTimeout(this.syncTimer);
          this.syncTimer = setTimeout(() => {
            try {
              const changed = this.syncSources();
              if (changed.length) this.onSynced?.(changed);
            } catch (e) { this.errors.capture("server", e, { at: "mcp sources sync" }); }
          }, 800);
        });
        // A removed folder ends its watch; a new one is armed again later.
        w.on("error", () => { w.close(); if (this.watchers.get(dir)?.w === w) this.watchers.delete(dir); });
        this.watchers.set(dir, { w, ino });
      } catch (e) { this.errors.capture("server", e, { at: "mcp sources watch", dir }); }
    }
  }
  onSynced?: (changed: McpReloadedServer[]) => void;

  // ---- resources and prompts ----

  // Concrete resources and templates are listed apart: either half shows
  // when the other fails, and a server without templates is not a failure.
  async resources(name: string, signal?: AbortSignal, from?: { list: "resources" | "templates"; cursor: string }): Promise<{ resources: ResourceHalf; templates: ResourceHalf }> {
    const c = await this.ensure(name, 15_000);
    this.used(name);
    const half = async (list: "resources" | "templates"): Promise<ResourceHalf> => {
      if (from && from.list !== list) return { items: [] };
      try {
        const r = await (list === "resources" ? c.listResources(signal, from?.cursor) : c.listResourceTemplates(signal, from?.cursor));
        return { items: r.items, next: r.next, error: r.error?.message };
      } catch (err) {
        if (err instanceof RpcError && err.code === -32601) return { items: [], unsupported: true };
        return { items: [], error: (err as Error).message };
      }
    };
    const [resources, templates] = await Promise.all([half("resources"), half("templates")]);
    return { resources, templates };
  }

  // Each item apart, in order, with the URI the server returned. Reading a
  // URI subscribes to its changes when the server offers that.
  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ResourceItem[]> {
    const c = await this.ensure(name, 15_000);
    this.used(name);
    const r = await c.readResource(uri, signal);
    const e = this.entries.get(name);
    if (e && c.capabilities.resources?.subscribe && !e.subscribed.has(uri)) {
      e.subscribed.add(uri);
      c.rpc("resources/subscribe", { uri }).catch((err) => { e.subscribed.delete(uri); this.errors.capture("server", err, { mcp: name, at: "resources/subscribe" }); });
    }
    return (r?.contents ?? []).map((p: any): ResourceItem =>
      p.text !== undefined ? { uri: String(p.uri ?? uri), mimeType: p.mimeType, text: String(p.text) } : { uri: String(p.uri ?? uri), mimeType: p.mimeType, bytes: b64Bytes(String(p.blob ?? "")) });
  }

  async prompts(name: string, signal?: AbortSignal) {
    const c = await this.ensure(name, 15_000);
    this.used(name);
    return c.listPrompts(signal);
  }

  // The latest lines of a server's own log, oldest first.
  log(name: string): LogLine[] {
    return [...(this.entries.get(name)?.log ?? [])];
  }

  // What a server suggests for an argument of one of its prompts or resource
  // templates (server/utilities/completion): at most the spec's 100 values,
  // strings only. A server that does not declare completions suggests nothing.
  async complete(name: string, ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string }, argument: { name: string; value: string }, context?: Record<string, string>, signal?: AbortSignal): Promise<{ values: string[]; hasMore?: true; total?: number }> {
    const c = await this.ensure(name, 15_000);
    this.used(name);
    if (!c.capabilities.completions) return { values: [] };
    const r = (await c.complete(ref, argument, context, signal))?.completion ?? {};
    const values = (Array.isArray(r.values) ? r.values : []).filter((v: unknown): v is string => typeof v === "string").slice(0, 100);
    return { values, ...(r.hasMore === true ? { hasMore: true as const } : {}), ...(typeof r.total === "number" ? { total: r.total } : {}) };
  }

  async promptMessages(name: string, prompt: string, args: Record<string, string>, signal?: AbortSignal): Promise<PromptMessage[]> {
    const c = await this.ensure(name, 15_000);
    this.used(name);
    const r = await c.getPrompt(prompt, args, signal);
    return (r?.messages ?? []).map((m: any) => ({ role: String(m.role ?? "user"), ...promptPart(m.content) }));
  }

  // The text a prompt gives the model. All the owner's words read as their
  // text; a conversation keeps who says what, one labelled block per message.
  async getPrompt(name: string, prompt: string, args: Record<string, string>, signal?: AbortSignal): Promise<string> {
    return promptText(await this.promptMessages(name, prompt, args, signal));
  }

  // Every prompt of the connected servers that offer prompts, for the slash
  // menu. A server that fails to list is left out (its own state shows why).
  // A server that says when its list changes (prompts.listChanged) is listed
  // again after it said so, or when it connected again; one that does not is
  // listed again when its list is older than PROMPTS_FRESH_MS.
  // `complete`: the server suggests values for the prompt's arguments (completion/complete).
  async allPrompts(signal?: AbortSignal): Promise<{ server: string; name: string; description: string; arguments: { name: string; description?: string; required?: boolean }[]; complete?: true }[]> {
    const out = await Promise.all([...this.ready(), ...this.asleep()].map(async (server) => {
      const e = this.entries.get(server);
      // A server with no process lists the prompts it was last seen to have; one never listed is started for it once.
      if (e?.cold && e.state === "idle") {
        if (!e.caps?.prompts) return [];
        const list = this.kept[server]?.prompts;
        if (list) return list.map((p: any) => ({ server, name: String(p.name), description: String(p.description ?? ""), arguments: Array.isArray(p.arguments) ? p.arguments : [] }));
        await this.ensure(server, 15_000).catch(() => {});
      }
      const c = e?.client;
      if (!e || !c?.capabilities.prompts) return [];
      const kept = e.prompts;
      const fresh = kept && kept.client === c && kept.rev === e.promptsRev && (c.capabilities.prompts.listChanged === true || Date.now() - kept.at < PROMPTS_FRESH_MS);
      let list = fresh ? kept.list : undefined;
      if (!list) {
        const rev = e.promptsRev;
        list = await c.listPrompts(signal).catch((err) => (this.errors.capture("tool", err, { server, at: "mcp prompts/list" }), undefined));
        // (A list that changed while it was read is read again next time.)
        if (list && e.client === c && e.promptsRev === rev) { e.prompts = { client: c, rev, at: Date.now(), list }; this.keep(e, list); }
      }
      const complete = c.capabilities.completions ? { complete: true as const } : {};
      return (list ?? []).map((p: any) => ({ server, name: String(p.name), description: String(p.description ?? ""), arguments: Array.isArray(p.arguments) ? p.arguments : [], ...complete }));
    }));
    return out.flat();
  }

  ready(): string[] {
    return [...this.entries.values()].filter((e) => e.state === "ready" && !e.session).map((e) => e.name);
  }

  // The command servers with a kept listing and no process.
  private asleep(): string[] {
    return [...this.entries.values()].filter((e) => e.cold && e.state === "idle" && !e.session).map((e) => e.name);
  }

  // The servers that offer resources or prompts: asked of each connected one, and from the kept listing for one with no process (nothing is started to answer).
  async capable(cap: "resources" | "prompts"): Promise<string[]> {
    const names: string[] = [];
    for (const s of this.ready()) {
      try {
        const c = await this.ensure(s, 3000);
        if (c.capabilities[cap]) names.push(s);
      } catch {}
    }
    for (const s of this.asleep()) if (this.entries.get(s)?.caps?.[cap]) names.push(s);
    return names;
  }

  // The config a server's instructions were published under, as a digest:
  // the config itself can hold a value the owner gave a plugin's setting,
  // which is not written to the state folder.
  private configKey(e: Entry) {
    return digest(canon({ ...e.config, enabled: undefined, class: undefined }));
  }

  private writePublished(at?: string) {
    try {
      writeFileSync(this.publishedPath + ".tmp", JSON.stringify(this.published), { mode: 0o600 });
      renameSync(this.publishedPath + ".tmp", this.publishedPath);
    } catch (err) {
      this.errors.capture("server", err, { at: "mcp instructions", ...(at ? { mcp: at } : {}) });
    }
  }

  private publish(e: Entry, published: string | undefined) {
    if (e.session) return; // no shared prompt carries a session's own server
    // Kept as a session's prompt carries it: a secret in it is a placeholder.
    const instructions = published === undefined ? undefined : conceal(published);
    const key = this.configKey(e), was = this.published[e.name];
    if (was && was.key === key && was.instructions === (instructions ?? null)) return;
    this.published[e.name] = { key, instructions: instructions ?? null };
    this.writePublished(e.name);
  }

  // What the server published the last time it connected under this config.
  private lastPublished(e: Entry): { instructions?: string } | undefined {
    const p = this.published[e.name];
    return p && p.key === this.configKey(e) ? { instructions: p.instructions ?? undefined } : undefined;
  }

  // Each server a session can use, with its instructions: the live ones, else
  // the ones it last published. A server that has never connected under its
  // config and is connecting now is waited for, up to `waitMs` in all, so a
  // session started with the daemon gets its instructions too.
  async configured(waitMs = 0): Promise<{ name: string; instructions?: string }[]> {
    const live = () => [...this.entries.values()].filter((e) => e.state !== "disabled" && e.state !== "missing" && !e.session);
    const unknown = live().filter((e) => e.state === "connecting" && !e.bundled && !this.lastPublished(e));
    if (waitMs > 0 && unknown.length && !runMode.client) {
      const settled = async (e: Entry) => {
        while (e.state === "connecting" && this.entries.get(e.name) === e && !this.disposed) {
          if (e.connecting) await e.connecting.catch(() => {});
          else await Bun.sleep(25); // start() connects a moment after it lists
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(unknown.map(settled)), new Promise((r) => (timer = setTimeout(r, waitMs)))]);
      clearTimeout(timer);
    }
    return live().map((e) => ({ name: e.name, instructions: e.bundled ? e.bundled.instructions ?? e.client?.instructions ?? this.lastPublished(e)?.instructions : this.leashed(e) ? this.pinnedInstructions(e) : e.client?.instructions ?? this.lastPublished(e)?.instructions }));
  }
}

export function promptText(msgs: PromptMessage[]): string {
  if (msgs.every((m) => m.role === "user")) return msgs.map((m) => m.text).join("\n\n");
  return msgs.map((m) => `<${m.role}>\n${m.text}\n</${m.role}>`).join("\n");
}

// A read result as text for the model: each item under its own URI.
export function resourceText(items: ResourceItem[]): string {
  if (items.length === 1 && items[0]!.text !== undefined) return items[0]!.text;
  return items.map((i) => i.text !== undefined ? `--- ${i.uri}${i.mimeType ? ` (${i.mimeType})` : ""}\n${i.text}` : `--- ${i.uri}: binary ${i.mimeType ?? "data"}, ${i.bytes} bytes`).join("\n");
}

// A result's text blocks with a proxy's credentials masked (the result as it was when the environment has none).
function maskedText(r: McpCallResult): McpCallResult {
  if (!proxyCredentials().length) return r;
  const out: McpCallResult = { ...r, content: r.content?.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? { ...b, text: maskProxy(b.text) } : b)) };
  if (r.structuredContent !== undefined) {
    try { out.structuredContent = JSON.parse(maskProxy(JSON.stringify(r.structuredContent))); } catch {} // a mask that broke the JSON leaves it as it was
  }
  return out;
}
