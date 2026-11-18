// Local telemetry: one row per model request (latency, time to first token,
// tokens, cost, outcome) and one per tool call that ran (duration, failure).
// Nothing leaves the machine. Rows are small and kept; a deleted session's
// rows stay so the totals over time do not change.
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import { registerHooks } from "../engine/hooks.ts";

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
`;

type Pending = { t0: number; first?: number };

export class Telemetry {
  private pending = new Map<string, Pending>();
  private tools = new Map<string, number>();

  constructor(private store: Store, bus: Bus) {
    store.migrate(SCHEMA);
    this.backfill();
    bus.on((f) => {
      if (f.t === "delta") {
        const p = this.pending.get(f.session_id);
        if (p && p.first === undefined) p.first = Date.now();
      } else if (f.t === "error" && f.error.source === "provider" && f.error.session_id) {
        // A failed attempt (a retry follows, or the turn ends with it).
        const p = this.pending.get(f.error.session_id);
        if (p) this.callEnd(f.error.session_id, p, { outcome: "error", error: f.error.message.slice(0, 300) });
      }
    });
    registerHooks({
      beforeRequest: (s, req) => {
        this.pending.set(s.id, { t0: Date.now() });
        return req;
      },
      afterResponse: (s, res) => {
        const p = this.pending.get(s.id);
        if (p) this.callEnd(s.id, p, { outcome: "ok", usage: res.usage, stop: res.stop });
      },
      beforeTool: (_s, call) => void this.tools.set(call.id, Date.now()),
      afterTool: (s, call, result) => {
        const t0 = this.tools.get(call.id);
        this.tools.delete(call.id);
        this.store.db
          .query("INSERT INTO telemetry_tools (session_id, ts, tool, ms, is_error) VALUES (?, ?, ?, ?, ?)")
          .run(s.id, Date.now(), call.tool.name, t0 === undefined ? null : Date.now() - t0, result.is_error ? 1 : 0);
      },
      turnEnd: (s, reason) => {
        const p = this.pending.get(s.id);
        if (p) this.callEnd(s.id, p, { outcome: reason === "interrupted" ? "interrupted" : "error" });
      },
    });
  }

  private callEnd(sessionId: string, p: Pending, r: { outcome: string; usage?: any; stop?: string; error?: string }) {
    this.pending.delete(sessionId);
    const now = Date.now();
    const u = r.usage ?? {};
    const model = this.store.session(sessionId)?.model ?? "";
    this.store.db
      .query(`INSERT INTO telemetry_calls (session_id, ts, model, latency_ms, ttft_ms, input, output, cache_read, cache_write, cost, unpriced, outcome, stop, error)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, p.t0, model, now - p.t0, p.first === undefined ? null : p.first - p.t0, u.input ?? 0, u.output ?? 0, u.cache_read ?? 0, u.cache_write ?? 0,
        typeof u.cost === "number" ? u.cost : null, u.unpriced ? 1 : 0, r.outcome, r.stop ?? null, r.error ?? null);
  }

  // Sessions from before telemetry: their stored steps give tokens and cost
  // (no timings), their tool results give calls and failures.
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
        FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.kind = 'assistant'`);
      db.exec(`INSERT INTO telemetry_tools (session_id, ts, tool, is_error)
        SELECT e.session_id, e.ts, COALESCE(u.tool, '?'), CASE WHEN json_extract(r.value, '$.is_error') THEN 1 ELSE 0 END
        FROM events e, json_each(e.data, '$.results') r
        LEFT JOIN (SELECT json_extract(b.value, '$.id') AS id, json_extract(b.value, '$.name') AS tool
                   FROM events a, json_each(a.data, '$.blocks') b WHERE a.kind = 'assistant' AND json_extract(b.value, '$.type') = 'tool_use') u
          ON u.id = json_extract(r.value, '$.tool_use_id')
        WHERE e.kind = 'tool_result'`);
      db.query("INSERT INTO admin_meta (key, value) VALUES ('telemetry_backfill', ?)").run(String(Date.now()));
    })();
  }

  report(q: { since?: number; until?: number; session?: string; bucket?: number }) {
    const db = this.store.db;
    const where = ["1 = 1"];
    const args: (string | number)[] = [];
    if (q.session) { where.push("session_id = ?"); args.push(q.session); }
    if (q.since !== undefined) { where.push("ts >= ?"); args.push(q.since); }
    if (q.until !== undefined) { where.push("ts < ?"); args.push(q.until); }
    const w = where.join(" AND ");
    const calls = db.query<CallRow, any[]>(`SELECT ts, model, latency_ms, ttft_ms, input, output, cache_read, cache_write, cost, unpriced, outcome, error FROM telemetry_calls WHERE ${w} ORDER BY ts`).all(...args);
    const tools = db.query<ToolRow, any[]>(`SELECT ts, tool, ms, is_error FROM telemetry_tools WHERE ${w} ORDER BY ts`).all(...args);
    const since = q.since ?? Math.min(calls[0]?.ts ?? Date.now(), tools[0]?.ts ?? Date.now());
    const until = q.until ?? Date.now();
    const bucket = q.bucket ?? pickBucket(until - since);

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
      series: [...series.entries()].sort(([a], [b]) => a - b).map(([t_ms, b]) => ({ t_ms, ...callStats(b.calls), ...toolStats(b.tools) })),
      by_model: [...byModel.entries()].map(([model, list]) => ({ model, ...callStats(list) })).sort((a, b) => b.calls - a.calls),
      tools: [...byTool.entries()].map(([tool, list]) => ({ tool, ...toolStats(list), p50_ms: pct(list.map((t) => t.ms), 0.5), p95_ms: pct(list.map((t) => t.ms), 0.95), total_ms: list.reduce((n, t) => n + (t.ms ?? 0), 0) }))
        .sort((a, b) => b.tool_calls - a.tool_calls),
      error_kinds: [...errorKinds.entries()].map(([message, list]) => ({ message, count: list.length, last_ms: list.at(-1)!.ts })).sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }
}

type CallRow = { ts: number; model: string; latency_ms: number | null; ttft_ms: number | null; input: number; output: number; cache_read: number; cache_write: number; cost: number | null; unpriced: number; outcome: string; error: string | null };
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
    interrupted: list.filter((c) => c.outcome === "interrupted").length,
    error_rate: list.length ? errors / list.length : 0,
    latency_p50: pct(list.map((c) => c.latency_ms), 0.5),
    latency_p95: pct(list.map((c) => c.latency_ms), 0.95),
    ttft_p50: pct(list.map((c) => c.ttft_ms), 0.5),
    ttft_p95: pct(list.map((c) => c.ttft_ms), 0.95),
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
