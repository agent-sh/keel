// One MCP manager per daemon: the configured servers, their connections and
// states, and one catalog source per server so search_tools finds their tools.
// Servers connect in the background after startup and on first use; a reload
// restarts only the servers whose config changed, and never touches a session's
// request prefix (MCP tools are deferred, so the eager tool list is fixed).
import type { ErrorTracker } from "../core/errors.ts";
import { registerCatalog, unregisterCatalog, type CatalogTool } from "../tools/catalog.ts";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import { AuthRequired, McpClient, type McpCallResult, type McpTool, type Transport } from "./client.ts";
import { expand, importable, readConfig, validate, writeConfig, type McpConfigFile, type McpServerConfig } from "./config.ts";
import { OAuthStore } from "./oauth.ts";
import { toOutput } from "./result.ts";

export type McpState = "disabled" | "connecting" | "ready" | "error" | "needs_auth";

export type McpServerState = {
  name: string;
  transport: "stdio" | "http";
  target: string;
  enabled: boolean;
  state: McpState;
  error?: string;
  tools: number;
  tool_names: string[];
  last_connected?: number;
  era?: "modern" | "legacy";
  version?: string;
  server_info?: { name?: string; version?: string };
  sign_in: boolean;   // the server can take an OAuth sign-in (HTTP)
  signed_in: boolean;
};

export type McpReloadedServer = { name: string; change: "added" | "removed" | "changed" | "unchanged" };

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

const same = (a: McpServerConfig, b: McpServerConfig) => JSON.stringify({ ...a, enabled: undefined }) === JSON.stringify({ ...b, enabled: undefined });

export class McpManager {
  private entries = new Map<string, Entry>();
  private cfg: McpConfigFile = { servers: {} };
  readonly oauth: OAuthStore;
  private disposed = false;

  constructor(private errors: ErrorTracker, stateDir: string, private workspace: string) {
    this.oauth = new OAuthStore(stateDir);
  }

  start() {
    try {
      this.cfg = readConfig();
    } catch (e) {
      this.errors.capture("server", e, { at: "mcp config" });
    }
    for (const [name, c] of Object.entries(this.cfg.servers)) this.addEntry(name, c);
    // Connect in the background so the panel shows real states; nothing waits on it.
    setTimeout(() => {
      for (const e of this.entries.values()) if (e.state !== "disabled") this.ensure(e.name).catch(() => {});
    }, 50);
  }

  dispose() {
    this.disposed = true;
    for (const e of this.entries.values()) {
      e.client?.close();
      unregisterCatalog(e.name);
    }
    this.entries.clear();
  }

  private addEntry(name: string, config: McpServerConfig) {
    const e: Entry = { name, config, state: config.enabled === false ? "disabled" : "connecting", tools: [], failures: 0 };
    this.entries.set(name, e);
    registerCatalog({
      name,
      tools: async () => {
        if (e.state === "disabled" || e.state === "needs_auth") return [];
        try {
          await this.ensure(name, 8_000);
        } catch {
          return [];
        }
        return e.tools.map((t) => this.catalogTool(e, t));
      },
      pending: () => (e.state === "connecting" ? [name] : []),
    });
    return e;
  }

  private catalogTool(e: Entry, t: McpTool): CatalogTool {
    return {
      server: e.name,
      name: t.name,
      qualified: `${e.name}__${t.name}`,
      description: t.description ?? t.title ?? "",
      input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
      readOnly: t.annotations?.readOnlyHint === true,
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
    if (e.state === "disabled") return Promise.reject(new Error(`${name} is turned off`));
    if (e.client && e.state === "ready") return Promise.resolve(e.client);
    if (!e.connecting) {
      e.state = "connecting";
      e.error = undefined;
      const t = this.transport(e);
      e.connecting = (async () => {
        const client = await McpClient.connect(t, (e.config.timeout_secs ?? 30) * 1000, e.era);
        if (this.entries.get(name) !== e || e.state === "disabled" || this.disposed) {
          client.close();
          throw new Error(`${name} was changed while it connected`);
        }
        // A server without the tools capability may still answer; one that
        // does not just has no tools.
        e.tools = await client.listTools().catch((err) => {
          if (client.capabilities.tools === undefined) return [];
          throw err;
        });
        e.client = client;
        e.era = client.era;
        e.state = "ready";
        e.last = Date.now();
        e.failures = 0;
        client.onListChanged = () => { client.listTools().then((t) => (e.tools = t)).catch(() => {}); };
        client.onClose = (why) => {
          if (e.client !== client) return;
          e.client = undefined;
          e.state = "error";
          e.error = why;
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
        .finally(() => { e.connecting = undefined; });
    }
    if (!wait) return e.connecting;
    return Promise.race([
      e.connecting,
      new Promise<McpClient>((_, rej) => setTimeout(() => rej(new Error(`${name} is still connecting`)), wait)),
    ]);
  }

  async call(name: string, tool: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const e = this.entries.get(name);
    let client: McpClient;
    try {
      client = await this.ensure(name);
    } catch (err) {
      const msg = e?.state === "needs_auth" ? `${name} needs sign-in: the owner signs in from the MCP servers panel.` : (err as Error).message;
      return { content: `MCP server ${name} is not available: ${msg}`, is_error: true };
    }
    let r: McpCallResult;
    try {
      r = await client.callTool(tool, input, ctx.signal, (e?.config.tool_timeout_secs ?? 600) * 1000);
    } catch (err) {
      if (err instanceof AuthRequired && e) {
        e.state = "needs_auth";
        e.www = err.wwwAuthenticate;
        return { content: `${name} needs sign-in again: the owner signs in from the MCP servers panel.`, is_error: true };
      }
      this.errors.capture("tool", err, { mcp: name, tool, session: ctx.sessionId });
      return { content: `${name}__${tool} failed: ${(err as Error).message}`, is_error: true };
    }
    return toOutput(r, ctx, `${name}__${tool}`);
  }

  // ---- owner actions ----

  list(): McpServerState[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({
      name: e.name,
      transport: e.config.url ? "http" : "stdio",
      target: e.config.url ?? [e.config.command, ...(e.config.args ?? [])].join(" "),
      enabled: e.state !== "disabled",
      state: e.state,
      error: e.error,
      tools: e.tools.length,
      tool_names: e.tools.map((t) => t.name),
      last_connected: e.last,
      era: e.client?.era,
      version: e.client?.version,
      server_info: e.client?.serverInfo,
      sign_in: !!e.config.url && !e.config.bearer_env,
      signed_in: !!e.config.url && this.oauth.signedIn(e.name),
    }));
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

  remove(name: string) {
    this.drop(name);
    delete this.cfg.servers[name];
    writeConfig(this.cfg);
  }

  private drop(name: string) {
    const e = this.entries.get(name);
    if (!e) return;
    e.client?.close();
    this.entries.delete(name);
    unregisterCatalog(name);
  }

  toggle(name: string, enabled: boolean) {
    const e = this.entries.get(name)!;
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
    e.client?.close();
    e.client = undefined;
    e.era = undefined;
    if (e.state === "disabled") return;
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

  importable() {
    return importable(this.workspace, this.cfg.servers);
  }

  importFrom(source: string, name: string): string | null {
    const hit = this.importable().find((i) => i.source === source && i.name === name);
    if (!hit) return `${source} has no server named ${name}`;
    return this.add(name, hit.config);
  }

  // ---- resources and prompts ----

  async resources(name: string, signal?: AbortSignal) {
    const c = await this.ensure(name, 15_000);
    const [resources, templates] = await Promise.all([
      c.listResources(signal),
      c.listResourceTemplates(signal).catch(() => []),
    ]);
    return [...resources, ...templates];
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<string> {
    const c = await this.ensure(name, 15_000);
    const r = await c.readResource(uri, signal);
    return (r?.contents ?? [])
      .map((p: any) => (p.text !== undefined ? p.text : `[binary ${p.mimeType ?? "data"}, ${Math.round(((p.blob?.length ?? 0) * 3) / 4)} bytes: ${p.uri}]`))
      .join("\n");
  }

  async prompts(name: string, signal?: AbortSignal) {
    const c = await this.ensure(name, 15_000);
    return c.listPrompts(signal);
  }

  async getPrompt(name: string, prompt: string, args: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const c = await this.ensure(name, 15_000);
    const r = await c.getPrompt(prompt, args, signal);
    return (r?.messages ?? [])
      .map((m: any) => `${m.role}: ${m.content?.type === "text" ? m.content.text : m.content?.type === "resource" ? m.content.resource?.text ?? "" : `[${m.content?.type}]`}`)
      .join("\n");
  }

  ready(): string[] {
    return [...this.entries.values()].filter((e) => e.state === "ready").map((e) => e.name);
  }

  configured(): { name: string; instructions?: string }[] {
    return [...this.entries.values()].filter((e) => e.state !== "disabled").map((e) => ({ name: e.name, instructions: e.client?.instructions }));
  }
}
