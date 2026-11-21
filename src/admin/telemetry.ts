// Local telemetry: one row per model request (latency, time to first token,
// tokens, cost, outcome) and one per tool call that ran (duration, failure).
// Nothing leaves the machine. Rows are small and kept; a deleted session's
// rows stay so the totals over time do not change.
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import { SessionMap } from "../core/session-map.ts";
import { lineage } from "../core/tree.ts";
import { registerHooks } from "../engine/hooks.ts";
import { promptOf } from "../engine/prompt-store.ts";
import { errorText } from "../engine/retry.ts";
import type { ProviderRequest } from "../providers/types.ts";
import { errorClass } from "./classes.ts";
import { armOf, experimentTables } from "./experiments.ts";
import { registerSettings, settings } from "./settings.ts";
import { scaleZones, ZONES, zoneBytes, zoneCache, type Zone, type ZoneCache, type Zones } from "./zones.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry_calls (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  unpriced INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  stop TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS telemetry_calls_ts ON telemetry_calls(ts);
CREATE TABLE IF NOT EXISTS telemetry_tools (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,
  ms INTEGER,
  is_error INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS telemetry_tools_ts ON telemetry_tools(ts);
CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS telemetry_toolsets (h TEXT PRIMARY KEY, names TEXT NOT NULL);
`;

// One attempt in flight. `step0`: when the first attempt of its model step
// started (a retry sends the same request object again); `first`: the first
// piece of anything streamed; `text`: the first piece of reply text.
type Pending = { t0: number; step0: number; attempt: number; first?: number; text?: number; session: string; model: string; purpose: string; turn: string | null; compaction: string; bytes: Zones; prefix: Prefix | null; cacheMs: number | null; toolset: string | null; effort: string | null };

// Fingerprints of what a turn request's cached prefix is made of, stored with
// the call so the next one (after a daemon restart too) can say what differs:
// the tool schemas in the prompt (deferred ones are not), the system text as
// sent, and the messages (`msgs` over all of them, `kept` over all but the
// last, which a provider's breakpoint may sit before).
type Prefix = { tools: string; system: string; n: number; msgs: string; kept: string; marks: string[] };
const fp = (v: unknown) => Bun.hash(typeof v === "string" ? v : JSON.stringify(v)).toString(36);
export function prefixOf(req: Pick<ProviderRequest, "tools" | "system">, marks: string[]): Prefix {
  return {
    tools: fp(req.tools.filter((t) => !t.defer).map((t) => [t.name, t.description, t.input_schema])),
    system: fp(req.system), n: marks.length, msgs: fp(marks), kept: fp(marks.slice(0, -1)), marks,
  };
}

// The parts of the prefix that differ from the previous turn request's, by
// its stored fingerprints; null when that call stored none (made before they
// were recorded). `blocks`: the system prompt blocks the engine replaced in between.
export function prefixDiff(prev: { h_tools: string | null; h_system: string | null; n_msgs: number | null; h_msgs: string | null; h_kept: string | null }, now: Prefix, blocks: string[] = []): string[] | null {
  if (prev.h_tools === null || prev.h_system === null || prev.n_msgs === null) return null;
  const out: string[] = [];
  if (prev.h_tools !== now.tools) out.push("tools");
  if (prev.h_system !== now.system) out.push(blocks.length ? `system (${blocks.join(", ")})` : "system");
  // The history is kept when this request starts with the last one's messages, its last one aside.
  const same = now.n >= prev.n_msgs && fp(now.marks.slice(0, prev.n_msgs)) === prev.h_msgs;
  const sameButLast = now.n >= prev.n_msgs - 1 && fp(now.marks.slice(0, Math.max(0, prev.n_msgs - 1))) === prev.h_kept;
  if (!same && !sameButLast) out.push("history");
  return out;
}

// Why a request read less from the prompt cache than the one before it in the
// same session: the cache lifetime passed (the one the request before asked
// for, ProviderRequest.cacheMs; a route that states none never expires here),
// the model changed, a compaction rewrote the history, the prefix changed (a
// stored fingerprint of the tools, the system text or the kept history
// differs from the last request's), or none of these: the request was the
// same up to the last one's end and the provider's cache missed anyway.
// Until when the prompt cache of a session's last turn request stays warm, by
// the lifetime that request asked for; undefined when its route states none.
export function warmUntil(store: Store, sessionId: string): number | undefined {
  const r = store.db.query<{ ts: number; cache_ms: number | null }, [string]>(
    "SELECT ts, cache_ms FROM telemetry_calls WHERE session_id = ? AND outcome = 'ok' AND COALESCE(purpose, 'turn') = 'turn' ORDER BY ts DESC LIMIT 1").get(sessionId);
  return r?.cache_ms ? r.ts + r.cache_ms : undefined;
}
export const BREAK_CAUSES = ["expired", "model_switch", "compaction", "prefix_changed", "provider_miss"] as const;

registerSettings(
  "budget",
  { daily_usd: null, monthly_usd: null },
  (v) => ([v.daily_usd, v.monthly_usd].some((x) => x !== null && !(typeof x === "number" && x > 0)) ? "a limit is an amount of dollars above 0, or null" : undefined),
);

export class Telemetry {
  // In flight, by the request object the engine passes to every measuring hook.
  private pending = new Map<ProviderRequest, Pending>();
  // The attempts each request object has had, and when its first one started.
  private steps = new WeakMap<ProviderRequest, { attempt: number; t0: number }>();
  // The message marks of each session's last turn request (frozen history).
  private prevMarks = new SessionMap<string[]>(256);
  // Each session's running turn, as its last request saw it: its tool calls belong to it.
  private turnOf = new SessionMap<string | null>(256);
  private toolsets = new Set<string>();

  constructor(private store: Store, bus: Bus) {
    store.migrate(SCHEMA);
    experimentTables(store);
    const cols = [["telemetry_calls", "cache_break", "TEXT"], ["telemetry_tools", "call_id", "TEXT"], ["telemetry_tools", "error", "TEXT"],
      ["telemetry_calls", "purpose", "TEXT"], ["telemetry_calls", "error_class", "TEXT"], ["telemetry_calls", "turn_event", "TEXT"],
      ["telemetry_calls", "attempt", "INTEGER"], ["telemetry_calls", "h_tools", "TEXT"], ["telemetry_calls", "h_system", "TEXT"], ["telemetry_calls", "n_msgs", "INTEGER"],
      ["telemetry_calls", "h_msgs", "TEXT"], ["telemetry_calls", "h_kept", "TEXT"], ["telemetry_calls", "break_detail", "TEXT"], ["telemetry_calls", "step_ms", "INTEGER"], ["telemetry_calls", "text_ms", "INTEGER"], ["telemetry_calls", "compaction_event", "TEXT"], ["telemetry_calls", "cache_ms", "INTEGER"],
      ["telemetry_tools", "outcome", "TEXT"], ["telemetry_tools", "event_id", "TEXT"], ["telemetry_tools", "model", "TEXT"],
      // What shaped the call: its experiment and arm, the tool names offered, the speed and effort.
      ["telemetry_calls", "exp_id", "TEXT"], ["telemetry_calls", "arm", "TEXT"], ["telemetry_calls", "toolset", "TEXT"], ["telemetry_calls", "speed", "TEXT"], ["telemetry_calls", "effort", "TEXT"],
      ["telemetry_tools", "turn_event", "TEXT"], ["telemetry_tools", "exp_id", "TEXT"], ["telemetry_tools", "arm", "TEXT"],
      ...ZONES.map((z) => ["telemetry_calls", `z_${z}`, "INTEGER"])] as const;
    for (const [t, col, type] of cols) if (!store.columnExists(t, col)) store.db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}`);
    store.migrate("CREATE INDEX IF NOT EXISTS telemetry_calls_session ON telemetry_calls(session_id, ts)");
    // A turn's rollup reads its own requests and tool runs by the turn's id.
    store.migrate("CREATE INDEX IF NOT EXISTS telemetry_calls_turn ON telemetry_calls(turn_event); CREATE INDEX IF NOT EXISTS telemetry_tools_turn ON telemetry_tools(turn_event)");
    this.backfill();
    void bus;
    registerHooks({
      beforeRequest: (_s, req) => {
        const over = this.overBudget();
        if (over) throw Object.assign(new Error(over), { kind: "budget" });
        return req;
      },
      requestSent: (s, req) => {
        const purpose = req.purpose ?? "turn";
        const { bytes, marks } = zoneBytes(req, this.prevMarks.get(s.id) ?? []);
        if (purpose === "turn") this.prevMarks.set(s.id, marks);
        // The model the request went to, read now: the owner may pick another before it answers.
        // The route the engine resolved for this request (an advisor or a
        // fallback is not the session's selection), read at dispatch.
        const now = Date.now();
        const step = this.steps.get(req) ?? { attempt: 0, t0: now };
        step.attempt++;
        this.steps.set(req, step);
        const line = this.lineageOf(s.id);
        const turn = purpose === "side" ? null : openTurn(line);
        if (purpose === "turn") this.turnOf.set(s.id, turn);
        const p: Pending = {
          t0: now, step0: step.t0, attempt: step.attempt, session: s.id, model: req.route ?? this.store.session(s.id)?.model ?? s.model, purpose,
          turn, compaction: line.findLast((e) => e.kind === "compaction")?.id ?? "", bytes,
          prefix: purpose === "turn" ? prefixOf(req, marks) : null, cacheMs: req.cacheMs ?? null,
          toolset: purpose === "reader" ? null : this.toolset(req.tools.map((t) => t.name)), effort: req.effort ?? null,
        };
        this.pending.set(req, p);
      },
      requestDelta: (_s, req, d) => {
        const p = this.pending.get(req);
        if (!p || !d.text) return;
        const now = Date.now();
        p.first ??= now;
        if (d.kind === "text") p.text ??= now;
      },
      requestDone: (_s, req, res) => {
        const p = this.take(req);
        if (!p) return;
        const cls = res.stop === "refusal" ? "refusal" : res.stop === "model_context_window_exceeded" ? "context_overflow" : null;
        this.callEnd(p, { outcome: "ok", usage: res.usage, stop: res.stop, cls });
      },
      requestFailed: (_s, req, err, aborted) => {
        const p = this.take(req);
        if (!p) return;
        const cls = aborted ? null : errorClass(err);
        this.callEnd(p, aborted || !cls ? { outcome: "interrupted" } : { outcome: "error", error: errorText(err), cls });
      },
      toolRan: (s, call, result, ran) => {
        // The assistant step that asked for the call: its event and model.
        const ev = this.callEvent(s.id, call.id);
        const tag = armOf(this.store, s.id);
        this.store.db
          .query("INSERT INTO telemetry_tools (session_id, ts, tool, ms, is_error, call_id, error, outcome, event_id, model, turn_event, exp_id, arm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(s.id, Date.now(), call.tool.name, ran.ms, ran.outcome === "error" ? 1 : 0, call.id, ran.outcome === "error" ? excerpt(result.content) : null,
            ran.outcome, ev?.id ?? null, ev?.model ?? null, this.turnOf.get(s.id) ?? null, tag?.exp_id ?? null, tag?.arm ?? null);
      },
    });
  }

  // The fingerprint of a set of offered tool names, the names kept once.
  private toolset(names: string[]): string {
    const sorted = [...new Set(names)].sort();
    const h = fp(sorted);
    if (!this.toolsets.has(h)) {
      this.store.db.query("INSERT OR IGNORE INTO telemetry_toolsets (h, names) VALUES (?, ?)").run(h, JSON.stringify(sorted));
      this.toolsets.add(h);
    }
    return h;
  }

  private take(req: ProviderRequest) {
    const p = this.pending.get(req);
    this.pending.delete(req);
    return p;
  }

  private lineageOf(id: string) {
    return lineage(this.store.events(id), this.store.session(id)?.head ?? null);
  }

  // The newest assistant event of the session holding a tool_use block with
  // exactly this id (never a mention of the id in text).
  private callEvent(sessionId: string, callId: string): { id: string; model: string | null } | undefined {
    return this.store.db.query<{ id: string; model: string | null }, [string, string]>(
      `SELECT e.id, json_extract(e.data, '$.model') AS model FROM events e, json_each(e.data, '$.blocks') b
        WHERE e.session_id = ? AND e.kind = 'assistant' AND json_extract(b.value, '$.type') = 'tool_use' AND json_extract(b.value, '$.id') = ?
        ORDER BY e.seq DESC LIMIT 1`).get(sessionId, callId) ?? undefined;
  }

  private callEnd(p: Pending, r: { outcome: string; usage?: any; stop?: string; error?: string; cls?: string | null }) {
    const now = Date.now();
    const u = r.usage ?? {};
    const prompt = (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0);
    // Zones only where the provider counted the prompt.
    const z = r.outcome === "ok" && prompt > 0 ? scaleZones(p.bytes, prompt) : null;
    const brk = r.outcome === "ok" && p.purpose === "turn" ? this.cacheBreak(p.session, p.model, p.t0, u, p.prefix) : null;
    const x = p.prefix;
    const tag = armOf(this.store, p.session);
    this.store.db
      .query(`INSERT INTO telemetry_calls (session_id, ts, model, latency_ms, ttft_ms, input, output, cache_read, cache_write, cost, unpriced, outcome, stop, error, cache_break,
                purpose, error_class, turn_event, z_tools, z_system, z_history, z_tail, attempt, step_ms, text_ms, compaction_event,
                h_tools, h_system, n_msgs, h_msgs, h_kept, break_detail, cache_ms, exp_id, arm, toolset, speed, effort)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.session, p.t0, p.model, now - p.t0, p.first === undefined ? null : p.first - p.t0, u.input ?? 0, u.output ?? 0, u.cache_read ?? 0, u.cache_write ?? 0,
        typeof u.cost === "number" ? u.cost : null, u.unpriced ? 1 : 0, r.outcome, r.stop ?? null, r.error?.slice(0, 300) ?? null, brk?.cause ?? null,
        p.purpose, r.cls ?? null, p.turn, z?.tools ?? null, z?.system ?? null, z?.history ?? null, z?.tail ?? null,
        p.attempt, now - p.step0, p.text === undefined ? null : p.text - p.t0, p.compaction,
        x?.tools ?? null, x?.system ?? null, x?.n ?? null, x?.msgs ?? null, x?.kept ?? null, brk?.detail ?? null, p.cacheMs,
        tag?.exp_id ?? null, tag?.arm ?? null, p.toolset, u.speed ?? u.speed_asked ?? null, p.effort);
  }

  // A turn request that read less than half of what it and the last one of the
  // session share broke the cache, whatever its size: a prompt that shrank
  // because the wire left out stale thinking was written again all the same
  // (side requests are not turn requests and are never compared). Why, by what the
  // two requests' stored fingerprints, the history and the clock say; `detail`
  // names the parts of the prefix that differ.
  private cacheBreak(sessionId: string, model: string, ts: number, u: any, now: Prefix | null): { cause: string; detail: string | null } | null {
    const prev = this.store.db
      .query<{ ts: number; model: string; prompt: number; h_tools: string | null; h_system: string | null; n_msgs: number | null; h_msgs: string | null; h_kept: string | null; cache_ms: number | null }, [string]>(
        "SELECT ts, model, input + cache_read + cache_write AS prompt, h_tools, h_system, n_msgs, h_msgs, h_kept, cache_ms FROM telemetry_calls WHERE session_id = ? AND outcome = 'ok' AND COALESCE(purpose, 'turn') = 'turn' ORDER BY ts DESC LIMIT 1")
      .get(sessionId);
    if (!prev || prev.prompt <= 0) return null;
    const prompt = (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0);
    const compacted = this.compactedBetween(sessionId, prev.ts, ts);
    if ((u.cache_read ?? 0) >= 0.5 * Math.min(prev.prompt, prompt)) return null;
    // The blocks of the system prompt the engine replaced since the last request.
    const changed = promptOf(this.store, sessionId)?.changed;
    const diff = now ? prefixDiff(prev, now, changed && changed.ts > prev.ts && changed.ts <= ts ? changed.blocks : []) : null;
    return { cause: breakCause({ gapMs: ts - prev.ts, lifeMs: prev.cache_ms, modelChanged: prev.model !== model, compacted, diff }), detail: diff?.length ? diff.join("; ") : null };
  }

  private compactedBetween(sessionId: string, a: number, b: number) {
    return !!this.store.db.query("SELECT 1 FROM events WHERE session_id = ? AND kind = 'compaction' AND ts > ? AND ts <= ? LIMIT 1").get(sessionId, a, b);
  }

  // Priced spend since local midnight and since the first of the month.
  spend(now = new Date()) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const q = (since: number) => this.store.db.query<{ usd: number | null; unpriced: number | null }, [number]>("SELECT SUM(cost) AS usd, SUM(unpriced) AS unpriced FROM telemetry_calls WHERE ts >= ?").get(since)!;
    const d = q(day), m = q(month);
    const b = settings().budget;
    return {
      day: { since_ms: day, usd: d.usd ?? 0, unpriced_calls: d.unpriced ?? 0, limit_usd: b.daily_usd as number | null },
      month: { since_ms: month, usd: m.usd ?? 0, unpriced_calls: m.unpriced ?? 0, limit_usd: b.monthly_usd as number | null },
    };
  }

  private overBudget(): string | undefined {
    const b = settings().budget;
    if (!b.daily_usd && !b.monthly_usd) return undefined;
    const s = this.spend();
    // Cents, or two significant digits below a cent: a limit is never shown as $0.00.
    const usd = (v: number) => "$" + (v >= 0.01 || v === 0 ? v.toFixed(2) : v.toLocaleString("en-US", { maximumSignificantDigits: 2 }));
    if (b.daily_usd && s.day.usd >= b.daily_usd) return `The daily spend limit of ${usd(b.daily_usd)} is reached (${usd(s.day.usd)} today). Raise it in Settings > Usage to go on.`;
    if (b.monthly_usd && s.month.usd >= b.monthly_usd) return `The monthly spend limit of ${usd(b.monthly_usd)} is reached (${usd(s.month.usd)} this month). Raise it in Settings > Usage to go on.`;
    return undefined;
  }

  // The last failed tool calls, newest first, with where they happened.
  examples(q: { tool?: string; session?: string; limit?: number; since?: number; until?: number }) {
    const where = ["t.is_error = 1"];
    const args: (string | number)[] = [];
    if (q.tool) { where.push("t.tool = ?"); args.push(q.tool); }
    // The interval of the report the examples explain, before the limit.
    if (q.since !== undefined) { where.push("t.ts >= ?"); args.push(q.since); }
    if (q.until !== undefined) { where.push("t.ts <= ?"); args.push(q.until); }
    if (q.session) { where.push("t.session_id = ?"); args.push(q.session); }
    args.push(Math.min(100, Math.max(1, q.limit ?? 20)));
    const sql = `SELECT t.session_id, t.ts, t.tool, t.ms, t.call_id, t.error, t.event_id, s.title AS session_title, s.id IS NULL AS session_gone
      FROM telemetry_tools t LEFT JOIN sessions s ON s.id = t.session_id WHERE ${where.join(" AND ")} ORDER BY t.ts DESC LIMIT ?`;
    return this.store.db.query<any, any[]>(sql).all(...args)
      .map((r) => ({ ...r, session_gone: !!r.session_gone, session_title: r.session_title ?? undefined,
        event_id: r.event_id ?? (r.call_id ? this.callEvent(r.session_id, r.call_id)?.id : undefined) ?? undefined }));
  }

  // Sessions from before telemetry: their stored steps give tokens and cost
  // (no timings), their tool results give calls and failures with the call
  // id, the first line of a failure and the step that asked for it. A fork
  // copies its history with the original timestamps: a step or result copied
  // into another session is the same request, counted once.
  private backfill() {
    const db = this.store.db;
    if (db.query("SELECT 1 FROM admin_meta WHERE key = 'telemetry_backfill'").get()) return;
    db.transaction(() => {
      db.exec(`INSERT INTO telemetry_calls (session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, stop)
        SELECT e.session_id, e.ts, COALESCE(json_extract(e.data, '$.model'), s.model),
          COALESCE(json_extract(e.data, '$.usage.input'), 0), COALESCE(json_extract(e.data, '$.usage.output'), 0),
          COALESCE(json_extract(e.data, '$.usage.cache_read'), 0), COALESCE(json_extract(e.data, '$.usage.cache_write'), 0),
          json_extract(e.data, '$.usage.cost'), CASE WHEN json_extract(e.data, '$.usage.unpriced') > 0 THEN 1 ELSE 0 END,
          'ok', json_extract(e.data, '$.stop')
        FROM events e JOIN sessions s ON s.id = e.session_id
        WHERE e.kind = 'assistant' AND e.rowid = (SELECT MIN(c.rowid) FROM events c WHERE c.kind = 'assistant' AND c.ts = e.ts AND c.data = e.data)`);
      const results = db.query<{ session_id: string; ts: number; data: string }, []>(
        `SELECT e.session_id, e.ts, e.data FROM events e
          WHERE e.kind = 'tool_result' AND e.rowid = (SELECT MIN(c.rowid) FROM events c WHERE c.kind = 'tool_result' AND c.ts = e.ts AND c.data = e.data)`).all();
      const insert = db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, call_id, error, outcome, event_id, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const r of results) {
        for (const res of (JSON.parse(r.data).results ?? []) as any[]) {
          const ev = res.tool_use_id ? this.callEvent(r.session_id, res.tool_use_id) : undefined;
          const use = ev ? (this.store.event(ev.id)?.data.blocks ?? []).find((b: any) => b.type === "tool_use" && b.id === res.tool_use_id) : undefined;
          insert.run(r.session_id, r.ts, use?.name ?? "?", res.is_error ? 1 : 0, res.tool_use_id ?? null, res.is_error ? excerpt(res.content) : null,
            res.is_error ? "error" : "ok", ev?.id ?? null, ev?.model ?? null);
        }
      }
      db.query("INSERT INTO admin_meta (key, value) VALUES ('telemetry_backfill', ?)").run(String(Date.now()));
    })();
  }

  private rows(q: Filter) {
    const where = ["1 = 1"];
    const args: (string | number)[] = [];
    if (q.session) { where.push("session_id = ?"); args.push(q.session); }
    if (q.model) { where.push("model = ?"); args.push(q.model); }
    if (q.since !== undefined) { where.push("ts >= ?"); args.push(q.since); }
    if (q.until !== undefined) { where.push("ts < ?"); args.push(q.until); }
    const w = where.join(" AND ");
    const calls = this.store.db.query<CallRow, any[]>(`SELECT * FROM telemetry_calls WHERE ${w} ORDER BY ts`).all(...args);
    // A model filter keeps the tool calls that model's steps asked for (a row
    // whose step is not known is in no model's count).
    const tools = this.store.db.query<ToolRow, any[]>(`SELECT ts, tool, ms, is_error FROM telemetry_tools WHERE ${w} ORDER BY ts`).all(...args);
    const since = q.since ?? Math.min(calls[0]?.ts ?? Date.now(), tools[0]?.ts ?? Date.now());
    const until = q.until ?? Date.now();
    return { calls, tools, since, until, bucket: q.bucket ?? pickBucket(until - since) };
  }

  report(q: Filter) {
    const { calls, tools, since, until, bucket } = this.rows(q);
    const series = new Map<number, { calls: CallRow[]; tools: ToolRow[] }>();
    const at = (ts: number) => {
      const t = Math.floor(ts / bucket) * bucket;
      let b = series.get(t);
      if (!b) series.set(t, (b = { calls: [], tools: [] }));
      return b;
    };
    for (const c of calls) at(c.ts).calls.push(c);
    for (const t of tools) at(t.ts).tools.push(t);

    const byModel = group(calls, (c) => c.model);
    const byTool = group(tools, (t) => t.tool);
    const errorKinds = group(calls.filter((c) => c.outcome === "error"), (c) => c.error ?? "unknown");
    return {
      since_ms: since,
      until_ms: until,
      bucket_ms: bucket,
      total: { ...callStats(calls), ...toolStats(tools) },
      series: [...series.entries()].sort(([a], [b]) => a - b).map(([t_ms, b]) => ({ t_ms, ...callStats(b.calls), ...toolStats(b.tools), classes: classCounts(b.calls) })),
      by_model: [...byModel.entries()].map(([model, list]) => ({ model, ...callStats(list) })).sort((a, b) => b.calls - a.calls),
      // total_ms sums the timed calls only (`timed` of `tool_calls`); null when none was timed.
      tools: [...byTool.entries()].map(([tool, list]) => {
        const timed = list.filter((t) => t.ms !== null);
        return { tool, ...toolStats(list), p50_ms: pct(list.map((t) => t.ms), 0.5), p95_ms: pct(list.map((t) => t.ms), 0.95), timed: timed.length, total_ms: timed.length ? timed.reduce((n, t) => n + t.ms!, 0) : null };
      })
        .sort((a, b) => b.tool_calls - a.tool_calls),
      breaks: BREAK_CAUSES.map((cause) => {
        const list = calls.filter((c) => c.cache_break === cause);
        // What differed, where it was recorded: each detail with its count.
        const details = new Map<string, number>();
        for (const c of list) if (c.break_detail) details.set(c.break_detail, (details.get(c.break_detail) ?? 0) + 1);
        return {
          cause, count: list.length, last_ms: list.at(-1)?.ts ?? null, uncached_tokens: list.reduce((n, c) => n + c.input + c.cache_write, 0),
          details: [...details.entries()].map(([detail, count]) => ({ detail, count })).sort((a, b) => b.count - a.count),
        };
      }).filter((b) => b.count),
      // Failures by class, per provider and model: `rate` is per request of that model.
      error_classes: [...byModel.entries()].flatMap(([model, list]) =>
        Object.entries(classCounts(list)).map(([cls, count]) => {
          const of = list.filter((c) => c.error_class === cls);
          return { provider: providerOf(model), model, class: cls, count, calls: list.length, rate: count / list.length, last_ms: of.at(-1)!.ts, last_error: of.findLast((c) => c.error)?.error ?? null };
        })).sort((a, b) => b.count - a.count),
      spend: this.spend(),
      error_kinds: [...errorKinds.entries()].map(([message, list]) => ({ message, count: list.length, last_ms: list.at(-1)!.ts })).sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }

  // Where the prompt tokens went: each request split into its zones (tools,
  // system, frozen history, volatile tail) with how each zone was served
  // (read from the cache, written to it, sent in full); in total, over time,
  // and per turn (with a session: its last 30 turns).
  tokens(q: Filter) {
    const { calls, since, until, bucket } = this.rows(q);
    const measured = calls.filter((c) => c.z_tools !== null);
    const sum = (list: CallRow[]) => {
      const out = Object.fromEntries(ZONES.map((z) => [z, { tokens: 0, read: 0, written: 0, fresh: 0 }])) as Record<Zone, ZoneCache>;
      for (const c of list) {
        const zc = zoneCache({ tools: c.z_tools!, system: c.z_system!, history: c.z_history!, tail: c.z_tail! }, c);
        for (const z of ZONES) for (const k of ["tokens", "read", "written", "fresh"] as const) out[z][k] += zc[z][k];
      }
      return out;
    };
    const series = new Map<number, CallRow[]>();
    for (const c of measured) {
      const t = Math.floor(c.ts / bucket) * bucket;
      (series.get(t) ?? series.set(t, []).get(t)!).push(c);
    }
    let turns: unknown[] = [];
    if (q.session) {
      const evs = this.store.events(q.session);
      const byTurn = group(measured.filter((c) => c.turn_event), (c) => c.turn_event!);
      turns = [...byTurn.entries()].map(([id, list]) => {
        // The prompt on the turn's own branch: its nearest user ancestor.
        const prompt = evs.some((e) => e.id === id) ? lineage(evs, id).findLast((e) => e.kind === "user") : undefined;
        return { turn_event: id, ts_ms: list[0]!.ts, prompt: String(prompt?.data.text ?? "").slice(0, 140), prompt_event: prompt?.id, requests: list.length, zones: sum(list), per_request: list.map((c) => ({ ts_ms: c.ts, purpose: c.purpose ?? "turn", zones: zoneCache({ tools: c.z_tools!, system: c.z_system!, history: c.z_history!, tail: c.z_tail! }, c) })) };
      }).slice(-30);
    }
    return {
      since_ms: since, until_ms: until, bucket_ms: bucket, zones: ZONES, estimate: true,
      measured_calls: measured.length, calls: calls.length,
      total: sum(measured),
      series: [...series.entries()].sort(([a], [b]) => a - b).map(([t_ms, list]) => ({ t_ms, calls: list.length, zones: sum(list) })),
      by_purpose: [...group(measured, (c) => c.purpose ?? "turn").entries()].map(([purpose, list]) => ({ purpose, calls: list.length, zones: sum(list) })),
      turns,
    };
  }

  // Each compaction: what started it, the context before and after (the
  // engine's estimate before; after, what the provider counted on the next
  // request), what the summary kept, what it cost and took, and how the
  // requests around it read the cache: the last one before and the first
  // AFTER_REQUESTS after.
  compactions(q: Filter & { limit?: number }) {
    const where = ["e.kind = 'compaction'"];
    const args: (string | number)[] = [];
    if (q.session) { where.push("e.session_id = ?"); args.push(q.session); }
    if (q.since !== undefined) { where.push("e.ts >= ?"); args.push(q.since); }
    if (q.until !== undefined) { where.push("e.ts < ?"); args.push(q.until); }
    const rows = this.store.db.query<{ id: string; session_id: string; ts: number; seq: number; data: string; title: string | null }, any[]>(
      `SELECT e.id, e.session_id, e.ts, e.seq, e.data, s.title FROM events e LEFT JOIN sessions s ON s.id = e.session_id WHERE ${where.join(" AND ")} ORDER BY e.ts DESC`).all(...args);
    // The turn requests after a compaction are the ones that carried it (the
    // compaction their branch had when sent); rows from before that was
    // recorded fall back to the session's next requests in time.
    const turnCalls = this.store.db.query<CallRow, [string, string, number, number]>(
      `SELECT * FROM telemetry_calls WHERE session_id = ? AND outcome = 'ok' AND COALESCE(purpose, 'turn') = 'turn'
        AND (compaction_event = ? OR (compaction_event IS NULL AND ts >= ?)) ORDER BY ts LIMIT ?`);
    const before = this.store.db.query<CallRow, [string, number]>(
      "SELECT * FROM telemetry_calls WHERE session_id = ? AND outcome = 'ok' AND COALESCE(purpose, 'turn') = 'turn' AND ts < ? ORDER BY ts DESC LIMIT 1");
    const cacheOf = (c: CallRow) => ({ ts_ms: c.ts, prompt_tokens: c.input + c.cache_read + c.cache_write, cache_read: c.cache_read, cache_write: c.cache_write, hit_ratio: hit(c) });
    const list = rows.map((r) => ({ r, d: JSON.parse(r.data) })).filter(({ d }) => !q.model || d.model === q.model).map(({ r, d }) => {
      const after = turnCalls.all(r.session_id, r.id, r.ts, AFTER_REQUESTS);
      const prev = before.get(r.session_id, r.ts); // summary requests are not turn requests
      const u = d.usage ?? null;
      const mode = d.mode as string;
      return {
        event_id: r.id, session_id: r.session_id, session_title: r.title ?? undefined, session_gone: r.title === null && !this.store.session(r.session_id), ts_ms: r.ts,
        mode, trigger: (d.trigger ?? (mode === "clear" ? "owner" : d.auto ? "threshold" : "owner")) as string, ahead: !!d.ahead, focus: d.focus ?? null,
        model: d.model ?? null,
        tokens_before: d.tokens_before ?? null,
        tokens_after: after[0] ? after[0].input + after[0].cache_read + after[0].cache_write : null,
        kept: mode === "summary" ? {
          summary_tokens: Math.round(String(d.summary ?? "").length / 4),
          owner_messages: (d.owner_messages ?? []).length,
          owner_tokens: Math.round((d.owner_messages ?? []).reduce((n: number, t: string) => n + t.length, 0) / 4),
          verbatim_events: d.covered ? this.keptVerbatim(r.session_id, d.covered, r.id) : 0,
        } : null,
        duration_ms: d.duration_ms ?? null,
        input_tokens: u ? u.input + u.cache_read + u.cache_write : 0, output_tokens: u?.output ?? 0, cache_read_tokens: u?.cache_read ?? 0,
        cost_usd: u && typeof u.cost === "number" ? u.cost : null, priced: mode === "clear" || (!!u && typeof u.cost === "number"), // a summary with no usage record has an unknown cost, not $0
        cache: { before: prev ? cacheOf(prev) : null, after: after.map(cacheOf) },
      };
    });
    const limit = Math.min(100, Math.max(0, q.limit ?? 20));
    const total = {
      count: list.length,
      tokens_before: list.reduce((n, c) => n + (c.tokens_before ?? 0), 0),
      tokens_after: list.reduce((n, c) => n + (c.tokens_after ?? 0), 0),
      measured_after: list.filter((c) => c.tokens_after !== null).length,
      // Before and after over the same compactions: those with both measured.
      paired: ((p) => ({ count: p.length, tokens_before: p.reduce((n, c) => n + c.tokens_before!, 0), tokens_after: p.reduce((n, c) => n + c.tokens_after!, 0) }))(list.filter((c) => c.tokens_before !== null && c.tokens_after !== null)),
      cost_usd: list.reduce((n, c) => n + (c.cost_usd ?? 0), 0),
      unpriced: list.filter((c) => c.mode !== "clear" && !c.priced).length,
      duration_p50_ms: pct(list.map((c) => c.duration_ms), 0.5),
      after_hit_ratio: ratio(list.flatMap((c) => c.cache.after)),
      before_hit_ratio: ratio(list.flatMap((c) => (c.cache.before ? [c.cache.before] : []))),
      by_trigger: Object.fromEntries([...group(list, (c) => c.trigger).entries()].map(([k, v]) => [k, v.length])),
    };
    return { total, after_requests: AFTER_REQUESTS, compactions: list.slice(0, limit) };
  }

  // Events kept word for word after a summary prepared ahead: those on the
  // summary's own branch between what it covers and the summary (a sibling
  // branch never reaches its requests).
  private keptVerbatim(sessionId: string, covered: string, summary: string) {
    const line = lineage(this.store.events(sessionId), summary);
    const from = line.findIndex((e) => e.id === covered);
    return from < 0 ? 0 : line.slice(from + 1, -1).filter((e) => ["user", "assistant", "tool_result"].includes(e.kind)).length;
  }

  // Two ranges, or two models over one range, side by side.
  compare(a: Filter, b: Filter) {
    const one = (q: Filter) => {
      const { calls, tools, since, until } = this.rows(q);
      const turn = calls.filter((c) => (c.purpose ?? "turn") === "turn");
      return { since_ms: since, until_ms: until, model: q.model ?? null, ...callStats(calls), ...toolStats(tools), cache_hit_ratio_turns: callStats(turn).cache_hit_ratio, classes: classCounts(calls),
        breaks: calls.filter((c) => c.cache_break).length, compactions: this.compactions({ ...q, limit: 0 }).total.count };
    };
    return { a: one(a), b: one(b) };
  }
}

// The turn_start of the branch's running turn: the last one with no turn_end after it.
function openTurn(line: { id: string; kind: string }[]): string | null {
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i]!.kind === "turn_end") return null;
    if (line[i]!.kind === "turn_start") return line[i]!.id;
  }
  return null;
}

export type Filter = { since?: number; until?: number; session?: string; model?: string; bucket?: number };
export const AFTER_REQUESTS = 3;

type CallRow = {
  ts: number; model: string; latency_ms: number | null; ttft_ms: number | null; input: number; output: number; cache_read: number; cache_write: number;
  cost: number | null; unpriced: number; outcome: string; error: string | null; cache_break: string | null; break_detail: string | null;
  purpose: string | null; error_class: string | null; turn_event: string | null; attempt: number | null; step_ms: number | null; text_ms: number | null; z_tools: number | null; z_system: number | null; z_history: number | null; z_tail: number | null;
};

const providerOf = (model: string) => (model.includes(":") ? model.slice(0, model.indexOf(":")) : "");
const hit = (c: { input: number; cache_read: number; cache_write: number }) => {
  const p = c.input + c.cache_read + c.cache_write;
  return p ? c.cache_read / p : null;
};
const ratio = (list: { prompt_tokens: number; cache_read: number }[]) => {
  const p = list.reduce((n, c) => n + c.prompt_tokens, 0);
  return p ? list.reduce((n, c) => n + c.cache_read, 0) / p : null;
};
function classCounts(list: CallRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of list) if (c.error_class) out[c.error_class] = (out[c.error_class] ?? 0) + 1;
  return out;
}

// `diff`: the parts of the prefix that differ from the last request's (null:
// not recorded for it). A recorded difference is a changed prefix whatever
// the clock says; with none recorded, a gap past the lifetime the last request
// asked for (`lifeMs`) is an expiry, and a miss inside it, or on a route that
// states no lifetime, is the provider's.
export function breakCause(b: { gapMs: number; lifeMs?: number | null; modelChanged: boolean; compacted: boolean; diff?: string[] | null }): (typeof BREAK_CAUSES)[number] {
  if (b.modelChanged) return "model_switch";
  if (b.compacted) return "compaction";
  if (b.diff?.length) return "prefix_changed";
  if (b.lifeMs && b.gapMs > b.lifeMs) return "expired";
  return b.diff ? "provider_miss" : "prefix_changed";
}

// One line of a failed result, at most 140 characters.
function excerpt(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (b.type === "text" ? b.text : "")).join(" ") : "";
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 140 ? line.slice(0, 139) + "..." : line;
}
type ToolRow = { ts: number; tool: string; ms: number | null; is_error: number };

function group<T>(list: T[], key: (t: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of list) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x);
  return m;
}

// The value at fraction q of the measured values (nearest rank); null when none was measured.
export function pct(values: (number | null)[], q: number): number | null {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))]!;
}

// The narrowest width that cuts the range into at most 60 buckets.
const WIDTHS = [5, 15, 60, 360, 1440, 10080, 43200].map((m) => m * 60_000);
export const pickBucket = (range: number) => WIDTHS.find((w) => range / w <= 60) ?? WIDTHS.at(-1)!;

function callStats(list: CallRow[]) {
  const errors = list.filter((c) => c.outcome === "error").length;
  const ok = list.filter((c) => c.outcome === "ok");
  const input = list.reduce((n, c) => n + c.input, 0);
  const cacheRead = list.reduce((n, c) => n + c.cache_read, 0);
  const cacheWrite = list.reduce((n, c) => n + c.cache_write, 0);
  const output = list.reduce((n, c) => n + c.output, 0);
  const prompt = input + cacheRead + cacheWrite;
  const unpriced = list.filter((c) => c.unpriced).length;
  const priced = list.reduce((n, c) => n + (c.cost ?? 0), 0);
  // Output speed over the streaming part of the request only.
  const streamed = list.filter((c) => c.latency_ms !== null && c.ttft_ms !== null && c.latency_ms > c.ttft_ms && c.output > 0);
  const streamMs = streamed.reduce((n, c) => n + (c.latency_ms! - c.ttft_ms!), 0);
  return {
    calls: list.length,
    errors,
    cache_breaks: list.filter((c) => c.cache_break).length,
    interrupted: list.filter((c) => c.outcome === "interrupted").length,
    error_rate: list.length ? errors / list.length : 0,
    latency_p50: pct(list.map((c) => c.latency_ms), 0.5),
    latency_p95: pct(list.map((c) => c.latency_ms), 0.95),
    ttft_p50: pct(list.map((c) => c.ttft_ms), 0.5),
    ttft_p95: pct(list.map((c) => c.ttft_ms), 0.95),
    // latency_* and ttft_* are per attempt (the first streamed piece of
    // anything); first_text_* is the first piece of reply text; step_latency_*
    // is what a model step that answered took through its retries and waits.
    first_text_p50: pct(list.map((c) => c.text_ms), 0.5),
    step_latency_p50: pct(ok.map((c) => c.step_ms), 0.5),
    step_latency_p95: pct(ok.map((c) => c.step_ms), 0.95),
    retried_steps: ok.filter((c) => (c.attempt ?? 1) > 1).length,
    // What the speed was measured over.
    speed_sample: { calls: streamed.length, output_tokens: streamed.reduce((n, c) => n + c.output, 0) },
    output_tokens_per_s: streamMs ? (streamed.reduce((n, c) => n + c.output, 0) / streamMs) * 1000 : null,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cache_hit_ratio: prompt ? cacheRead / prompt : null,
    priced_cost_usd: priced,
    unpriced_calls: unpriced,
    cost_usd: unpriced ? null : priced,
  };
}

function toolStats(list: ToolRow[]) {
  const errors = list.filter((t) => t.is_error).length;
  return { tool_calls: list.length, tool_errors: errors, tool_error_rate: list.length ? errors / list.length : 0 };
}
