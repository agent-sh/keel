// Traces: one per turn, with a span for the turn, each model request attempt
// and each tool call, the way OpenTelemetry's GenAI conventions shape agents
// (invoke_agent, chat, execute_tool). A span holds the request's shape (never
// its words), what the wire saw (status, the provider's request id, timings)
// and the failure. A failed request also keeps the request itself, gzipped, so
// it can be sent again (replay). The trace id is the turn's turn_start event
// id, so an error that names its turn names its trace. Kept SPAN_DAYS days.
import { conceal } from "../core/conceal.ts";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Bus } from "../core/bus.ts";
import { errorScope } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Message, Session, ToolResultBlock } from "../core/types.ts";
import { registerHooks } from "../engine/hooks.ts";
import { errorText } from "../engine/retry.ts";
import type { ProviderRequest, ProviderResult } from "../providers/types.ts";
import { redactHeaders, type Wire, wireOf } from "../providers/wiretap.ts";
import { errorClass } from "./classes.ts";
import { newestTurn } from "./marks.ts";

export type SpanKind = "turn" | "request" | "tool";
export type SpanStatus = "running" | "ok" | "error" | "interrupted";
export type Span = {
  span_id: string;
  trace_id: string;
  parent_id: string | null;
  session_id: string;
  kind: SpanKind;
  name: string;
  start_ms: number;
  end_ms: number | null;
  status: SpanStatus;
  error: string | null;
  error_type: string | null;
  error_id: string | null;
  attrs: Record<string, any>;
  replayable: boolean;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_id TEXT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  error_type TEXT,
  error_id TEXT,
  attrs TEXT NOT NULL,
  request BLOB
);
CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace_id, start_ms);
CREATE INDEX IF NOT EXISTS spans_session ON spans(session_id, start_ms);
CREATE INDEX IF NOT EXISTS spans_start ON spans(start_ms);
`;

export const SPAN_DAYS = 14;
// How many traces a list returns: when the caller names no number, and at most.
export const TRACE_LIST = 50;
export const TRACE_LIST_MAX = 200;
// A request larger than this as UTF-8 (images inline) is not kept for replay.
export const KEEP_REQUEST_BYTES = 16 * 1024 * 1024;

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
export const traceIdOf = (turnEvent: string) => turnEvent.replace(/-/g, "").toLowerCase();
export const turnSpanId = (traceId: string) => traceId.slice(16);
export const newSpanId = () => hex(8);
// A tool call's span id comes from its call, so a subagent the call starts can
// name it as its parent before the call has ended.
export const toolSpanId = (sessionId: string, callId: string) => new Bun.CryptoHasher("sha256").update(`${sessionId}\0${callId}`).digest("hex").slice(0, 16);

// W3C trace context: `00-<trace id>-<parent span id>-<flags>`.
export const traceparent = (trace: string, span: string) => `00-${trace}-${span}-01`;
export function parseTraceparent(v: unknown): { trace: string; span: string } | null {
  const m = typeof v === "string" ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(v) : null;
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { trace: m[1]!, span: m[2]! };
}

export type Place = { trace: string; span: string; parent: string | null; links: { trace_id: string; span_id: string }[] };
// Where a turn's span sits. A turn's span id always comes from its turn_start
// event. A plain turn is the root of its own trace. The turn a spawn call
// started is a child of that call in the parent's trace (the call starts it
// and it is the call's work), so one trace holds the parent turn, the call and
// the child's turn. A later turn of the same child (a message woke it) runs on
// its own time: its own trace, with a link to the call, as OpenTelemetry links
// asynchronous work to what caused it.
export function turnPlace(turnEvent: string, spawn: { trace: string; span: string } | null, first: boolean): Place {
  const own = traceIdOf(turnEvent);
  const span = turnSpanId(own);
  if (!spawn) return { trace: own, span, parent: null, links: [] };
  if (first) return { trace: spawn.trace, span, parent: spawn.span, links: [] };
  return { trace: own, span, parent: null, links: [{ trace_id: spawn.trace, span_id: spawn.span }] };
}

type Turn = { id: string; ts: number; seq: number };

// Where a session's turn sits, read from its events: a subagent's task prompt
// carries the context of the spawn call that started it. A turn that never
// ran (stopped while it was set up, or closed unstarted when the daemon came
// back: a turn_start with its turn_end right after it, of no length) is not
// the agent's first turn; the first one that ran is.
// Kept by turn: what is before a turn does not change once it has started.
// The task prompt is kept by session for the same reason, and is looked for
// only in a session an agent call started: every other session has none, and
// finding that out would read all its prompts at each new turn.
const places = new Map<string, Place>();
const tasks = new Map<string, { seq: number; tp: string } | null>();
export function placeOf(store: Store, sessionId: string, turn: Pick<Turn, "id" | "seq">): Place {
  const hit = places.get(turn.id);
  if (hit) return hit;
  let task = tasks.get(sessionId);
  if (task === undefined) {
    // `null`: the daemon's sessions say who started them, and this one says nobody did.
    task = store.session(sessionId)?.parent_id === null ? null : store.db.query<{ seq: number; tp: string }, [string]>(
      "SELECT seq, json_extract(data, '$.traceparent') AS tp FROM events WHERE session_id = ? AND kind = 'user' AND json_extract(data, '$.traceparent') IS NOT NULL ORDER BY seq LIMIT 1",
    ).get(sessionId);
    if (tasks.size > 500) tasks.clear();
    tasks.set(sessionId, task);
  }
  const spawn = task && task.seq < turn.seq ? parseTraceparent(task.tp) : null;
  const first = !!spawn && !store.db.query(
    `SELECT 1 FROM events t WHERE t.session_id = ? AND t.kind = 'turn_start' AND t.seq > ? AND t.seq < ?
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = t.session_id AND e.seq = t.seq + 1 AND e.kind = 'turn_end' AND e.parent = t.id
         AND (json_extract(e.data, '$.unstarted') OR json_extract(e.data, '$.ms') = 0))
     LIMIT 1`).get(sessionId, task!.seq, turn.seq);
  const p = turnPlace(turn.id, spawn, first);
  if (places.size > 500) places.clear();
  places.set(turn.id, p);
  return p;
}

// The context a spawn call hands the session it starts: the call's span, in
// the trace the calling turn really sits in. That is the turn's own trace for
// a plain turn and an ancestor's for the first turn of a spawned agent, so a
// chain of spawns stays in the trace of the turn that started the first one.
export function spawnContext(store: Store, sessionId: string, callId: string): string | null {
  const turn = newestTurn(store, sessionId);
  return turn ? traceparent(placeOf(store, sessionId, turn).trace, toolSpanId(sessionId, callId)) : null;
}

// What a request carries, by count and size, never its text. Bytes are UTF-8
// bytes of the JSON, as they go on the wire, not UTF-16 units of the string.
export function requestShape(req: Pick<ProviderRequest, "system" | "messages" | "tools" | "effort" | "maxTokens" | "purpose" | "speed">) {
  const roles: Record<string, number> = {};
  const blocks: Record<string, number> = {};
  let bytes = 0;
  for (const m of req.messages) {
    roles[m.role] = (roles[m.role] ?? 0) + 1;
    const content = Array.isArray(m.content) ? m.content : [{ type: "text" }];
    for (const b of content as any[]) blocks[b.type] = (blocks[b.type] ?? 0) + 1;
    bytes += Buffer.byteLength(JSON.stringify(m.content));
  }
  const last = req.messages.at(-1);
  return {
    purpose: req.purpose ?? "turn",
    system_chars: req.system.length,
    messages: req.messages.length,
    roles,
    blocks,
    message_bytes: bytes,
    last_message: last ? { role: last.role, blocks: Array.isArray(last.content) ? (last.content as any[]).map((b) => b.type) : ["text"] } : null,
    tools: req.tools.length,
    effort: req.effort ?? null,
    max_tokens: req.maxTokens ?? null,
    speed: req.speed ?? null,
  };
}

// What came back, by kind: the stop reason, the usage, the blocks and tool calls.
export function resultShape(res: ProviderResult) {
  const blocks: Record<string, number> = {};
  for (const b of res.blocks) blocks[b.type] = (blocks[b.type] ?? 0) + 1;
  return {
    response_model: res.model,
    stop: res.stop,
    ...(res.stop_details ? { stop_details: res.stop_details } : {}),
    usage: res.usage,
    blocks,
    tool_calls: res.blocks.filter((b: any) => b.type === "tool_use").map((b: any) => b.name),
    ...(res.served ? { served: res.served } : {}),
  };
}

const row = (r: any): Span => ({
  span_id: r.span_id, trace_id: r.trace_id, parent_id: r.parent_id ?? null, session_id: r.session_id, kind: r.kind, name: r.name,
  start_ms: r.start_ms, end_ms: r.end_ms ?? null, status: r.status, error: r.error ?? null, error_type: r.error_type ?? null,
  error_id: r.error_id ?? null, attrs: JSON.parse(r.attrs), replayable: !!r.replayable,
});
// A retry sends the same request object again: its bytes are kept once, on the first failed attempt, and later attempts point there.
// The pointer alone does not make a retry replayable: the span it names can age out first, and its bytes go with it.
const COLS = "span_id, trace_id, parent_id, session_id, kind, name, start_ms, end_ms, status, error, error_type, error_id, attrs, (request IS NOT NULL OR EXISTS (SELECT 1 FROM spans AS kept WHERE kept.span_id = json_extract(spans.attrs, '$.request_in') AND kept.request IS NOT NULL)) AS replayable";

type Open = { span: string; trace: string; t0: number; first?: number; attempt: number };

export class Tracer {
  private open = new WeakMap<ProviderRequest, Open>();
  private attempts = new WeakMap<ProviderRequest, number>();
  private kept = new WeakMap<ProviderRequest, string>();
  // Each span as it ends (the OTLP exporter listens).
  private ended = new Set<(s: Span) => void>();

  constructor(private store: Store, bus: Bus, private isRunning: (id: string) => boolean) {
    store.migrate(SCHEMA);
    // A span still running when the daemon stopped did not end on its own.
    store.db.run("UPDATE spans SET status = 'interrupted', end_ms = COALESCE(end_ms, start_ms) WHERE status = 'running'");
    this.prune();
    // Failure text an older build kept as it was: anything that reads as a secret becomes a placeholder.
    for (const r of store.db.query<{ span_id: string; error: string }, []>("SELECT span_id, error FROM spans WHERE error IS NOT NULL").all()) {
      const shown = conceal(r.error);
      if (shown !== r.error) store.db.run("UPDATE spans SET error = ? WHERE span_id = ?", [shown, r.span_id]);
    }
    // The error row a failed span became: linked both ways.
    bus.on((f) => {
      if (f.t === "error" && f.error.span_id) store.db.run("UPDATE spans SET error_id = ? WHERE span_id = ?", [f.error.id, f.error.span_id]);
    });
    registerHooks({
      requestSent: (s, req) => this.sent(s, req),
      requestDelta: (_s, req) => {
        const o = this.open.get(req);
        if (o && !o.first) o.first = Date.now();
      },
      requestDone: (_s, req, res) => this.done(req, res),
      requestFailed: (_s, req, err, aborted) => this.failed(req, err, aborted),
      toolRan: (s, call, result, ran) => this.tool(s, call.id, call.tool.name, call.input, result, ran),
      turnEnd: (s, reason) => this.turnEnd(s, reason),
    });
  }

  onEnd(f: (s: Span) => void) {
    this.ended.add(f);
    return () => void this.ended.delete(f);
  }

  prune() {
    this.store.db.run("DELETE FROM spans WHERE start_ms < ?", [Date.now() - SPAN_DAYS * 86_400_000]);
  }

  // The turn a request or tool call belongs to: its turn_start event. The
  // engine's scope names the turn the code runs in, and none once that turn is
  // over, so a summary a turn left behind is in no turn when it is sent during
  // the next one. Code the engine did not start (a call from the HTTP API) is
  // in the open turn of a running session.
  private turnOf(s: Session, purpose: string): Turn | null {
    if (purpose === "side") return null;
    const scope = errorScope.getStore();
    if (scope?.session === s.id) return scope.turn ? this.store.db.query<Turn, [string, string]>("SELECT id, ts, seq FROM events WHERE id = ? AND session_id = ? AND kind = 'turn_start'").get(scope.turn, s.id) : null;
    return this.isRunning(s.id) ? this.lastTurn(s.id) : null;
  }

  private lastTurn(sessionId: string): Turn | null {
    return newestTurn(this.store, sessionId);
  }

  place(sessionId: string, turn: Turn): Place {
    return placeOf(this.store, sessionId, turn);
  }

  // The trace context of a session's open turn (for TRACEPARENT in its commands).
  context(sessionId: string): { trace: string; span: string } | null {
    const turn = this.lastTurn(sessionId);
    return turn ? this.place(sessionId, turn) : null;
  }

  private ensureTurn(s: Session, turn: Turn) {
    const p = this.place(s.id, turn);
    this.store.db.run(
      "INSERT OR IGNORE INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, status, attrs) VALUES (?, ?, ?, ?, 'turn', 'invoke_agent', ?, 'running', ?)",
      [p.span, p.trace, p.parent, s.id, turn.ts, JSON.stringify({ turn_event: turn.id, model: s.model, ...(s.parent_id ? { parent_session: s.parent_id } : {}), ...(p.links.length ? { links: p.links } : {}) })],
    );
    return { trace: p.trace, span: p.span };
  }

  private sent(s: Session, req: ProviderRequest) {
    const purpose = req.purpose ?? "turn";
    const turn = this.turnOf(s, purpose);
    const parent = turn ? this.ensureTurn(s, turn) : null;
    const trace = parent?.trace ?? hex(16);
    const span = newSpanId();
    const attempt = (this.attempts.get(req) ?? 0) + 1;
    this.attempts.set(req, attempt);
    const t0 = Date.now();
    this.open.set(req, { span, trace, t0, attempt });
    const model = req.route ?? `${s.model}`;
    this.store.db.run(
      "INSERT INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, status, attrs) VALUES (?, ?, ?, ?, 'request', ?, ?, 'running', ?)",
      [span, trace, parent?.span ?? null, s.id, `chat ${req.model}`, t0, JSON.stringify({ route: model, model: req.model, attempt, ...(turn ? { turn_event: turn.id } : {}), shape: requestShape(req) })],
    );
  }

  private finish(span: string, patch: { status: SpanStatus; error?: string | null; error_type?: string | null; attrs?: Record<string, unknown>; request?: Uint8Array | null }) {
    const cur = this.store.db.query<{ attrs: string }, [string]>("SELECT attrs FROM spans WHERE span_id = ?").get(span);
    if (!cur) return;
    const attrs = { ...JSON.parse(cur.attrs), ...(patch.attrs ?? {}) };
    this.store.db.run("UPDATE spans SET end_ms = ?, status = ?, error = ?, error_type = ?, attrs = ?, request = COALESCE(?, request) WHERE span_id = ?", [
      Date.now(), patch.status, patch.error ?? null, patch.error_type ?? null, JSON.stringify(attrs), patch.request ?? null, span,
    ]);
    this.emitEnd(span);
  }

  private emitEnd(span: string) {
    if (!this.ended.size) return;
    const s = this.span(span);
    if (s) for (const f of this.ended) try { f(s); } catch {}
  }

  private wireAttrs(req: ProviderRequest, o: Open): Record<string, unknown> {
    const w: Wire | undefined = wireOf.get(req);
    return { ...(w && Object.keys(w).length ? { wire: w } : {}), ...(o.first ? { ttft_ms: o.first - o.t0 } : {}) };
  }

  private done(req: ProviderRequest, res: ProviderResult) {
    const o = this.open.get(req);
    if (!o) return;
    this.open.delete(req);
    const refused = res.stop === "refusal";
    this.finish(o.span, { status: refused ? "error" : "ok", error: refused ? res.stop_details?.explanation ?? "refusal" : null, error_type: refused ? "refusal" : null, attrs: { ...this.wireAttrs(req, o), result: resultShape(res) } });
  }

  private failed(req: ProviderRequest, err: unknown, aborted: boolean) {
    const o = this.open.get(req);
    if (!o) return;
    this.open.delete(req);
    if (err && typeof err === "object") try { Object.assign(err, { span_id: o.span, trace_id: o.trace }); } catch {}
    const e = err as any;
    const type = aborted ? "cancelled" : errorClass(err) ?? e?.kind ?? e?.name ?? "error";
    const prior = this.kept.get(req);
    const packed = aborted || prior ? null : packRequest(req);
    if (packed) this.kept.set(req, o.span);
    this.finish(o.span, {
      status: aborted ? "interrupted" : "error",
      error: aborted ? null : conceal(errorText(err).slice(0, 4000)),
      error_type: type,
      attrs: { ...this.wireAttrs(req, o), ...(e?.status ? { http_status: e.status } : {}), ...(e?.kind ? { error_kind: e.kind } : {}), ...(e?.retryAfterMs ? { retry_after_ms: e.retryAfterMs } : {}), ...(prior && !aborted ? { request_in: prior } : {}) },
      request: packed,
    });
  }

  private tool(s: Session, callId: string, name: string, input: unknown, result: ToolResultBlock, ran: { ms: number; outcome: "ok" | "error" | "interrupted"; error?: Error }) {
    const turn = this.turnOf(s, "turn");
    const parent = turn ? this.ensureTurn(s, turn) : null;
    const span = toolSpanId(s.id, callId);
    const trace = parent?.trace ?? hex(16);
    const now = Date.now();
    // What the tool threw names this span, as a failed request does, unless a
    // request that failed inside the call already named its own (the closer cause).
    const named = (ran.error as { span_id?: unknown } | undefined)?.span_id;
    const inner = typeof named === "string" && this.store.db.query("SELECT 1 FROM spans WHERE span_id = ? AND kind = 'request' AND start_ms >= ?").get(named, now - ran.ms);
    if (ran.error && !inner) try { Object.assign(ran.error, { span_id: span, trace_id: trace }); } catch {}
    const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    const inputJson = JSON.stringify(input ?? {});
    this.store.db.run(
      "INSERT OR REPLACE INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, end_ms, status, error, error_type, attrs) VALUES (?, ?, ?, ?, 'tool', ?, ?, ?, ?, ?, ?, ?)",
      [span, trace, parent?.span ?? null, s.id, `execute_tool ${name}`, now - ran.ms, now, ran.outcome, ran.outcome === "error" ? conceal(content.slice(0, 1000), s.id) : null,
        ran.outcome === "error" ? "tool_error" : null,
        JSON.stringify({ tool: name, call_id: callId, input_keys: input && typeof input === "object" ? Object.keys(input) : [], input_bytes: Buffer.byteLength(inputJson), result_bytes: Buffer.byteLength(content), ...(turn ? { turn_event: turn.id } : {}) })],
    );
    this.emitEnd(span);
  }

  private turnEnd(s: Session, reason: string) {
    const turn = this.lastTurn(s.id);
    if (!turn) return;
    const { span } = this.ensureTurn(s, turn);
    // A turn the model declined did not do its work: failed, as its declined request is.
    const declined = reason === "refusal";
    const status: SpanStatus = reason === "error" || declined ? "error" : reason === "interrupted" || reason === "restart" ? "interrupted" : "ok";
    const fail = status === "error" ? this.store.db.query<{ error: string; error_type: string }, [string]>("SELECT error, error_type FROM spans WHERE parent_id = ? AND status = 'error' ORDER BY start_ms DESC LIMIT 1").get(span) : null;
    this.finish(span, { status, error: fail?.error ?? (declined ? "refusal" : null), error_type: fail?.error_type ?? (declined ? "refusal" : status === "error" ? "error" : null), attrs: { reason } });
  }

  span(id: string): Span | undefined {
    const r = this.store.db.query<any, [string]>(`SELECT ${COLS} FROM spans WHERE span_id = ?`).get(id);
    return r ? row(r) : undefined;
  }

  // A trace's spans. A turn's own id (its turn_start without dashes) also finds
  // it when the turn sits in another trace: a subagent's first turn is in its parent's.
  trace(traceId: string): Span[] {
    const all = (id: string) => this.store.db.query<any, [string]>(`SELECT ${COLS} FROM spans WHERE trace_id = ? ORDER BY start_ms, rowid`).all(id).map(row);
    const spans = all(traceId);
    if (spans.length || traceId.length !== 32) return spans;
    const host = this.store.db.query<{ trace_id: string }, [string]>("SELECT trace_id FROM spans WHERE span_id = ? AND kind = 'turn'").get(turnSpanId(traceId));
    return host ? all(host.trace_id) : [];
  }

  // A session's traces, newest first: the span of each turn (a subagent's first
  // turn sits under its spawn call), or the lone request of a side answer.
  // Never more than TRACE_LIST_MAX, whatever the caller asks for.
  traces(sessionId: string, limit = TRACE_LIST): Span[] {
    const n = Number.isFinite(limit) ? Math.min(TRACE_LIST_MAX, Math.max(1, Math.trunc(limit))) : TRACE_LIST;
    return this.store.db.query<any, [string, number]>(`SELECT ${COLS} FROM spans WHERE session_id = ? AND (parent_id IS NULL OR kind = 'turn') ORDER BY start_ms DESC LIMIT ?`).all(sessionId, n).map(row);
  }

  // The request a failed span sent, as sent.
  request(spanId: string): ProviderRequest | undefined {
    const r = this.store.db.query<{ request: Uint8Array | null; at: string | null }, [string]>("SELECT request, json_extract(attrs, '$.request_in') AS at FROM spans WHERE span_id = ?").get(spanId);
    if (!r?.request) return r?.at ? this.request(r.at) : undefined;
    return JSON.parse(gunzipSync(r.request).toString("utf8"));
  }

  // A replay: recorded as its own request span in its own trace, pointing at the original.
  recordReplay(of: Span, route: string, t0: number, out: { ok: boolean; error?: string; error_type?: string; result?: ProviderResult; wire?: Wire; ttft?: number }) {
    const span = newSpanId();
    this.store.db.run(
      "INSERT INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, end_ms, status, error, error_type, attrs) VALUES (?, ?, NULL, ?, 'request', ?, ?, ?, ?, ?, ?, ?)",
      [span, hex(16), of.session_id, `chat ${route.split(":").slice(1).join(":") || route}`, t0, Date.now(), out.ok ? "ok" : "error", out.error ?? null, out.error_type ?? null,
        JSON.stringify({ route, replay_of: of.span_id, shape: of.attrs.shape, ...(out.wire && Object.keys(out.wire).length ? { wire: out.wire } : {}), ...(out.ttft ? { ttft_ms: out.ttft } : {}), ...(out.result ? { result: resultShape(out.result) } : {}) })],
    );
    this.emitEnd(span);
    return this.span(span)!;
  }
}

// The request without its signal and callbacks, gzipped; extra headers keep their names only.
export function packRequest(req: ProviderRequest): Uint8Array | null {
  const { signal: _s, onHeaders: _h, ...rest } = req;
  const body = JSON.stringify({ ...rest, ...(rest.extraHeaders ? { extraHeaders: redactHeaders(rest.extraHeaders) } : {}) });
  return Buffer.byteLength(body) > KEEP_REQUEST_BYTES ? null : gzipSync(body);
}

export type { Message };
