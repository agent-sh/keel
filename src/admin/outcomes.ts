// What each turn came to and what shaped it, so a feature's value can be read
// from the data: one row per turn (its outcome, cost, tokens, cache share,
// tool failures and retries, and the features it ran with), the owner's
// rating of a reply, and what a feature saved against its counterfactual
// where the feature computes one (a readers job prices the working model
// reading the same material). Regressions in the daily values raise an alert.
//
// Only what the engine observes is recorded: a turn that ended normally is
// "ok", never "succeeded"; whether the work was right is the owner's rating
// or an offline experiment's check.
import { raise } from "../automation/alerts.ts";
import type { Session, StoredEvent } from "../core/types.ts";
import type { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import { registerHooks } from "../engine/hooks.ts";
import { armOf, type Experiments } from "./experiments.ts";
import { meanInterval, xmr, XMR_MIN, type Interval } from "./stats.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry_turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_event TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  ms INTEGER,
  reason TEXT NOT NULL,
  outcome TEXT NOT NULL,
  stopped_by TEXT,
  model TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  retried_steps INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_errors INTEGER NOT NULL DEFAULT 0,
  readers INTEGER NOT NULL DEFAULT 0,
  run_code INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  compaction_event TEXT,
  compacted_in_turn INTEGER NOT NULL DEFAULT 0,
  cache_ms INTEGER,
  speed TEXT,
  effort TEXT,
  toolset TEXT,
  exp_id TEXT,
  arm TEXT,
  rating INTEGER
);
CREATE INDEX IF NOT EXISTS telemetry_turns_ts ON telemetry_turns(ts);
CREATE INDEX IF NOT EXISTS telemetry_turns_session ON telemetry_turns(session_id, ts);
CREATE TABLE IF NOT EXISTS reply_ratings (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_event TEXT, value INTEGER NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS telemetry_savings (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, feature TEXT NOT NULL, call_id TEXT,
  cost REAL, cf_cost REAL, tokens INTEGER, cf_tokens INTEGER, model TEXT, exp_id TEXT, arm TEXT
);
CREATE INDEX IF NOT EXISTS telemetry_savings_ts ON telemetry_savings(ts);
`;

const READER_TOOLS = new Set(["AskReaders", "ask_readers"]);
const NORMAL = new Set(["end_turn", "stop_sequence", "stop"]);

// A turn's end reason as an outcome class.
export function outcomeOf(reason: string, stoppedBy?: string | null): string {
  if (NORMAL.has(reason)) return "ok";
  if (reason === "interrupted") return stoppedBy && stoppedBy !== "owner" ? "stopped_by_parent" : "stopped_by_owner";
  if (reason === "restart") return "cut";
  if (reason === "max_steps" || reason === "max_tokens") return "budget";
  if (reason === "refusal") return "refusal";
  return "error";
}
export const OUTCOMES = ["ok", "error", "refusal", "stopped_by_owner", "stopped_by_parent", "cut", "budget"] as const;

type Turn = Record<string, any>;
export type Filter = { since?: number; until?: number };
const DAY = 86_400_000;

export class Outcomes {
  constructor(private store: Store, private experiments?: Experiments) {
    store.migrate(SCHEMA);
    this.backfill();
    registerHooks({
      turnEnd: (s, reason) => {
        const row = this.recordTurn(s, reason);
        if (row) this.experiments?.check(s.id);
      },
      // A turn the daemon went down under had no end of its own: the next
      // start closed it, and no turnEnd ran. It is a cut turn like one a stop
      // parked, counted from the branch as that start left it.
      turnCut: (s, cut) => {
        if (!cut.crashed) return;
        const line = this.store.lineage(s.id);
        const at = line.findIndex((e) => e.id === cut.end_event);
        if (at >= 0) this.recordTurn(s, "restart", line.slice(0, at + 1));
      },
      // A readers job's result carries what the working model would have paid.
      resultStored: (s, results) => {
        if (!results.some((r) => r.tool_use_id)) return;
        const ev = this.store.db.query<{ data: string; ts: number }, [string]>("SELECT data, ts FROM events WHERE session_id = ? AND kind = 'tool_result' ORDER BY seq DESC LIMIT 1").get(s.id);
        if (ev) this.saving(s.id, ev.ts, JSON.parse(ev.data));
      },
    });
  }

  private saving(sessionId: string, ts: number, data: any) {
    for (const [callId, shown] of Object.entries((data?.shown ?? {}) as Record<string, any>)) {
      const r = shown?.readers;
      if (!r || r.whole || !r.working) continue;
      const tag = armOf(this.store, sessionId);
      const u = r.usage ?? {};
      this.store.db.query("INSERT INTO telemetry_savings (session_id, ts, feature, call_id, cost, cf_cost, tokens, cf_tokens, model, exp_id, arm) VALUES (?, ?, 'readers', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(sessionId, ts, callId, typeof r.cost === "number" ? r.cost : null, typeof r.working.cost === "number" ? r.working.cost : null,
          (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0) + (u.output ?? 0), r.working.tokens ?? null, r.working.model ?? null, tag?.exp_id ?? null, tag?.arm ?? null);
    }
  }

  // The turn that just ended: from its turn_start to its turn_end on the
  // session's branch, with the calls and tool runs of that span.
  recordTurn(s: Session, reason: string, line?: StoredEvent[]): Turn | undefined {
    const events = line ?? this.store.lineage(s.id);
    const endAt = events.findLastIndex((e) => e.kind === "turn_end");
    if (endAt < 0) return undefined;
    let startAt = endAt;
    while (startAt >= 0 && events[startAt]!.kind !== "turn_start") startAt--;
    if (startAt < 0) return undefined;
    return this.write(s.id, events.slice(startAt, endAt + 1), reason);
  }

  // The rollup of one turn. A request or tool run belongs to the turn whose id
  // it was recorded with (`turn_event`), whatever the clock says: two turns
  // that share a millisecond, or branches of one session, never count each
  // other's rows. A side request is in no turn. A row from before the ids
  // were recorded goes to one turn only: the last one of its session that
  // started at or before it (by time, then by order), when that turn was still
  // running at the row's time.
  private write(sessionId: string, span: StoredEvent[], reason: string): Turn | undefined {
    const start = span[0]!, end = span.at(-1)!;
    const db = this.store.db;
    const own = (table: string, cols: string) => db.query<any, [string]>(`SELECT ${cols} FROM ${table} r WHERE r.turn_event = ?`).all(start.id);
    // Rows without an id in the turn's time, read by the time range: the unary
    // plus keeps the planner off the turn_event index, which holds every row
    // without an id under one key.
    const undated = (table: string, cols: string, more = "") => db.query<any, [string, number, number]>(
      `SELECT ${cols} FROM ${table} r WHERE r.session_id = ? AND r.ts >= ? AND r.ts <= ? AND +r.turn_event IS NULL${more}`).all(sessionId, start.ts, end.ts);
    // When the next turn of the session started (by time, then by order): read
    // once a turn, and only when a row without an id is there to place.
    let next: { ts: number | null } | undefined;
    const placed = (rows: any[]) => {
      if (!rows.length) return rows;
      next ??= { ts: db.query<{ ts: number | null }, [string, number, number, number]>(
        "SELECT MIN(ts) AS ts FROM events WHERE session_id = ? AND kind = 'turn_start' AND (ts > ? OR (ts = ? AND seq > ?))").get(sessionId, start.ts, start.ts, start.seq)?.ts ?? null };
      const bound = next.ts;
      return bound === null ? rows : rows.filter((r) => r.ts < bound);
    };
    const rowsOf = (table: string, cols: string, more = "") => [...own(table, cols), ...placed(undated(table, cols, more))].sort((x, y) => x.ts - y.ts || x.id - y.id);
    const calls = rowsOf("telemetry_calls", "r.*", " AND COALESCE(r.purpose, 'turn') != 'side'").filter((c) => (c.purpose ?? "turn") !== "side");
    const tools: { tool: string; is_error: number }[] = rowsOf("telemetry_tools", "r.id, r.ts, r.tool, r.is_error");
    const ok = calls.filter((c) => c.outcome === "ok");
    const turnCalls = ok.filter((c) => (c.purpose ?? "turn") === "turn");
    const sum = (k: string) => ok.reduce((n, c) => n + (c[k] ?? 0), 0);
    const priced = calls.every((c) => !c.unpriced);
    const usage = end.data?.usage ?? {};
    const cost = calls.length ? (priced ? calls.reduce((n, c) => n + (c.cost ?? 0), 0) : null) : typeof usage.cost === "number" ? usage.cost : null;
    const last = turnCalls.at(-1) ?? calls.at(-1);
    const tag = armOf(this.store, sessionId);
    const stoppedBy = end.data?.stopped_by ?? null;
    const row: Turn = {
      session_id: sessionId, turn_event: start.id, ts: start.ts, ms: end.data?.ms ?? end.ts - start.ts, reason, outcome: outcomeOf(reason, stoppedBy), stopped_by: stoppedBy,
      model: last?.model ?? start.data?.model ?? null, requests: calls.length, failed_attempts: calls.filter((c) => c.outcome === "error").length,
      retried_steps: ok.filter((c) => (c.attempt ?? 1) > 1).length, tool_calls: tools.length, tool_errors: tools.filter((t) => t.is_error).length,
      readers: tools.filter((t) => READER_TOOLS.has(t.tool)).length, run_code: tools.filter((t) => t.tool === "run_code").length,
      input: calls.length ? sum("input") : usage.input ?? 0, output: calls.length ? sum("output") : usage.output ?? 0,
      cache_read: calls.length ? sum("cache_read") : usage.cache_read ?? 0, cache_write: calls.length ? sum("cache_write") : usage.cache_write ?? 0, cost,
      compaction_event: turnCalls[0]?.compaction_event || null, compacted_in_turn: span.some((e) => e.kind === "compaction") ? 1 : 0,
      cache_ms: last?.cache_ms ?? null, speed: last?.speed ?? null, effort: last?.effort ?? start.data?.effort ?? null, toolset: turnCalls[0]?.toolset ?? null,
      exp_id: tag?.exp_id ?? null, arm: tag?.arm ?? null,
      rating: db.query<{ v: number | null }, [string]>("SELECT MIN(value) AS v FROM reply_ratings WHERE turn_event = ?").get(start.id)?.v ?? null,
    };
    const cols = Object.keys(row);
    db.query(`INSERT INTO telemetry_turns (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
      ON CONFLICT(turn_event) DO UPDATE SET ${cols.filter((c) => c !== "turn_event").map((c) => `${c} = excluded.${c}`).join(", ")}`).run(...cols.map((c) => row[c]));
    return row;
  }

  // Turns from before this table: each stored turn_end, once.
  private backfill() {
    const db = this.store.db;
    if (db.query("SELECT 1 FROM admin_meta WHERE key = 'turns_backfill'").get()) return;
    const sessions = db.query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM events WHERE kind = 'turn_end'").all();
    db.transaction(() => {
      for (const { session_id } of sessions) {
        const evs = this.store.events(session_id);
        const byId = new Map(evs.map((e) => [e.id, e]));
        for (const end of evs.filter((e) => e.kind === "turn_end")) {
          const span: StoredEvent[] = [];
          for (let e: StoredEvent | undefined = end; e; e = e.parent ? byId.get(e.parent) : undefined) {
            span.push(e);
            if (e.kind === "turn_start") break;
          }
          if (span.at(-1)?.kind !== "turn_start") continue;
          this.write(session_id, span.reverse(), String(end.data?.reason ?? "end_turn"));
        }
        for (const e of evs) if (e.kind === "tool_result" && e.data?.shown) this.saving(session_id, e.ts, e.data);
      }
      db.query("INSERT OR REPLACE INTO admin_meta (key, value) VALUES ('turns_backfill', ?)").run(String(Date.now()));
    })();
  }

  // The owner's rating of a reply: 1 up, -1 down, 0 takes it back. Counted on
  // the turn that made the reply (a turn rated down anywhere is rated down).
  // `eventId` is the reply or its turn's turn_end.
  rate(eventId: string, value: number) {
    if (![1, -1, 0].includes(value)) throw Object.assign(new Error("value is 1, -1 or 0"), { status: 400 });
    const ev = this.store.event(eventId);
    // A reply, or the end of the turn whose reply it is (where the page shows the rating).
    if (!ev || (ev.kind !== "assistant" && ev.kind !== "turn_end")) throw Object.assign(new Error("no such reply"), { status: 404 });
    const line = lineage(this.store.events(ev.session_id), ev.id);
    const turn = line.findLast((e) => e.kind === "turn_start")?.id ?? null;
    const db = this.store.db;
    if (value === 0) db.query("DELETE FROM reply_ratings WHERE event_id = ?").run(eventId);
    else db.query("INSERT INTO reply_ratings (event_id, session_id, turn_event, value, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET value = excluded.value, ts = excluded.ts")
      .run(eventId, ev.session_id, turn, value, Date.now());
    if (turn) db.query("UPDATE telemetry_turns SET rating = (SELECT MIN(value) FROM reply_ratings WHERE turn_event = ?) WHERE turn_event = ?").run(turn, turn);
    return { event_id: eventId, value, turn_event: turn };
  }

  ratings(sessionId: string): Record<string, number> {
    return Object.fromEntries(this.store.db.query<{ event_id: string; value: number }, [string]>("SELECT event_id, value FROM reply_ratings WHERE session_id = ?").all(sessionId).map((r) => [r.event_id, r.value]));
  }

  // A session's turn rollups, oldest first.
  sessionTurns(sessionId: string): Turn[] {
    return this.store.db.query<Turn, [string]>("SELECT * FROM telemetry_turns WHERE session_id = ? ORDER BY ts, id").all(sessionId);
  }

  private turns(q: Filter): Turn[] {
    return this.store.db.query<Turn, [number, number]>("SELECT * FROM telemetry_turns WHERE ts >= ? AND ts < ? ORDER BY ts").all(q.since ?? 0, q.until ?? Date.now() + 1);
  }

  // Each feature's turns grouped by how the feature stood, over a range, with
  // the counterfactual savings where a feature computes them and a daily trend.
  features(q: Filter) {
    const turns = this.turns(q);
    const toolsets = new Map(this.store.db.query<{ h: string; names: string }, []>("SELECT h, names FROM telemetry_toolsets").all().map((r) => [r.h, JSON.parse(r.names) as string[]]));
    const tsLabel = toolsetLabels(turns, toolsets);
    const life = (ms: number | null) => (ms === null || ms === undefined ? "none stated" : ms >= 3_600_000 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`);
    const dims: { id: string; label: string; note: string; key: (t: Turn) => string | null }[] = [
      { id: "readers", label: "Readers", note: "turns that handed a reading job to reader models, against turns that did not", key: (t) => (t.readers > 0 ? "used" : "not used") },
      { id: "run_code", label: "Code mode", note: "turns that ran run_code, against turns that did not", key: (t) => (t.run_code > 0 ? "used" : "not used") },
      { id: "compaction", label: "Compaction", note: "turns on a compacted context, against turns on the full history", key: (t) => (t.compacted_in_turn ? "compacted during the turn" : t.compaction_event ? "after a compaction" : "full history") },
      { id: "cache_life", label: "Cache lifetime", note: "by the lifetime the turn's requests asked for", key: (t) => (t.requests ? life(t.cache_ms) : null) },
      { id: "speed", label: "Speed tier", note: "by the tier that served the turn", key: (t) => (t.requests ? t.speed ?? "standard" : null) },
      { id: "effort", label: "Effort", note: "by the effort the turn asked for", key: (t) => (t.requests ? t.effort ?? "model default" : null) },
      { id: "toolset", label: "Tool set", note: "by the tools offered, against the most used set", key: (t) => (t.toolset ? tsLabel.get(t.toolset) ?? t.toolset : null) },
      { id: "model", label: "Model", note: "by the model that answered", key: (t) => t.model ?? null },
      { id: "arm", label: "Experiment arm", note: "turns of sessions in an experiment, by arm", key: (t) => (t.arm ? t.arm : null) },
    ];
    const dimensions = dims.map((d) => {
      const groups = new Map<string, Turn[]>();
      let unrecorded = 0;
      for (const t of turns) {
        const k = d.key(t);
        if (k === null) { unrecorded++; continue; }
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
      }
      return { id: d.id, label: d.label, note: d.note, unrecorded, groups: [...groups.entries()].map(([value, list]) => ({ value, ...groupStats(list) })).sort((a, b) => b.turns - a.turns) };
    });
    return { since_ms: q.since ?? turns[0]?.ts ?? Date.now(), until_ms: q.until ?? Date.now(), turns: turns.length, observational: true,
      outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, turns.filter((t) => t.outcome === o).length])),
      total: groupStats(turns), dimensions, savings: this.savings(q), trend: this.trend(turns, q), regressions: this.regressions(Date.now(), false) };
  }

  private savings(q: Filter) {
    const rows = this.store.db.query<any, [number, number]>("SELECT * FROM telemetry_savings WHERE ts >= ? AND ts < ?").all(q.since ?? 0, q.until ?? Date.now() + 1);
    const by = new Map<string, any[]>();
    for (const r of rows) (by.get(r.feature) ?? by.set(r.feature, []).get(r.feature)!).push(r);
    return [...by.entries()].map(([feature, list]) => {
      const priced = list.filter((r) => r.cost !== null && r.cf_cost !== null);
      const saved = meanInterval(priced.map((r) => ({ v: r.cf_cost - r.cost, cluster: r.session_id })));
      return {
        feature, calls: list.length, priced: priced.length,
        cost_usd: priced.reduce((n, r) => n + r.cost, 0), counterfactual_usd: priced.reduce((n, r) => n + r.cf_cost, 0),
        saved_usd: priced.reduce((n, r) => n + r.cf_cost - r.cost, 0), saved_per_call: saved,
        tokens: list.reduce((n, r) => n + (r.tokens ?? 0), 0), counterfactual_tokens: list.reduce((n, r) => n + (r.cf_tokens ?? 0), 0),
        counterfactual: "the working model reading the same material once, uncached: a lower bound, since that material would then ride in every later request",
      };
    });
  }

  private trend(turns: Turn[], q: Filter) {
    const until = q.until ?? Date.now();
    const days = new Map<number, Turn[]>();
    for (const t of turns) {
      const k = until - Math.ceil((until - t.ts) / DAY) * DAY;
      (days.get(k) ?? days.set(k, []).get(k)!).push(t);
    }
    return [...days.entries()].sort(([a], [b]) => a - b).map(([t_ms, list]) => {
      const priced = list.filter((t) => t.cost !== null);
      const prompt = list.reduce((n, t) => n + t.input + t.cache_read + t.cache_write, 0);
      return {
        t_ms, last_ms: Math.max(...list.map((t) => t.ts)), turns: list.length, cost_per_turn: priced.length ? priced.reduce((n, t) => n + t.cost, 0) / priced.length : null,
        error_rate: list.filter((t) => t.outcome === "error").length / list.length, cache_read_share: prompt ? list.reduce((n, t) => n + t.cache_read, 0) / prompt : null,
        readers_share: list.filter((t) => t.readers > 0).length / list.length, run_code_share: list.filter((t) => t.run_code > 0).length / list.length,
      };
    });
  }

  // The last 24 hours of each watched metric against the 14 windows of 24
  // hours before it, on an XmR chart: outside the limits in the bad
  // direction is a regression, alerted once a day per metric when `alert`.
  regressions(now = Date.now(), alert = true) {
    const db = this.store.db;
    const window = (k: number) => [now - (k + 1) * DAY, now - k * DAY] as const;
    const metrics: { id: string; label: string; bad: "high" | "low"; value: (a: number, b: number) => { v: number; n: number } | null }[] = [
      { id: "cache_read_share", label: "cache read share of turn requests", bad: "low", value: (a, b) => {
        const r = db.query<{ read: number | null; prompt: number | null; n: number }, [number, number]>("SELECT SUM(cache_read) AS read, SUM(input + cache_read + cache_write) AS prompt, COUNT(*) AS n FROM telemetry_calls WHERE outcome = 'ok' AND COALESCE(purpose, 'turn') = 'turn' AND ts >= ? AND ts < ?").get(a, b)!;
        return r.prompt ? { v: r.read! / r.prompt, n: r.n } : null;
      } },
      { id: "error_rate", label: "share of model requests that failed", bad: "high", value: (a, b) => {
        const r = db.query<{ e: number; n: number }, [number, number]>("SELECT SUM(outcome = 'error') AS e, COUNT(*) AS n FROM telemetry_calls WHERE ts >= ? AND ts < ?").get(a, b)!;
        return r.n ? { v: r.e / r.n, n: r.n } : null;
      } },
      { id: "cost_per_turn", label: "mean cost per turn", bad: "high", value: (a, b) => {
        const r = db.query<{ c: number | null; n: number }, [number, number]>("SELECT AVG(cost) AS c, COUNT(cost) AS n FROM telemetry_turns WHERE ts >= ? AND ts < ?").get(a, b)!;
        return r.n ? { v: r.c!, n: r.n } : null;
      } },
    ];
    return metrics.map((m) => {
      const now0 = m.value(...window(0));
      const base = Array.from({ length: 14 }, (_, i) => m.value(...window(i + 1))).filter((x): x is { v: number; n: number } => !!x).reverse();
      const lim = xmr(base.map((b) => b.v));
      const status = !now0 ? "no data" : !lim ? "baseline too short" : now0.v > lim.upper ? "high" : now0.v < lim.lower ? "low" : "ok";
      const regression = status === m.bad;
      if (regression && alert) this.alertOnce(m.id, m.label, now0!.v, lim!);
      return { metric: m.id, label: m.label, bad: m.bad, value: now0?.v ?? null, n: now0?.n ?? 0, baseline_days: base.length, needs_days: XMR_MIN, limits: lim, status, regression };
    });
  }

  private alertOnce(metric: string, label: string, value: number, lim: { mean: number; lower: number; upper: number }) {
    const db = this.store.db;
    const key = `regression_alert:${metric}`;
    const last = Number(db.query<{ value: string }, [string]>("SELECT value FROM admin_meta WHERE key = ?").get(key)?.value ?? 0);
    if (Date.now() - last < DAY) return;
    db.query("INSERT OR REPLACE INTO admin_meta (key, value) VALUES (?, ?)").run(key, String(Date.now()));
    const f = (v: number) => (Math.abs(v) < 1 ? v.toPrecision(3) : v.toFixed(2));
    raise("regression", null, `Regression: ${label}`, `${label} over the last 24 hours is ${f(value)}, outside its normal range ${f(lim.lower)} to ${f(lim.upper)} (the 14 days before). Settings > Observability shows what changed.`,
      { metric, value, limits: lim, open_settings: "observability" });
  }
}

// Each tool set named by how it differs from the most used one.
function toolsetLabels(turns: Turn[], sets: Map<string, string[]>) {
  const count = new Map<string, number>();
  for (const t of turns) if (t.toolset) count.set(t.toolset, (count.get(t.toolset) ?? 0) + 1);
  const base = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const ref = new Set(base ? sets.get(base) ?? [] : []);
  const out = new Map<string, string>();
  for (const h of count.keys()) {
    const names = sets.get(h) ?? [];
    if (h === base) { out.set(h, `most used (${names.length} tools)`); continue; }
    const mine = new Set(names);
    const diff = [...names.filter((n) => !ref.has(n)).map((n) => `+${n}`), ...[...ref].filter((n) => !mine.has(n)).map((n) => `-${n}`)];
    out.set(h, diff.length > 6 ? `${names.length} tools (${diff.length} differ)` : diff.join(" ") || `${names.length} tools`);
  }
  return out;
}

function groupStats(list: Turn[]) {
  const priced = list.filter((t) => t.cost !== null);
  const prompt = list.reduce((n, t) => n + t.input + t.cache_read + t.cache_write, 0);
  const toolCalls = list.reduce((n, t) => n + t.tool_calls, 0);
  const ms = list.map((t) => t.ms).filter((x) => x !== null).sort((a, b) => a - b);
  const cost: Interval | null = priced.length ? meanInterval(priced.map((t) => ({ v: t.cost, cluster: t.session_id })), { reps: 1000 }) : null;
  return {
    turns: list.length, sessions: new Set(list.map((t) => t.session_id)).size,
    ok_rate: list.length ? list.filter((t) => t.outcome === "ok").length / list.length : null,
    error_rate: list.length ? list.filter((t) => t.outcome === "error").length / list.length : null,
    stopped_by_owner: list.filter((t) => t.outcome === "stopped_by_owner").length,
    refusals: list.filter((t) => t.outcome === "refusal").length,
    cost_per_turn: cost, priced_turns: priced.length,
    cache_read_share: prompt ? list.reduce((n, t) => n + t.cache_read, 0) / prompt : null,
    ms_p50: ms.length ? ms[Math.ceil(ms.length / 2) - 1] : null,
    tool_error_rate: toolCalls ? list.reduce((n, t) => n + t.tool_errors, 0) / toolCalls : null,
    retried_steps: list.reduce((n, t) => n + t.retried_steps, 0),
    thumbs_up: list.filter((t) => t.rating === 1).length, thumbs_down: list.filter((t) => t.rating === -1).length,
  };
}
