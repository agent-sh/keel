// Traces: one per turn, with a span for the turn, each model request attempt
// and each tool call, the way OpenTelemetry's GenAI conventions shape agents
// (invoke_agent, chat, execute_tool). A span holds the request's shape (never
// its words), what the wire saw (status, the provider's request id, timings)
// and the failure. A failed request also keeps the request itself, gzipped, so
// it can be sent again (replay). The trace id is the turn's turn_start event
// id, so an error that names its turn names its trace. Kept SPAN_DAYS days.
import { scrubbed } from "../core/conceal.ts";
import { fromSaid, type AnsweredBy } from "../safety/card.ts";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Bus } from "../core/bus.ts";
import { errorScope } from "../core/errors.ts";
import { messageFacts } from "../core/message-facts.ts";
import type { Store } from "../core/store.ts";
import type { Message, Session, ToolResultBlock } from "../core/types.ts";
import { registerHooks } from "../engine/hooks.ts";
import { errorText } from "../engine/retry.ts";
import { reportedUsage } from "../providers/reported.ts";
import type { ProviderRequest, ProviderResult } from "../providers/types.ts";
import { redactHeaders, type Wire, wireOf } from "../providers/wiretap.ts";
import { errorClass } from "./classes.ts";
import { wentDownAt } from "./life.ts";
import { newestTurn } from "./marks.ts";

// `wait`: time of a turn that is no request and no tool run (a retry's wait,
// an approval card open, a compaction, a prompt in the queue). Its name says which.
export type SpanKind = "turn" | "request" | "tool" | "wait";
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
-- The few spans still running: a start closes the ones the daemon before it left, without reading every span.
CREATE INDEX IF NOT EXISTS spans_running ON spans(start_ms) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS spans_owed (span_id TEXT PRIMARY KEY, first INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS trace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
// The scrub the stored failure texts were last passed through (conceal.ts): raised when its rules change.
const SCRUB_VERSION = "2";

// What a failed turn failed of: its newest failed step, among the spans of its
// trace (a turn's steps are in its trace). By its parent alone this was a pass
// over every span, newest first, on the loop: seconds for a turn whose failure
// left no failed step (a request refused before it was sent).
export const TURN_FAILURE_SQL = "SELECT error, error_type FROM spans WHERE trace_id = ? AND parent_id = ? AND status = 'error' ORDER BY start_ms DESC LIMIT 1";

export const SPAN_DAYS = 14;
// The spans owed at a start, oldest first. Without CROSS JOIN, SQLite reads every span in the
// order of its start (spans_start) to look each one up among the few owed, and skips the sort:
// seconds on a store of two weeks of spans with their requests, before the daemon listens.
export const OWED_AT_START = "SELECT o.span_id, o.first FROM spans_owed o CROSS JOIN spans s ON s.span_id = o.span_id ORDER BY s.start_ms";
// A prompt that waited in the queue this long has that wait in its turn's trace; a shorter one is no wait to speak of.
const QUEUE_WAIT_MS = 1000;
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
// One row of a span is written for every request, so only what a reader asks for is kept: the
// roles (the two alternate: the count of messages says them) and the last message's blocks are not,
// and a setting the request did not set is left out.
export function requestShape(req: Pick<ProviderRequest, "system" | "messages" | "tools" | "effort" | "maxTokens" | "purpose" | "speed">) {
  const blocks: Record<string, number> = {};
  let bytes = 0;
  for (const m of req.messages) {
    const content = Array.isArray(m.content) ? m.content : [{ type: "text" }];
    for (const b of content as any[]) blocks[b.type] = (blocks[b.type] ?? 0) + 1;
    bytes += messageFacts(m).contentBytes;
  }
  return {
    purpose: req.purpose ?? "turn",
    system_chars: req.system.length,
    messages: req.messages.length,
    blocks,
    message_bytes: bytes,
    tools: req.tools.length,
    ...(req.effort ? { effort: req.effort } : {}),
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.speed ? { speed: req.speed } : {}),
  };
}

// What came back: the stop reason, the usage and the tool calls (the blocks' counts are the text and the calls).
export function resultShape(res: ProviderResult) {
  return {
    response_model: res.model,
    stop: res.stop,
    ...(res.stop_details ? { stop_details: res.stop_details } : {}),
    usage: res.usage,
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
  // A request sent again for a failed span, and the span its measured send made.
  private replays = new WeakMap<ProviderRequest, string>();
  private made = new WeakMap<ProviderRequest, string>();
  private kept = new WeakMap<ProviderRequest, string>();
  // Each span as it ends (the OTLP exporter listens).
  private ended = new Map<(s: Span) => void, (() => boolean) | undefined>();
  // The waits open now, by what they wait on: a session's retry or compaction, an approval card.
  private waits = new Map<string, string>();
  // The attributes of the spans written as running (a request, a wait), until each ends: its end is
  // then written without reading the row back, so nothing of a step asks for the side rows that
  // wait (src/core/side.ts) to be written before their commit. `turnMade`: the turn whose span is
  // written, by session.
  private running = new Map<string, Record<string, unknown>>();
  private turnMade = new Map<string, string>();
  private born = Date.now();
  private later(what: string, sql: string, params: unknown[]) {
    this.store.side.later(what, () => void this.store.db.run(sql, params as any[]));
  }
  private began(span: string, attrs: Record<string, unknown>) {
    if (this.running.size > 10_000) this.running.clear();
    this.running.set(span, JSON.parse(JSON.stringify(attrs)));
    return JSON.stringify(attrs);
  }
  // When each queued prompt joined its queue, from the queue's own frames, until its turn starts.
  private queued = new Map<string, number>();

  constructor(private store: Store, bus: Bus, private isRunning: (id: string) => boolean) {
    store.migrate(SCHEMA);
    // A span still running when the daemon stopped did not end on its own: it
    // ran until the daemon went down, when that is known (src/admin/life.ts).
    // The ones a daemon before this process left (they began before it did) are owed to whoever exports
    // spans: a collector that got their children gets them too, closed as interrupted. Owed in the
    // store, not in this process: a daemon that goes down again before the collector took them
    // still owes them at its next start (owedAtStart, exported).
    const left = store.db.query<{ span_id: string }, [number]>("SELECT span_id FROM spans WHERE status = 'running' AND start_ms < ? ORDER BY start_ms").all(Math.floor(performance.timeOrigin)).map((r) => r.span_id);
    store.db.transaction(() => {
      const owe = store.db.query("INSERT OR IGNORE INTO spans_owed (span_id, first) VALUES (?, 1)");
      for (const id of left) owe.run(id);
      store.db.run("UPDATE spans SET status = 'interrupted', end_ms = COALESCE(end_ms, MAX(start_ms, ?)) WHERE status = 'running'", [wentDownAt() ?? 0]);
    })();
    this.prune();
    // Failure text an older build kept as it was: anything that reads as a secret becomes a placeholder.
    // Once per version of the scrub, not at every start: new text is scrubbed where it is captured.
    if (store.db.query<{ value: string }, []>("SELECT value FROM trace_meta WHERE key = 'scrubbed'").get()?.value !== SCRUB_VERSION) {
      store.db.transaction(() => {
        for (const r of store.db.query<{ span_id: string; error: string }, []>("SELECT span_id, error FROM spans WHERE error IS NOT NULL").all()) {
          const shown = scrubbed(r.error);
          if (shown !== r.error) store.db.run("UPDATE spans SET error = ? WHERE span_id = ?", [shown, r.span_id]);
        }
        store.db.run("INSERT OR REPLACE INTO trace_meta (key, value) VALUES ('scrubbed', ?)", [SCRUB_VERSION]);
      })();
    }
    // The error row a failed span became: linked both ways.
    bus.on((f) => {
      if (f.t === "error" && f.error.span_id) store.db.run("UPDATE spans SET error_id = ? WHERE span_id = ?", [f.error.id, f.error.span_id]);
    });
    // What a turn waits on between its requests and tools, from the daemon's
    // own frames: the wait before a retry, a compaction, an approval card.
    bus.on((f) => {
      try {
        if (f.t === "queue") {
          for (const q of f.queue) if (!this.queued.has(q.id)) this.queued.set(q.id, q.created);
          if (this.queued.size > 2000) this.queued.clear();
        } else if (f.t === "status") {
          const key = `step:${f.session_id}`;
          this.endWait(key);
          // A provider that cannot be reached is waited for, not retried by count: a wait of its own name.
          if (f.status.kind === "retry" && f.status.unreachable) this.wait(f.session_id, key, "provider wait", { since: f.status.unreachable });
          else if (f.status.kind === "retry") this.wait(f.session_id, key, "retry wait", { attempt: f.status.attempt, max: f.status.max });
          else if (f.status.kind === "compacting") this.wait(f.session_id, key, "compaction", { auto: f.status.auto });
        } else if (f.t === "feature" && f.name === "heavy" && f.data?.key) {
          // A command that waits for a heavy-command slot (src/tools/heavy.ts): the wait is the turn's.
          const h = f.data as { key: string; session_id: string; state: string; pattern?: string; call_id?: string; waited_ms?: number };
          const key = `heavy:${h.key}`;
          if (h.state === "waiting") this.wait(h.session_id, key, "slot wait", { pattern: h.pattern, call_id: h.call_id });
          else this.endWait(key, { outcome: h.state === "started" ? "started" : "stopped", waited_ms: h.waited_ms });
        } else if (f.t === "feature" && f.name === "approval" && f.data?.id) {
          const a = f.data as { id: string; session_id: string; state: string; tool?: string; risk?: string; call_id?: string; choice?: string; by?: AnsweredBy };
          const key = `approval:${a.id}`;
          if (a.state === "pending") this.wait(a.session_id, key, "approval wait", { tool: a.tool, risk: a.risk, call_id: a.call_id, approval_id: a.id });
          else this.endWait(key, { answer: a.state, ...(a.choice ? { choice: a.choice } : {}), ...(a.by ? { from: fromSaid(a.by) } : {}) });
        }
      } catch {
        // A wait that could not be recorded is a gap in a trace, never a failure of the turn.
      }
    });
    registerHooks({
      requestSent: (s, req) => this.sent(s, req),
      requestDelta: (_s, req) => {
        const o = this.open.get(req);
        if (o && !o.first) o.first = Date.now();
      },
      requestDone: (_s, req, res) => this.done(req, res),
      requestWaiting: (_s, req) => {
        const o = this.open.get(req);
        if (!o) return;
        this.open.delete(req);
        this.attempts.set(req, o.attempt - 1);
        this.finish(o.span, { status: "interrupted", attrs: { ...this.wireAttrs(req, o), provider_wait: true } });
      },
      requestFailed: (_s, req, err, aborted) => this.failed(req, err, aborted),
      toolRan: (s, call, result, ran) => this.tool(s, call.id, call.tool.name, call.input, result, ran, call.hook),
      turnEnd: (s, reason) => this.turnEnd(s, reason),
    });
  }

  // The spans daemons before this one left running, closed as interrupted, that no collector has
  // taken yet: the ones this start closed (`first`: counted in the metrics once) and the ones an
  // earlier start owed and went down before a batch with them was answered. Handed out once per
  // process; they stay owed until `exported` says a collector took them, or `forget` that there is none.
  private handed = false;
  owedAtStart(): { span: Span; first: boolean }[] {
    if (this.handed) return [];
    this.handed = true;
    // A span that was pruned meanwhile is owed to nobody.
    this.store.db.run("DELETE FROM spans_owed WHERE span_id NOT IN (SELECT span_id FROM spans)");
    const rows = this.store.db.query<{ span_id: string; first: number }, []>(OWED_AT_START).all();
    this.store.db.run("UPDATE spans_owed SET first = 0");
    this.owed = rows.length;
    return rows.map((r) => ({ span: this.span(r.span_id), first: !!r.first })).filter((x): x is { span: Span; first: boolean } => !!x.span);
  }
  // How many are owed, known without a read: the exporter says this of every batch it sends.
  private owed = 0;
  // A collector took these spans: the owed ones among them are owed no more.
  exported(ids: string[]) {
    if (!this.owed || !ids.length) return;
    const del = this.store.db.query("DELETE FROM spans_owed WHERE span_id = ?");
    this.store.db.transaction(() => { for (const id of ids) this.owed -= del.run(id).changes; })();
    this.owed = Math.max(0, this.owed);
  }
  // No collector is set: nothing got their children, so nothing is owed.
  forget() {
    this.store.db.run("DELETE FROM spans_owed");
    this.owed = 0;
  }

  // `wanted`: whether the listener takes spans right now (an exporter with nowhere to send takes none):
  // a span that nobody takes is not read back when it ends.
  onEnd(f: (s: Span) => void, wanted?: () => boolean) {
    this.ended.set(f, wanted);
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
    if (purpose === "side" || purpose === "sampling" || purpose === "title" || purpose === "judge") return null;
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
    if (this.turnMade.get(s.id) === turn.id) return { trace: p.trace, span: p.span };
    if (this.turnMade.size > 2_000) this.turnMade.clear();
    this.turnMade.set(s.id, turn.id);
    const attrs = { turn_event: turn.id, model: s.model, ...(s.parent_id ? { parent_session: s.parent_id } : {}), ...(p.links.length ? { links: p.links } : {}) };
    const sql = "INSERT OR IGNORE INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, status, attrs) VALUES (?, ?, ?, ?, 'turn', 'invoke_agent', ?, 'running', ?)";
    const row = [p.span, p.trace, p.parent, s.id, turn.ts, JSON.stringify(attrs)];
    // A turn that began under this tracer has no span yet (the check above): its row waits with the
    // other side rows. One from before (a turn a restart goes on with) is looked for, as it was.
    const fresh = turn.ts >= this.born;
    if (fresh) this.later("a turn's span", sql, row);
    const made = fresh || this.store.db.run(sql, row).changes > 0;
    // (Written by this call: its attributes are the ones its end goes on from.)
    if (made) this.began(p.span, attrs);
    // A prompt that waited in the queue: that wait is the turn's too, before its first step.
    if (made) {
      const qid = this.store.db.query<{ id: string | null }, [string]>(
        "SELECT u.data ->> '$.queue_id' AS id FROM events t JOIN events u ON u.id = t.parent WHERE t.id = ? AND u.kind = 'user'").get(turn.id)?.id;
      const queued = qid ? this.queued.get(qid) : undefined;
      if (qid) this.queued.delete(qid);
      if (queued !== undefined && turn.ts - queued >= QUEUE_WAIT_MS) {
        this.later("a queue wait's span",
          "INSERT OR IGNORE INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, end_ms, status, attrs) VALUES (?, ?, ?, ?, 'wait', 'queue wait', ?, ?, 'ok', ?)",
          [newSpanId(), p.trace, p.span, s.id, queued, turn.ts, JSON.stringify({ turn_event: turn.id })],
        );
      }
    }
    return { trace: p.trace, span: p.span };
  }

  // A wait of the session's running turn begins. Outside a turn (the owner's
  // own compaction, a card of a call no turn runs) nothing is recorded.
  private wait(sessionId: string, key: string, name: string, attrs: Record<string, unknown>) {
    if (this.waits.has(key) || !this.isRunning(sessionId)) return;
    const s = this.store.session(sessionId);
    const turn = s && this.lastTurn(sessionId);
    if (!s || !turn) return;
    const parent = this.ensureTurn(s, turn);
    const span = newSpanId();
    this.later("a wait's span",
      "INSERT INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, status, attrs) VALUES (?, ?, ?, ?, 'wait', ?, ?, 'running', ?)",
      [span, parent.trace, parent.span, sessionId, name, Date.now(), this.began(span, { ...attrs, turn_event: turn.id })],
    );
    this.waits.set(key, span);
  }

  // A wait of the session's running turn that is already over (an edit's
  // wait for a language server): a span of its own under the turn, with what
  // it cost and what it gave.
  // (`status`: "error" for a wait that failed, a hook that did.)
  waited(sessionId: string, name: string, startMs: number, endMs: number, attrs: Record<string, unknown>, status: "ok" | "error" = "ok") {
    try {
      if (!this.isRunning(sessionId)) return;
      const s = this.store.session(sessionId);
      const turn = s && this.lastTurn(sessionId);
      if (!s || !turn) return;
      const parent = this.ensureTurn(s, turn);
      this.later("a wait's span",
        "INSERT INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, end_ms, status, attrs) VALUES (?, ?, ?, ?, 'wait', ?, ?, ?, ?, ?)",
        [newSpanId(), parent.trace, parent.span, sessionId, name, startMs, endMs, status, JSON.stringify({ ...attrs, turn_event: turn.id })],
      );
    } catch {
      // A wait that could not be recorded is a gap in a trace, never a failure of the turn.
    }
  }

  // The daemon itself did not answer for a while (src/admin/stall.ts): each
  // turn that ran then gets the stall as a span of its own, with what took
  // the time, so a trace with a hole in it says whose hole it was.
  stall(ctx: { ms: number; ended_ms: number; turns?: { session_id: string; turn?: string }[]; cause?: Record<string, unknown> }, what: string, errorId?: string) {
    for (const t of ctx.turns ?? []) {
      const s = this.store.session(t.session_id);
      const turn = s && t.turn ? this.store.db.query<Turn, [string, string]>("SELECT id, ts, seq FROM events WHERE id = ? AND session_id = ? AND kind = 'turn_start'").get(t.turn, s.id) : null;
      if (!s || !turn) continue;
      const parent = this.ensureTurn(s, turn);
      const span = newSpanId();
      this.later("a stall's span",
        "INSERT INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, end_ms, status, error_id, attrs) VALUES (?, ?, ?, ?, 'wait', 'daemon stall', ?, ?, 'ok', ?, ?)",
        [span, parent.trace, parent.span, s.id, Math.round(Math.max(turn.ts, ctx.ended_ms - ctx.ms)), Math.round(ctx.ended_ms), errorId ?? null, JSON.stringify({ turn_event: turn.id, ms: ctx.ms, what, ...(ctx.cause ? { cause: ctx.cause } : {}) })],
      );
      // Ended as it is written: it goes to whatever exports the trace, as a tool's span does.
      this.emitEnd(span);
    }
  }

  private endWait(key: string, attrs?: Record<string, unknown>, status: SpanStatus = "ok") {
    const span = this.waits.get(key);
    if (!span) return;
    this.waits.delete(key);
    this.finish(span, { status, attrs });
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
    this.later("a request's span",
      "INSERT INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, status, attrs) VALUES (?, ?, ?, ?, 'request', ?, ?, 'running', ?)",
      [span, trace, parent?.span ?? null, s.id, `chat ${req.model}`, t0, this.began(span, { route: model, model: req.model, attempt, ...(turn ? { turn_event: turn.id } : {}), ...(this.replays.has(req) ? { replay_of: this.replays.get(req) } : {}), shape: requestShape(req) })],
    );
    this.made.set(req, span);
  }

  private finish(span: string, patch: { status: SpanStatus; error?: string | null; error_type?: string | null; attrs?: Record<string, unknown>; request?: Uint8Array | null }) {
    // (Its attributes as they were written: from memory for a span this daemon began, else read back.)
    const known = this.running.get(span);
    this.running.delete(span);
    const cur = known ?? ((r) => (r ? JSON.parse(r.attrs) : undefined))(this.store.db.query<{ attrs: string }, [string]>("SELECT attrs FROM spans WHERE span_id = ?").get(span));
    if (!cur) return;
    const attrs = { ...cur, ...(patch.attrs ?? {}) };
    this.later("a span's end", "UPDATE spans SET end_ms = ?, status = ?, error = ?, error_type = ?, attrs = ?, request = COALESCE(?, request) WHERE span_id = ?", [
      Date.now(), patch.status, patch.error ?? null, patch.error_type ?? null, JSON.stringify(attrs), patch.request ?? null, span,
    ]);
    this.emitEnd(span);
  }

  private emitEnd(span: string) {
    const takers = [...this.ended].filter(([, wanted]) => !wanted || wanted()).map(([f]) => f);
    if (!takers.length) return;
    const s = this.span(span);
    if (s) for (const f of takers) try { f(s); } catch {}
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
    this.finish(o.span, { status: refused ? "error" : "ok", error: refused ? scrubbed(res.stop_details?.explanation ?? "refusal") : null, error_type: refused ? "refusal" : null, attrs: { ...this.wireAttrs(req, o), result: resultShape(res) } });
  }

  private failed(req: ProviderRequest, err: unknown, aborted: boolean) {
    const o = this.open.get(req);
    if (!o) return;
    this.open.delete(req);
    if (err && typeof err === "object") try { Object.assign(err, { span_id: o.span, trace_id: o.trace }); } catch {}
    const e = err as any;
    const type = aborted ? "cancelled" : errorClass(err) ?? e?.kind ?? e?.name ?? "error";
    const prior = this.kept.get(req);
    // What its stream reported before it ended: the tokens it was billed for, as an answer's span has them.
    const usage = reportedUsage(err);
    const packed = aborted || prior ? null : packRequest(req);
    if (packed) this.kept.set(req, o.span);
    this.finish(o.span, {
      status: aborted ? "interrupted" : "error",
      error: aborted ? null : scrubbed(errorText(err).slice(0, 4000)),
      error_type: type,
      attrs: { ...this.wireAttrs(req, o), ...(e?.status ? { http_status: e.status } : {}), ...(e?.kind ? { error_kind: e.kind } : {}), ...(e?.retryAfterMs ? { retry_after_ms: e.retryAfterMs } : {}), ...(prior && !aborted ? { request_in: prior } : {}), ...(usage ? { result: { usage } } : {}) },
      request: packed,
    });
  }

  // `hook`: what the owner's hooks did to the call (`input` is then the input they left, which is what ran).
  private tool(s: Session, callId: string, name: string, input: unknown, result: ToolResultBlock, ran: { ms: number; outcome: "ok" | "error" | "interrupted"; error?: Error }, hook?: { from?: unknown; skipped?: true }) {
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
    this.later("a tool's span",
      "INSERT OR REPLACE INTO spans (span_id, trace_id, parent_id, session_id, kind, name, start_ms, end_ms, status, error, error_type, attrs) VALUES (?, ?, ?, ?, 'tool', ?, ?, ?, ?, ?, ?, ?)",
      [span, trace, parent?.span ?? null, s.id, `execute_tool ${name}`, now - ran.ms, now, ran.outcome, ran.outcome === "error" ? scrubbed(content.slice(0, 1000), s.id) : null,
        ran.outcome === "error" ? "tool_error" : null,
        JSON.stringify({ tool: name, call_id: callId, input_keys: input && typeof input === "object" ? Object.keys(input) : [], input_bytes: Buffer.byteLength(inputJson), result_bytes: Buffer.byteLength(content), ...(turn ? { turn_event: turn.id } : {}),
          ...(hook?.from !== undefined ? { hook_rewrote: true, asked_input_bytes: Buffer.byteLength(JSON.stringify(hook.from ?? {})) } : {}), ...(hook?.skipped ? { hook_allowed: true } : {}) })],
    );
    this.emitEnd(span);
  }

  private turnEnd(s: Session, reason: string) {
    const turn = this.lastTurn(s.id);
    if (!turn) return;
    const { trace, span } = this.ensureTurn(s, turn);
    // What the turn still waited on when it ended was cut with it (a card left open, a retry stopped).
    this.endWait(`step:${s.id}`, undefined, "interrupted");
    for (const [key, id] of this.waits) {
      if (key.startsWith("approval:") && this.store.db.query("SELECT 1 FROM spans WHERE span_id = ? AND parent_id = ?").get(id, span)) this.endWait(key, undefined, "interrupted");
    }
    // A turn the model declined did not do its work: failed, as its declined request is.
    const declined = reason === "refusal";
    const status: SpanStatus = reason === "error" || declined ? "error" : reason === "interrupted" || reason === "restart" ? "interrupted" : "ok";
    const fail = status === "error" ? this.store.db.query<{ error: string; error_type: string }, [string, string]>(TURN_FAILURE_SQL).get(trace, span) : null;
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

  // A request sent again for the span `of`: its own trace, which the measuring hooks make when the request
  // is sent through `measured` (the ledger books it with them). `spanOf` is the span they made.
  replaying(req: ProviderRequest, of: Span) { this.replays.set(req, of.span_id); }
  spanOf(req: ProviderRequest): Span | undefined { const id = this.made.get(req); return id ? this.span(id) : undefined; }
}

// The request without its signal and callbacks, gzipped; extra headers keep their names only.
export function packRequest(req: ProviderRequest): Uint8Array | null {
  const { signal: _s, onHeaders: _h, ...rest } = req;
  const body = JSON.stringify({ ...rest, ...(rest.extraHeaders ? { extraHeaders: redactHeaders(rest.extraHeaders) } : {}) });
  return Buffer.byteLength(body) > KEEP_REQUEST_BYTES ? null : gzipSync(body);
}

export type { Message };
