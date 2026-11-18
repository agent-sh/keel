// A small MCP client: stdio and Streamable HTTP, both protocol eras.
//
// Modern servers (2026-07-28) are stateless: no initialize handshake, every
// request carries its version and capabilities in _meta. Legacy servers
// (2025-03-26 .. 2025-11-25) need initialize, and over HTTP may assign an
// Mcp-Session-Id. We probe with server/discover and fall back to initialize on
// any error that is not a recognized modern one, as the spec's dual-era client
// section says. Most servers in use today are legacy.

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-11-25";
const CLIENT_INFO = { name: "keel", version: "0.1.0" };

// Error codes the modern spec reserves; seeing one means the server is modern.
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);

export type McpTool = { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name?: string; description?: string };
export type McpCallResult = { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };

export type Transport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: "http"; url: string; headers: Record<string, string>; token?: () => Promise<string | undefined> };

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

// 401 from an HTTP server: the manager turns it into needs_auth and the
// WWW-Authenticate header starts discovery.
export class AuthRequired extends Error {
  constructor(readonly wwwAuthenticate: string | null) {
    super("the server needs sign-in");
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class McpClient {
  era: "modern" | "legacy" = "legacy";
  version = LEGACY_VERSION;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  capabilities: Record<string, any> = {};
  onListChanged?: () => void;
  onClose?: (why: string) => void;

  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private proc?: ReturnType<typeof Bun.spawn>;
  private stderrTail = "";
  private sessionId?: string;
  private closed = false;

  private constructor(private t: Transport, private timeoutMs: number) {}

  // `era` skips the probe when an earlier connection to the same config
  // already found it (the spec lets a client cache the era per server).
  static async connect(t: Transport, timeoutMs = 30_000, era?: "modern" | "legacy"): Promise<McpClient> {
    const c = new McpClient(t, timeoutMs);
    if (t.kind === "stdio") c.spawn();
    try {
      await c.handshake(era);
    } catch (e) {
      c.close();
      throw c.withStderr(e);
    }
    return c;
  }

  get target() {
    return this.t.kind === "stdio" ? [this.t.command, ...this.t.args].join(" ") : this.t.url;
  }

  private withStderr(e: unknown): Error {
    const err = e instanceof Error ? e : new Error(String(e));
    const tail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
    if (tail && !(err instanceof AuthRequired)) err.message += `\nstderr: ${tail}`;
    return err;
  }

  private async handshake(known?: "modern" | "legacy") {
    if (known !== "legacy") await this.probe();
    if (this.era === "modern") return;
    const r = await this.rpc("initialize", {
      protocolVersion: LEGACY_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this.version = r?.protocolVersion ?? LEGACY_VERSION;
    this.capabilities = r?.capabilities ?? {};
    this.instructions = r?.instructions;
    this.serverInfo = r?.serverInfo;
    await this.notify("notifications/initialized", {});
  }

  private async probe() {
    // Probe for a modern server first; a short wait, since legacy servers often
    // answer an unknown method quickly and some never answer at all.
    try {
      const r = await this.rpc("server/discover", {}, { timeoutMs: Math.min(5_000, this.timeoutMs), modern: true });
      const versions: string[] = r?.supportedVersions ?? [];
      if (versions.includes(MODERN_VERSION)) {
        this.era = "modern";
        this.version = MODERN_VERSION;
        this.capabilities = r.capabilities ?? {};
        this.instructions = r.instructions;
        this.serverInfo = r._meta?.["io.modelcontextprotocol/serverInfo"];
        return;
      }
    } catch (e) {
      if (e instanceof AuthRequired) throw e;
      if (this.closed) throw e;
      // A modern error means a modern server: falling back to initialize
      // would be wrong, so say which versions it wants.
      if (e instanceof RpcError && MODERN_ERRORS.has(e.code)) {
        const sup = (e.data as any)?.supported ?? (e.data as any)?.supportedVersions;
        throw new Error(`the server speaks MCP ${Array.isArray(sup) ? sup.join(", ") : "versions"} only; keel speaks ${MODERN_VERSION} and ${LEGACY_VERSION}`);
      }
      // any other error (or none in time): a legacy server
    }
    this.era = "legacy";
  }

  // ---- stdio ----

  private spawn() {
    const t = this.t as Extract<Transport, { kind: "stdio" }>;
    const proc = Bun.spawn([t.command, ...t.args], {
      cwd: t.cwd,
      env: t.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.onMessage(line);
        }
      }
    })().catch(() => {});
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        this.stderrTail = (this.stderrTail + dec.decode(chunk, { stream: true })).slice(-4000);
      }
    })().catch(() => {});
    proc.exited.then((code) => {
      const why = `the server exited (code ${code})`;
      this.failAll(this.withStderr(new Error(why)));
      if (!this.closed) {
        this.closed = true;
        this.onClose?.(why);
      }
    });
  }

  private onMessage(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; } // servers sometimes log to stdout
    this.dispatch(msg);
  }

  private dispatch(msg: any) {
    if (Array.isArray(msg)) return msg.forEach((m) => this.dispatch(m));
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message ?? "error", msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server-to-client requests (legacy roots/sampling/elicitation): we
      // offer none of those capabilities, so say so.
      this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `keel does not support ${msg.method}` } });
      return;
    }
    if (msg.method === "notifications/tools/list_changed") this.onListChanged?.();
  }

  private write(msg: unknown) {
    if (this.t.kind === "stdio") {
      const sink = this.proc?.stdin as import("bun").FileSink | undefined;
      sink?.write(JSON.stringify(msg) + "\n");
      sink?.flush();
    } else {
      this.post(msg).catch(() => {});
    }
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  // ---- HTTP ----

  private async headers(method: string, params: any): Promise<Record<string, string>> {
    const t = this.t as Extract<Transport, { kind: "http" }>;
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.version,
      "mcp-method": method,
      ...t.headers,
    };
    const name = params?.name ?? params?.uri;
    if (typeof name === "string" && (method === "tools/call" || method === "resources/read" || method === "prompts/get")) {
      h["mcp-name"] = /^[\x20-\x7e]*$/.test(name) ? name : `=?base64?${Buffer.from(name).toString("base64")}?=`;
    }
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    const tok = await t.token?.();
    if (tok) h.authorization = `Bearer ${tok}`;
    return h;
  }

  // POST one message; responses (JSON or an SSE stream) are dispatched.
  private async post(msg: any, signal?: AbortSignal): Promise<void> {
    const t = this.t as Extract<Transport, { kind: "http" }>;
    const res = await fetch(t.url, {
      method: "POST",
      headers: await this.headers(msg.method, msg.params),
      body: JSON.stringify(msg),
      signal,
    });
    if (res.status === 401) throw new AuthRequired(res.headers.get("www-authenticate"));
    const sid = res.headers.get("mcp-session-id");
    if (sid && this.era === "legacy") this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return;
    const ctype = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let body: any;
      try { body = JSON.parse(text); } catch {}
      if (body?.error && msg.id !== undefined) {
        this.dispatch({ ...body, id: body.id ?? msg.id });
        return;
      }
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    if (ctype.includes("text/event-stream")) return this.readSse(res);
    const text = await res.text();
    if (text.trim()) this.dispatch(JSON.parse(text));
  }

  private async readSse(res: Response) {
    const dec = new TextDecoder();
    let buf = "";
    let data: string[] = [];
    for await (const chunk of res.body as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (data.length) {
            try { this.dispatch(JSON.parse(data.join("\n"))); } catch {}
          }
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (data.length) try { this.dispatch(JSON.parse(data.join("\n"))); } catch {}
  }

  // ---- requests ----

  private meta() {
    return {
      "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    };
  }

  async rpc(method: string, params: any = {}, opt: { signal?: AbortSignal; timeoutMs?: number; modern?: boolean } = {}): Promise<any> {
    if (this.closed) throw new Error("the connection is closed");
    const id = this.nextId++;
    const p = opt.modern || this.era === "modern" ? { ...params, _meta: { ...params._meta, ...this.meta() } } : params;
    const msg = { jsonrpc: "2.0", id, method, params: p };
    const timeoutMs = opt.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const done = (f: (v: any) => void) => (v: any) => { clearTimeout(timer); opt.signal?.removeEventListener("abort", onAbort); f(v); };
      const onAbort = () => {
        this.pending.delete(id);
        if (this.era === "legacy") this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } });
        done(reject)(new Error("cancelled"));
      };
      opt.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      if (this.t.kind === "stdio") this.write(msg);
      else {
        const ac = new AbortController();
        opt.signal?.addEventListener("abort", () => ac.abort(), { once: true });
        this.post(msg, ac.signal).then(
          () => {
            // A stream that ended without our answer loses the request.
            if (this.pending.has(id)) { this.pending.delete(id); done(reject)(new Error(`${method}: the server closed the response without an answer`)); }
          },
          (e) => { if (this.pending.has(id)) { this.pending.delete(id); done(reject)(e); } },
        );
      }
    });
  }

  async notify(method: string, params: any = {}) {
    const msg = { jsonrpc: "2.0", method, params };
    if (this.t.kind === "stdio") this.write(msg);
    else await this.post(msg);
  }

  // Lists follow nextCursor; a bound stops a server that never ends a listing.
  private async list<T>(method: string, key: string, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.rpc(method, cursor ? { cursor } : {}, { signal });
      out.push(...(r?.[key] ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  listTools(signal?: AbortSignal) { return this.list<McpTool>("tools/list", "tools", signal); }
  listResources(signal?: AbortSignal) { return this.list<any>("resources/list", "resources", signal); }
  listResourceTemplates(signal?: AbortSignal) { return this.list<any>("resources/templates/list", "resourceTemplates", signal); }
  listPrompts(signal?: AbortSignal) { return this.list<any>("prompts/list", "prompts", signal); }
  readResource(uri: string, signal?: AbortSignal) { return this.rpc("resources/read", { uri }, { signal }); }
  getPrompt(name: string, args: Record<string, string> = {}, signal?: AbortSignal) { return this.rpc("prompts/get", { name, arguments: args }, { signal }); }
  callTool(name: string, args: unknown, signal?: AbortSignal, timeoutMs?: number, meta?: Record<string, unknown>): Promise<McpCallResult> {
    return this.rpc("tools/call", { name, arguments: args ?? {}, ...(meta ? { _meta: meta } : {}) }, { signal, timeoutMs });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("the connection is closed"));
    if (this.proc) {
      try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
      const proc = this.proc;
      setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 2000).unref?.();
      proc.kill("SIGTERM");
    } else if (this.sessionId && this.t.kind === "http") {
      // legacy HTTP session: say goodbye; failures do not matter
      this.headers("", {}).then((h) => fetch((this.t as any).url, { method: "DELETE", headers: h })).catch(() => {});
    }
  }
}
