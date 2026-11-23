// The telemetry reports as functions of the database alone: what they read is
// the ledger of model requests and tool runs (hundreds of thousands of rows on
// a store in long use), so they run on the read thread (src/core/reads.ts) and
// import nothing of the daemon.
import type { Database } from "bun:sqlite";
import type { Filter, ToolRow } from "./telemetry.ts";
import { ZONES, zoneCache, type Zone, type ZoneCache } from "./zones.ts";

export const BREAK_CAUSES = ["expired", "warm_missed", "model_switch", "compaction", "branch_switch", "prefix_changed", "provider_miss"] as const;

export type CallRow = {
  ts: number; model: string; latency_ms: number | null; ttft_ms: number | null; input: number; output: number; cache_read: number; cache_write: number;
  cost: number | null; unpriced: number; outcome: string; error: string | null; cache_break: string | null; break_detail: string | null;
  purpose: string | null; error_class: string | null; turn_event: string | null; attempt: number | null; step_ms: number | null; text_ms: number | null; z_tools: number | null; z_system: number | null; z_history: number | null; z_tail: number | null;
};

const providerOf = (model: string) => (model.includes(":") ? model.slice(0, model.indexOf(":")) : "");
function classCounts(list: CallRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of list) if (c.error_class) out[c.error_class] = (out[c.error_class] ?? 0) + 1;
  return out;
}

export function group<T>(list: T[], key: (t: T) => string) {
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
    // What every view shows as the failed share: the requests with a failure
    // class (an error, or a reply the model declined), of all of them.
    failed: list.filter((c) => c.error_class).length,
    failed_share: list.length ? list.filter((c) => c.error_class).length / list.length : 0,
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

export type Limits = { daily_usd: number | null; monthly_usd: number | null };

// Priced spend since local midnight and since the first of the month.
export function spendOf(db: Database, limits: Limits, now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const q = (since: number) => db.query<{ usd: number | null; unpriced: number | null }, [number]>("SELECT SUM(cost) AS usd, SUM(unpriced) AS unpriced FROM telemetry_calls WHERE ts >= ?").get(since)!;
  const d = q(day), m = q(month);
  return {
    day: { since_ms: day, usd: d.usd ?? 0, unpriced_calls: d.unpriced ?? 0, limit_usd: limits.daily_usd },
    month: { since_ms: month, usd: m.usd ?? 0, unpriced_calls: m.unpriced ?? 0, limit_usd: limits.monthly_usd },
  };
}

function rows(db: Database, q: Filter) {
  const where = ["1 = 1"];
  const args: (string | number)[] = [];
  if (q.session) { where.push("session_id = ?"); args.push(q.session); }
  if (q.model) { where.push("model = ?"); args.push(q.model); }
  if (q.since !== undefined) { where.push("ts >= ?"); args.push(q.since); }
  if (q.until !== undefined) { where.push("ts < ?"); args.push(q.until); }
  const w = where.join(" AND ");
  const calls = db.query<CallRow, any[]>(`SELECT * FROM telemetry_calls WHERE ${w} ORDER BY ts`).all(...args);
  // A model filter keeps the tool calls that model's steps asked for (a row
  // whose step is not known is in no model's count).
  const tools = db.query<ToolRow, any[]>(`SELECT ts, tool, ms, is_error FROM telemetry_tools WHERE ${w} ORDER BY ts`).all(...args);
  const since = q.since ?? Math.min(calls[0]?.ts ?? Date.now(), tools[0]?.ts ?? Date.now());
  const until = q.until ?? Date.now();
  return { calls, tools, since, until, bucket: q.bucket ?? pickBucket(until - since), where: w, args };
}

// The failed calls of each tool by session, the most failures first, with how many calls of that tool the session made.
type FailedIn = { tool: string; session_id: string; title: string | null; failed: number; calls: number };
function failedIn(db: Database, where: string, args: (string | number)[]): Map<string, FailedIn[]> {
  const rows = db.query<FailedIn, any[]>(
    `SELECT t.tool, t.session_id, s.title, SUM(t.is_error) AS failed, COUNT(*) AS calls FROM (SELECT tool, session_id, is_error FROM telemetry_tools WHERE ${where}) t
     LEFT JOIN sessions s ON s.id = t.session_id GROUP BY t.tool, t.session_id HAVING SUM(t.is_error) > 0 ORDER BY failed DESC, calls DESC`).all(...args);
  const by = new Map<string, FailedIn[]>();
  for (const r of rows) (by.get(r.tool) ?? by.set(r.tool, []).get(r.tool)!).push(r);
  return by;
}

export function reportOf(db: Database, q: Filter, limits: Limits) {
  const { calls, tools, since, until, bucket, where, args } = rows(db, q);
  const failures = failedIn(db, where, args);
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
    // `last_ms`: when the bucket's newest request or tool call was (a bucket starts on the clock's grid, which may be the day before).
    series: [...series.entries()].sort(([a], [b]) => a - b).map(([t_ms, b]) => ({ t_ms, last_ms: Math.max(b.calls.at(-1)?.ts ?? 0, b.tools.at(-1)?.ts ?? 0), ...callStats(b.calls), ...toolStats(b.tools), classes: classCounts(b.calls) })),
    by_model: [...byModel.entries()].map(([model, list]) => ({ model, ...callStats(list) })).sort((a, b) => b.calls - a.calls),
    // total_ms sums the timed calls only (`timed` of `tool_calls`); null when none was timed.
    tools: [...byTool.entries()].map(([tool, list]) => {
      const timed = list.filter((t) => t.ms !== null);
      // `failed_in`: the sessions its failures happened in, the most first (ten of them; `failed_in_more` counts the rest).
      const inSessions = failures.get(tool) ?? [];
      return {
        tool, ...toolStats(list), p50_ms: pct(list.map((t) => t.ms), 0.5), p95_ms: pct(list.map((t) => t.ms), 0.95), timed: timed.length, total_ms: timed.length ? timed.reduce((n, t) => n + t.ms!, 0) : null,
        failed_in: inSessions.slice(0, 10).map(({ tool: _t, title, ...r }) => ({ ...r, ...(title !== null ? { title } : {}) })), ...(inSessions.length > 10 ? { failed_in_more: inSessions.length - 10 } : {}),
      };
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
    spend: spendOf(db, limits),
    error_kinds: [...errorKinds.entries()].map(([message, list]) => ({ message, count: list.length, last_ms: list.at(-1)!.ts })).sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

// Where the prompt tokens went: each request split into its zones (tools,
// system, frozen history, volatile tail) with how each zone was served
// (read from the cache, written to it, sent in full); in total, over time,
// and per turn (with a session: its last 30 turns).
export function tokensOf(db: Database, q: Filter) {
  const { calls, since, until, bucket } = rows(db, q);
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
    // The prompt on the turn's own branch: its nearest user ancestor, found
    // by walking up from the turn (a turn starts right under its prompt).
    const promptOf = db.query<{ id: string; data: string }, [string, string]>(`WITH RECURSIVE up(id, parent, kind, data) AS (
        SELECT id, parent, kind, data FROM events WHERE id = ?1 AND session_id = ?2
        UNION ALL SELECT e.id, e.parent, e.kind, e.data FROM events e JOIN up ON e.id = up.parent WHERE up.kind != 'user')
      SELECT id, data FROM up WHERE kind = 'user'`);
    const byTurn = group(measured.filter((c) => c.turn_event), (c) => c.turn_event!);
    turns = [...byTurn.entries()].slice(-30).map(([id, list]) => {
      const prompt = promptOf.get(id, q.session!);
      const text = prompt ? (JSON.parse(prompt.data) as { text?: unknown }).text : undefined;
      return { turn_event: id, ts_ms: list[0]!.ts, prompt: String(text ?? "").slice(0, 140), prompt_event: prompt?.id, requests: list.length, zones: sum(list), per_request: list.map((c) => ({ ts_ms: c.ts, purpose: c.purpose ?? "turn", zones: zoneCache({ tools: c.z_tools!, system: c.z_system!, history: c.z_history!, tail: c.z_tail! }, c) })) };
    });
  }
  return {
    since_ms: since, until_ms: until, bucket_ms: bucket, zones: ZONES, estimate: true,
    measured_calls: measured.length, calls: calls.length,
    total: sum(measured),
    series: [...series.entries()].sort(([a], [b]) => a - b).map(([t_ms, list]) => ({ t_ms, last_ms: list.at(-1)!.ts, calls: list.length, zones: sum(list) })),
    by_purpose: [...group(measured, (c) => c.purpose ?? "turn").entries()].map(([purpose, list]) => ({ purpose, calls: list.length, zones: sum(list) })),
    turns,
  };
}

// One side of a comparison: the calls and tool runs of a range or a model.
export function sideOf(db: Database, q: Filter) {
  const { calls, tools, since, until } = rows(db, q);
  const turn = calls.filter((c) => (c.purpose ?? "turn") === "turn");
  return { since_ms: since, until_ms: until, model: q.model ?? null, ...callStats(calls), ...toolStats(tools), cache_hit_ratio_turns: callStats(turn).cache_hit_ratio, classes: classCounts(calls),
    breaks: calls.filter((c) => c.cache_break).length, compactions: compactionCount(db, q) };
}

// How many compactions the filter matches (the ones the compactions report lists).
function compactionCount(db: Database, q: Filter): number {
  const where = ["kind = 'compaction'"];
  const args: (string | number)[] = [];
  if (q.session) { where.push("session_id = ?"); args.push(q.session); }
  if (q.since !== undefined) { where.push("ts >= ?"); args.push(q.since); }
  if (q.until !== undefined) { where.push("ts < ?"); args.push(q.until); }
  if (q.model) { where.push("json_extract(data, '$.model') = ?"); args.push(q.model); }
  return db.query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM events WHERE ${where.join(" AND ")}`).get(...args)!.n;
}
