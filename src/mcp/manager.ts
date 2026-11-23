// One MCP manager per daemon: the configured servers, their connections and
// states, and one catalog source per server so search_tools finds their tools.
// Servers connect in the background after startup and on first use; a reload
// restarts only the servers whose config changed, and never touches a session's
// request prefix (MCP tools are deferred, so the eager tool list is fixed).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, dirname, join } from "node:path";
import { spelled } from "../safety/chars.ts";
import { detached, type ErrorTracker } from "../core/errors.ts";
import { registerCatalog, unregisterCatalog, type CatalogTool } from "../tools/catalog.ts";
import type { CallClass } from "../safety/policy.ts";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import { AuthRequired, McpAuthorizationError, McpClient, RpcError, SessionExpired, type InputHandler, type InputRequest, type McpCallResult, type McpTool, type Transport } from "./client.ts";
import { formOf, type ElicitResult } from "./elicit.ts";
import { allHooks } from "../engine/hooks.ts";
import { askFor, DECLINED } from "../tools/interact.ts";
import { canon, expand, importable, mergeServers, parseConfig, RESERVED, validate, writeConfig, type McpConfigFile, type McpServerConfig } from "./config.ts";
import { binding, endpoint, readSources, sourceFiles, sourced } from "./sources.ts";
import { OAuthStore } from "./oauth.ts";
import { reapLeft, track } from "./procs.ts";
import { readText } from "../core/proc.ts";
import { toOutput } from "./result.ts";
import { conceal } from "../core/conceal.ts";
import { STATUS_CAP, STATUS_METHOD, type Pushed } from "./channel.ts";
import { runMode } from "../core/runmode.ts";
import { serverName } from "../plugins/manifest.ts";

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
type CallAsks = { asked: number; declined: number; queued: number; self: number; roots: number; notes: Set<string>; readOnly: boolean; end?: () => void; ended?: string };
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
  resource_updates: Record<string, number>; // per subscribed URI: goes up when its body changed
  sync?: { source: string; name: string; label: string; gone: boolean }; // follows another agent's entry
  plugin?: string; // the installed plugin it comes with (it goes and stops with the plugin)
  endpoint?: string; // what the server is, whatever it is called (sources.ts endpoint)
  // Its pushed events (src/mcp/channel.ts): taken at all (the owner's switch, off by default),
  // whether the connected server declares the capability, and whether it asks to be told what became of each.
  // (The daemon's route adds the sessions that take them and the latest events, with what became of each.)
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

// The bytes base64 holds (padding deducted).
export const b64Bytes = (b: string) => {
  const t = b.replace(/\s/g, "");
  return Math.max(0, Math.floor((t.length * 3) / 4) - (t.endsWith("==") ? 2 : t.endsWith("=") ? 1 : 0));
};

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
  bundled?: BundledServer;
  resourcesRev: number;
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
};

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
export function shownTarget(c: McpServerConfig): string {
  if (c.command) return [c.command, ...(c.args ?? [])].join(" ");
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

function serverEnv(c: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET.test(k)) env[k] = v;
  for (const k of c.env_vars ?? []) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(c.env ?? {})) env[k] = expand(String(v));
  return env;
}

// A headers helper prints a JSON object of header names and values (Claude
// Code's headersHelper, Codex's http_headers_helper). Run at each connect;
// the values never reach a log.
async function helperHeaders(cmd: string, timeoutMs = 10_000): Promise<Record<string, string>> {
  const p = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([readText(p.stdout, "mcp headers helper"), readText(p.stderr, "mcp headers helper"), p.exited]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`the headers helper exited with ${code}${err.trim() ? `: ${err.trim().slice(0, 200)}` : ""}`);
  let h: unknown;
  try { h = JSON.parse(out); } catch { throw new Error("the headers helper did not print a JSON object"); }
  if (!h || typeof h !== "object" || Array.isArray(h) || Object.values(h).some((v) => typeof v !== "string")) throw new Error("the headers helper did not print a JSON object of strings");
  return h as Record<string, string>;
}

const pluginWord = (plugin: string) => `it comes with the plugin ${plugin}: turn the plugin off or remove it in Settings > Plugins`;

// (Whether it is on and whether its events are taken are not what the server is: neither restarts it.)
const same = (a: McpServerConfig, b: McpServerConfig) => JSON.stringify({ ...a, enabled: undefined, channel: undefined }) === JSON.stringify({ ...b, enabled: undefined, channel: undefined });

// How long a server that refused the Streamable HTTP request is given to name
// its address the older way, when nothing says it speaks that transport.
const SSE_TRY_MS = 4000;

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
    this.oauth = new OAuthStore(stateDir);
    this.bundledOffPath = join(stateDir, "mcp-bundled-off.json");
    this.publishedPath = join(stateDir, "mcp-instructions.json");
    this.askedPath = join(stateDir, "mcp-asked.json");
    // (Entries of sessions that are gone are never asked about: only the newest are kept.)
    try { this.asked = new Set((JSON.parse(readFileSync(this.askedPath, "utf8")) as string[]).slice(-200)); } catch {} // none kept
    try { this.published = JSON.parse(readFileSync(this.publishedPath, "utf8")); } catch {} // none kept yet
    const keyPath = join(stateDir, "mcp-bind.key");
    if (!existsSync(keyPath)) {
      mkdirSync(stateDir, { recursive: true });
      try { writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" }); } catch {} // another manager wrote it first
    }
    this.bindKey = readFileSync(keyPath);
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
      const config: McpServerConfig = c.command
        ? { command: String(c.command), ...(c.args ? { args: c.args.map(String) } : {}), ...(c.env ? { env: c.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) }
        : { ...(c.url ? { url: String(c.url) } : {}), ...(c.headers ? { headers: c.headers } : {}), ...(c.transport ? { transport: c.transport } : {}) };
      const had = mine().find((e) => e.given === s.name && !keep.has(e.name) && same(e.config, config));
      if (had) { keep.add(had.name); had.holder = opts.holder; out.push({ name: s.name, label: had.label }); continue; }
      const label = sessionLabel(s.name, (n) => [...this.entries.values()].some((e) => (e.label ?? e.name) === n && (!e.session || e.session === session)));
      const bad = config.transport === "sse" ? "it uses the older SSE transport, which Keel does not speak: give its Streamable HTTP address"
        // The session's tools run on another machine: the command would start on this one, outside what the session reaches.
        : config.command && opts.remote ? `the session's tools run on another machine (${opts.remote}), and this command would start on this one`
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
  setPluginServers(plugin: string, servers: { name: string; label: string; config: Record<string, unknown> }[]) {
    const keep = new Set<string>();
    for (const s of servers) {
      const config = s.config as McpServerConfig;
      const had = [...this.entries.values()].find((e) => e.plugin === plugin && e.given === s.name);
      if (had && same(had.config, config) && (had.name === s.label || this.entries.get(s.label)?.plugin !== plugin)) { keep.add(had.name); continue; }
      if (had) this.drop(had.name);
      // A name taken since the install (the owner added a server by it): the plugin's id goes before it.
      const taken = (n: string) => RESERVED.has(n.toLowerCase()) || n in this.cfg.servers || (this.entries.has(n) && !keep.has(n) && this.entries.get(n)!.plugin !== plugin) || keep.has(n);
      let label = s.label;
      for (let n = 1; taken(label); n++) label = serverName(`${plugin}-${s.name}${n > 1 ? `-${n}` : ""}`);
      if (validate(label, config)) continue;
      const e = this.addEntry(label, config);
      e.plugin = plugin;
      e.given = s.name;
      keep.add(label);
      if (!runMode.client && config.enabled !== false) this.ensure(label).catch(() => {});
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
    const moved = this.addEntry(label, config);
    moved.plugin = plugin;
    moved.given = given;
    if (config.enabled !== false) this.ensure(label).catch(() => {});
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
    this.addEntry(name, now);
    if (now.enabled !== false) this.ensure(name).catch(() => {});
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
    if (!runMode.client) {
      try { this.syncSources(); } catch (e) { this.errors.capture("server", e, { at: "mcp sources sync" }); }
      this.watchSources();
    }
    // Connect in the background so the panel shows real states; nothing waits on it.
    // A command's own daemon connects a server only when a turn uses it.
    if (!runMode.client) setTimeout(() => {
      for (const e of this.entries.values()) if (e.state !== "disabled" && !e.bundled) this.ensure(e.name).catch(() => {});
    }, 50);
  }

  dispose() {
    this.disposed = true;
    for (const { w } of this.watchers.values()) w.close();
    this.watchers.clear();
    clearTimeout(this.syncTimer);
    for (const e of this.entries.values()) {
      e.abort?.abort(); // one still connecting ends with the manager
      e.client?.close();
      unregisterCatalog(e.name);
    }
    this.entries.clear();
  }

  private addEntry(name: string, config: McpServerConfig, bundled?: BundledServer, own?: Own) {
    const e: Entry = { name, config, state: config.enabled === false ? "disabled" : "connecting", tools: [], failures: 0, bundled, resourcesRev: 0, updates: {}, subscribed: new Set(), ...own };
    this.entries.set(name, e);
    if (!own) this.unshadow(name);
    registerCatalog({
      name,
      session: e.session,
      tools: async () => {
        // Phone control turned off leaves search, and a call still gets the plain reason.
        if (e.state === "disabled" && e.bundled?.live) return e.bundled.tools.map((t) => ({ ...this.catalogTool(e, t), hidden: true }));
        if (e.state === "disabled" || e.state === "needs_auth" || e.state === "missing") return [];
        // A bundled server's shipped list: searching it starts nothing.
        if (e.bundled) return (e.client ? e.tools : e.bundled.tools).map((t) => this.catalogTool(e, t));
        try {
          await this.ensure(name, 8_000);
        } catch {
          return [];
        }
        return e.tools.map((t) => this.catalogTool(e, t));
      },
      pending: () => (e.state === "connecting" ? [e.label ?? name] : []),
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
        return e.state === "ready" ? e.tools.map((t) => this.catalogTool(e, t)) : [];
      },
    });
    return e;
  }

  private catalogTool(e: Entry, t: McpTool): CatalogTool {
    const server = e.label ?? e.name;
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
      readOnly: e.bundled ? e.bundled.reads(t.name) : !!e.config.read_tools?.includes(t.name),
      judge: e.bundled?.judge ? (input: any) => e.bundled!.judge!(t.name, input) : undefined,
      run: (input: any, ctx: ToolContext) => this.call(e.name, t.name, input, ctx),
    };
  }

  private transport(e: Entry): Transport {
    const c = e.config;
    // A session's own server: every value as the editor gave it. Nothing is
    // expanded against the daemon's environment, no header comes from it, and
    // no sign-in of the owner's is sent along.
    if (e.session) {
      if (c.command) return { kind: "stdio", command: c.command, args: c.args ?? [], env: sessionEnv(c, false), cwd: c.cwd ?? this.workspace, started: (p) => track(this.stateDir, p, e.label ?? e.name) };
      return { kind: "http", url: c.url!, headers: Object.fromEntries(Object.entries(c.headers ?? {}).map(([k, v]) => [k, String(v)])) };
    }
    if (c.command) {
      return { kind: "stdio", command: expand(c.command), args: (c.args ?? []).map((a) => expand(a)), env: serverEnv(c), cwd: c.cwd ? expand(c.cwd) : this.workspace, started: (p) => track(this.stateDir, p, e.name) };
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
          const h = await helperHeaders(expand(e.config.headers_helper));
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
        e.client = client;
        e.era = client.era;
        e.state = "ready";
        e.ran = true;
        this.told(e, "started");
        this.publish(e, client.instructions);
        e.last = Date.now();
        e.failures = 0;
        e.resourcesRev++;
        e.subscribed.clear();
        // The latest list wins: an older reply that lands last is dropped.
        let asked = 0;
        client.onListChanged = () => {
          const mine = ++asked;
          client.listTools().then(
            (t) => { if (mine === asked && e.client === client) e.tools = t; },
            (err) => { if (mine === asked && e.client === client) this.errors.capture("server", err, { mcp: name, at: "tools/list after a change" }); },
          );
        };
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
            e.error = err.message;
            if (e.failures++ === 0) {
              this.errors.capture("server", err, { mcp: name });
              this.told(e, "failed", err.message);
            }
          }
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

  // Why a session may not reach a server Keel brings, or nothing.
  refusal(name: string, session: string | undefined): string | undefined {
    return session ? this.entries.get(name)?.bundled?.refuses?.(session) : undefined;
  }

  call(name: string, tool: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const b = this.entries.get(name)?.bundled;
    const no = this.refusal(name, ctx.sessionId);
    if (no) return Promise.resolve({ content: no, is_error: true });
    if (b?.call) return b.call(tool, input, ctx, (t, i, m) => this.callRaw(name, t, i, ctx, m));
    return this.callRaw(name, tool, input, ctx);
  }

  private async callRaw(name: string, tool: string, input: unknown, ctx: ToolContext, meta?: Record<string, unknown>): Promise<ToolOutput> {
    const e = this.entries.get(name);
    const shown = e?.label ?? name; // the name the session knows it by
    const config = e?.config;
    const tools = e?.tools;
    let client: McpClient;
    try {
      client = await this.ensure(name);
    } catch (err) {
      const msg = e?.state === "needs_auth" ? (e.session ? `${shown} asks for a sign-in, which a server the editor passed cannot do here: the editor passes its credentials in the server's headers.` : `${shown} needs sign-in: the owner signs in from the MCP servers panel.`) : (err as Error).message;
      return { content: `MCP server ${shown} is not available: ${msg}`, is_error: true };
    }
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
    }, readOnly: e ? (e.bundled ? e.bundled.reads(tool) : !!e.config.read_tools?.includes(tool)) : false };
    // What the model is told besides the result: what the server asked that got no answer, and why.
    const noted = (out: ToolOutput): ToolOutput => {
      if (!call.notes.size) return out;
      const text = [...call.notes].map((n) => `[keel] ${n}`).join("\n");
      return { ...out, content: typeof out.content === "string" ? `${out.content}\n\n${text}` : [...out.content, { type: "text", text }] };
    };
    let r: McpCallResult;
    try {
      r = await client.callTool(tool, input, signal, (e?.config.tool_timeout_secs ?? 600) * 1000, meta, authorize, {
        session: ctx.sessionId,
        // (By the name the session knows the server by: the card and the notes show it.)
        ask: (q) => this.input(shown, q, ctx, card, call),
        dropped: (method, why) => call.notes.add(`${shown} ${method === "roots/list" ? "asked for the session's folder" : "asked the owner a question"} while this call ran and got no answer: ${why}. If the result depends on it, run the call again when no other call is using ${shown}.`),
      }, e?.config.tool_max_secs ? e.config.tool_max_secs * 1000 : undefined);
    } catch (err) {
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
      return noted({ content: `${shown}__${tool} failed: ${(err as Error).message}`, is_error: true });
    }
    this.callEnded(ctx.sessionId, card);
    return noted(await toOutput(r, ctx, `${shown}__${tool}`));
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
    // (None for a session whose tools run on another machine: its folder is a path there, and this server runs here.)
    if (q.method === "roots/list") {
      // The folder does not change under a call: a server that asks for it over and over is ended like one that keeps asking the owner.
      if (++call.roots > QUESTIONS_MAX) {
        call.ended ??= `${server} asked for the session's folder more than ${QUESTIONS_MAX} times in this call.`;
        call.end?.();
        throw new RpcError(-32603, call.ended);
      }
      return Promise.resolve(this.elsewhere?.(ctx.sessionId) ? { roots: [] } : rootsOf(ctx.cwd));
    }
    if (q.method !== "elicitation/create") throw new RpcError(-32601, `keel does not support ${q.method}`);
    const mode = q.params?.mode ?? "form";
    // 2025-11-25 elicitation, Error Handling: a mode the client did not declare is invalid params.
    if (mode !== "form") throw new RpcError(-32602, `keel offers form elicitation only, not ${mode} mode`);
    // Past a bound: the call ends, here and for every question it still sends.
    const end = (why: string): never => {
      call.ended ??= why;
      call.end?.();
      throw new RpcError(-32603, call.ended);
    };
    if (call.ended) end(call.ended);
    // Answered by Keel itself, as if the owner made no choice: a few times, then the call ends.
    const unasked = (why: string) => {
      if (++call.self > SELF_MAX) end(`${why} It asked ${call.self} questions that could not be put to the owner.`);
      call.notes.add(`${why} It was answered as if the owner made no choice.`);
      return Promise.resolve<ElicitResult>({ action: "cancel" });
    };
    const over = overLimit(server, call);
    if (over) end(over);
    call.asked++;
    if (!card) return unasked(`${server} asked the owner a question, and a call a program made has no card to show it on: call the tool directly.`);
    if (call.queued >= QUEUED_MAX + 1) return unasked(`${server} asked more than ${QUEUED_MAX} questions at once: one card is shown at a time, and no more than that wait behind it.`);
    call.queued++;
    // One card per call: a second question waits for the first.
    const run = (this.queue.get(card) ?? Promise.resolve()).then(() => {
      const out = call.ended ?? declinedOut(server, call);
      return out ? end(out) : this.elicit(server, q.params, ctx, card, call, unasked);
    }).finally(() => { call.queued--; });
    const tail = run.catch(() => {});
    this.queue.set(card, tail);
    void tail.then(() => { if (this.queue.get(card) === tail) this.queue.delete(card); });
    return run;
  }

  // A server that asks outside any call (many ask for the roots as soon as
  // they are connected): the folder the server itself was started in. A
  // question then has no card to be asked on, so no choice was made.
  private inputOutside(dir: string, q: InputRequest): Promise<unknown> {
    if (q.method === "roots/list") return Promise.resolve(rootsOf(dir));
    if (q.method === "elicitation/create") return Promise.resolve<ElicitResult>({ action: "cancel" });
    throw new RpcError(-32601, `keel does not support ${q.method}`);
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

  // ---- owner actions ----

  // The owner's servers and the ones Keel brings; with a session, that
  // session's own too (`session` on each), under the names it knows them by.
  list(session?: string): McpServerState[] {
    return [...this.entries.values()].filter((e) => !e.session || e.session === session).sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name)).map((e) => {
      const live = e.bundled?.live && e.state !== "disabled" ? e.bundled.live.state() : null;
      return {
      name: e.label ?? e.name,
      ...(e.session ? { session: e.session } : {}),
      transport: e.bundled?.live ? "socket" : e.config.url ? "http" : "stdio",
      target: e.bundled?.live?.target ?? (e.session ? shownTarget(e.config) : e.config.url ?? [e.config.command, ...(e.config.args ?? [])].join(" ")),
      enabled: e.state !== "disabled",
      state: live?.state ?? e.state,
      // (Of a session's own server, the reason in one line: what its command printed is not shown.)
      error: live ? live.error : e.session ? e.error?.split("\nstderr:")[0]!.split("\n")[0] : e.error,
      tools: (e.bundled && !e.client ? e.bundled.tools : e.tools).length,
      tool_names: (e.bundled && !e.client ? e.bundled.tools : e.tools).map((t) => t.name),
      read_tools: e.bundled ? [] : (e.config.read_tools ?? []),
      hinted_reads: e.bundled ? [] : e.tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
      last_connected: e.last,
      era: e.client?.era,
      version: e.client?.version,
      ...(e.config.transport === "sse" || e.sse ? { sse: true as const } : {}),
      // Name, title and version; icons (data URIs of kilobytes) stay out of a list polled every second or two.
      server_info: e.client?.serverInfo ? { name: e.client.serverInfo.name, title: (e.client.serverInfo as any).title, version: e.client.serverInfo.version } : undefined,
      endpoint: e.bundled ? undefined : endpoint(e.config),
      sign_in: !!e.config.url && !e.config.bearer_env && !e.config.headers_helper,
      ...(e.plugin ? { plugin: e.plugin } : {}),
      sync: e.config.sync ? { ...e.config.sync, label: this.labels.get(e.config.sync.source) ?? e.config.sync.source, gone: this.gone.has(e.name) } : undefined,
      signed_in: !!e.config.url && this.oauth.signedIn(e.name),
      bundled: e.bundled?.label,
      resources: !!e.client?.capabilities.resources,
      prompts: !!e.client?.capabilities.prompts,
      resources_rev: e.resourcesRev,
      resource_updates: e.updates,
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
    return this.channelFrom(e);
  }
  // What became of an event, to a server that asked to be told (STATUS_CAP).
  tellChannel(entry: string, params: Record<string, unknown>) {
    const c = this.entries.get(entry)?.client;
    if (!c?.capabilities.experimental?.[STATUS_CAP] || c.isClosed) return;
    c.notify(STATUS_METHOD, params).catch((err) => this.errors.capture("server", err, { mcp: entry, at: "mcp channel status" }));
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

  remove(name: string) {
    if (this.entries.get(name)?.bundled) throw new Error(`${name} is built in: turn it off instead`);
    const by = this.entries.get(name)?.plugin;
    if (by) throw new Error(pluginWord(by));
    const { [name]: _gone, ...rest } = this.cfg.servers;
    this.save(rest);
    this.drop(name);
    this.oauth.forget(name);
  }

  // A call still running on the old client finishes there (its result is
  // the old server's); the client closes when nothing waits on it.
  private drop(name: string) {
    const e = this.entries.get(name);
    if (!e) return;
    const c = e.client;
    e.client = undefined;
    this.entries.delete(name);
    unregisterCatalog(name);
    // One still connecting ends now: its process is not left to the handshake's own limit.
    e.abort?.abort();
    if (c) c.retire();
    if (e.ran) this.told(e, "ended");
    // Gone, not replaced (a change of its config adds it again at once): whatever named it for its events goes.
    if (!e.session && !e.bundled) queueMicrotask(() => {
      if (this.entries.has(name) || this.disposed) return;
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
      e.state = "disabled";
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

  async finishSignIn(query: URLSearchParams): Promise<string> {
    const name = await this.oauth.finish(query);
    if (this.entries.has(name)) await this.reconnect(name);
    return name;
  }

  signOut(name: string) {
    this.oauth.signOut(name);
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
      if (canon(sourced(c)) === canon({ ...sourced(hit.config), sync: undefined })) continue;
      const next: McpServerConfig = { ...sourced(hit.config), sync: c.sync };
      if (c.enabled === false) next.enabled = false;
      if (c.read_tools) next.read_tools = c.read_tools;
      if (c.channel) next.channel = true;
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
    return c.listPrompts(signal);
  }

  async promptMessages(name: string, prompt: string, args: Record<string, string>, signal?: AbortSignal): Promise<PromptMessage[]> {
    const c = await this.ensure(name, 15_000);
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
  async allPrompts(signal?: AbortSignal): Promise<{ server: string; name: string; description: string; arguments: { name: string; description?: string; required?: boolean }[] }[]> {
    const out = await Promise.all(this.ready().map(async (server) => {
      const c = this.entries.get(server)?.client;
      if (!c?.capabilities.prompts) return [];
      const list = await c.listPrompts(signal).catch((e) => (this.errors.capture("tool", e, { server, at: "mcp prompts/list" }), [] as any[]));
      return list.map((p: any) => ({ server, name: String(p.name), description: String(p.description ?? ""), arguments: Array.isArray(p.arguments) ? p.arguments : [] }));
    }));
    return out.flat();
  }

  ready(): string[] {
    return [...this.entries.values()].filter((e) => e.state === "ready" && !e.session).map((e) => e.name);
  }

  private configKey(e: Entry) {
    return canon({ ...e.config, enabled: undefined });
  }

  private publish(e: Entry, published: string | undefined) {
    if (e.session) return; // no shared prompt carries a session's own server
    // Kept as a session's prompt carries it: a secret in it is a placeholder.
    const instructions = published === undefined ? undefined : conceal(published);
    const key = this.configKey(e), was = this.published[e.name];
    if (was && was.key === key && was.instructions === (instructions ?? null)) return;
    this.published[e.name] = { key, instructions: instructions ?? null };
    try {
      writeFileSync(this.publishedPath + ".tmp", JSON.stringify(this.published));
      renameSync(this.publishedPath + ".tmp", this.publishedPath);
    } catch (err) {
      this.errors.capture("server", err, { at: "mcp instructions", mcp: e.name });
    }
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
    return live().map((e) => ({ name: e.name, instructions: e.bundled?.instructions ?? e.client?.instructions ?? this.lastPublished(e)?.instructions }));
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
