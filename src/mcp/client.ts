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
import { CHANNEL_CAP, CHANNEL_METHOD } from "./channel.ts";
import { APP_MIME, UI_EXTENSION } from "./apps.ts";
import { SKILLS_EXTENSION } from "./skills.ts";
import { vault } from "../safety/secrets.ts";
import { maskProxy } from "./env.ts";

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-11-25";
const CLIENT_INFO = { name: "keel", version: "0.1.0" };
// What Keel offers a server. Declared in initialize to a legacy server
// (2025-11-25 lifecycle, capability negotiation) and in the _meta of every
// request to a modern one (2026-07-28). Elicitation in both modes: the owner
// answers a form on a card, or is shown a page to open in their own browser
// (src/mcp/elicit.ts).
//
// Tasks: a legacy server's tool that requires a task is called as one
// (2025-11-25 basic/utilities/tasks), and a modern server is told Keel takes
// a task in place of a result (the io.modelcontextprotocol/tasks extension,
// in the per-request capabilities). Keel only sends task-augmented requests:
// it offers no `tasks` capability of its own, which is for a client that
// runs a server's requests as tasks.
//
// Roots (roots/list: the folders the client works in, as file URIs) go to a
// legacy server that is a local command only. The 2026-07-28 revision
// deprecates roots (SEP-2577: a new implementation should not adopt it, a
// folder is a tool argument or server configuration), so a modern server is
// not offered it. A server reached over HTTP is not either: a path on this
// machine is nothing it can open, and it would learn the owner's folder names.
// It says when the folders change (listChanged): see rootsChange.
// Sampling (client/sampling): a server may ask for a reply of the session's
// model; each request is put to the owner first (manager.ts sample). Neither
// tool use nor the servers' context is offered with it.
const ELICITATION = { elicitation: { form: {}, url: {} }, sampling: {} };
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
// MCP Apps (src/mcp/apps.ts): the host draws a tool's ui:// page, in both eras.
const APPS = { [UI_EXTENSION]: { mimeTypes: [APP_MIME] } };
// Skills over MCP (src/mcp/skills.ts): a modern server that declares the extension is asked for its skills.
const offered = (t: Transport, era: "modern" | "legacy"): Record<string, object> =>
  era === "modern" ? { ...ELICITATION, extensions: { [TASKS_EXTENSION]: {}, [SKILLS_EXTENSION]: {}, ...APPS } }
  : t.kind === "stdio" ? { ...ELICITATION, roots: { listChanged: true }, extensions: APPS } : { ...ELICITATION, extensions: APPS };
// How long Keel waits between two looks at a task whose server suggests no
// interval: the reference TypeScript SDK's default (shared/protocol.ts,
// `task.pollInterval ?? defaultTaskPollInterval ?? 1000`).
const TASK_POLL_MS = 1000;
// The least time between two looks at a task, whatever the server suggests or
// how often it says the task changed. The spec (2025-11-25 basic/utilities/
// tasks, and its 2026-07-28 extension) gives no floor: requestors SHOULD
// respect pollInterval and receivers SHOULD rate-limit task operations. A
// server that suggests 0, or sends status notifications without end, would
// otherwise have Keel ask hundreds of times a second; 250 ms keeps a task
// that ends at once answered within a quarter second.
export const TASK_POLL_FLOOR_MS = 250;
const TASK_DONE = new Set(["completed", "failed", "cancelled"]);

// What a server asks of the client while it works on a call, and the handler
// a call gives for it. The handler resolves to the result the method names
// (an ElicitResult) and throws an RpcError for what Keel refuses.
export type InputRequest = { method: string; params?: any };
export type InputHandler = (req: InputRequest) => Promise<unknown>;
// What a call gives so the server's own requests can reach it. `session`: the
// session the call belongs to (a request is never routed across sessions).
// `dropped`: told when a request that may have been this call's was not
// routed to any call, with the reason.
// `task`: told the id of a task the server made of the call, as soon as there is one (a call that goes on in the
// background keeps it, to look at the task again after a restart).
export type CallInput = { session: string; ask: InputHandler; dropped?: (method: string, why: string) => void; task?: (taskId: string) => void };
// A modern server answers a call with input_required and no question, to be
// called again with its state. Each such round is sent at once with no owner
// in it, so a server that never stops would spin: this many in a row end the call.
const QUIET_ROUNDS = 3;
// The most rounds one call takes, whatever its handler answers: more than the
// manager's own bounds on a call's questions allow (src/mcp/manager.ts), so
// it is met only by a server that is called again for ever.
const ROUNDS_MAX = 64;
// The most requests of its own a server makes in a minute that no call
// answers (outside any call, after its call ended, or with nothing to say
// which call it is for). A server asks for the folders once or twice; one
// that asks on and on would be answered as fast as it can ask, so its
// connection is ended.
const LOOSE_MAX = 120;

// Error codes the modern spec reserves; seeing one means the server is modern.
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);

// `outputSchema`: the JSON Schema its structured content conforms to (2025-11-25 server/tools; src/mcp/result.ts checks it).
// `execution.taskSupport`: whether the tool runs as a task (2025-11-25 server/tools and basic/utilities/tasks).
export type McpTool = { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Record<string, unknown>; execution?: { taskSupport?: unknown }; _meta?: Record<string, unknown> };
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

// `input`: the call takes the server's own requests. `hold` stops the request's timer while the owner is asked,
// and gives back what starts it again.
// `progressed`: the server reported progress on it (its progressToken is the request's id).
// The longest a tool call may run while its server keeps reporting progress,
// when its server's config names none: Claude Code's documented default for
// an MCP tool call's wall-clock limit (MCP_TOOL_TIMEOUT, 100000000 ms, about
// 28 hours; code.claude.com/docs/en/env-vars). Claude Code is taken because it
// documents the same two limits: an idle window that progress resets, and a
// wall-clock limit that progress does not extend. Codex documents one 60 s
// per-tool timeout and nothing about progress, so it gives no ceiling.
export const TOOL_CEILING_MS = 100_000_000;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; input?: CallInput; hold: () => () => void; progressed?: (progress: unknown) => void };

// Errors that carry a server's stderr already.
const told = new WeakSet<Error>();

export class McpClient {
  era: "modern" | "legacy" = "legacy";
  version = LEGACY_VERSION;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  capabilities: Record<string, any> = {};
  onListChanged?: () => void;
  // The prompt list changed (server/prompts, listChanged).
  onPrompts?: () => void;
  // A line of the server's log (server/utilities/logging: notifications/message), from a server that declared logging.
  onLog?: (params: { level?: unknown; logger?: unknown; data?: unknown }) => void;
  // The resource list changed, or (after a subscription) one resource's body did.
  onResources?: (change: { list: true } | { uri: string }) => void;
  // An event the server pushed (src/mcp/channel.ts), heard only from a server
  // that declared the channel capability, as Claude Code registers its listener.
  onChannel?: (params: unknown) => void;
  get channel() { return !!this.capabilities.experimental?.[CHANNEL_CAP]; }
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
  // `endpointWithinMs`: how long the older transport's stream is given to
  // name its address (the whole timeout unless given).
  // `outside`: answers what the server asks outside any call, from the handshake on.
  static async connect(t: Transport, timeoutMs = 30_000, era?: "modern" | "legacy", signal?: AbortSignal, endpointWithinMs?: number, outside?: InputHandler): Promise<McpClient> {
    if (signal?.aborted) throw new Error("the server was dropped before it connected");
    const c = new McpClient(t, timeoutMs);
    c.outside = outside;
    if (t.kind === "stdio") c.spawn();
    const dropped = () => c.close();
    signal?.addEventListener("abort", dropped, { once: true });
    try {
      // A server of the older transport predates the modern era: no probe.
      if (t.kind === "http" && t.sse) { await c.openEvents(endpointWithinMs); era = "legacy"; }
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
    // (A server can echo a value it was given, such as a plugin's sensitive setting: known values are hidden.)
    // (An exit fails the connect with its stderr already told: it is told once.)
    if (tail && !(err instanceof AuthRequired) && !told.has(err)) {
      err.message += `\nstderr: ${vault.redact(maskProxy(tail), null, "output")}`;
      told.add(err);
    }
    return err;
  }

  private async handshake(known?: "modern" | "legacy") {
    if (known !== "legacy") await this.probe();
    if (this.era === "modern") return;
    const r = await this.rpc("initialize", {
      protocolVersion: LEGACY_VERSION,
      capabilities: offered(this.t, "legacy"),
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

  // `origin`: the request whose response stream carried the message (HTTP).
  private dispatch(msg: any, origin?: number | string) {
    if (Array.isArray(msg)) return msg.forEach((m) => this.dispatch(m, origin));
    if (msg && typeof msg === "object" && msg.id !== undefined && msg.id !== null && !msg.method) {
      // A server that echoes the number as a string ("3" for 3) still answers that request.
      const id = this.pending.has(msg.id) ? msg.id : typeof msg.id === "string" && /^\d+$/.test(msg.id) && String(Number(msg.id)) === msg.id && this.pending.has(Number(msg.id)) ? Number(msg.id) : undefined;
      const p = id === undefined ? undefined : this.pending.get(id);
      if (!p) return;
      // A reply that is neither a result nor an error object ends the call now: it would wait out its timeout for an answer that is not coming.
      // (A null error is no error: servers that write every field send "error": null beside a result.)
      const bad = msg.result === undefined && msg.error == null ? "it has neither a result nor an error"
        : msg.error != null && (typeof msg.error !== "object" || Array.isArray(msg.error)) ? "its error is not an object" : "";
      if (bad) {
        let said = ""; try { said = JSON.stringify(msg) ?? ""; } catch {}
        p.reject(new Error(`the server sent a malformed reply (${bad}): ${said.slice(0, 200)}${said.length > 200 ? "..." : ""}`));
        this.pending.delete(id!);
        return;
      }
      this.pending.delete(id!);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message ?? "error", msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    // The server asks whether the client is there (2025-11-25 Ping: an empty result, promptly).
    if (msg.method === "ping" && msg.id !== undefined) return this.answer({ jsonrpc: "2.0", id: msg.id, result: {} }, "ping");
    if (msg.method && msg.id !== undefined) return void this.serverRequest(msg, origin);
    if (msg.method === "notifications/tools/list_changed") this.onListChanged?.();
    else if (msg.method === "notifications/prompts/list_changed") this.onPrompts?.();
    else if (msg.method === "notifications/message" && this.capabilities.logging && msg.params && typeof msg.params === "object") this.onLog?.(msg.params);
    else if (msg.method === "notifications/resources/list_changed") this.onResources?.({ list: true });
    else if (msg.method === "notifications/resources/updated" && typeof msg.params?.uri === "string") this.onResources?.({ uri: msg.params.uri });
    else if (msg.method === CHANNEL_METHOD && this.channel) this.onChannel?.(msg.params);
    // Progress on a request that asked for it (basic/utilities/progress): its timeout starts again.
    else if (msg.method === "notifications/progress" && msg.params?.progressToken !== undefined) this.pending.get(msg.params.progressToken)?.progressed?.(msg.params.progress);
    // The step on a page the owner was sent to is done; an id nothing waits on is ignored, as the specification says.
    else if (msg.method === "notifications/elicitation/complete" && typeof msg.params?.elicitationId === "string") this.links.get(msg.params.elicitationId)?.ac.abort();
    // A task Keel waits on changed (2025-11-25 notifications/tasks/status; notifications/tasks of the extension): it is looked at now.
    else if ((msg.method === "notifications/tasks/status" || msg.method === "notifications/tasks") && typeof msg.params?.taskId === "string") this.tasks.get(msg.params.taskId)?.();
  }

  // The pages the owner was sent to whose completion is waited on, by elicitationId.
  // `ac` is aborted when the server says the step is done.
  private links = new Map<string, { ac: AbortController; n: number }>();
  // Waits for the server to say the step at a page is done: `signal` is
  // aborted then. One id may be watched by more than one waiter; `drop` ends this one's watch.
  watchLink(id: string): { signal: AbortSignal; drop: () => void } {
    let w = this.links.get(id);
    if (!w) this.links.set(id, (w = { ac: new AbortController(), n: 0 }));
    w.n++;
    let dropped = false;
    const entry = w;
    return { signal: w.ac.signal, drop: () => { if (dropped) return; dropped = true; if (--entry.n === 0 && this.links.get(id) === entry) this.links.delete(id); } };
  }
  // The tasks Keel waits on: what wakes the wait for each.
  private tasks = new Map<string, () => void>();

  // A legacy server's own request (2025-11-25: elicitation/create is sent
  // while the server works on a client request; roots/list at any time). It
  // goes to the call it belongs to. Over HTTP that is the call whose response
  // stream carried it. Over stdio (and on the stream a server opens for
  // itself) nothing names the call, and Keel does not guess:
  // - one call in flight: it gets the request, however often the server asks;
  // - a question with more than one call in flight, also of one session
  //   (the call that started first is not the one that asks first): no call
  //   gets it. It is answered as if the owner made no choice, and each of
  //   those calls is told, so its result says why;
  // - a request for the folders with calls of one session in flight: that
  //   session's folders, which are the same for each of its calls; with more
  //   than one session it is refused, and each call is told;
  // - no call in flight: `outside`. There is no card to ask on and no
  //   session's folder then.
  outside?: InputHandler;
  private async serverRequest(msg: any, origin?: number | string) {
    let asker: Pending | undefined;
    const reply = (body: object) => this.answer({ jsonrpc: "2.0", id: msg.id, ...body }, String(msg.method), asker?.input);
    const refuse = (code: number, message: string) => reply({ error: { code, message } });
    const method = String(msg.method);
    // (The extensions a client declares are no methods a server may ask of it.)
    const head = method.split("/")[0]!;
    if (head === "extensions" || !Object.hasOwn(offered(this.t, this.era), head)) return refuse(-32601, `keel does not support ${method}`);
    this.asks = true;
    if (origin !== undefined) asker = this.pending.get(origin)?.input ? this.pending.get(origin) : undefined;
    else {
      const calls = [...this.pending.values()].filter((p) => p.input); // oldest first
      const sessions = new Set(calls.map((p) => p.input!.session));
      const question = method === "elicitation/create" || method === "sampling/createMessage";
      if (sessions.size > 1 || (question && calls.length > 1)) {
        const why = sessions.size > 1
          ? `calls of ${sessions.size} sessions were in flight on this server, and nothing names the call such a request belongs to`
          : `${calls.length} calls were in flight on this server, and nothing names the call a question belongs to`;
        for (const p of calls) p.input!.dropped?.(method, why);
        if (this.looseOver()) return;
        return method === "elicitation/create" ? reply({ result: { action: "cancel" } }) : refuse(question ? -1 : -32603, `not answered: ${why}`);
      }
      asker = calls[0];
    }
    const handler = asker?.input?.ask ?? this.outside;
    if (!asker?.input && this.looseOver()) return;
    if (!handler) return refuse(-32603, "nothing here answers this");
    // The owner's time is not the server's: the call's timer waits with it.
    const resume = asker?.hold();
    const roots = method === "roots/list";
    if (roots) this.rootsAsking++;
    try {
      const result = await handler({ method, params: msg.params });
      if (roots) this.rootsTold = JSON.stringify(result);
      reply({ result });
    } catch (e) {
      refuse(e instanceof RpcError ? e.code : -32603, (e as Error).message);
    } finally {
      resume?.();
      // A call that came while the answer was made is for its own folders: the server is told after the answer.
      if (roots && --this.rootsAsking === 0 && this.rootsWanted) {
        const w = this.rootsWanted;
        this.rootsWanted = undefined;
        this.rootsChange(w.roots, w.session);
      }
    }
  }

  // The folders this server was last told (roots/list), or that it was told
  // had changed: undefined while it never asked.
  private rootsTold?: string;
  // Answers to roots/list being made, and the folders a call came for meanwhile.
  private rootsAsking = 0;
  private rootsWanted?: { roots: unknown; session: string };
  // The folders a call is about to be made for. When they are not what the
  // server was last told, it is told they changed
  // (notifications/roots/list_changed), and a server that keeps them asks
  // again: while the call is in flight, so it is answered with that call's
  // session's folders. A server that never asked is not told, and neither is
  // one with calls of another session in flight: its request could not be
  // answered (serverRequest), so the next call tells it. One that is being
  // answered is told after the answer, if it still differs. Says whether it was told.
  rootsChange(roots: unknown, session: string): boolean {
    if (this.rootsAsking) { this.rootsWanted = { roots, session }; return false; }
    const now = JSON.stringify(roots);
    if (this.closed || this.rootsTold === undefined || this.rootsTold === now || !Object.hasOwn(offered(this.t, this.era), "roots")) return false;
    if ([...this.pending.values()].some((p) => p.input && p.input.session !== session)) return false;
    this.rootsTold = now;
    this.notify("notifications/roots/list_changed").catch(() => {});
    return true;
  }

  // Counts a request no call answers; past the bound the connection is ended and its owner told why.
  private loose = { since: 0, n: 0 };
  private looseOver(): boolean {
    const now = Date.now();
    if (now - this.loose.since > 60_000) this.loose = { since: now, n: 0 };
    if (++this.loose.n <= LOOSE_MAX) return false;
    this.drop(`the server made more than ${LOOSE_MAX} requests of its own in a minute that no call was waiting for`);
    return true;
  }

  // Ends the connection from this side, and tells its owner why.
  drop(why: string) {
    if (this.closed) return;
    this.closedWhy = why;
    this.close();
    this.closeHook?.(why);
  }
  // Whether the server ever made a request of its own on this connection (the calls of one connection then take turns by
  // session when sessions share it: src/mcp/links.ts).
  private asks = false;
  get hasAsked() { return this.asks; }
  // Set by a shared connection's view: a call's place among the sessions' calls on it.
  declare gate?: (session: string, signal: AbortSignal) => Promise<() => void>;
  // Whether a request of the server's own comes with nothing that names the
  // call it is for (stdio, and the older transport's one stream): a question
  // of a call that is over would then go to the next call.
  get unnamedRequests() { return this.t.kind === "stdio" || !!this.t.sse; }

  private write(msg: unknown) {
    if (this.t.kind === "stdio") {
      const sink = this.proc?.stdin as import("bun").FileSink | undefined;
      sink?.write(JSON.stringify(msg) + "\n");
      sink?.flush();
    } else {
      this.post(msg).catch(() => {});
    }
  }

  // Keel's answer to a request of the server's own (a ping, a question, the
  // folders). Over HTTP the server takes it with 202 or 204 and nothing else
  // (2025-11-25 transports: a posted response is accepted with 202 and no
  // body). Whatever else it sends back is no message: the server numbers its
  // requests apart from Keel's, so a body with an id could be taken as the
  // answer to Keel's own request of that number. Any other status is the
  // server's failure, said to its owner and to the call the request was for.
  onAnswerRefused?: (r: { method: string; why: string; session?: string }) => void;
  private answer(msg: { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: unknown }, method: string, call?: CallInput) {
    if (this.t.kind === "stdio") return this.write(msg);
    this.post(msg).catch((e) => {
      if (this.closed) return;
      const why = (e as Error).message;
      call?.dropped?.(method, `the server did not take Keel's answer (${why})`);
      try { this.onAnswerRefused?.({ method, why, ...(call ? { session: call.session } : {}) }); } catch {}
    });
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
  private async openEvents(within = this.timeoutMs) {
    const t = this.t as Extract<Transport, { kind: "http" }>;
    const ac = new AbortController();
    this.events = ac;
    const headers: Record<string, string> = { accept: "text/event-stream", ...t.headers };
    const tok = await t.token?.();
    if (tok) headers.authorization = `Bearer ${tok}`;
    const timer = setTimeout(() => ac.abort(), within);
    let res: Response;
    try {
      res = await fetch(t.url, { headers, signal: ac.signal, timeout: false, ...DIRECT } as RequestInit);
    } catch (e) {
      clearTimeout(timer);
      throw ac.signal.aborted ? new Error(`the event stream did not open within ${Math.round(within / 1000)}s`) : e;
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
      refused(new Error(why === "the connection is closed" && !this.endpoint && !this.closed ? `the event stream named no address for messages within ${Math.round(within / 1000)}s` : why));
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
      ...(method ? { "mcp-method": method } : {}), // a response Keel posts names none
      ...t.headers,
    };
    // (A task's requests name the task: the extension's Streamable HTTP binding.)
    const task = method === "tasks/get" || method === "tasks/update" || method === "tasks/cancel";
    const name = task ? params?.taskId : params?.name ?? params?.uri;
    if (typeof name === "string" && (task || method === "tools/call" || method === "resources/read" || method === "prompts/get")) {
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
    // An answer Keel posted: nothing in the reply is read (see answer). The
    // older transport takes a POST with any 2xx, its messages come on its stream.
    if (msg.id !== undefined && msg.method === undefined) {
      void res.body?.cancel().catch(() => {});
      if (t.sse && res.ok) return;
      throw new Error(`HTTP ${res.status} to a posted answer, where 202 or 204 is the acknowledgement`);
    }
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
    if (ctype.includes("text/event-stream")) return this.readSse(res, undefined, msg.id);
    const text = await res.text();
    if (text.trim()) this.dispatch(JSON.parse(text), msg.id);
  }

  private async readSse(res: Response, st?: SseState, origin?: number | string) {
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
      try { this.dispatch(msg, origin); } catch {} // as before: a message that cannot be handled does not end the stream
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
    if (!c.tools?.listChanged && !c.prompts?.listChanged && !c.resources?.listChanged && !c.resources?.subscribe && !c.logging) return;
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
      "io.modelcontextprotocol/clientCapabilities": offered(this.t, "modern"),
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    };
  }

  // `progress`: the request asks the server for progress (its id as the
  // progressToken), and a report whose progress grew starts its timeout
  // again: the timeout is the time a server goes without moving on.
  // `ceilingMs` bounds the request whatever it reports (lifecycle: Timeouts
  // lets progress reset the clock, and a client should always enforce a
  // maximum); the owner's stop ends it at any time.
  async rpc(method: string, params: any = {}, opt: { signal?: AbortSignal; timeoutMs?: number; timeoutText?: string; modern?: boolean; authorize?: () => string | undefined; input?: CallInput; progress?: () => void; ceilingMs?: number; ceilingText?: string } = {}): Promise<any> {
    const deny = opt.authorize?.();
    if (deny) throw new McpAuthorizationError(deny);
    if (this.closed) throw new Error("the connection is closed");
    if (opt.signal?.aborted) throw new Error("cancelled");
    const id = this.nextId++;
    const asked = opt.progress ? { ...params, _meta: { ...params._meta, progressToken: id } } : params;
    const p = opt.modern || this.era === "modern" ? { ...asked, _meta: { ...asked._meta, ...this.meta() } } : asked;
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
      // The owner's time is not the server's: the timer stops while the owner
      // is asked and goes on with what was left, so a server that keeps
      // asking still has one timeout for its call, not a new one a question.
      // `spent`: the server's time so far (the owner's is not counted), against the ceiling.
      let left = timeoutMs, since = 0, spent = 0;
      const ceiling = opt.ceilingMs ?? Infinity;
      const arm = () => {
        since = Date.now();
        const capped = ceiling - spent < left;
        timer = setTimeout(() => giveUp(capped ? (opt.ceilingText ?? `${method} ran past its longest time, ${Math.round(ceiling / 1000)}s, while it reported progress`) : (opt.timeoutText ?? `${method} timed out after ${Math.round(timeoutMs / 1000)}s`), "timed out"), Math.max(0, Math.min(left, ceiling - spent)));
      };
      let held = 0;
      const hold = () => {
        if (held++ === 0) { clearTimeout(timer); left = Math.max(0, left - (Date.now() - since)); spent += Date.now() - since; }
        return () => { if (--held === 0 && this.pending.has(id)) arm(); };
      };
      // (While the owner is asked the clock is held; a report then changes nothing.)
      // Only progress that grew counts (the spec: progress increases with each notification); a repeat moves nothing.
      let last = -Infinity;
      const progressed = opt.progress ? (p: unknown) => {
        if (held || !this.pending.has(id) || typeof p !== "number" || !(p > last)) return;
        last = p;
        clearTimeout(timer); spent += Date.now() - since; left = timeoutMs; arm(); opt.progress!();
      } : undefined;
      this.pending.set(id, { resolve: done(resolve), reject: fail, input: opt.input, hold, progressed });
      arm();
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
  // The skills extension as the server declared it (only a modern server does, and it must serve resources too):
  // skills/list and skills/get are sent only once this is seen (ext-skills, Capability Negotiation).
  get skills(): { directoryRead: boolean } | undefined {
    const x = this.era === "modern" && this.capabilities.resources ? this.capabilities.extensions?.[SKILLS_EXTENSION] : undefined;
    return x && typeof x === "object" ? { directoryRead: (x as any).directoryRead === true } : undefined;
  }
  listSkills(signal?: AbortSignal) { return this.list<unknown>("skills/list", "skills", signal); }
  async getSkill(uri: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.rpc("skills/get", { uri }, { signal }))?.skill;
  }
  // Suggestions for an argument of a prompt or a resource template (server/utilities/completion).
  complete(ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string }, argument: { name: string; value: string }, context?: Record<string, string>, signal?: AbortSignal) {
    return this.rpc("completion/complete", { ref, argument, ...(context && Object.keys(context).length ? { context: { arguments: context } } : {}) }, { signal });
  }
  readResource(uri: string, signal?: AbortSignal) { return this.rounds("resources/read", { uri }, { signal }); }
  getPrompt(name: string, args: Record<string, string> = {}, signal?: AbortSignal) { return this.rounds("prompts/get", { name, arguments: args }, { signal }); }
  // `ceilingMs`: the call's longest time however it reports progress (TOOL_CEILING_MS by default).
  // `taskSupport`: the tool's `execution.taskSupport` as it was listed.
  callTool(name: string, args: unknown, signal?: AbortSignal, timeoutMs?: number, meta?: Record<string, unknown>, authorize?: () => string | undefined, input?: CallInput, ceilingMs = TOOL_CEILING_MS, taskSupport?: unknown): Promise<McpCallResult> {
    // 2025-11-25 tasks, Tool-Level Negotiation: a tool that requires a task is
    // called as one on a server that takes task-augmented calls. One that
    // only allows it is called plainly: Keel waits for the result either way,
    // and a plain call takes one request where a task takes three or more.
    // The server picks the task's lifetime (no `ttl`).
    const asTask = this.era === "legacy" && taskSupport === "required" && !!this.capabilities.tasks?.requests?.tools?.call;
    return this.rounds("tools/call", { name, arguments: args ?? {}, ...(asTask ? { task: {} } : {}), ...(meta ? { _meta: meta } : {}) }, { signal, timeoutMs, authorize, input, progress: () => {}, ceilingMs }, asTask);
  }

  // A modern server asks for input by answering the request with
  // input_required: its questions in `inputRequests`, its own state in
  // `requestState`. The client gathers the answers and sends the request
  // again, as a new one, with `inputResponses` and the state exactly as it
  // came (2026-07-28 basic/patterns/mrtr). A legacy server sends its
  // questions as requests of its own while the call is open (serverRequest).
  // `asTask`: the request asked a legacy server for a task (callTool).
  private async rounds(method: string, params: Record<string, unknown>, opt: NonNullable<Parameters<McpClient["rpc"]>[2]>, asTask = false): Promise<any> {
    let next = params;
    // One timeout for the whole call, however many rounds it takes: the time
    // the server works counts, the time the owner takes to answer does not.
    const whole = opt.timeoutMs ?? this.timeoutMs;
    let left = whole;
    let ceiling = opt.ceilingMs;
    for (let quiet = 0, round = 1; ; round++) {
      if (left <= 0) throw new Error(`${method} timed out after ${Math.round(whole / 1000)}s, before round ${round} of the call`);
      if (round > ROUNDS_MAX) throw new Error(`the server asked to be called again ${ROUNDS_MAX} times in one call`);
      let began = Date.now();
      const start = began;
      // (A later round has only what is left of the call's time: its timeout is said as the call's.)
      // A progress report gives the call its whole time again, from the report on, up to its ceiling.
      const progress = opt.progress && (() => { began = Date.now(); left = whole; opt.progress!(); });
      const r = await this.rpc(method, next, { ...opt, progress, timeoutMs: left, ...(ceiling !== undefined ? { ceilingMs: ceiling, ceilingText: `${method} ran past its longest time, ${Math.round(opt.ceilingMs! / 1000)}s, while it reported progress` } : {}), ...(round > 1 ? { timeoutText: `${method} timed out after ${Math.round(whole / 1000)}s, in round ${round} of the call` } : {}) });
      left -= Date.now() - began;
      if (ceiling !== undefined) ceiling -= Date.now() - start;
      // A task in place of the result: a modern server's CreateTaskResult is
      // the task itself, a legacy one's holds it under `task`.
      if (r?.resultType === "task") return this.awaitTask(r, method, opt, ceiling);
      if (asTask && r?.task && typeof r.task === "object" && r.content === undefined) return this.awaitTask(r.task, method, opt, ceiling);
      if (r?.resultType !== "input_required") return r;
      const asked = Object.entries((r.inputRequests ?? {}) as Record<string, InputRequest>);
      if (!asked.length && ++quiet > QUIET_ROUNDS) throw new Error("the server kept asking to be called again without asking for anything");
      if (asked.length) quiet = 0;
      if (asked.length && !opt.input) throw new Error(`the server asked for input (${asked.map(([, q]) => q?.method).join(", ")}), which only a tool call can gather`);
      const inputResponses: Record<string, unknown> = {};
      for (const [key, q] of asked) inputResponses[key] = await opt.input!.ask({ method: String(q?.method), params: q?.params });
      next = { ...params, ...(asked.length ? { inputResponses } : {}), ...(r.requestState !== undefined ? { requestState: r.requestState } : {}) };
    }
  }

  // A task the server runs for a request, followed to its result (2025-11-25
  // basic/utilities/tasks; the io.modelcontextprotocol/tasks extension for a
  // modern server). Keel looks at it with tasks/get at the interval the
  // server suggests (pollInterval, or the extension's pollIntervalMs), and
  // at once when the server says it changed. Each request has the call's
  // timeout; the whole wait has the call's ceiling, as a call that reports
  // progress does, and ends at the owner's stop. A task Keel stops waiting
  // on before it ended is cancelled (tasks/cancel), as far as the server
  // takes that. Two looks are TASK_POLL_FLOOR_MS apart at least. A task that
  // keeps working is waited on up to the call's ceiling: the server's
  // tool_max_secs, else TOOL_CEILING_MS (its config says so).
  // Input the task needs: a legacy server sends its questions on the
  // tasks/result request, which Keel opens when the task asks for input
  // and which answers when the task ends (as the reference SDK does). A
  // modern one lists them in the task (`inputRequests`), and the answers go
  // back with tasks/update, each request once.
  private async awaitTask(seed: any, method: string, opt: NonNullable<Parameters<McpClient["rpc"]>[2]>, ceilingMs?: number): Promise<any> {
    const id = seed?.taskId;
    if (typeof id !== "string" || !id) throw new Error(`${method}: the server answered with a task that has no id`);
    const modern = this.era === "modern";
    const start = Date.now();
    const ceiling = ceilingMs ?? opt.ceilingMs ?? Infinity;
    const each = { signal: opt.signal, timeoutMs: opt.timeoutMs, authorize: opt.authorize };
    try { opt.input?.task?.(id); } catch { /* the call's note of its task is not the task */ }
    let wake = () => {};
    this.tasks.set(id, () => wake());
    const answered = new Set<string>();
    let t = seed, ended = false;
    let looked = Date.now();
    try {
      for (;;) {
        if (TASK_DONE.has(t?.status)) break;
        const left = ceiling - (Date.now() - start);
        if (left <= 0) throw new Error(`${method} ran past its longest time, ${Math.round(ceiling / 1000)}s, as a task its server worked on (the server's tool_max_secs sets it)`);
        if (t?.status === "input_required" && !modern) {
          const r = await this.rpc("tasks/result", { taskId: id }, { ...each, input: opt.input, ceilingMs: left });
          ended = true;
          return r;
        }
        if (t?.status === "input_required") {
          const asked = Object.entries((t.inputRequests ?? {}) as Record<string, InputRequest>).filter(([k]) => !answered.has(k));
          if (asked.length && !opt.input) throw new Error(`the task asked for input (${asked.map(([, q]) => q?.method).join(", ")}), which only a tool call can gather`);
          if (asked.length) {
            const inputResponses: Record<string, unknown> = {};
            for (const [k, q] of asked) { inputResponses[k] = await opt.input!.ask({ method: String(q?.method), params: q?.params }); answered.add(k); }
            await this.rpc("tasks/update", { taskId: id, inputResponses }, each);
          }
        }
        const every = Number(t?.pollInterval ?? t?.pollIntervalMs);
        const wait = Math.max(TASK_POLL_FLOOR_MS, Number.isFinite(every) && every >= 0 ? every : TASK_POLL_MS);
        await new Promise<void>((res) => {
          let timer: ReturnType<typeof setTimeout>;
          const end = () => { clearTimeout(timer); opt.signal?.removeEventListener("abort", end); res(); };
          const at = (ms: number) => { clearTimeout(timer); timer = setTimeout(end, Math.max(0, Math.min(ms, left, 2 ** 31 - 1))); };
          at(wait - (Date.now() - looked));
          // A status notification looks at once, but never sooner than the floor after the last look.
          wake = () => at(TASK_POLL_FLOOR_MS - (Date.now() - looked));
          opt.signal?.addEventListener("abort", end, { once: true });
        });
        wake = () => {};
        if (opt.signal?.aborted) throw new Error("cancelled");
        looked = Date.now();
        t = await this.rpc("tasks/get", { taskId: id }, each);
      }
      ended = true;
      if (!modern) return await this.rpc("tasks/result", { taskId: id }, each);
      if (t.status === "completed") return t.result;
      if (t.status === "failed") throw new RpcError(typeof t.error?.code === "number" ? t.error.code : -32603, String(t.error?.message ?? t.statusMessage ?? "the task failed"), t.error?.data);
      throw new Error(`the server cancelled the task${t.statusMessage ? `: ${String(t.statusMessage)}` : ""}`);
    } catch (e) {
      // (A legacy server takes tasks/cancel only when it says so.)
      if (!ended && !this.closed && (modern || this.capabilities.tasks?.cancel)) this.rpc("tasks/cancel", { taskId: id }).catch(() => {});
      throw e;
    } finally {
      this.tasks.delete(id);
    }
  }

  // A task this server made of an earlier call (its id was kept), looked at again until it ends and answered with the
  // call's result, as the call that made it would have been. The server says what became of a task it no longer knows.
  // `input`: what answers the task's questions (a call that went on in the background has none: it asks for input,
  // and the call fails saying so).
  resumeTask(taskId: string, o: { signal?: AbortSignal; timeoutMs?: number; ceilingMs?: number; input?: CallInput } = {}): Promise<any> {
    return this.awaitTask({ taskId, status: "working" }, "tools/call", { signal: o.signal, timeoutMs: o.timeoutMs, input: o.input, ceilingMs: o.ceilingMs }, o.ceilingMs);
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
