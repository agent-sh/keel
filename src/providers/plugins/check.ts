// `keel plugin check`: the conformance runner of provider plugin protocol v1
// (keel docs/PROVIDER_PLUGINS.md, "Conformance"). It starts the plugin in a
// scratch environment with fake credentials, points it at a fake vendor on
// loopback and runs the fixtures of the spec's table in its order. Checks use
// fake credentials only and make no paid model call.
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { JsonArrayDecoder, SseDecoder, type SseEvent } from "../sse.ts";
import type { ProviderRequest, ProviderResult } from "../types.ts";
import { classify } from "../http.ts";
import { Barrier, FakeVendor, type Answer } from "./check-vendor.ts";
import { FIXTURE_FILES } from "./check-fixtures.ts";
import { codecFor } from "./index.ts";
import type { PluginProviderDecl } from "./host.ts";
import { pumpLines, pumpText } from "../../core/proc.ts";

const LOCAL = 20_000;
const IDLE = 300_000;
const STEP = 5_000;
const FIXTURE_MS = 60_000;
const NA = "\u0000n/a:";
const CRED_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-goog-api-key)$|-(key|token|secret|credential|credentials|auth|authorization)$/;
const TRANSPORT = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);
const PASS_ENV = /^(PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TMPDIR|TZ|SSL_CERT_FILE|SSL_CERT_DIR|LC_.*)$/;
const SCRATCH: [string, string][] = [["HOME", "home"], ["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_STATE_HOME", "state"], ["XDG_CACHE_HOME", "cache"], ["XDG_RUNTIME_DIR", "runtime"]];

export type Target = { id: string; command: string; args: string[]; env: string[]; settings: Record<string, unknown>; providerSettings: Record<string, unknown> };
export type Row = { fixture: string; result: "pass" | "fail" | "n/a"; ms: number; detail: string };
type Verdict = string | void; // a detail; a thrown Error is a failure, a NA-prefixed one is n/a

const na = (why: string) => new Error(NA + why);
const fail = (why: string) => new Error(why);
const enc = new TextEncoder();
const dec = new TextDecoder();
const fixture = (name: string) => {
  const path = FIXTURE_FILES[name];
  if (!path) throw fail(`no fixture ${name}`);
  return new Uint8Array(readFileSync(path));
};
const declared = (list: string[] | undefined, name: string) =>
  (list ?? []).some((p) => (p.endsWith("*") ? name.toLowerCase().startsWith(p.slice(0, -1)) : p === name.toLowerCase()));
const eqBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

// ---- one plugin process over JSON-RPC ----

type Ev =
  | { kind: "head"; status: number; headers: Record<string, string> }
  | { kind: "chunk"; data: Uint8Array }
  | { kind: "end" }
  | { kind: "error"; error: any }
  | { kind: "gone"; reason: string };

class Queue<T> {
  private items: T[] = [];
  private waiting: ((v: T | undefined) => void) | null = null;
  push(x: T) { if (this.waiting) { const w = this.waiting; this.waiting = null; w(x); } else this.items.push(x); }
  next(ms: number): Promise<T | undefined> {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((res) => {
      const t = setTimeout(() => { this.waiting = null; res(undefined); }, ms);
      this.waiting = (v) => { clearTimeout(t); res(v); };
    });
  }
  drain(): T[] { return this.items.splice(0); }
}

let rpcIds = 1;
let reqIds = 1;

class Proc {
  readonly lines: string[] = [];
  stderr = "";
  exit?: number | null;
  dead?: string;
  violations = 0;
  lastViolation = "";
  private pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
  private streams = new Map<string, Queue<Ev>>();
  private finals = new Set<string>();
  private exited: Promise<number | null>;

  constructor(readonly p: Subprocess<"pipe", "pipe", "pipe">) {
    this.exited = p.exited.then((c) => (this.exit = p.signalCode ? null : c));
    this.exited.then(() => {
      for (const [, q] of this.streams) q.push({ kind: "gone", reason: `the process exited (${p.signalCode ?? this.exit})` });
      for (const [, w] of this.pending) w.rej(fail(`the process exited (${p.signalCode ?? this.exit})`));
      this.pending.clear();
    });
    void this.read();
    void pumpText(p.stderr, (t) => (this.stderr = (this.stderr + t).slice(-65536)), "plugin check stderr");
  }

  private async read() {
    await pumpLines(this.p.stdout, (line) => { if (line.trim()) this.onLine(line); }, "plugin check stdout");
  }

  private violation(what: string) { this.violations++; this.lastViolation = what; }

  private onLine(line: string) {
    this.lines.push(line);
    let m: any;
    try { m = JSON.parse(line); } catch { this.dead = "a line that is not JSON"; return this.violation(this.dead); }
    if (m.id !== undefined && m.id !== null && !m.method) {
      const w = this.pending.get(m.id);
      if (!w) { this.dead = `an answer to id ${m.id} that was never sent`; return this.violation(this.dead); }
      this.pending.delete(m.id);
      return m.error ? w.rej(Object.assign(fail(`error ${m.error.code}: ${m.error.message}`), { rpc: m.error })) : w.res(m.result);
    }
    if (typeof m.method === "string" && m.method.startsWith("response/")) {
      const rid = m.params?.request_id;
      if (this.finals.has(rid)) return this.violation(`${m.method} after the request's final message`);
      const q = this.streams.get(rid);
      if (!q) return this.violation(`${m.method} for an unknown request`);
      const p = m.params;
      if (m.method === "response/head") q.push({ kind: "head", status: p.status, headers: p.headers ?? {} });
      else if (m.method === "response/chunk") q.push({ kind: "chunk", data: new Uint8Array(Buffer.from(String(p.data ?? ""), "base64")) });
      else if (m.method === "response/end") { this.finals.add(rid); q.push({ kind: "end" }); }
      else if (m.method === "response/error") { this.finals.add(rid); q.push({ kind: "error", error: p }); }
    }
  }

  private send(m: object) {
    try { this.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"); this.p.stdin.flush(); } catch {}
  }

  call(method: string, params: object, ms: number, id = rpcIds++): Promise<any> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(Object.assign(fail(`no answer to ${method} within ${ms / 1000} s`), { timeout: true })); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.send({ id, method, params });
    });
  }
  notify(method: string, params: object) { this.send({ method, params }); }

  // request/start; the acknowledgement and the request's events.
  start(requestId: string, params: object) {
    const q = new Queue<Ev>();
    this.streams.set(requestId, q);
    const id = rpcIds++;
    const ack = this.call("request/start", params, LOCAL, id);
    return { id, ack, q };
  }

  closeStdin() { try { this.p.stdin.end(); } catch {} }
  async waitExit(ms: number): Promise<number | null | undefined> {
    return Promise.race([this.exited, Bun.sleep(ms).then(() => undefined)]);
  }
  get alive() { return this.exit === undefined; }
  kill(sig: NodeJS.Signals) { try { this.p.kill(sig); } catch {} }
  tail() { return this.stderr.slice(-600).trim(); }
}

// ---- the check ----

type Prov = { decl: PluginProviderDecl & { request_envelope?: { field: string; added_fields?: string[] } }; model: string; family: string; thinks: boolean };
type Run = { marker: string; requestId: string; rpcId: number; native: Uint8Array; headers: Record<string, string>; ack?: string; events: Ev[] };

const random = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

export class Check {
  readonly rows: Row[] = [];
  private credential = `keel-test-${random(16)}`;
  private nonce = random(4);
  private vendor = new FakeVendor(this.credential).start();
  private scratch: string;
  private env: Record<string, string>;
  private procs: Proc[] = [];
  private providers: Prov[] = [];
  private caps: { cancel?: boolean; max_concurrent?: number; status?: boolean; ping?: boolean } = {};
  private leaked?: string;
  private expected = JSON.parse(dec.decode(fixture("expected.json"))).fixtures as Record<string, any>;

  constructor(private t: Target, stateDir: string, private only: string[] = [], private onRow?: (r: Row) => void) {
    const plugins = join(stateDir, "plugins");
    this.scratch = join(plugins, `check-${t.id}-${this.nonce}`);
    for (const [, d] of SCRATCH) mkdirSync(join(this.scratch, d), { recursive: true, mode: 0o700 });
    for (const d of [plugins, this.scratch, ...SCRATCH.map(([, d]) => join(this.scratch, d))]) try { chmodSync(d, 0o700); } catch {}
    // "The test environment": no proxy and no session bus; the scratch dirs for the owner's.
    const env: Record<string, string> = { KEEL_PROVIDER_PLUGIN: "1" };
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && PASS_ENV.test(k)) env[k] = v;
    for (const k of t.env) if (!k.startsWith("KEEL_") && process.env[k] !== undefined && !/proxy|DBUS/i.test(k)) env[k] = process.env[k]!;
    for (const [k, d] of SCRATCH) env[k] = join(this.scratch, d);
    env.KEEL_PLUGIN_TEST = "1";
    env.KEEL_PLUGIN_TEST_BASE_URL = this.vendor.baseUrl;
    env.KEEL_PLUGIN_TEST_CREDENTIAL = this.credential;
    this.env = env;
  }

  private spawn(): Proc {
    const p = Bun.spawn([this.t.command, ...this.t.args], { cwd: this.scratch, env: this.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const proc = new Proc(p);
    this.procs.push(proc);
    return proc;
  }

  private init(versions: number[], caps: object = { system_prefix: true }) {
    return {
      protocol_versions: versions, plugin_id: this.t.id, keel_version: "0.1.0", data_dir: this.scratch,
      settings: this.t.settings, provider_settings: this.t.providerSettings, capabilities: caps,
    };
  }

  private async stop(p: Proc, ask: boolean) {
    if (!p.alive) return;
    if (ask && !p.dead) await p.call("shutdown", {}, STEP).catch(() => {});
    p.closeStdin();
    if ((await p.waitExit(STEP)) !== undefined) return;
    p.kill("SIGTERM");
    if ((await p.waitExit(STEP)) !== undefined) return;
    p.kill("SIGKILL");
    await p.waitExit(STEP);
  }

  private wanted(f: string) { return !this.only.length || this.only.some((o) => f === o || f.startsWith(o)); }

  private async step(name: string, f: () => Promise<Verdict>, always = false): Promise<boolean> {
    if (!always && !this.wanted(name)) return true;
    const t0 = Date.now();
    let row: Row;
    try {
      const v = await Promise.race([f(), Bun.sleep(FIXTURE_MS).then(() => { throw fail("timed out after 60 s"); })]);
      row = { fixture: name, result: "pass", ms: Date.now() - t0, detail: v || "" };
    } catch (e) {
      const m = (e as Error).message;
      row = m.startsWith(NA) ? { fixture: name, result: "n/a", ms: Date.now() - t0, detail: m.slice(NA.length) } : { fixture: name, result: "fail", ms: Date.now() - t0, detail: m };
    }
    this.rows.push(row);
    this.onRow?.(row);
    return row.result !== "fail";
  }

  async run(): Promise<void> {
    try {
      const main = this.spawn();
      if (!(await this.step("handshake", () => this.handshake(main), true))) return void (await this.stop(main, false));
      await this.step("version_choice", () => this.version([1, 2]));
      await this.step("version_mismatch", () => this.version([2]));
      if (!(await this.step("models", () => this.models(main), true))) return void (await this.stop(main, true));
      await this.step("status", () => this.status(main));
      await this.step("ping", () => this.ping(main));
      await this.step("forward_compat", () => this.forwardCompat(main));
      await this.step("system_prefix_capability", () => this.systemPrefix());
      for (const p of this.providers) await this.step(`turn:${p.decl.id}`, () => this.plain(main, p, `turn:${p.decl.id}`, { unknown: true }));
      for (const p of this.providers) await this.step(`non_streamed:${p.decl.id}`, () => this.nonStreamed(main, p));
      for (const p of this.providers) await this.step(`body:${p.decl.id}`, () => this.plain(main, p, `body:${p.decl.id}`, { extra: " שלום 😀 café \u0001 \"quoted\" back\\slash 1.50e3 0.25" }));
      for (const p of this.providers) await this.step(`malformed:${p.decl.id}`, () => this.plain(main, p, `malformed:${p.decl.id}`, { file: this.malformedFile(p) }));
      let pool = { baseline: this.vendor.connections, limit: 1 };
      await this.step("concurrent", async () => {
        pool.baseline = this.vendor.connections;
        const r = await this.concurrent(main);
        pool.limit = r.n;
        return r.detail;
      });
      await this.step("connection_pool", () => this.connectionPool(main, pool.baseline, pool.limit));
      await this.step("cancel", () => this.cancel(main));
      for (const s of [401, 429, 500]) for (const p of this.providers) await this.step(`${s === 401 ? "auth_401" : s === 429 ? "limit_429" : "server_500"}:${p.decl.id}`, () => this.errorFixture(main, p, s));
      await this.step("restart", () => this.restart());
      await this.step("shutdown", () => this.shutdown());
      await this.step("eof", () => this.eof());
      await this.stop(main, true);
      await this.step("credential", async () => this.credentialRule());
      await this.step("isolation", async () => this.isolationRule());
    } finally {
      for (const p of this.procs) if (p.alive) p.kill("SIGKILL");
      this.vendor.stop();
      rmSync(this.scratch, { recursive: true, force: true });
    }
  }

  // ---- fixtures ----

  private async handshake(main: Proc): Promise<Verdict> {
    const t0 = Date.now();
    const r = await main.call("initialize", { ...this.init([1]), x_check_unknown: true }, LOCAL).catch((e) => { throw fail(this.withTail(main, e.message)); });
    if (r?.protocol_version !== 1) throw fail(`protocol_version is ${r?.protocol_version}, not 1`);
    if (r.plugin?.id !== this.t.id) throw fail(`plugin.id is \`${r.plugin?.id}\`, not \`${this.t.id}\``);
    if (!Array.isArray(r.providers) || !r.providers.length) throw fail("no provider is declared");
    const ids = new Set<string>();
    for (const d of r.providers as PluginProviderDecl[]) {
      if (typeof d.id !== "string" || typeof d.label !== "string") throw fail("a provider without its id or label");
      if (ids.has(d.id)) throw fail(`provider \`${d.id}\` is declared twice`);
      ids.add(d.id);
      if (!["anthropic_messages", "openai_responses", "chat_completions", "gemini_generate_content"].includes(d.wire) || !["sse", "json_array", undefined].includes(d.stream_format))
        throw fail(`provider \`${d.id}\` uses a wire or stream format v1 does not define`);
      if (d.wire !== "gemini_generate_content" && (d.request_envelope || d.response_envelope || d.stream_format === "json_array"))
        throw fail(`provider \`${d.id}\` declares an envelope or json_array on ${d.wire}`);
      if (!declared(d.response_headers, "retry-after")) throw fail(`provider \`${d.id}\` does not pass retry-after`);
    }
    this.caps = r.capabilities ?? {};
    this.providers = r.providers.map((decl: any) => ({ decl, model: "", family: "other", thinks: true }));
    return `${r.plugin.name ?? r.plugin.id} ${r.plugin.version ?? ""} in ${Date.now() - t0} ms, ${this.providers.length} provider(s)`;
  }

  private async version(versions: number[]): Promise<Verdict> {
    const p = this.spawn();
    try {
      const r = await p.call("initialize", this.init(versions), LOCAL).then((v) => ({ ok: v }), (e) => ({ err: e }));
      if (versions.length === 1 && versions[0] === 2) {
        if ("ok" in r) throw fail("a result to an initialize that offers only version 2");
        const e = (r.err as any).rpc;
        if (!e) throw r.err;
        if (e.code !== -32000) throw fail(`error ${e.code} instead of -32000`);
        if (!e.data?.supported?.includes?.(1)) throw fail("error -32000 without data.supported holding 1");
        p.closeStdin();
        if ((await p.waitExit(STEP)) === undefined) throw fail("the process did not exit within 5 s of the EOF");
        return;
      }
      if ("err" in r) throw r.err;
      if (r.ok?.protocol_version !== 1) throw fail(`protocol_version ${r.ok?.protocol_version}, not 1`);
    } finally {
      await this.stop(p, !(versions.length === 1 && versions[0] === 2));
    }
  }

  private async models(main: Proc): Promise<Verdict> {
    const r = await main.call("models/list", {}, IDLE);
    let count = 0;
    for (const p of this.providers) {
      const g = (r?.providers ?? []).find((x: any) => x.provider === p.decl.id);
      if (!g) throw fail(`no group for provider \`${p.decl.id}\``);
      const ids = new Set<string>();
      for (const m of g.models ?? []) {
        if (typeof m.id !== "string") throw fail(`a model of \`${p.decl.id}\` without an id`);
        if (ids.has(m.id)) throw fail(`model \`${m.id}\` is listed twice for \`${p.decl.id}\``);
        ids.add(m.id);
        const rs = m.capabilities?.reasoning;
        if (rs?.kind === "levels" && rs.default !== undefined && !rs.levels?.includes(rs.default)) throw fail(`model \`${m.id}\`: default level \`${rs.default}\` is not one of its levels`);
        if (rs?.kind === "budget" && (rs.min > rs.max || (rs.default !== undefined && (rs.default < rs.min || rs.default > rs.max)))) throw fail(`model \`${m.id}\`: the budget breaks min <= default <= max`);
      }
      const first = (g.models ?? []).find((m: any) => m.capabilities?.tools);
      if (!first) throw fail(`provider \`${p.decl.id}\` lists no model with tools`);
      p.model = first.id;
      p.family = first.family ?? "other";
      p.thinks = first.capabilities?.reasoning ? first.capabilities.reasoning.kind !== "none" : true;
      count += g.models.length;
    }
    return `${count} model(s)`;
  }

  private async status(main: Proc): Promise<Verdict> {
    if (!this.caps.status) throw na("the plugin does not declare status");
    const r = await main.call("status", {}, IDLE);
    for (const p of this.providers) {
      const s = (r?.providers ?? []).find((x: any) => x.provider === p.decl.id);
      if (!s) throw fail(`no entry for provider \`${p.decl.id}\``);
      if (s.state !== "ready") throw fail(`provider \`${p.decl.id}\` is \`${s.state}\`, not ready, in test mode`);
    }
  }

  private async systemPrefix(): Promise<Verdict> {
    const p = this.spawn();
    try {
      const r = await p.call("initialize", this.init([1], {}), LOCAL).then((v) => ({ ok: v }), (e) => ({ err: e }));
      if ("err" in r) {
        if ((r.err as any).rpc?.code === -32003) return "refused the host without the capability";
        throw r.err;
      }
      if ((r.ok?.providers ?? []).some((x: any) => x.system_prefix)) throw fail("a system_prefix was declared without Keel's capability");
    } finally {
      await this.stop(p, true);
    }
  }

  // The native request of a check turn: one tool, a system prompt, one user message ending in the marker.
  private native(p: Prov, marker: string, extra = "", stream = true) {
    const req = {
      model: p.model, system: "You are the coding agent of this workspace.",
      messages: [{ role: "user", content: [{ type: "text", text: `List the files of the project.${extra} ${marker}` }] }],
      tools: [{ name: "Bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
      signal: new AbortController().signal, sessionKey: `keel-check-${this.nonce}`,
    } as ProviderRequest;
    const codec = codecFor(p.decl, p.thinks);
    const body: any = codec.body(req, { origin: `check:${p.model}`, sessionKey: req.sessionKey!, efforts: [] });
    if (!stream) {
      if ("stream" in body) body.stream = false;
      delete body.stream_options;
    }
    const headers: Record<string, string> = { "content-type": "application/json", accept: stream && p.decl.stream_format !== "json_array" ? "text/event-stream" : "application/json" };
    if (p.decl.wire === "anthropic_messages") headers["anthropic-version"] = "2023-06-01";
    return { native: enc.encode(JSON.stringify(body)), headers };
  }

  private async turn(proc: Proc, p: Prov, label: string, answer: Answer, o: { stream?: boolean; operation?: string; extra?: string; unknown?: boolean } = {}): Promise<Run> {
    const marker = `[keel-check ${label} ${this.nonce}]`;
    const stream = o.stream ?? true;
    const { native, headers } = this.native(p, marker, o.extra, stream);
    this.vendor.answer(marker, answer);
    const requestId = `r-check-${(reqIds++).toString(36)}`;
    const params: any = {
      request_id: requestId, provider: p.decl.id, model: p.model, session_id: `keel-check-${this.nonce}`,
      operation: o.operation ?? "turn", wire: p.decl.wire, stream, headers, body: b64(native),
    };
    if (o.unknown) params.x_check_unknown = true;
    const s = proc.start(requestId, params);
    const run: Run = { marker, requestId, rpcId: s.id, native, headers, events: [] };
    try { await s.ack; } catch (e) { run.ack = (e as Error).message; return run; }
    for (;;) {
      const ev = await s.q.next(IDLE);
      if (!ev) { run.events.push({ kind: "gone", reason: "no message within the idle timeout" }); break; }
      if (ev.kind === "head") { const n = Object.keys(ev.headers).find((h) => CRED_HEADER.test(h.toLowerCase())); if (n) this.leaked = n; }
      run.events.push(ev);
      if (ev.kind !== "head" && ev.kind !== "chunk") break;
    }
    return run;
  }

  private served(p: Prov, file: string, stream: boolean): Answer {
    return { kind: "bytes", status: 200, headers: [["content-type", stream && p.decl.stream_format !== "json_array" ? "text/event-stream" : "application/json"], ["request-id", `req-check-${this.nonce}`]], body: fixture(file) };
  }

  private turnFile(p: Prov) {
    const w = p.decl.response_envelope ? ".envelope" : "";
    return p.decl.stream_format === "json_array" ? `${p.decl.wire}.turn${w}.json-array` : `${p.decl.wire}.turn${w}.sse`;
  }
  private malformedFile(p: Prov) {
    return p.decl.stream_format === "json_array" ? this.turnFile(p) : `${p.decl.wire}.turn${p.decl.response_envelope ? ".envelope" : ""}.malformed.sse`;
  }
  private wholeFile(p: Prov) {
    return { anthropic_messages: "anthropic_messages.message.json", openai_responses: "openai_responses.response.json", chat_completions: "chat_completions.completion.json" }[p.decl.wire as string]
      ?? (p.decl.response_envelope ? "gemini_generate_content.response.envelope.json" : "gemini_generate_content.response.json");
  }

  private withTail(p: Proc, s: string) { const t = p.tail(); return t ? `${s}; stderr: ${t}` : s; }

  // The acknowledgement came before any response/* of the request.
  private order(proc: Proc, run: Run) {
    let ack = -1, first = -1;
    proc.lines.forEach((l, i) => {
      let m: any;
      try { m = JSON.parse(l); } catch { return; }
      if (m.id === run.rpcId && m.result !== undefined && ack < 0) ack = i;
      if (String(m.method ?? "").startsWith("response/") && m.params?.request_id === run.requestId && first < 0) first = i;
    });
    if (ack < 0) throw fail("no acknowledgement");
    if (first >= 0 && first < ack) throw fail("a response/* message came before the acknowledgement");
  }

  // The vendor side: the request count, the credential in a header only, the headers, the body rule.
  private vendorSide(p: Prov, run: Run, most: number) {
    const seen = this.vendor.requestsFor(run.marker);
    if (!seen.length || seen.length > most) throw fail(`the fake vendor received ${seen.length} request(s) for it, not ${most === 1 ? "1" : `1 to ${most}`}`);
    for (const r of seen) {
      if (!r.credentialInHeader) throw fail("the vendor request did not carry the fake credential in a header");
      if (r.credentialInUrl || r.credentialInBody) throw fail("the fake credential appeared in the URL or the body");
      for (const [n, v] of Object.entries(run.headers)) {
        const got = r.headers.find(([k]) => k === n)?.[1];
        if (got !== v) throw fail(`the vendor request has \`${n}: ${got ?? "(absent)"}\`, not \`${v}\``);
      }
      bodyRule(p, run.native, r.body);
    }
  }

  // "A turn passes", for a 2xx answer of `file`.
  private judge(proc: Proc, p: Prov, run: Run, file: string, stream: boolean): Verdict {
    if (run.ack) throw fail(this.withTail(proc, run.ack));
    const last = run.events.at(-1);
    if (last?.kind === "gone") throw fail(this.withTail(proc, `the request ended with ${last.reason}`));
    this.order(proc, run);
    this.vendorSide(p, run, 1);
    const head = run.events.find((e) => e.kind === "head") as Extract<Ev, { kind: "head" }> | undefined;
    if (!head) throw fail(`no head; the request ended with ${describe(last)}`);
    if (head.status !== 200) throw fail(`the head says ${head.status}, not 200`);
    const names = Object.keys(head.headers).map((h) => h.toLowerCase());
    const cred = names.find((n) => CRED_HEADER.test(n));
    if (cred) throw fail(`the head holds the credential header \`${cred}\``);
    const undeclared = names.find((n) => !TRANSPORT.has(n) && !declared(p.decl.response_headers, n));
    if (undeclared) throw fail(`the head holds \`${undeclared}\`, which the provider does not declare`);
    if (last?.kind !== "end") throw fail(`the request ended with ${describe(last)}, not response/end`);
    const body = concatChunks(run.events);
    const want = fixture(file);
    if (!eqBytes(body, want)) throw fail(`the chunks hold ${body.length} bytes that differ from the ${want.length} bytes of ${file}`);
    compareReading(read(p, body, stream), this.expected[file.replace(".malformed", "")] ?? this.expected[file]);
  }

  private async plain(main: Proc, p: Prov, label: string, o: { file?: string; extra?: string; unknown?: boolean }): Promise<Verdict> {
    const file = o.file ?? this.turnFile(p);
    const run = await this.turn(main, p, label, this.served(p, file, true), { extra: o.extra, unknown: o.unknown });
    return this.judge(main, p, run, file, true);
  }

  private async nonStreamed(main: Proc, p: Prov): Promise<Verdict> {
    const file = this.wholeFile(p);
    const run = await this.turn(main, p, `non_streamed:${p.decl.id}`, this.served(p, file, false), { stream: false, operation: "probe" });
    this.judge(main, p, run, file, false);
    if (declared(p.decl.response_headers, "content-type")) {
      const head = run.events.find((e) => e.kind === "head") as any;
      const ct = Object.entries<string>(head.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
      if (!ct.includes("application/json")) throw fail(`the head's content-type is \`${ct}\`, not application/json`);
    }
  }

  private async concurrent(main: Proc): Promise<{ n: number; detail: string }> {
    const limit = this.caps.max_concurrent ?? 0;
    if (limit === 1) throw na("max_concurrent is 1");
    const n = limit === 2 || limit === 3 ? limit : 4;
    const p = this.providers[0]!;
    const file = this.turnFile(p);
    const barrier = new Barrier(n);
    const runs = await Promise.all(Array.from({ length: n }, (_, i) => this.turn(main, p, `concurrent#${i + 1}`, { kind: "barrier", barrier, answer: this.served(p, file, true) })));
    if (barrier.maxOpen < n) throw fail(`only ${barrier.maxOpen} of the ${n} requests were open at the fake vendor together`);
    runs.forEach((r, i) => { try { this.judge(main, p, r, file, true); } catch (e) { throw fail(`request ${i + 1}: ${(e as Error).message}`); } });
    return { n, detail: `n = ${n}: all open together` };
  }

  private async connectionPool(main: Proc, baseline: number, limit: number): Promise<Verdict> {
    const p = this.providers[0]!;
    const file = this.turnFile(p);
    for (const i of [1, 2]) {
      const run = await this.turn(main, p, `connection_pool#${i}`, this.served(p, file, true));
      try { this.judge(main, p, run, file, true); } catch (e) { throw fail(`turn ${i}: ${(e as Error).message}`); }
    }
    const opened = this.vendor.connections - baseline;
    if (opened > limit) throw fail(`${opened} TCP connections were opened where ${limit} would do: no shared pool`);
    return `${opened} new connection(s), at most ${limit}`;
  }

  // A turn whose answer stops after its first event and then sends keep-alives.
  private held(p: Prov): { answer: Answer; release: () => void } {
    const bytes = fixture(this.turnFile(p));
    let end: number;
    if (p.decl.stream_format === "json_array") end = firstElementEnd(bytes);
    else {
      const s = dec.decode(bytes);
      const at = s.indexOf("\n\n");
      end = at >= 0 ? enc.encode(s.slice(0, at + 2)).length : bytes.length;
    }
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    return {
      answer: { kind: "hold", first: bytes.slice(0, end), keepalive: enc.encode(p.decl.stream_format === "json_array" ? " " : ": keep-alive\n\n"), contentType: p.decl.stream_format === "json_array" ? "application/json" : "text/event-stream", release: released },
      release,
    };
  }

  private async startHeld(proc: Proc, p: Prov, label: string) {
    const marker = `[keel-check ${label} ${this.nonce}]`;
    const { native, headers } = this.native(p, marker);
    const h = this.held(p);
    this.vendor.answer(marker, h.answer);
    const requestId = `r-check-${(reqIds++).toString(36)}`;
    const s = proc.start(requestId, { request_id: requestId, provider: p.decl.id, model: p.model, session_id: `keel-check-${this.nonce}`, operation: "turn", wire: p.decl.wire, stream: true, headers, body: b64(native) });
    await s.ack;
    for (;;) {
      const ev = await s.q.next(LOCAL);
      if (!ev) throw fail("no first chunk within 20 s");
      if (ev.kind === "head") continue;
      if (ev.kind === "chunk") break;
      throw fail(`the held request ended with ${describe(ev)}`);
    }
    return { marker, requestId, q: s.q, release: h.release };
  }

  private async stillAnswers(main: Proc) {
    const [m, ms] = this.caps.ping ? ["ping", LOCAL] : this.caps.status ? ["status", IDLE] : ["models/list", IDLE];
    await main.call(m as string, {}, ms as number).catch((e) => { throw fail(`${m} after it: ${e.message}`); });
  }

  private async ping(main: Proc): Promise<Verdict> {
    if (!this.caps.ping) throw na("the plugin does not declare ping");
    const p = this.providers[0]!;
    const h = await this.startHeld(main, p, "ping");
    const t0 = Date.now();
    const r = await main.call("ping", {}, LOCAL).then((v) => ({ ok: v }), (e) => ({ err: e }));
    const took = Date.now() - t0;
    if (this.caps.cancel) main.notify("request/cancel", { request_id: h.requestId });
    else h.release();
    for (let ev = await h.q.next(LOCAL); ev && (ev.kind === "head" || ev.kind === "chunk"); ev = await h.q.next(LOCAL));
    if ("err" in r) throw r.err;
    if (JSON.stringify(r.ok) !== "{}") throw fail(`ping answered ${JSON.stringify(r.ok)}, not {}`);
    return `answered in ${took} ms while a request was held`;
  }

  private async forwardCompat(main: Proc): Promise<Verdict> {
    const r = await main.call("keel/check-unknown", {}, LOCAL).then((v) => ({ ok: v }), (e) => ({ err: e }));
    if ("ok" in r) throw fail("a result to an unknown method");
    const e = (r.err as any).rpc;
    if (!e) throw r.err;
    if (e.code !== -32601) throw fail(`error ${e.code} instead of -32601`);
    main.notify("keel/check-unknown", {});
    await this.stillAnswers(main);
    if (main.dead) throw fail(`the plugin broke the framing: ${main.dead}`);
  }

  private async cancel(main: Proc): Promise<Verdict> {
    if (!this.caps.cancel) throw na("the plugin does not declare cancel");
    const p = this.providers[0]!;
    const h = await this.startHeld(main, p, "cancel");
    const before = main.violations;
    const t0 = Date.now();
    main.notify("request/cancel", { request_id: h.requestId });
    let last: Ev | undefined;
    for (;;) {
      last = await h.q.next(LOCAL);
      if (!last) throw fail("no final message within 20 s of the cancel");
      if (last.kind !== "chunk" && last.kind !== "head") break;
    }
    if (!((last.kind === "error" && last.error.kind === "cancelled") || last.kind === "end")) throw fail(`the request ended with ${describe(last)}, not cancelled`);
    const took = Date.now() - t0;
    const rec = this.vendor.requestsFor(h.marker)[0];
    if (!rec) throw fail("the fake vendor saw no request");
    for (const until = t0 + LOCAL; !rec.closed && Date.now() < until;) await Bun.sleep(50);
    if (!rec.closed) throw fail("the fake vendor's connection was still open 20 s after the cancel");
    main.notify("request/cancel", { request_id: "r-check-unknown" });
    await this.stillAnswers(main);
    await Bun.sleep(200);
    if (main.violations !== before) throw fail(`a message came for the request after its final one: ${main.lastViolation}`);
    if (main.dead) throw fail(`the plugin broke the framing: ${main.dead}`);
    return `ended in ${took} ms`;
  }

  private async errorFixture(main: Proc, p: Prov, status: number): Promise<Verdict> {
    const file = `errors/${p.decl.wire}.${status}.json`;
    const body = fixture(file);
    const headers: [string, string][] = [["content-type", "application/json"]];
    if (status === 429) headers.push(["retry-after", "7"]);
    const label = `${status === 401 ? "auth_401" : status === 429 ? "limit_429" : "server_500"}:${p.decl.id}`;
    const run = await this.turn(main, p, label, { kind: "bytes", status, headers, body });
    if (run.ack) throw fail(run.ack);
    this.order(main, run);
    this.vendorSide(p, run, status === 401 ? 2 : 1);
    const err = run.events.find((e) => e.kind === "error") as any;
    const head = run.events.find((e) => e.kind === "head") as any;
    let outcome: { kind: string; retryable: boolean; retryAfterMs?: number };
    if (err) {
      const e = err.error;
      const ok = status === 401 ? e.kind === "auth" : status === 429 ? e.kind === "limit" && e.limit === "rate" && e.retry_after_ms === 7000 : false;
      if (!ok) throw fail(`the ${status} answer ended in response/error kind ${e.kind} (${e.message}); the vendor answer must be forwarded${status === 401 ? " or end in kind auth" : status === 429 ? " or end in kind limit, limit rate, retry_after_ms 7000" : ""}`);
      // How the host reads a plugin's error (src/providers/plugins/host.ts).
      outcome = e.kind === "auth" ? { kind: "auth", retryable: false } : { kind: "rate", retryable: true, retryAfterMs: e.retry_after_ms };
    } else if (head) {
      if (head.status !== status) throw fail(`the head says ${head.status}, not ${status}`);
      if (run.events.at(-1)?.kind !== "end") throw fail(`the request ended with ${describe(run.events.at(-1))}, not response/end`);
      if (!eqBytes(concatChunks(run.events), body)) throw fail(`the chunks differ from ${file}`);
      const fwd = new Headers();
      for (const [k, v] of Object.entries<string>(head.headers)) if (declared(p.decl.response_headers, k) && !CRED_HEADER.test(k.toLowerCase())) fwd.set(k, v);
      if (status === 429 && fwd.get("retry-after") !== "7") throw fail("the forwarded 429 lost its retry-after: 7");
      const e = classify(`${this.t.id}/${p.decl.id}`, status, fwd, dec.decode(body));
      outcome = { kind: e.kind, retryable: e.retryable, retryAfterMs: e.retryAfterMs };
    } else throw fail(`no head and no error; the request ended with ${describe(run.events.at(-1))}`);
    const fine = status === 401 ? outcome.kind === "auth" && !outcome.retryable
      : status === 429 ? outcome.kind === "rate" && outcome.retryAfterMs === 7000
      : outcome.kind === "server" && outcome.retryable;
    if (!fine) throw fail(`Keel's outcome is ${outcome.kind} (retry after ${outcome.retryAfterMs ?? "none"}), not what the fixture expects`);
    return `Keel's outcome: ${outcome.kind}${status === 429 ? ", retry after 7 s" : ""}`;
  }

  private async initialized(): Promise<Proc> {
    const p = this.spawn();
    await p.call("initialize", this.init([1]), LOCAL).catch((e) => { throw fail(`initialize: ${e.message}`); });
    return p;
  }

  private async restart(): Promise<Verdict> {
    const p = this.providers[0]!;
    const first = await this.initialized();
    let h;
    try { h = await this.startHeld(first, p, "restart#held"); } catch (e) { await this.stop(first, false); throw e; }
    try { process.kill(-first.p.pid, "SIGKILL"); } catch {} // the plugin's group, when it leads one
    first.kill("SIGKILL");
    let ev: Ev | undefined;
    for (ev = await h.q.next(LOCAL); ev && (ev.kind === "chunk" || ev.kind === "head"); ev = await h.q.next(LOCAL));
    if (!ev) throw fail("the killed process was not noticed within 20 s");
    if (ev.kind !== "gone") throw fail(`after SIGKILL the request ended with ${describe(ev)}`);
    // The host fails such a turn as a passing network error and starts the plugin again after 1 s.
    await first.waitExit(STEP);
    await Bun.sleep(1000);
    const t0 = Date.now();
    const second = await this.initialized().catch((e) => { throw fail(`the restarted plugin: ${e.message}`); });
    const took = Date.now() - t0;
    try {
      await second.call("models/list", {}, IDLE).catch(() => {});
      const file = this.turnFile(p);
      const run = await this.turn(second, p, "restart#turn", this.served(p, file, true));
      try { this.judge(second, p, run, file, true); } catch (e) { throw fail(`the turn after the restart: ${(e as Error).message}`); }
    } finally {
      await this.stop(second, true);
    }
    return `network, retryable; restarted and initialized in ${took} ms`;
  }

  private async shutdown(): Promise<Verdict> {
    const p = this.providers[0]!;
    const proc = await this.initialized();
    try {
      const h = await this.startHeld(proc, p, "shutdown#held");
      const id = rpcIds++;
      const t0 = Date.now();
      const r = await proc.call("shutdown", {}, STEP, id).then((v) => ({ ok: v }), (e) => ({ err: e }));
      const took = Date.now() - t0;
      if ("err" in r) throw (r.err as any).timeout ? fail("no shutdown answer within 5 s") : r.err;
      if (JSON.stringify(r.ok) !== "{}") throw fail(`shutdown answered ${JSON.stringify(r.ok)}, not {}`);
      const cancelled = h.q.drain().some((e) => e.kind === "error" && e.error.kind === "cancelled");
      if (!cancelled) throw fail("the held turn did not end as cancelled");
      const at = (f: (m: any) => boolean) => proc.lines.findIndex((l) => { try { return f(JSON.parse(l)); } catch { return false; } });
      const errAt = at((m) => m.method === "response/error" && m.params?.request_id === h.requestId);
      const ansAt = at((m) => m.id === id);
      if (!(errAt >= 0 && ansAt >= 0 && errAt < ansAt)) throw fail("the cancelled error did not come before the shutdown answer");
      proc.closeStdin();
      const code = await proc.waitExit(STEP);
      if (code === undefined) throw fail("the plugin did not exit within 5 s of the EOF");
      if (code !== 0) throw fail(`the plugin exited with ${code}, not 0`);
      const rec = this.vendor.requestsFor(h.marker)[0];
      if (!rec) throw fail("the fake vendor saw no request");
      for (const until = Date.now() + STEP; !rec.closed && Date.now() < until;) await Bun.sleep(50);
      if (!rec.closed) throw fail("the held vendor connection was not closed");
      return `answered in ${took} ms, exit 0, no signal`;
    } finally {
      await this.stop(proc, false);
    }
  }

  private async eof(): Promise<Verdict> {
    const proc = await this.initialized();
    try {
      proc.closeStdin();
      const code = await proc.waitExit(STEP);
      if (code === undefined) throw fail("the plugin did not exit within 5 s of the EOF");
      if (code !== 0) throw fail(`the plugin exited with ${code}, not 0`);
    } finally {
      await this.stop(proc, false);
    }
  }

  private credentialRule(): Verdict {
    const reqs = this.vendor.requests;
    if (!reqs.length) throw na("no vendor request was made");
    const bad = reqs.find((r) => !r.credentialInHeader);
    if (bad) throw fail(`a request to ${bad.target} did not carry the fake credential in a header`);
    if (reqs.some((r) => r.credentialInUrl || r.credentialInBody)) throw fail("the fake credential appeared in a URL or a request body");
    if (this.leaked) throw fail(`a response/head held the credential header \`${this.leaked}\``);
    const forms = credentialForms(this.credential);
    for (const p of this.procs) {
      if (forms.some((f) => p.stderr.includes(f))) throw fail("the fake credential appeared on stderr");
      if (p.lines.some((l) => forms.some((f) => l.includes(f)))) throw fail("the fake credential appeared on stdout");
    }
    return `${reqs.length} vendor request(s)`;
  }

  private isolationRule(): Verdict {
    const stray = this.vendor.requests.find((r) => !r.marker);
    if (stray) throw fail(`a request to ${stray.target} carried no fixture marker: in test mode only model calls are sent`);
    return `${this.vendor.requests.length} vendor request(s), each a fixture's`;
  }
}

// ---- pure helpers ----

function describe(e: Ev | undefined): string {
  if (!e) return "nothing";
  if (e.kind === "head") return `a head with ${e.status}`;
  if (e.kind === "chunk") return "a chunk";
  if (e.kind === "end") return "response/end";
  if (e.kind === "error") return `response/error kind ${e.error.kind} (${e.error.message})`;
  return `the process went away: ${e.reason}`;
}

function concatChunks(events: Ev[]): Uint8Array {
  const parts = events.filter((e) => e.kind === "chunk").map((e) => (e as any).data as Uint8Array);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// The credential as written and base64 encoded at the three byte alignments.
export function credentialForms(c: string): string[] {
  const b = enc.encode(c);
  const out = [c];
  for (let skip = 0; skip < 3; skip++) {
    const rest = b.slice(skip);
    const whole = Math.floor(rest.length / 3) * 3;
    if (whole >= 6) out.push(b64(rest.slice(0, whole)));
  }
  return out;
}

function firstElementEnd(bytes: Uint8Array): number {
  const d = new JsonArrayDecoder();
  for (let i = 0; i < bytes.length; i++) if (d.push(bytes.slice(i, i + 1)).length) return i + 1;
  return bytes.length;
}

// Two JSON texts hold the same value with strings and numbers as written.
export function sameJson(a: string, b: string): string | null {
  const ra = rawParse(a), rb = rawParse(b);
  return compareRaw(ra, rb, "");
}
type Raw = { t: "o"; m: Map<string, Raw> } | { t: "a"; v: Raw[] } | { t: "s"; v: string } | { t: "n"; v: string };
function rawParse(s: string): Raw {
  let i = 0;
  const ws = () => { while (/\s/.test(s[i] ?? "")) i++; };
  const val = (): Raw => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++; const m = new Map<string, Raw>(); ws();
      if (s[i] === "}") { i++; return { t: "o", m }; }
      for (;;) { ws(); const k = (val() as any).v; ws(); i++; m.set(k, val()); ws(); if (s[i++] === "}") return { t: "o", m }; }
    }
    if (c === "[") {
      i++; const v: Raw[] = []; ws();
      if (s[i] === "]") { i++; return { t: "a", v }; }
      for (;;) { v.push(val()); ws(); if (s[i++] === "]") return { t: "a", v }; }
    }
    if (c === "\"") {
      let j = i + 1;
      while (s[j] !== "\"") j += s[j] === "\\" ? 2 : 1;
      const v = JSON.parse(s.slice(i, j + 1));
      i = j + 1;
      return { t: "s", v };
    }
    let j = i;
    while (j < s.length && !/[\s,\]}]/.test(s[j]!)) j++;
    const v = s.slice(i, j);
    i = j;
    return { t: "n", v };
  };
  return val();
}
function compareRaw(a: Raw, b: Raw, at: string): string | null {
  if (a.t !== b.t) return `${at || "the value"} changed its type`;
  if (a.t === "o") {
    const bm = (b as any).m as Map<string, Raw>;
    if (a.m.size !== bm.size || [...a.m.keys()].some((k) => !bm.has(k))) return `${at || "the object"}: the members differ`;
    for (const [k, v] of a.m) { const d = compareRaw(v, bm.get(k)!, `${at}.${k}`); if (d) return d; }
    return null;
  }
  if (a.t === "a") {
    const bv = (b as any).v as Raw[];
    if (a.v.length !== bv.length) return `${at}: the arrays differ in length`;
    for (let k = 0; k < a.v.length; k++) { const d = compareRaw(a.v[k]!, bv[k]!, `${at}[${k}]`); if (d) return d; }
    return null;
  }
  return a.v === (b as any).v ? null : `${at}: \`${a.v}\` became \`${(b as any).v}\``;
}

// The body rule: the native body byte for byte, or with a request envelope a
// JSON object whose field holds every member Keel sent as written.
function bodyRule(p: Prov, native: Uint8Array, sent: Uint8Array) {
  const env = p.decl.request_envelope;
  if (!env) {
    if (!eqBytes(native, sent)) throw fail(`the vendor body (${sent.length} bytes) is not the native body (${native.length} bytes) byte for byte`);
    return;
  }
  let outer: Raw;
  try { outer = rawParse(dec.decode(sent)); } catch { throw fail("the vendor body is not a JSON object"); }
  if (outer.t !== "o") throw fail("the vendor body is not a JSON object");
  const inner = outer.m.get(env.field);
  if (!inner || inner.t !== "o") throw fail(`the vendor body has no object \`${env.field}\``);
  const nat = rawParse(dec.decode(native));
  if (nat.t !== "o") throw fail("the native body is not a JSON object");
  for (const [k, v] of nat.m) {
    const got = inner.m.get(k);
    if (!got) throw fail(`the wrapped body lacks \`${k}\``);
    const d = compareRaw(v, got, k);
    if (d) throw fail(`\`${k}\`: ${d}`);
  }
  const extra = [...inner.m.keys()].find((k) => !nat.m.has(k) && !(env.added_fields ?? []).includes(k));
  if (extra) throw fail(`the wrapped body adds \`${extra}\`, which added_fields does not name`);
}

// Keel's reading of a provider's answer bytes, with the same codec a turn uses.
export function read(p: Pick<Prov, "decl" | "thinks">, body: Uint8Array, stream: boolean): ProviderResult {
  const req = { model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal } as ProviderRequest;
  const ctx = { origin: "check:m", sessionKey: "k", efforts: [] };
  const parser = codecFor(p.decl, p.thinks).parser(req, ctx, () => {});
  const feed = (evs: SseEvent[]) => evs.forEach((e) => parser.event(e));
  if (stream) {
    const d = p.decl.stream_format === "json_array" ? new JsonArrayDecoder() : new SseDecoder();
    for (let i = 0; i < body.length; i += 7) feed(d.push(body.slice(i, i + 7)));
    feed(d.finish());
  } else {
    const whole = JSON.parse(dec.decode(body));
    if (p.decl.wire === "anthropic_messages") feed(anthropicEvents(whole));
    else if (p.decl.wire === "openai_responses") feed([{ data: JSON.stringify({ type: "response.completed", response: whole }) } as SseEvent]);
    else feed([{ data: JSON.stringify(whole) } as SseEvent]);
  }
  return parser.result();
}

// A whole Messages answer as the events of its stream.
function anthropicEvents(m: any): SseEvent[] {
  const ev = (o: object) => ({ data: JSON.stringify(o) }) as SseEvent;
  const out = [ev({ type: "message_start", message: { ...m, content: [] } })];
  (m.content ?? []).forEach((b: any, index: number) => {
    out.push(ev({ type: "content_block_start", index, content_block: b.type === "tool_use" ? { ...b, input: {} } : b }));
    if (b.type === "tool_use") out.push(ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } }));
    out.push(ev({ type: "content_block_stop", index }));
  });
  out.push(ev({ type: "message_delta", delta: { stop_reason: m.stop_reason }, usage: { output_tokens: m.usage?.output_tokens } }), ev({ type: "message_stop" }));
  return out;
}

// The reading against the file's entry of expected.json.
export function compareReading(r: ProviderResult, want: any) {
  if (!want) throw fail("expected.json has no entry for this file");
  const text = r.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("");
  const thought = r.blocks.filter((b) => b.type === "thinking").map((b: any) => b.thinking).join("");
  const calls = (r.blocks.filter((b) => b.type === "tool_use") as any[]).map((c) => ({ id: c.id, name: c.name, arguments: c.input, ...(c.signature ? { thought_signature: c.signature } : {}) }));
  const u = r.usage;
  const got = {
    text, thought, tool_calls: calls, stop_reason: r.stop,
    usage: { input_tokens: u.input + u.cache_read + u.cache_write, output_tokens: u.output, cache_read_tokens: u.cache_read, cache_write_tokens: u.cache_write },
  };
  const exp = {
    text: want.text, thought: want.thought ?? "",
    tool_calls: want.tool_calls.map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments, ...(c.thought_signature ? { thought_signature: c.thought_signature } : {}) })),
    stop_reason: want.stop_reason,
    usage: { input_tokens: want.usage.input_tokens, output_tokens: want.usage.output_tokens, cache_read_tokens: want.usage.cache_read_tokens, cache_write_tokens: want.usage.cache_write_tokens },
  };
  for (const k of Object.keys(exp) as (keyof typeof exp)[]) {
    if (JSON.stringify(got[k]) !== JSON.stringify(exp[k])) throw fail(`Keel reads \`${k}\` as ${JSON.stringify(got[k])} where expected.json says ${JSON.stringify(exp[k])}`);
  }
}
