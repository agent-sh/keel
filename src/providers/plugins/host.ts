// Provider plugin host, protocol v1 (keel docs/PROVIDER_PLUGINS.md): one
// persistent JSON-RPC process per plugin, newline-delimited on stdio. keel-bun
// builds the native body and parses the stream with its own wire codecs; the
// plugin holds the credentials and sends the HTTP request.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { classify, ProviderError, scrub, streamIdleMs } from "../http.ts";
import { JsonArrayDecoder, SseDecoder, type SseEvent } from "../sse.ts";
import type { PluginEntry } from "./config.ts";

export type PluginProviderDecl = {
  id: string;
  label: string;
  wire: string;
  stream_format?: "sse" | "json_array";
  request_envelope?: { kind: string; field: string };
  response_envelope?: { kind: string; field: string };
  system_prefix?: string;
  response_headers?: string[];
  unusable?: string; // why keel-bun cannot use this declaration
};

export type PluginModel = {
  id: string;
  label?: string;
  family?: string;
  context_window?: number;
  max_output?: number;
  capabilities?: { tools?: boolean; images?: boolean; reasoning?: { kind: string; levels?: string[]; default?: string } };
  billing?: { kind: string; plan?: string; currency?: string; input_per_mtok?: number; output_per_mtok?: number; cache_read_per_mtok?: number; cache_write_per_mtok?: number; estimated?: boolean };
};

export type ProviderState = { state: string; account?: string; detail?: string; sign_in?: { command: string; note?: string }; reset_at_ms?: number; usage_windows?: { id?: string; label?: string; used_percent?: number; resets_at_ms?: number }[] };

export type PluginState = "starting" | "ready" | "restarting" | "not_responding" | "stopped";

const WIRES = new Set(["anthropic_messages", "gemini_generate_content", "openai_responses", "chat_completions"]);
const CRED_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-goog-api-key)$|-(key|token|secret|credential|credentials|auth|authorization)$/;
const PASS_ENV = /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TMPDIR|TZ|DBUS_SESSION_BUS_ADDRESS|SSL_CERT_FILE|SSL_CERT_DIR|(HTTP|HTTPS|NO|ALL)_PROXY|(http|https|no|all)_proxy|LC_.*|XDG_.*)$/;
const ACK_MS = 20_000;
const IDLE_MS = streamIdleMs();

// An async queue of a request's events.
class Channel<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private failWith: Error | null = null;
  private closed = false;
  private onFail: ((e: Error) => void) | null = null;
  push(x: T) {
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: x, done: false }); } else this.items.push(x);
  }
  close() { this.closed = true; if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: undefined as any, done: true }); } }
  fail(e: Error) { this.failWith = e; if (this.onFail) { const f = this.onFail; this.onFail = null; this.waiting = null; f(e); } }
  async next(timeoutMs: number): Promise<IteratorResult<T>> {
    if (this.items.length) return { value: this.items.shift()!, done: false };
    if (this.failWith) throw this.failWith;
    if (this.closed) return { value: undefined as any, done: true };
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiting = null; this.onFail = null; rej(new ProviderError("network", "the plugin stalled: no data within the idle timeout")); }, timeoutMs);
      this.waiting = (r) => { clearTimeout(t); this.onFail = null; res(r); };
      this.onFail = (e) => { clearTimeout(t); rej(e); };
    });
  }
}

type Msg = { kind: "head"; status: number; headers: Record<string, string> } | { kind: "chunk"; data: Uint8Array } | { kind: "end" };

export class PluginProcess {
  state: PluginState = "stopped";
  reason?: string;
  name?: string;
  version?: string;
  protocol?: number;
  caps: { cancel?: boolean; max_concurrent?: number; models_changed?: boolean; status?: boolean; ping?: boolean } = {};
  providers: PluginProviderDecl[] = [];
  models = new Map<string, { at: number; models: PluginModel[]; problem?: string }>();
  status = new Map<string, ProviderState>();
  statusAt = 0;
  violations = { count: 0, last: "" };
  stderrTail = "";
  restartAt = 0;
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private nextId = 1;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; t: Timer }>();
  private requests = new Map<string, Channel<Msg>>();
  private heard = 0;
  private delay = 1000;
  private readyAt = 0;
  private stopping = false;
  private restartTimer: Timer | null = null;
  private ready: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private queue: (() => void)[] = [];
  private listingQueued: Promise<void> | null = null;
  onChange?: () => void;

  constructor(public entry: PluginEntry, private stateDir: string, private keelVersion: string, private capture: (e: unknown, ctx?: unknown) => void) {}

  get pid() { return this.proc?.pid; }
  get limit() {
    const a = this.caps.max_concurrent || 0, b = this.entry.max_concurrent || 0;
    return a && b ? Math.min(a, b) : a || b || Infinity;
  }

  start() {
    if (!this.entry.enabled) { this.state = "stopped"; this.reason = "enabled = false"; return; }
    if (this.entry.problem) { this.state = "stopped"; this.reason = this.entry.problem; return; }
    this.stopping = false;
    this.state = "starting";
    this.reason = undefined;
    this.ready = this.boot().catch((e) => {
      this.capture(e, { plugin: this.entry.id, at: "start" });
      if (this.state !== "stopped") this.crashed(`start failed: ${(e as Error).message}`);
    });
  }

  // Resolves once the start (initialize, models/list, status) finished either way.
  whenSettled() { return this.ready; }

  private async boot() {
    const dataDir = join(this.stateDir, "plugins", this.entry.id);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const env: Record<string, string> = { KEEL_PROVIDER_PLUGIN: "1" };
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && PASS_ENV.test(k)) env[k] = v;
    for (const k of this.entry.env) if (!k.startsWith("KEEL_") && process.env[k] !== undefined) env[k] = process.env[k]!;
    this.proc = Bun.spawn([this.entry.command, ...this.entry.args], { cwd: dataDir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const proc = this.proc;
    this.readStdout(proc);
    this.readStderr(proc);
    proc.exited.then((code) => { if (this.proc === proc && !this.stopping) this.crashed(`exited with status ${code}`); });

    const init = await this.call("initialize", {
      protocol_versions: [1],
      plugin_id: this.entry.id,
      keel_version: this.keelVersion,
      data_dir: dataDir,
      settings: this.entry.settings ?? {},
      provider_settings: Object.fromEntries(Object.entries(this.entry.providers).map(([k, v]) => [k, v.settings ?? {}])),
      capabilities: { system_prefix: true },
    }, ACK_MS).catch((e: any) => {
      if (e.code === -32000 || e.code === -32003) { this.stop(`the plugin refused this host: ${e.message}`); }
      throw e;
    });
    if (init.protocol_version !== 1) return this.stop(`protocol version ${init.protocol_version} is not offered (keel-bun speaks 1)`);
    if (init.plugin?.id !== this.entry.id) return this.stop(`the command runs plugin \`${init.plugin?.id}\`, not \`${this.entry.id}\``);
    this.name = init.plugin?.name;
    this.version = init.plugin?.version;
    this.protocol = 1;
    this.caps = init.capabilities ?? {};
    const seen = new Set<string>();
    this.providers = (init.providers ?? []).map((p: PluginProviderDecl) => {
      let unusable: string | undefined;
      if (!WIRES.has(p.wire)) unusable = `needs a newer Keel: wire \`${p.wire}\``;
      else if (p.stream_format && p.stream_format !== "sse" && !(p.stream_format === "json_array" && p.wire === "gemini_generate_content")) unusable = `stream format \`${p.stream_format}\` on wire \`${p.wire}\``;
      else if ((p.request_envelope || p.response_envelope) && p.wire !== "gemini_generate_content") unusable = "an envelope outside the Gemini wire";
      else if ([p.request_envelope, p.response_envelope].some((e) => e && e.kind !== "json_field")) unusable = "needs a newer Keel: envelope kind";
      else if (seen.has(p.id)) unusable = "a repeated provider id";
      seen.add(p.id);
      const label = this.entry.providers[p.id]?.label ?? p.label;
      return { ...p, label, unusable };
    });
    if (!this.providers.some((p) => !p.unusable)) return this.stop("no provider declaration keel-bun can use");
    await this.listModels();
    await this.readStatus();
    this.state = "ready";
    this.readyAt = Date.now();
    this.onChange?.();
  }

  async listModels() {
    try {
      const r = await this.call("models/list", {}, IDLE_MS);
      const at = Date.now();
      for (const g of r.providers ?? []) this.models.set(g.provider, { at, models: g.models ?? [], problem: g.problem });
    } catch (e) {
      for (const p of this.providers) {
        const prev = this.models.get(p.id);
        this.models.set(p.id, { at: prev?.at ?? 0, models: prev?.models ?? [], problem: `listing failed: ${(e as Error).message}` });
      }
    }
  }

  async readStatus() {
    if (!this.caps.status) return;
    this.statusAt = Date.now();
    try {
      const r = await this.call("status", {}, IDLE_MS);
      for (const s of r.providers ?? []) this.status.set(s.provider, { ...s, detail: s.detail && scrub(String(s.detail)).slice(0, 400) });
    } catch (e) {
      for (const p of this.providers) this.status.set(p.id, { state: "error", detail: `status failed: ${(e as Error).message}` });
    }
  }

  // Asked when the providers are read: a status older than a minute, a ping
  // after a minute of silence.
  async freshen() {
    if (this.state !== "ready") return;
    if (this.caps.status && Date.now() - this.statusAt > 60_000) await this.readStatus();
    else if (this.caps.ping && Date.now() - this.heard > 60_000) {
      await this.call("ping", {}, ACK_MS).catch(() => this.hung());
    }
  }

  providerAvailable(pid: string): boolean {
    if (this.state !== "ready") return false;
    if (this.entry.providers[pid]?.enabled === false) return false;
    if (!this.caps.status) return (this.models.get(pid)?.models.length ?? 0) > 0;
    const s = this.status.get(pid)?.state;
    return s === "ready" || s === "limited";
  }

  // ---- JSON-RPC ----

  private write(msg: object) {
    if (!this.proc) throw new ProviderError("network", `plugin ${this.entry.id} is not running`);
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    this.proc.stdin.flush();
  }

  call(method: string, params: object, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new ProviderError("network", `plugin ${this.entry.id}: no answer to ${method} within ${timeoutMs / 1000} s`));
        if (method === "ping" || method === "initialize" || method === "request/start") this.hung();
      }, timeoutMs);
      this.pending.set(id, { res, rej, t });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(t); this.pending.delete(id); rej(e as Error); }
    });
  }

  private notify(method: string, params: object) {
    try { this.write({ method, params }); } catch {}
  }

  private violation(what: string, fatal = false) {
    this.violations.count++;
    this.violations.last = what.slice(0, 300);
    if (fatal) this.crashed(`protocol violation: ${what}`);
  }

  private async readStdout(proc: Subprocess<"pipe", "pipe", "pipe">) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line) this.onLine(line);
        }
        if (buf.length > 32 * 1024 * 1024) return this.violation("a line over 32 MiB", true);
      }
    } catch {}
    if (this.proc === proc && !this.stopping) this.crashed("its output ended");
  }

  private async readStderr(proc: Subprocess<"pipe", "pipe", "pipe">) {
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stderr) this.stderrTail = scrub((this.stderrTail + dec.decode(chunk, { stream: true })).slice(-4096));
    } catch {}
  }

  private onLine(line: string) {
    this.heard = Date.now();
    let m: any;
    try { m = JSON.parse(line); } catch { return this.violation("a stdout line that is not JSON", true); }
    if (!m || typeof m !== "object" || Array.isArray(m)) return this.violation("a stdout line that is not a JSON object", true);
    if ("id" in m && m.id !== null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return this.violation(`an answer to id ${m.id}, which was never sent or already answered`, true);
      this.pending.delete(m.id);
      clearTimeout(p.t);
      if (m.error) p.rej(Object.assign(new ProviderError("server", `plugin ${this.entry.id}: ${scrub(String(m.error.message)).slice(0, 400)}`), { code: m.error.code }));
      else p.res(m.result ?? {});
      return;
    }
    if (m.id !== undefined && m.method) {
      // v1 plugins send no requests.
      return this.write({ id: m.id, error: { code: -32601, message: "keel-bun takes no requests from a plugin" } });
    }
    const params = m.params ?? {};
    switch (m.method) {
      case "response/head":
      case "response/chunk":
      case "response/end":
      case "response/error": {
        const ch = this.requests.get(params.request_id);
        if (!ch) return; // cancelled or unknown: dropped
        if (m.method === "response/head") {
          if (!(params.status >= 200 && params.status <= 599)) { this.violation("a head status outside 200..599"); return ch.fail(new ProviderError("server", "the plugin sent a bad head")); }
          const headers: Record<string, string> = {};
          const wanted = this.providers.flatMap((p) => p.response_headers ?? []);
          for (const [k, v] of Object.entries<string>(params.headers ?? {})) {
            const name = k.toLowerCase();
            if (CRED_HEADER.test(name)) { this.violation(`a credential header \`${name}\` in a head`); continue; }
            if (wanted.some((w) => (w.endsWith("*") ? name.startsWith(w.slice(0, -1)) : w === name))) headers[name] = String(v);
          }
          ch.push({ kind: "head", status: params.status, headers });
        } else if (m.method === "response/chunk") {
          let data: Uint8Array;
          try { data = Buffer.from(String(params.data ?? ""), "base64"); } catch { this.violation("chunk data that is not base64"); return ch.fail(new ProviderError("server", "bad chunk")); }
          ch.push({ kind: "chunk", data });
        } else if (m.method === "response/end") {
          ch.push({ kind: "end" });
          ch.close();
        } else {
          ch.fail(pluginError(params));
        }
        return;
      }
      case "models/changed":
        this.relist();
        return;
      case "status/changed":
        void this.readStatus().then(() => this.onChange?.());
        return;
    }
  }

  // Coalesced: one listing at a time, one more for what arrived meanwhile.
  private relist() {
    if (this.listingQueued) return;
    this.listingQueued = (async () => {
      await Bun.sleep(1000);
      this.listingQueued = null;
      await this.listModels();
      this.onChange?.();
    })();
  }

  // ---- requests ----

  private async slot() {
    if (this.inFlight < this.limit) { this.inFlight++; return; }
    await new Promise<void>((res) => this.queue.push(res));
    this.inFlight++;
  }
  private release() {
    this.inFlight--;
    this.queue.shift()?.();
  }

  // One native request through the plugin. Yields decoded stream events.
  async *request(o: {
    provider: PluginProviderDecl; model: string; sessionId: string; operation: string; headers: Record<string, string>; body: object; signal: AbortSignal;
  }): AsyncGenerator<SseEvent> {
    if (this.state === "starting") await this.ready;
    if (this.state !== "ready") throw new ProviderError("network", `plugin ${this.entry.id} is ${this.state.replace("_", " ")}${this.reason ? `: ${this.reason}` : ""}`);
    await this.slot();
    const requestId = `r-${Date.now().toString(36)}-${(this.nextId++).toString(36)}`;
    const ch = new Channel<Msg>();
    this.requests.set(requestId, ch);
    let ended = false;
    const cancel = () => {
      if (ended) return;
      if (this.caps.cancel) this.notify("request/cancel", { request_id: requestId });
      ch.fail(new ProviderError("cancelled", "cancelled"));
    };
    o.signal.addEventListener("abort", cancel, { once: true });
    try {
      await this.call("request/start", {
        request_id: requestId,
        provider: o.provider.id,
        model: o.model,
        session_id: o.sessionId,
        operation: o.operation,
        wire: o.provider.wire,
        stream: true,
        headers: o.headers,
        body: Buffer.from(JSON.stringify(o.body)).toString("base64"),
      }, ACK_MS);
      const head = await ch.next(IDLE_MS);
      if (head.done || head.value.kind !== "head") throw new ProviderError("network", "the plugin ended the request without an answer");
      const { status, headers } = head.value;
      if (status < 200 || status >= 300) {
        let body = "";
        const until = Date.now() + 20_000;
        for (;;) {
          const r = await ch.next(Math.max(1, until - Date.now())).catch(() => ({ done: true }) as any);
          if (r.done || r.value.kind === "end") break;
          if (r.value.kind === "chunk") body += new TextDecoder().decode(r.value.data);
        }
        throw classify(`${this.entry.id}/${o.provider.id}`, status, new Headers(headers), body);
      }
      const dec = o.provider.stream_format === "json_array" ? new JsonArrayDecoder() : new SseDecoder();
      for (;;) {
        const r = await ch.next(IDLE_MS);
        if (r.done || r.value.kind === "end") break;
        if (r.value.kind === "chunk") yield* dec.push(r.value.data);
      }
      yield* dec.finish();
      ended = true;
    } catch (e) {
      // A stall or a bad answer: the plugin stops sending this request.
      if (!ended && !o.signal.aborted && this.caps.cancel) this.notify("request/cancel", { request_id: requestId });
      throw e;
    } finally {
      ended = true;
      o.signal.removeEventListener("abort", cancel);
      this.requests.delete(requestId);
      this.release();
    }
  }

  // ---- lifecycle ----

  private hung() {
    if (this.state !== "ready" && this.state !== "starting") return;
    this.state = "not_responding";
    this.crashed("it did not answer within 20 s");
  }

  private crashed(why: string) {
    if (this.stopping) return;
    for (const [, p] of this.pending) { clearTimeout(p.t); p.rej(new ProviderError("network", `plugin ${this.entry.id} ${why}`)); }
    this.pending.clear();
    for (const [, ch] of this.requests) ch.fail(new ProviderError("network", `plugin ${this.entry.id} ${why}`));
    this.requests.clear();
    this.kill();
    if (this.readyAt && Date.now() - this.readyAt > 60_000) this.delay = 1000;
    this.readyAt = 0;
    this.state = "restarting";
    this.reason = why;
    this.restartAt = Date.now() + this.delay;
    this.capture(new Error(`plugin ${this.entry.id} ${why}`), { plugin: this.entry.id, stderr: this.stderrTail.slice(-600) });
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.start(); }, this.delay);
    this.delay = Math.min(this.delay * 2, 60_000);
    this.onChange?.();
  }

  private kill() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try { p.stdin.end(); } catch {}
    setTimeout(() => { if (p.exitCode === null) p.kill("SIGTERM"); }, 5000).unref?.();
    setTimeout(() => { if (p.exitCode === null) p.kill("SIGKILL"); }, 10_000).unref?.();
  }

  stop(reason?: string) {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.state = "stopped";
    this.reason = reason;
    if (this.proc) this.call("shutdown", {}, 5000).catch(() => {}).finally(() => this.kill());
    this.onChange?.();
  }

  killNow() {
    this.stopping = true;
    try { this.proc?.kill("SIGKILL"); } catch {}
  }
}

function pluginError(p: any): ProviderError {
  const msg = `plugin: ${scrub(String(p.message ?? p.kind)).slice(0, 400)}`;
  switch (p.kind) {
    case "auth": return new ProviderError("auth", msg, p.status);
    case "limit": return new ProviderError(p.limit === "rate" ? "rate" : "quota", msg, p.status, p.retry_after_ms);
    case "refused": case "protocol": return new ProviderError("invalid", msg, p.status);
    case "overloaded": return new ProviderError("overloaded", msg, p.status, p.retry_after_ms);
    case "network": return new ProviderError("network", msg, p.status);
    case "cancelled": return new ProviderError("cancelled", msg);
    default: return new ProviderError("server", msg, p.status);
  }
}
