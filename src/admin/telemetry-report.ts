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

// The range of a report and the filter its queries share; the first request or tool run is read when the range has no start.
function scope(db: Database, q: Filter) {
  const where = ["1 = 1"];
  const args: (string | number)[] = [];
  if (q.session) { where.push("session_id = ?"); args.push(q.session); }
  if (q.model) { where.push("model = ?"); args.push(q.model); }
  if (q.since !== undefined) { where.push("ts >= ?"); args.push(q.since); }
  if (q.until !== undefined) { where.push("ts < ?"); args.push(q.until); }
  const w = where.join(" AND ");
  const first = (table: string) => db.query<{ ts: number | null }, any[]>(`SELECT MIN(ts) AS ts FROM ${table} WHERE ${w}`).get(...args)?.ts ?? undefined;
  const since = q.since ?? Math.min(first("telemetry_calls") ?? Date.now(), first("telemetry_tools") ?? Date.now());
  const until = q.until ?? Date.now();
  return { since, until, bucket: q.bucket ?? pickBucket(until - since), where: w, args };
}

function rows(db: Database, q: Filter) {
  const { where: w, args, ...range } = scope(db, q);
  const calls = db.query<CallRow, any[]>(`SELECT * FROM telemetry_calls WHERE ${w} ORDER BY ts`).all(...args);
  // A model filter keeps the tool calls that model's steps asked for (a row
  // whose step is not known is in no model's count).
  const tools = db.query<ToolRow, any[]>(`SELECT ts, tool, ms, is_error FROM telemetry_tools WHERE ${w} ORDER BY ts`).all(...args);
  return { calls, tools, ...range, where: w, args };
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

// Failed calls by tool and class, the most first: one query on the ledger's class column. `example`: the newest line of the class.
function failureClasses(db: Database, where: string, args: (string | number)[]) {
  return db.query<{ tool: string; class: string; count: number; last_ms: number; example: string | null }, any[]>(
    `SELECT tool, error_class AS class, COUNT(*) AS count, MAX(ts) AS last_ms, error AS example
     FROM telemetry_tools t WHERE ${where} AND is_error = 1 AND error_class IS NOT NULL GROUP BY tool, error_class ORDER BY count DESC, last_ms DESC LIMIT 50`).all(...args);
}

// The report reads the ledger by aggregates in SQL: what comes back to the loop's thread is one row a
// group (the whole range, a bucket, a model, a tool, a failure class), never a row of the ledger.
// A percentile is the value at its nearest rank (as `pct`): the ranks are worked out here from the
// group's counts and the values are picked by a window over the sorted column.
type Key = string;
type Where = { w: string; args: (string | number)[] };
type Pcts = Map<Key, Map<number, number>>; // group -> quantile -> value

// The group of a row, as text: `all` is every row together.
const BUCKET = (b: number) => `CAST(ts * 1.0 / ${b} AS INTEGER) * ${b}`;
const ALL = "'all'";

function percentilesOf(db: Database, table: string, { w, args }: Where, key: string, col: string, only: string, counts: Map<Key, number>, qs: number[]): Pcts {
  const ranks: [Key, number, number][] = [];
  for (const [k, n] of counts) for (const q of qs) ranks.push([k, Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1)) + 1, q]);
  const out: Pcts = new Map();
  if (!ranks.length) return out;
  const rows = db.query<{ k: string; rn: number; v: number }, any[]>(
    `SELECT k, rn, v FROM (SELECT CAST(${key} AS TEXT) AS k, ${col} AS v, ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY ${col}) AS rn
       FROM ${table} WHERE ${w} AND ${col} IS NOT NULL ${only}) WHERE (k, rn) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`)
    .all(...args, JSON.stringify(ranks.map(([k, rn]) => [k, rn])));
  const at = new Map(rows.map((r) => [`${r.k}\0${r.rn}`, r.v]));
  for (const [k, rn, q] of ranks) (out.get(k) ?? out.set(k, new Map()).get(k)!).set(q, at.get(`${k}\0${rn}`)!);
  return out;
}

type CallAgg = {
  k: Key; calls: number; errors: number; cache_breaks: number; interrupted: number; failed: number; unpriced: number; input: number; cache_read: number; cache_write: number; output: number; priced: number;
  retried: number; streamed: number; streamed_out: number; stream_ms: number; last_ms: number; first_ms: number; n_latency: number; n_ttft: number; n_text: number; n_step: number;
};
const STREAMED = "(latency_ms IS NOT NULL AND ttft_ms IS NOT NULL AND latency_ms > ttft_ms AND output > 0)";

// Every group of the key, its sums and its percentiles.
function callGroups(db: Database, wh: Where, key: string) {
  const groups = db.query<CallAgg, any[]>(
    `SELECT CAST(${key} AS TEXT) AS k, COUNT(*) AS calls, SUM(outcome = 'error') AS errors, SUM(COALESCE(cache_break, '') != '') AS cache_breaks, SUM(outcome = 'interrupted') AS interrupted,
       SUM(COALESCE(error_class, '') != '') AS failed, SUM(COALESCE(unpriced, 0) != 0) AS unpriced, SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(output) AS output,
       SUM(COALESCE(cost, 0)) AS priced, SUM(outcome = 'ok' AND COALESCE(attempt, 1) > 1) AS retried, SUM(${STREAMED}) AS streamed, SUM(CASE WHEN ${STREAMED} THEN output ELSE 0 END) AS streamed_out,
       SUM(CASE WHEN ${STREAMED} THEN latency_ms - ttft_ms ELSE 0 END) AS stream_ms, MAX(ts) AS last_ms, MIN(ts) AS first_ms,
       COUNT(latency_ms) AS n_latency, COUNT(ttft_ms) AS n_ttft, COUNT(text_ms) AS n_text, COUNT(CASE WHEN outcome = 'ok' THEN step_ms END) AS n_step
     FROM telemetry_calls WHERE ${wh.w} GROUP BY ${key}`).all(...wh.args);
  const counts = (f: (g: CallAgg) => number) => new Map(groups.map((g) => [g.k, f(g)] as const).filter(([, n]) => n > 0));
  const latency = percentilesOf(db, "telemetry_calls", wh, key, "latency_ms", "", counts((g) => g.n_latency), [0.5, 0.95]);
  const ttft = percentilesOf(db, "telemetry_calls", wh, key, "ttft_ms", "", counts((g) => g.n_ttft), [0.5, 0.95]);
  const text = percentilesOf(db, "telemetry_calls", wh, key, "text_ms", "", counts((g) => g.n_text), [0.5]);
  const step = percentilesOf(db, "telemetry_calls", wh, key, "step_ms", "AND outcome = 'ok'", counts((g) => g.n_step), [0.5, 0.95]);
  const by = new Map<Key, ReturnType<typeof statsOf>>();
  const pick = (m: Pcts, k: Key, q: number) => m.get(k)?.get(q) ?? null;
  for (const g of groups) by.set(g.k, statsOf(g, { latency_p50: pick(latency, g.k, 0.5), latency_p95: pick(latency, g.k, 0.95), ttft_p50: pick(ttft, g.k, 0.5), ttft_p95: pick(ttft, g.k, 0.95), first_text_p50: pick(text, g.k, 0.5), step_latency_p50: pick(step, g.k, 0.5), step_latency_p95: pick(step, g.k, 0.95) }));
  return { stats: by, aggs: new Map(groups.map((g) => [g.k, g])) };
}

// The numbers of `callStats`, from the sums of a group (none: the numbers of no calls).
function statsOf(g: CallAgg | undefined, p: Record<"latency_p50" | "latency_p95" | "ttft_p50" | "ttft_p95" | "first_text_p50" | "step_latency_p50" | "step_latency_p95", number | null>) {
  const n = (v: number | undefined) => v ?? 0;
  const calls = n(g?.calls), errors = n(g?.errors), unpriced = n(g?.unpriced), failed = n(g?.failed);
  const input = n(g?.input), cacheRead = n(g?.cache_read), cacheWrite = n(g?.cache_write), prompt = input + cacheRead + cacheWrite, priced = n(g?.priced);
  return {
    calls, errors, cache_breaks: n(g?.cache_breaks), interrupted: n(g?.interrupted), error_rate: calls ? errors / calls : 0, failed, failed_share: calls ? failed / calls : 0,
    latency_p50: p.latency_p50, latency_p95: p.latency_p95, ttft_p50: p.ttft_p50, ttft_p95: p.ttft_p95, first_text_p50: p.first_text_p50, step_latency_p50: p.step_latency_p50, step_latency_p95: p.step_latency_p95,
    retried_steps: n(g?.retried),
    speed_sample: { calls: n(g?.streamed), output_tokens: n(g?.streamed_out) },
    output_tokens_per_s: n(g?.stream_ms) ? (n(g?.streamed_out) / n(g?.stream_ms)) * 1000 : null,
    input_tokens: input, output_tokens: n(g?.output), cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, cache_hit_ratio: prompt ? cacheRead / prompt : null,
    priced_cost_usd: priced, unpriced_calls: unpriced, cost_usd: unpriced ? null : priced,
  };
}

type ToolAgg = { k: Key; tool_calls: number; tool_errors: number; timed: number; total_ms: number | null; last_ms: number };
function toolGroups(db: Database, wh: Where, key: string): Map<Key, ToolAgg> {
  return new Map(db.query<ToolAgg, any[]>(
    `SELECT CAST(${key} AS TEXT) AS k, COUNT(*) AS tool_calls, SUM(is_error != 0) AS tool_errors, COUNT(ms) AS timed, SUM(ms) AS total_ms, MAX(ts) AS last_ms FROM telemetry_tools WHERE ${wh.w} GROUP BY ${key}`)
    .all(...wh.args).map((g) => [g.k, g]));
}
const toolStatsOf = (g: ToolAgg | undefined) => ({ tool_calls: g?.tool_calls ?? 0, tool_errors: g?.tool_errors ?? 0, tool_error_rate: g?.tool_calls ? g.tool_errors / g.tool_calls : 0 });

export function reportOf(db: Database, q: Filter, limits: Limits) {
  const { since, until, bucket, where, args } = scope(db, q);
  const wh = { w: where, args };
  const failures = failedIn(db, where, args);
  const BY = BUCKET(bucket);
  const total = callGroups(db, wh, ALL), perBucket = callGroups(db, wh, BY), perModel = callGroups(db, wh, "model");
  const totalTools = toolGroups(db, wh, ALL), bucketTools = toolGroups(db, wh, BY), perTool = toolGroups(db, wh, "tool");
  const empty = statsOf(undefined, { latency_p50: null, latency_p95: null, ttft_p50: null, ttft_p95: null, first_text_p50: null, step_latency_p50: null, step_latency_p95: null });
  const toolMs = percentilesOf(db, "telemetry_tools", wh, "tool", "ms", "", new Map([...perTool].map(([k, g]) => [k, g.timed] as const).filter(([, n]) => n > 0)), [0.5, 0.95]);

  // The classes of failed requests in each bucket, and by model.
  const bucketClasses = new Map<Key, Record<string, number>>();
  for (const r of db.query<{ k: string; c: string; n: number }, any[]>(`SELECT CAST(${BY} AS TEXT) AS k, error_class AS c, COUNT(*) AS n FROM telemetry_calls WHERE ${where} AND COALESCE(error_class, '') != '' GROUP BY ${BY}, error_class ORDER BY MIN(ts), MIN(id)`).all(...args)) {
    (bucketClasses.get(r.k) ?? bucketClasses.set(r.k, {}).get(r.k)!)[r.c] = r.n;
  }
  const keys = [...new Set([...perBucket.stats.keys(), ...bucketTools.keys()])].sort((a, b) => Number(a) - Number(b));
  // Models in the order their first request came (as the rows were grouped when they were all read).
  const models = [...perModel.aggs.values()].sort((a, b) => a.first_ms - b.first_ms || 0);
  const modelClasses = db.query<{ model: string; c: string; n: number; last_ms: number }, any[]>(
    `SELECT model, error_class AS c, COUNT(*) AS n, MAX(ts) AS last_ms FROM telemetry_calls WHERE ${where} AND COALESCE(error_class, '') != '' GROUP BY model, error_class ORDER BY MIN(ts), MIN(id)`).all(...args);
  const lastError = new Map(db.query<{ model: string; c: string; error: string }, any[]>(
    `SELECT model, c, error FROM (SELECT model, error_class AS c, error, ROW_NUMBER() OVER (PARTITION BY model, error_class ORDER BY ts DESC, id DESC) AS rn
       FROM telemetry_calls WHERE ${where} AND COALESCE(error_class, '') != '' AND COALESCE(error, '') != '') WHERE rn = 1`).all(...args).map((r) => [`${r.model}\0${r.c}`, r.error]));

  const breakRows = db.query<{ cause: string; n: number; last_ms: number; uncached: number }, any[]>(
    `SELECT cache_break AS cause, COUNT(*) AS n, MAX(ts) AS last_ms, SUM(input + cache_write) AS uncached FROM telemetry_calls WHERE ${where} AND cache_break IN (SELECT value FROM json_each(?)) GROUP BY cache_break`)
    .all(...args, JSON.stringify(BREAK_CAUSES));
  const details = db.query<{ cause: string; detail: string; n: number }, any[]>(
    `SELECT cache_break AS cause, break_detail AS detail, COUNT(*) AS n FROM telemetry_calls WHERE ${where} AND cache_break IN (SELECT value FROM json_each(?)) AND COALESCE(break_detail, '') != '' GROUP BY cache_break, break_detail ORDER BY n DESC, MIN(ts), MIN(id)`)
    .all(...args, JSON.stringify(BREAK_CAUSES));
  const errorKinds = db.query<{ message: string; count: number; last_ms: number }, any[]>(
    `SELECT COALESCE(error, 'unknown') AS message, COUNT(*) AS count, MAX(ts) AS last_ms FROM telemetry_calls WHERE ${where} AND outcome = 'error' GROUP BY COALESCE(error, 'unknown') ORDER BY count DESC, MIN(ts), MIN(id) LIMIT 10`).all(...args);

  const allTotal = total.stats.get("all") ?? empty, allTools = totalTools.get("all");
  return {
    since_ms: since,
    until_ms: until,
    bucket_ms: bucket,
    total: { ...allTotal, ...toolStatsOf(allTools) },
    // `last_ms`: when the bucket's newest request or tool call was (a bucket starts on the clock's grid, which may be the day before).
    series: keys.map((k) => ({ t_ms: Number(k), last_ms: Math.max(perBucket.aggs.get(k)?.last_ms ?? 0, bucketTools.get(k)?.last_ms ?? 0), ...(perBucket.stats.get(k) ?? empty), ...toolStatsOf(bucketTools.get(k)), classes: bucketClasses.get(k) ?? {} })),
    by_model: models.map((m) => ({ model: m.k, ...perModel.stats.get(m.k)! })).sort((a, b) => b.calls - a.calls),
    // total_ms sums the timed calls only (`timed` of `tool_calls`); null when none was timed.
    tools: [...perTool.values()].map((g) => {
      // `failed_in`: the sessions its failures happened in, the most first (ten of them; `failed_in_more` counts the rest).
      const inSessions = failures.get(g.k) ?? [];
      return {
        tool: g.k, ...toolStatsOf(g), p50_ms: toolMs.get(g.k)?.get(0.5) ?? null, p95_ms: toolMs.get(g.k)?.get(0.95) ?? null, timed: g.timed, total_ms: g.timed ? g.total_ms : null,
        failed_in: inSessions.slice(0, 10).map(({ tool: _t, title, ...r }) => ({ ...r, ...(title !== null ? { title } : {}) })), ...(inSessions.length > 10 ? { failed_in_more: inSessions.length - 10 } : {}),
      };
    })
      .sort((a, b) => b.tool_calls - a.tool_calls),
    breaks: BREAK_CAUSES.map((cause) => {
      const r = breakRows.find((x) => x.cause === cause);
      return { cause, count: r?.n ?? 0, last_ms: r?.last_ms ?? null, uncached_tokens: r?.uncached ?? 0, details: details.filter((d) => d.cause === cause).map(({ detail, n }) => ({ detail, count: n })) };
    }).filter((b) => b.count),
    // Failures by class, per provider and model: `rate` is per request of that model.
    error_classes: models.flatMap((m) =>
      modelClasses.filter((c) => c.model === m.k).map((c) => ({
        provider: providerOf(m.k), model: m.k, class: c.c, count: c.n, calls: m.calls, rate: c.n / m.calls, last_ms: c.last_ms, last_error: lastError.get(`${m.k}\0${c.c}`) ?? null,
      }))).sort((a, b) => b.count - a.count),
    spend: spendOf(db, limits),
    tool_failure_classes: failureClasses(db, where, args),
    error_kinds: errorKinds,
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
