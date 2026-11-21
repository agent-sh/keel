// A small MCP client: stdio and Streamable HTTP, both protocol eras.
//
// Modern servers (2026-07-28) are stateless: no initialize handshake, every
// request carries its version and capabilities in _meta. Legacy servers
// (2025-03-26 .. 2025-11-25) need initialize, and over HTTP may assign an
// Mcp-Session-Id. We probe with server/discover and fall back to initialize on
// any error that is not a recognized modern one, as the spec's dual-era client
// section says. Most servers in use today are legacy.
import { chunks, pumpLines, pumpText } from "../core/proc.ts";

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
export class McpAuthorizationError extends Error {}

export class AuthRequired extends Error {
  constructor(readonly wwwAuthenticate: string | null) {
    super("the server needs sign-in");
  }
}

// 404 on a request that named the legacy HTTP session: the server ended it.
// The request was refused, not run; nothing sends it again.
export class SessionExpired extends Error {
  constructor() {
    super("the server ended its session and refused the request (HTTP 404)");
  }
}

// What an SSE stream said besides its messages: the last event ID, the wait
// the server asked for before a reconnect, and how many events came.
type SseState = { id?: string; retry?: number; events: number };

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class McpClient {
  era: "modern" | "legacy" = "legacy";
  version = LEGACY_VERSION;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  capabilities: Record<string, any> = {};
  onListChanged?: () => void;
  // The resource list changed, or (after a subscription) one resource's body did.
  onResources?: (change: { list: true } | { uri: string }) => void;
  // Set late, it still hears a close that already happened.
  private closeHook?: (why: string) => void;
  private closedWhy?: string;
  get onClose() { return this.closeHook; }
  set onClose(f: ((why: string) => void) | undefined) {
    this.closeHook = f;
    if (f && this.closedWhy !== undefined) f(this.closedWhy);
  }
  get isClosed() { return this.closed; }
  // The server ended this client's session: it takes no new request, and a new session needs a new client.
  expired = false;
  get inflight() { return this.pending.size; }

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
    this.listen();
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
    void pumpLines(proc.stdout as ReadableStream<Uint8Array>, (l) => { const line = l.trim(); if (line) this.onMessage(line); }, "mcp stdout");
    void pumpText(proc.stderr as ReadableStream<Uint8Array>, (t) => (this.stderrTail = (this.stderrTail + t).slice(-4000)), "mcp stderr");
    proc.exited.then((code) => {
      const why = `the server exited (code ${code})`;
      this.failAll(this.withStderr(new Error(why)));
      this.shut(why);
    });
  }

  // The other side ended it: no new request goes out, and the owner of this client hears why.
  private shut(why: string) {
    if (this.closed) return;
    this.closed = true;
    this.closedWhy = why;
    this.stream?.abort();
    this.closeHook?.(why);
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
    else if (msg.method === "notifications/resources/list_changed") this.onResources?.({ list: true });
    else if (msg.method === "notifications/resources/updated" && typeof msg.params?.uri === "string") this.onResources?.({ uri: msg.params.uri });
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
      // A modern request names its version in _meta; the header must match it (the probe runs before the era is known).
      "mcp-protocol-version": params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? this.version,
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
  private async post(msg: any, signal?: AbortSignal, authorize?: () => string | undefined): Promise<void> {
    const t = this.t as Extract<Transport, { kind: "http" }>;
    const headers = await this.headers(msg.method, msg.params);
    const deny = authorize?.();
    if (deny) throw new McpAuthorizationError(deny);
    const res = await fetch(t.url, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
      signal,
    });
    if (res.status === 401) throw new AuthRequired(res.headers.get("www-authenticate"));
    // Legacy sessions (2025-11-25 transports, Session Management 3 and 4): a
    // server that ended the session answers 404 to every request naming it,
    // and the client starts a new session with a new initialize. Requests
    // already answering on the old session end on their own.
    const named = headers["mcp-session-id"];
    if (res.status === 404 && named) {
      if (this.sessionId === named) {
        this.sessionId = undefined; // nothing left to say goodbye to
        this.expired = true;
        this.shut("the server ended the session");
      }
      throw new SessionExpired();
    }
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

  private async readSse(res: Response, st?: SseState) {
    const dec = new TextDecoder();
    let buf = "";
    let data: string[] = [];
    const value = (line: string, name: string) => line.slice(name.length + 1).replace(/^ /, "");
    for await (const chunk of chunks(res.body!)) {
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
        } else if (line.startsWith("data:")) {
          data.push(value(line, "data"));
          if (st) st.events++;
        } else if (st && line.startsWith("id:")) st.id = value(line, "id");
        else if (st && line.startsWith("retry:") && /^\d+$/.test(value(line, "retry"))) st.retry = Number(value(line, "retry"));
      }
    }
    if (data.length) try { this.dispatch(JSON.parse(data.join("\n"))); } catch {}
  }

  // ---- the standalone stream (legacy HTTP) ----

  // A legacy server may send messages outside any request: a list changed,
  // a resource was updated. They come on an SSE stream the client opens with
  // GET (2025-11-25 transports, Listening for Messages from the Server). It
  // is opened for a server that says it sends what Keel listens to. A server
  // that answers 405, or anything but a stream, offers none: requests go on
  // without it, and it is not asked again.
  //
  // A stream that ended is opened again from the last event it carried
  // (Resumability and Redelivery), after the wait the server named (`retry`),
  // else after a second, growing 1.5 times to 30 s while streams end with
  // nothing on them. Two failures to open in a row end it (the delays and
  // the count are the reference SDK's). A session that ended is found by the
  // next request, not here.
  private stream?: AbortController;
  private listen() {
    const c = this.capabilities;
    if (this.t.kind !== "http" || this.era !== "legacy" || this.closed || this.stream) return;
    if (!c.tools?.listChanged && !c.resources?.listChanged && !c.resources?.subscribe) return;
    const url = this.t.url;
    const ac = (this.stream = new AbortController());
    const st: SseState = { events: 0 };
    void (async () => {
      let failed = 0, quiet = 0;
      while (!ac.signal.aborted) {
        const before = st.events;
        try {
          const h = await this.headers("", {});
          delete h["content-type"];
          delete h["mcp-method"];
          h.accept = "text/event-stream";
          if (st.id !== undefined) h["last-event-id"] = st.id;
          // Bun ends a response that stays silent for five minutes; this one is silent by nature.
          const res = await fetch(url, { method: "GET", headers: h, signal: ac.signal, timeout: false } as RequestInit);
          const stream = res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream");
          if (!stream) {
            void res.body?.cancel().catch(() => {});
            if (res.status < 500) return;
            throw new Error(`HTTP ${res.status}`);
          }
          failed = 0;
          await this.readSse(res, st).catch(() => {}); // a cut stream is an ended one
        } catch {
          if (++failed > 2) return;
        }
        if (ac.signal.aborted) return;
        const wait = st.retry ?? Math.min(30_000, 1000 * 1.5 ** quiet);
        quiet = st.events > before ? 0 : quiet + 1;
        await pause(wait, ac.signal);
      }
    })();
  }

  // ---- requests ----

  private meta() {
    return {
      "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    };
  }

  async rpc(method: string, params: any = {}, opt: { signal?: AbortSignal; timeoutMs?: number; modern?: boolean; authorize?: () => string | undefined } = {}): Promise<any> {
    const deny = opt.authorize?.();
    if (deny) throw new McpAuthorizationError(deny);
    if (this.closed) throw new Error("the connection is closed");
    const id = this.nextId++;
    const p = opt.modern || this.era === "modern" ? { ...params, _meta: { ...params._meta, ...this.meta() } } : params;
    const msg = { jsonrpc: "2.0", id, method, params: p };
    const timeoutMs = opt.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
        this.settled();
      }, timeoutMs);
      const ac = new AbortController();
      const forward = () => ac.abort();
      const done = (f: (v: any) => void) => (v: any) => { clearTimeout(timer); opt.signal?.removeEventListener("abort", onAbort); opt.signal?.removeEventListener("abort", forward); f(v); this.settled(); };
      const onAbort = () => {
        this.pending.delete(id);
        if (this.era === "legacy") this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } });
        done(reject)(new Error("cancelled"));
      };
      opt.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      if (this.t.kind === "stdio") this.write(msg);
      else {
        opt.signal?.addEventListener("abort", forward, { once: true });
        this.post(msg, ac.signal, opt.authorize).then(
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

  // Lists follow nextCursor: only a missing one ends a listing (a cursor is an
  // opaque string, "" included). A bound stops a server that never ends one;
  // what it stopped at comes back as `next`, so a caller can go on from there.
  async page<T>(method: string, key: string, signal?: AbortSignal, from?: string): Promise<{ items: T[]; next?: string }> {
    const items: T[] = [];
    let cursor = from;
    for (let page = 0; page < 50; page++) {
      const r = await this.rpc(method, cursor !== undefined ? { cursor } : {}, { signal });
      items.push(...(r?.[key] ?? []));
      cursor = typeof r?.nextCursor === "string" ? r.nextCursor : undefined;
      if (cursor === undefined) return { items };
    }
    return { items, next: cursor };
  }
  private async list<T>(method: string, key: string, signal?: AbortSignal): Promise<T[]> {
    return (await this.page<T>(method, key, signal)).items;
  }

  listTools(signal?: AbortSignal) { return this.list<McpTool>("tools/list", "tools", signal); }
  listResources(signal?: AbortSignal, from?: string) { return this.page<any>("resources/list", "resources", signal, from); }
  listResourceTemplates(signal?: AbortSignal, from?: string) { return this.page<any>("resources/templates/list", "resourceTemplates", signal, from); }
  listPrompts(signal?: AbortSignal) { return this.list<any>("prompts/list", "prompts", signal); }
  readResource(uri: string, signal?: AbortSignal) { return this.rpc("resources/read", { uri }, { signal }); }
  getPrompt(name: string, args: Record<string, string> = {}, signal?: AbortSignal) { return this.rpc("prompts/get", { name, arguments: args }, { signal }); }
  callTool(name: string, args: unknown, signal?: AbortSignal, timeoutMs?: number, meta?: Record<string, unknown>, authorize?: () => string | undefined): Promise<McpCallResult> {
    return this.rpc("tools/call", { name, arguments: args ?? {}, ...(meta ? { _meta: meta } : {}) }, { signal, timeoutMs, authorize });
  }

  // Close once nothing waits on this client (a reload replaced it).
  retire() {
    if (!this.pending.size) return this.close();
    this.retiring = true;
  }
  private retiring = false;
  private settled() {
    if (this.retiring && !this.pending.size) queueMicrotask(() => this.close());
  }

  close() {
    this.failAll(new Error("the connection is closed"));
    this.stream?.abort();
    if (this.closed) return;
    this.closed = true;
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
