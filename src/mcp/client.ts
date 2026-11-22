// A small MCP client: stdio, Streamable HTTP in both protocol eras, and the
// older HTTP with SSE transport (2024-11-05) that servers still in use speak.
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
  // `started`: told the process once it runs, so its owner can see that it ends (src/mcp/procs.ts).
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string; started?: (proc: { pid: number; kill(signal?: number | NodeJS.Signals): void; exited: Promise<unknown> }) => void }
  // `sse`: the older HTTP with SSE transport. The URL is the server's event
  // stream: its first event names the address messages are posted to, and
  // every answer and notification comes back on the stream.
  | { kind: "http"; url: string; headers: Record<string, string>; token?: () => Promise<string | undefined>; sse?: boolean };

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
// the server asked for before a reconnect, and how many messages it carried.
type SseState = { id?: string; retry?: number; messages: number };

// The most one event of the standalone stream may hold. It carries
// notifications (a method and a URI) and requests Keel refuses: an event
// past a megabyte is nothing Keel reads, and a stream with no line end at
// all would otherwise be kept in memory whole.
const STREAM_EVENT_MAX = 1 << 20;

// No request to an MCP server follows a redirect. Its headers (a key the
// owner configured, a sign-in's token) and the request's body were given for
// the address named: a redirect would carry them wherever the server says,
// another origin included. A 3xx is a refusal that says where it pointed, so
// the owner can give that address when it is the server's own.
const DIRECT = { redirect: "manual" as const };
function moved(res: Response, url: string): Error | undefined {
  if (res.status < 300 || res.status >= 400 || res.status === 304) return;
  let to = "";
  try { const u = new URL(res.headers.get("location") ?? "", url); to = ` to ${u.origin}${u.pathname}`; } catch {}
  void res.body?.cancel().catch(() => {});
  return new Error(`${new URL(url).origin} answered with a redirect${to}, which is not followed: a server's headers go only to the address given. Give the address it redirects to, if that is the server's own.`);
}
class StreamOverrun extends Error {}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  const end = () => { clearTimeout(t); signal.removeEventListener("abort", end); res(); };
  const t = setTimeout(end, ms);
  signal.addEventListener("abort", end, { once: true });
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
  // `signal`: nobody wants the connection any more (its server was dropped
  // while it connected): the process ends now, not when the handshake gives up.
  static async connect(t: Transport, timeoutMs = 30_000, era?: "modern" | "legacy", signal?: AbortSignal): Promise<McpClient> {
    if (signal?.aborted) throw new Error("the server was dropped before it connected");
    const c = new McpClient(t, timeoutMs);
    if (t.kind === "stdio") c.spawn();
    const dropped = () => c.close();
    signal?.addEventListener("abort", dropped, { once: true });
    try {
      // A server of the older transport predates the modern era: no probe.
      if (t.kind === "http" && t.sse) { await c.openEvents(); era = "legacy"; }
      await c.handshake(era);
    } catch (e) {
      c.close();
      throw c.withStderr(e);
    } finally {
      signal?.removeEventListener("abort", dropped);
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
    t.started?.(proc);
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
    this.events?.abort();
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
    // The server asks whether the client is there (2025-11-25 Ping: an empty result, promptly).
    if (msg.method === "ping" && msg.id !== undefined) return this.write({ jsonrpc: "2.0", id: msg.id, result: {} });
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

  // ---- HTTP with SSE (2024-11-05) ----

  // The server's event stream, held for the life of the client. Its first
  // event, `endpoint`, names where messages are posted (a path or a URL of
  // the same origin: a server cannot send the client's requests elsewhere).
  // Every later `message` event is a JSON-RPC message: an answer to a posted
  // request, a notification, a request of the server's own. The stream
  // ending ends the client: its requests have nowhere to be answered.
  private events?: AbortController;
  private endpoint?: string;
  private async openEvents() {
    const t = this.t as Extract<Transport, { kind: "http" }>;
    const ac = new AbortController();
    this.events = ac;
    const headers: Record<string, string> = { accept: "text/event-stream", ...t.headers };
    const tok = await t.token?.();
    if (tok) headers.authorization = `Bearer ${tok}`;
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(t.url, { headers, signal: ac.signal, timeout: false, ...DIRECT } as RequestInit);
    } catch (e) {
      clearTimeout(timer);
      throw ac.signal.aborted ? new Error(`the event stream did not open within ${Math.round(this.timeoutMs / 1000)}s`) : e;
    }
    const elsewhere = moved(res, t.url);
    if (elsewhere) { clearTimeout(timer); ac.abort(); throw elsewhere; }
    if (res.status === 401) { clearTimeout(timer); throw new AuthRequired(res.headers.get("www-authenticate")); }
    if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      clearTimeout(timer);
      ac.abort();
      throw new Error(`no event stream at ${t.url}: HTTP ${res.status}${res.ok ? `, ${res.headers.get("content-type") ?? "no content type"}` : ""}`);
    }
    let named!: () => void, refused!: (e: Error) => void;
    const ready = new Promise<void>((ok, no) => { named = ok; refused = no; });
    const read = async () => {
      const dec = new TextDecoder();
      let buf = "", event = "message", data: string[] = [];
      let held = 0; // the bytes of the event being read
      const value = (line: string, name: string) => line.slice(name.length + 1).replace(/^ /, "");
      const flush = () => {
        const body = data.join("\n"), kind = event;
        data = [];
        held = 0;
        event = "message";
        if (!body) return;
        if (kind === "endpoint") {
          if (this.endpoint) return; // named once
          let to: URL;
          try { to = new URL(body, t.url); } catch { return refused(new Error(`the server named an address that is not one: ${body.slice(0, 200)}`)); }
          if (to.origin !== new URL(t.url).origin) return refused(new Error(`the server named another origin for its messages (${to.origin}): refused`));
          this.endpoint = to.href;
          return named();
        }
        if (kind !== "message") return;
        let msg: unknown;
        try { msg = JSON.parse(body); } catch { return; }
        try { this.dispatch(msg); } catch {}
      };
      for await (const chunk of chunks(res.body!)) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line === "") flush();
          else if (line.startsWith("event:")) event = value(line, "event");
          else if (line.startsWith("data:")) {
            data.push(value(line, "data"));
            held += line.length;
          }
        }
        // One event is held to a bound, whether it is one line with no end or
        // data lines with no blank line after them: this stream lives as long
        // as the client, and no timer of a request ends it.
        if (held + buf.length > STREAM_EVENT_MAX) throw new StreamOverrun();
      }
    };
    read().then(
      () => "the server closed its event stream",
      (e) => (ac.signal.aborted ? "the connection is closed" : e instanceof StreamOverrun ? "the server sent an event too large to read" : `the event stream broke: ${(e as Error).message}`),
    ).then((why) => {
      refused(new Error(why));
      if (this.closed) return;
      this.failAll(new Error(why));
      this.shut(why);
    });
    try {
      await ready;
    } catch (e) {
      ac.abort();
      throw e;
    } finally {
      clearTimeout(timer);
    }
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
    const to = t.sse ? this.endpoint! : t.url;
    const res = await fetch(to, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
      signal,
      ...DIRECT,
      // A request's own timer aborts it (rpc), so that timer is its one limit:
      // Bun would end a response that stays silent for five minutes, well
      // inside a long tool call's time.
      ...(signal ? { timeout: false } : {}),
    } as RequestInit);
    const elsewhere = moved(res, to);
    if (elsewhere) throw elsewhere;
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
    // The older transport answers on its stream: what an accepted POST says in
    // its body ("Accepted", an empty object) is no message.
    if (t.sse) return void res.body?.cancel().catch(() => {});
    if (ctype.includes("text/event-stream")) return this.readSse(res);
    const text = await res.text();
    if (text.trim()) this.dispatch(JSON.parse(text));
  }

  private async readSse(res: Response, st?: SseState) {
    const dec = new TextDecoder();
    let buf = "";
    let data: string[] = [];
    let held = 0; // the bytes of the event being read
    const value = (line: string, name: string) => line.slice(name.length + 1).replace(/^ /, "");
    // An event with no JSON in it (the priming event, a comment) is no message.
    const event = () => {
      if (!data.length) return;
      let msg: unknown;
      try { msg = JSON.parse(data.join("\n")); } catch { return; } finally { data = []; held = 0; }
      if (st) st.messages++;
      try { this.dispatch(msg); } catch {} // as before: a message that cannot be handled does not end the stream
    };
    for await (const chunk of chunks(res.body!)) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") event();
        else if (line.startsWith("data:")) {
          data.push(value(line, "data"));
          held += line.length;
        } else if (st && line.startsWith("id:")) st.id = value(line, "id");
        else if (st && line.startsWith("retry:") && /^\d+$/.test(value(line, "retry"))) st.retry = Number(value(line, "retry"));
      }
      // A request's stream ends with its timer; the standalone one has this bound.
      if (st && held + buf.length > STREAM_EVENT_MAX) throw new StreamOverrun();
    }
    event();
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
  // (Resumability and Redelivery), after a second, growing 1.5 times to 30 s
  // while streams end with no message on them, or after the wait the server
  // named (`retry`) when that is longer: a server cannot ask to be polled
  // faster than the backoff. Three failures to open in a row end it: the
  // first and two retries (the delays and the count are the reference
  // SDK's). So does an event past the bound. A session that ended is found
  // by the next request, not here.
  private stream?: AbortController;
  private listen() {
    const c = this.capabilities;
    // (The older transport's own event stream carries what the server sends: there is no second one to open.)
    if (this.t.kind !== "http" || this.t.sse || this.era !== "legacy" || this.closed || this.stream) return;
    if (!c.tools?.listChanged && !c.resources?.listChanged && !c.resources?.subscribe) return;
    const url = this.t.url;
    const ac = (this.stream = new AbortController());
    const st: SseState = { messages: 0 };
    void (async () => {
      let failed = 0, quiet = 0, overrun = false;
      while (!ac.signal.aborted) {
        const before = st.messages;
        try {
          const h = await this.headers("", {});
          delete h["content-type"];
          delete h["mcp-method"];
          h.accept = "text/event-stream";
          if (st.id !== undefined) h["last-event-id"] = st.id;
          // Bun ends a response that stays silent for five minutes; this one is silent by nature.
          // (A redirect is not followed: it reads as no stream here, like any other answer below 500.)
          const res = await fetch(url, { method: "GET", headers: h, signal: ac.signal, timeout: false, ...DIRECT } as RequestInit);
          const stream = res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream");
          if (!stream) {
            void res.body?.cancel().catch(() => {});
            if (res.status < 500) return;
            throw new Error(`HTTP ${res.status}`);
          }
          failed = 0;
          await this.readSse(res, st).catch((e) => { overrun = e instanceof StreamOverrun; }); // a cut stream is an ended one
        } catch {
          if (++failed > 2) return;
        }
        if (ac.signal.aborted || overrun) return;
        quiet = st.messages > before ? 0 : quiet + 1;
        await pause(Math.max(st.retry ?? 0, Math.min(30_000, 1000 * 1.5 ** Math.max(0, quiet - 1))), ac.signal);
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
    if (opt.signal?.aborted) throw new Error("cancelled");
    const id = this.nextId++;
    const p = opt.modern || this.era === "modern" ? { ...params, _meta: { ...params._meta, ...this.meta() } } : params;
    const msg = { jsonrpc: "2.0", id, method, params: p };
    const timeoutMs = opt.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The one way out, for an answer, a failure, a timeout and a cancel: the
      // entry, the timer and the caller's listener go, and a POST still open
      // is aborted (after an answer that only ends a stream left open).
      const done = (f: (v: any) => void) => (v: any) => {
        clearTimeout(timer);
        opt.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        ac.abort();
        f(v);
        this.settled();
      };
      const fail = done(reject);
      // Stop waiting, and tell the server. Over stdio there is no response to
      // close, so the notification is the only cancellation, in both eras; a
      // legacy HTTP server is sent it too (lifecycle: Timeouts). For a modern
      // HTTP server the closed response is the cancellation. initialize is
      // never cancelled, and the probe runs before the era is known.
      const giveUp = (why: string, reason: string) => {
        if (!this.pending.has(id)) return;
        fail(new Error(why));
        const told = this.t.kind === "stdio" || this.era === "legacy";
        if (told && !opt.modern && method !== "initialize" && !this.closed) this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } });
      };
      const onAbort = () => giveUp("cancelled", "cancelled");
      this.pending.set(id, { resolve: done(resolve), reject: fail });
      timer = setTimeout(() => giveUp(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`, "timed out"), timeoutMs);
      opt.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.t.kind === "stdio") this.write(msg);
      // Over the older transport the POST is only accepted; the answer comes on the event stream.
      else if (this.t.sse) this.post(msg, ac.signal, opt.authorize).catch((e) => { if (this.pending.has(id)) fail(e); });
      else {
        this.post(msg, ac.signal, opt.authorize).then(
          // A stream that ended without our answer loses the request.
          () => { if (this.pending.has(id)) fail(new Error(`${method}: the server closed the response without an answer`)); },
          (e) => { if (this.pending.has(id)) fail(e); },
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
  // A continuation that failed comes back the same way, with the pages before
  // it and the failure: asking again from `next` sends the cursor that failed.
  // (A cursor is this connection's: on a closed one the failure is thrown.)
  async page<T>(method: string, key: string, signal?: AbortSignal, from?: string): Promise<{ items: T[]; next?: string; error?: Error }> {
    const items: T[] = [];
    let cursor = from;
    for (let page = 0; page < 50; page++) {
      let r: any;
      try {
        r = await this.rpc(method, cursor !== undefined ? { cursor } : {}, { signal });
      } catch (e) {
        if (cursor === undefined || signal?.aborted || this.closed) throw e;
        return { items, next: cursor, error: e as Error };
      }
      items.push(...(r?.[key] ?? []));
      cursor = typeof r?.nextCursor === "string" ? r.nextCursor : undefined;
      if (cursor === undefined) return { items };
    }
    return { items, next: cursor };
  }
  private async list<T>(method: string, key: string, signal?: AbortSignal): Promise<T[]> {
    const r = await this.page<T>(method, key, signal);
    if (r.error) throw r.error; // a whole list or none
    return r.items;
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
    this.events?.abort();
    if (this.closed) return;
    this.closed = true;
    if (this.proc) {
      try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
      const proc = this.proc;
      setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 2000).unref?.();
      proc.kill("SIGTERM");
    } else if (this.sessionId && this.t.kind === "http") {
      // legacy HTTP session: say goodbye; failures do not matter
      this.headers("", {}).then((h) => fetch((this.t as any).url, { method: "DELETE", headers: h, ...DIRECT })).catch(() => {});
    }
  }
}
