// One MCP manager per daemon: the configured servers, their connections and
// states, and one catalog source per server so search_tools finds their tools.
// Servers connect in the background after startup and on first use; a reload
// restarts only the servers whose config changed, and never touches a session's
// request prefix (MCP tools are deferred, so the eager tool list is fixed).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { detached, type ErrorTracker } from "../core/errors.ts";
import { registerCatalog, unregisterCatalog, type CatalogTool } from "../tools/catalog.ts";
import type { CallClass } from "../safety/policy.ts";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import { AuthRequired, McpAuthorizationError, McpClient, RpcError, SessionExpired, type McpCallResult, type McpTool, type Transport } from "./client.ts";
import { expand, importable, readConfig, validate, writeConfig, type McpConfigFile, type McpServerConfig } from "./config.ts";
import { binding, endpoint, readSources, sourceFiles, sourced } from "./sources.ts";
import { OAuthStore } from "./oauth.ts";
import { readText } from "../core/proc.ts";
import { toOutput } from "./result.ts";
import { conceal } from "../core/conceal.ts";
import { runMode } from "../core/runmode.ts";

// armed, not_armed, unreachable: phone control, whose state is the gateway's answer.
export type McpState = "disabled" | "connecting" | "ready" | "error" | "needs_auth" | "idle" | "missing" | "armed" | "not_armed" | "unreachable";

// A server Keel brings itself: not in mcp.json, cannot be removed, offered to
// every session. Its tool list ships with Keel, so search starts nothing; the
// process starts at the first call ("idle" until then). `reads` is Keel's own
// list of the tools that only read; `call` wraps each call (tab ownership).
export type BundledServer = {
  label: string;
  config: McpServerConfig | null;   // null: not installed on this machine
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
  // What a call does, for the gate, before any card (phone control refuses an unarmed phone here).
  judge?: (tool: string, input: any) => Promise<CallClass>;
};

export type McpServerState = {
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
  server_info?: { name?: string; version?: string };
  sign_in: boolean;   // the server can take an OAuth sign-in (HTTP)
  signed_in: boolean;
  bundled?: string;   // the label of a server Keel brings itself
  resources: boolean; // the connected server offers resources
  prompts: boolean;   // the connected server offers prompt templates
  resources_rev: number; // goes up when its resource list changed (a list read again shows it)
  resource_updates: Record<string, number>; // per subscribed URI: goes up when its body changed
  sync?: { source: string; name: string; label: string; gone: boolean }; // follows another agent's entry
  endpoint?: string; // what the server is, whatever it is called (sources.ts endpoint)
};

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
  www?: string | null;
  failures: number;
  bundled?: BundledServer;
  resourcesRev: number;
  updates: Record<string, number>;
  subscribed: Set<string>;
};

// Credential-shaped variables stay out of tool servers' environments unless
// the config names them; a server gets what it was configured with.
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|BEARER|SESSION)|^(AWS_|ANTHROPIC_|OPENAI_|CLAUDE_CODE_|GEMINI_|GOOGLE_|AZURE_|KEEL_)/i;

function serverEnv(c: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET.test(k)) env[k] = v;
  for (const k of c.env_vars ?? []) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(c.env ?? {})) env[k] = expand(String(v));
  return env;
}

// Key order is the writer's: compare with keys sorted.
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) : x));

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

const same = (a: McpServerConfig, b: McpServerConfig) => JSON.stringify({ ...a, enabled: undefined }) === JSON.stringify({ ...b, enabled: undefined });

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

  constructor(private errors: ErrorTracker, stateDir: string, private workspace: string) {
    this.oauth = new OAuthStore(stateDir);
    this.bundledOffPath = join(stateDir, "mcp-bundled-off.json");
    this.publishedPath = join(stateDir, "mcp-instructions.json");
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
  }

  start() {
    try {
      this.cfg = readConfig();
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
      e.client?.close();
      unregisterCatalog(e.name);
    }
    this.entries.clear();
  }

  private addEntry(name: string, config: McpServerConfig, bundled?: BundledServer) {
    const e: Entry = { name, config, state: config.enabled === false ? "disabled" : "connecting", tools: [], failures: 0, bundled, resourcesRev: 0, updates: {}, subscribed: new Set() };
    this.entries.set(name, e);
    registerCatalog({
      name,
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
      pending: () => (e.state === "connecting" ? [name] : []),
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
    return {
      server: e.name,
      name: t.name,
      qualified: `${e.name}__${t.name}`,
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
    if (c.command) {
      return { kind: "stdio", command: expand(c.command), args: (c.args ?? []).map((a) => expand(a)), env: serverEnv(c), cwd: c.cwd ? expand(c.cwd) : this.workspace };
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
      const t = this.transport(e);
      // One connection for every session: a turn that happens to open it does
      // not own it, so what it fails with later is no turn's.
      e.connecting = detached(() => (async () => {
        if (e.config.transport === "sse") throw new Error("this server uses the older SSE transport, which Keel does not speak; give its Streamable HTTP address instead");
        if (t.kind === "http" && e.config.headers_helper) {
          const h = await helperHeaders(expand(e.config.headers_helper));
          Object.assign(t.headers, h);
          // The helper's own Authorization wins over a stored sign-in.
          if (Object.keys(h).some((k) => k.toLowerCase() === "authorization")) t.token = undefined;
        }
        const client = await McpClient.connect(t, (e.config.timeout_secs ?? 30) * 1000, e.era);
        // Removed, turned off or replaced meanwhile: this client is nobody's.
        const stale = () => this.entries.get(name) !== e || e.state === "disabled" || this.disposed;
        if (stale()) {
          client.close();
          throw new Error(`${name} was changed while it connected`);
        }
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
        };
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
          if (this.entries.get(name) !== e) throw err;
          if (err instanceof AuthRequired) {
            e.state = "needs_auth";
            e.www = err.wwwAuthenticate;
            e.error = "Sign in to use this server.";
          } else if (e.state !== "disabled") {
            e.state = "error";
            e.error = err.message;
            if (e.failures++ === 0) this.errors.capture("server", err, { mcp: name });
          }
          throw err;
        })
        .finally(() => { e.connecting = undefined; }));
    }
    if (!wait) return e.connecting;
    return Promise.race([
      e.connecting,
      new Promise<McpClient>((_, rej) => setTimeout(() => rej(new Error(`${name} is still connecting`)), wait)),
    ]);
  }

  call(name: string, tool: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const b = this.entries.get(name)?.bundled;
    if (b?.call) return b.call(tool, input, ctx, (t, i, m) => this.callRaw(name, t, i, ctx, m));
    return this.callRaw(name, tool, input, ctx);
  }

  private async callRaw(name: string, tool: string, input: unknown, ctx: ToolContext, meta?: Record<string, unknown>): Promise<ToolOutput> {
    const e = this.entries.get(name);
    const config = e?.config;
    const tools = e?.tools;
    let client: McpClient;
    try {
      client = await this.ensure(name);
    } catch (err) {
      const msg = e?.state === "needs_auth" ? `${name} needs sign-in: the owner signs in from the MCP servers panel.` : (err as Error).message;
      return { content: `MCP server ${name} is not available: ${msg}`, is_error: true };
    }
    // Keep the same entry and listing across connection setup and (for HTTP)
    // header preparation. Those awaits are still before the request is sent.
    const authorize = ctx.authorizationError ? () => ctx.authorizationError!() ??
      (!e || this.entries.get(name) !== e || e.client !== client || e.config !== config || e.tools !== tools
        ? "Refused: the MCP server or tool changed before invocation. Look up the tool again." : undefined) : undefined;
    let r: McpCallResult;
    try {
      r = await client.callTool(tool, input, ctx.signal, (e?.config.tool_timeout_secs ?? 600) * 1000, meta, authorize);
    } catch (err) {
      if (err instanceof McpAuthorizationError) return { content: err.message, is_error: true };
      if (err instanceof AuthRequired && e) {
        e.state = "needs_auth";
        e.www = err.wwwAuthenticate;
        return { content: `${name} needs sign-in again: the owner signs in from the MCP servers panel.`, is_error: true };
      }
      this.errors.capture("tool", err, { mcp: name, tool, session: ctx.sessionId });
      if (err instanceof SessionExpired) return { content: `${name}__${tool} did not run: ${err.message}. Keel opens a new session; the call was not sent again. Look the tool up again and call it if it is still needed.`, is_error: true };
      return { content: `${name}__${tool} failed: ${(err as Error).message}`, is_error: true };
    }
    return toOutput(r, ctx, `${name}__${tool}`);
  }

  // ---- owner actions ----

  list(): McpServerState[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
      const live = e.bundled?.live && e.state !== "disabled" ? e.bundled.live.state() : null;
      return {
      name: e.name,
      transport: e.bundled?.live ? "socket" : e.config.url ? "http" : "stdio",
      target: e.bundled?.live?.target ?? e.config.url ?? [e.config.command, ...(e.config.args ?? [])].join(" "),
      enabled: e.state !== "disabled",
      state: live?.state ?? e.state,
      error: live ? live.error : e.error,
      tools: (e.bundled && !e.client ? e.bundled.tools : e.tools).length,
      tool_names: (e.bundled && !e.client ? e.bundled.tools : e.tools).map((t) => t.name),
      read_tools: e.bundled ? [] : (e.config.read_tools ?? []),
      hinted_reads: e.bundled ? [] : e.tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
      last_connected: e.last,
      era: e.client?.era,
      version: e.client?.version,
      // Name, title and version; icons (data URIs of kilobytes) stay out of a list polled every second or two.
      server_info: e.client?.serverInfo ? { name: e.client.serverInfo.name, title: (e.client.serverInfo as any).title, version: e.client.serverInfo.version } : undefined,
      endpoint: e.bundled ? undefined : endpoint(e.config),
      sign_in: !!e.config.url && !e.config.bearer_env && !e.config.headers_helper,
      sync: e.config.sync ? { ...e.config.sync, label: this.labels.get(e.config.sync.source) ?? e.config.sync.source, gone: this.gone.has(e.name) } : undefined,
      signed_in: !!e.config.url && this.oauth.signedIn(e.name),
      bundled: e.bundled?.label,
      resources: !!e.client?.capabilities.resources,
      prompts: !!e.client?.capabilities.prompts,
      resources_rev: e.resourcesRev,
      resource_updates: e.updates,
    } as McpServerState;
    });
  }

  has(name: string) {
    return this.entries.has(name);
  }

  add(name: string, config: McpServerConfig): string | null {
    const bad = validate(name, config);
    if (bad) return bad;
    this.drop(name);
    this.cfg.servers[name] = config;
    writeConfig(this.cfg);
    this.addEntry(name, config);
    if (config.enabled !== false) this.ensure(name).catch(() => {});
    return null;
  }

  // The owner marks which of a server's tools are reads (they run without asking).
  setReads(name: string, tools: string[]) {
    const e = this.entries.get(name)!;
    if (e.bundled) throw new Error(`${name} is built in: its reads are its own`);
    const c: McpServerConfig = { ...e.config, read_tools: [...new Set(tools.map(String))] };
    if (!c.read_tools!.length) delete c.read_tools;
    e.config = c;
    this.cfg.servers[name] = c;
    writeConfig(this.cfg);
  }

  remove(name: string) {
    if (this.entries.get(name)?.bundled) throw new Error(`${name} is built in: turn it off instead`);
    this.drop(name);
    delete this.cfg.servers[name];
    writeConfig(this.cfg);
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
    if (c) c.retire();
  }

  toggle(name: string, enabled: boolean) {
    const e = this.entries.get(name)!;
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
    e.config = c;
    this.cfg.servers[name] = c;
    writeConfig(this.cfg);
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

  async reconnect(name: string) {
    const e = this.entries.get(name)!;
    if (e.bundled?.live) {
      if (e.state !== "disabled") await e.bundled.live.check();
      return;
    }
    e.client?.close();
    e.client = undefined;
    e.era = undefined;
    if (e.state === "disabled" || e.state === "missing") return;
    e.state = "connecting";
    await this.ensure(name, 15_000).catch(() => {});
  }

  // Read the file again; only what changed restarts.
  reload(only?: string): { servers: McpReloadedServer[] } {
    const next = readConfig(); // throws with the parser's reason: nothing changes
    const out: McpReloadedServer[] = [];
    const names = new Set([...Object.keys(next.servers), ...this.entries.keys()]);
    for (const name of [...names].sort()) {
      if (only && name !== only) continue;
      if (this.entries.get(name)?.bundled) continue; // not from the file
      const now = next.servers[name];
      const e = this.entries.get(name);
      if (!now) {
        this.drop(name);
        out.push({ name, change: "removed" });
      } else if (!e) {
        this.addEntry(name, now);
        if (now.enabled !== false) this.ensure(name).catch(() => {});
        out.push({ name, change: "added" });
      } else if (!same(e.config, now) || (e.config.enabled === false) !== (now.enabled === false)) {
        this.drop(name);
        this.addEntry(name, now);
        if (now.enabled !== false) this.ensure(name).catch(() => {});
        out.push({ name, change: "changed" });
      } else out.push({ name, change: "unchanged" });
    }
    this.cfg = only ? { ...this.cfg, servers: { ...this.cfg.servers, ...(next.servers[only] ? { [only]: next.servers[only] } : {}) } } : next;
    if (only && !next.servers[only]) delete this.cfg.servers[only];
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
    const out: McpReloadedServer[] = [];
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
      if (validate(name, next)) continue;
      this.cfg.servers[name] = next;
      this.drop(name);
      this.addEntry(name, next);
      if (next.enabled !== false) this.ensure(name).catch(() => {});
      out.push({ name, change: "changed" });
    }
    if (out.length) writeConfig(this.cfg);
    return out;
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
    return [...this.entries.values()].filter((e) => e.state === "ready").map((e) => e.name);
  }

  private configKey(e: Entry) {
    return canon({ ...e.config, enabled: undefined });
  }

  private publish(e: Entry, published: string | undefined) {
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
    const live = () => [...this.entries.values()].filter((e) => e.state !== "disabled" && e.state !== "missing");
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
