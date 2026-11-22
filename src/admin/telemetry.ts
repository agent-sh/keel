// Local telemetry: one row per model request (latency, time to first token,
// tokens, cost, outcome) and one per tool call that ran (duration, failure).
// Nothing leaves the machine. Rows are small and kept; a deleted session's
// rows stay so the totals over time do not change.
import { reasonLine } from "./reason.ts";
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import { SessionMap } from "../core/session-map.ts";
import { lineage } from "../core/tree.ts";
import { registerHooks } from "../engine/hooks.ts";
import { promptOf } from "../engine/prompt-store.ts";
import { adoptionBetween, EXPIRED } from "../engine/build-pin.ts";
import { errorText } from "../engine/retry.ts";
import type { ProviderRequest } from "../providers/types.ts";
import { errorClass } from "./classes.ts";
import { armOf, experimentTables } from "./experiments.ts";
import { registerSettings, settings } from "./settings.ts";
import { readsOf } from "../server/reads.ts";
import { BREAK_CAUSES, group, pct, spendOf, type CallRow, type Limits } from "./telemetry-report.ts";
import { scaleZones, ZONES, zoneBytes, type Zones } from "./zones.ts";

export { BREAK_CAUSES, pct, pickBucket } from "./telemetry-report.ts";
export type { ToolRow };

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
type Pending = { t0: number; step0: number; attempt: number; first?: number; text?: number; session: string; model: string; purpose: string; turn: string | null; compaction: string; line: readonly { id: string }[]; bytes: Zones; prefix: Prefix | null; cacheMs: number | null; toolset: string | null; effort: string | null };

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
  // Each session's running turn: its tool calls belong to it. Its request
  // says which it is; a call that runs before the turn's first request (a turn
  // resumed after a restart runs the calls it was cut in) reads it from the branch.
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
          turn, compaction: line.findLast((e) => e.kind === "compaction")?.id ?? "", line, bytes,
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
      // A new turn: what the last one's requests said is not this one's.
      turnStart: (s) => void this.turnOf.delete(s.id),
      toolRan: (s, call, result, ran) => {
        // The assistant step that asked for the call: its event and model.
        const ev = this.callEvent(s.id, call.id);
        let turn = this.turnOf.get(s.id);
        if (turn === undefined) this.turnOf.set(s.id, (turn = openTurn(this.lineageOf(s.id))));
        const tag = armOf(this.store, s.id);
        this.store.db
          .query("INSERT INTO telemetry_tools (session_id, ts, tool, ms, is_error, call_id, error, outcome, event_id, model, turn_event, exp_id, arm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(s.id, Date.now(), call.tool.name, ran.ms, ran.outcome === "error" ? 1 : 0, call.id, ran.outcome === "error" ? this.scrubbed(s.id, excerpt(result.content)) : null,
            ran.outcome, ev?.id ?? null, ev?.model ?? null, turn, tag?.exp_id ?? null, tag?.arm ?? null);
      },
    });
  }

  // The line of a failure as it is kept: a key-shaped token a command printed is scrubbed as in any
  // error text the store keeps.
  private scrubbed(sessionId: string, line: string): string {
    try { return String(this.store.redact(sessionId, "error", line)); } catch { return line; }
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

  // The branch the session shows, as the store keeps it: nothing is copied or
  // walked for a request of a long session.
  private lineageOf(id: string) {
    return this.store.lineage(id);
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
    const brk = r.outcome === "ok" && p.purpose === "turn" ? this.cacheBreak(p, u) : null;
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
    this.spent(p.t0, typeof u.cost === "number" ? u.cost : null, u.unpriced ? 1 : 0);
  }

  // A turn request that read less than half of what it and the last one of the
  // session share broke the cache, whatever its size: a prompt that shrank
  // because the wire left out stale thinking was written again all the same
  // (side requests are not turn requests and are never compared). Why, by what the
  // two requests' stored fingerprints, the history and the clock say; `detail`
  // names the parts of the prefix that differ.
  // The request knows the branch it was sent on and that branch's last compaction.
  private cacheBreak(p: Pending, u: any): { cause: string; detail: string | null } | null {
    const { session: sessionId, model, t0: ts, prefix: now } = p;
    const prev = this.store.db
      .query<{ ts: number; model: string; prompt: number; h_tools: string | null; h_system: string | null; n_msgs: number | null; h_msgs: string | null; h_kept: string | null; cache_ms: number | null; compaction_event: string | null; turn_event: string | null }, [string]>(
        "SELECT ts, model, input + cache_read + cache_write AS prompt, h_tools, h_system, n_msgs, h_msgs, h_kept, cache_ms, compaction_event, turn_event FROM telemetry_calls WHERE session_id = ? AND outcome = 'ok' AND COALESCE(purpose, 'turn') = 'turn' ORDER BY ts DESC LIMIT 1")
      .get(sessionId);
    if (!prev || prev.prompt <= 0) return null;
    const prompt = (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0);
    if ((u.cache_read ?? 0) >= 0.5 * Math.min(prev.prompt, prompt)) return null;
    // What the last request was sent on, as it recorded it: its turn and its
    // branch's last compaction. When either is not on this request's branch,
    // the session shows another branch (it went back, or to a sibling). When
    // both are and this branch's last compaction is another one, the history
    // was compacted since. Only a row from before the compaction was recorded
    // has the session's events searched (every event of it is read for that).
    const on = (id: string | null) => !id || p.line.some((e) => e.id === id);
    const switched = !on(prev.turn_event) || !on(prev.compaction_event);
    const compacted = prev.compaction_event === null ? this.compactedBetween(sessionId, prev.ts, ts) : !switched && prev.compaction_event !== p.compaction;
    // The blocks of the system prompt the engine replaced since the last request.
    const changed = promptOf(this.store, sessionId)?.changed;
    const diff = now ? prefixDiff(prev, now, changed && changed.ts > prev.ts && changed.ts <= ts ? changed.blocks : []) : null;
    // The session took the running build's tools and prompt in between
    // (src/engine/build-pin.ts): the detail names the tools and says why then.
    const took = adoptionBetween(this.store, sessionId, prev.ts, ts);
    const parts = (diff ?? []).map((d) => (d === "tools" && took?.tools.length ? `tools (${took.tools.slice(0, 8).join(", ")}${took.tools.length > 8 ? `, ${took.tools.length - 8} more` : ""})` : d));
    if (took) parts.push(`build ${took.to_build} taken: ${took.reason}`);
    return { cause: breakCause({ gapMs: ts - prev.ts, lifeMs: prev.cache_ms, modelChanged: prev.model !== model, compacted, switched, diff, tookExpired: took?.reason === EXPIRED }), detail: parts.length ? parts.join("; ") : null };
  }

  private compactedBetween(sessionId: string, a: number, b: number) {
    return !!this.store.db.query("SELECT 1 FROM events WHERE session_id = ? AND kind = 'compaction' AND ts > ? AND ts <= ? LIMIT 1").get(sessionId, a, b);
  }

  // Priced spend since local midnight and since the first of the month. A
  // budget is checked before every request, so the two sums are not read from
  // the ledger each time: they are read once for the day (and again when
  // another connection wrote to the database), and every request this daemon
  // records after that is added to them (spent). Whatever else changes the
  // ledger's rows of this month calls spendChanged.
  private totals?: { day: number; month: number; version: number; sums: { usd: number; unpriced: number }[] };
  private dataVersion(): number {
    return this.store.db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
  }
  spend(now = new Date()) {
    const limits = this.limits();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const version = this.dataVersion();
    let t = this.totals;
    if (!t || t.day !== day || t.month !== month || t.version !== version) {
      const s = spendOf(this.store.db, limits, now);
      t = this.totals = { day, month, version, sums: [{ usd: s.day.usd, unpriced: s.day.unpriced_calls }, { usd: s.month.usd, unpriced: s.month.unpriced_calls }] };
    }
    return {
      day: { since_ms: day, usd: t.sums[0]!.usd, unpriced_calls: t.sums[0]!.unpriced, limit_usd: limits.daily_usd },
      month: { since_ms: month, usd: t.sums[1]!.usd, unpriced_calls: t.sums[1]!.unpriced, limit_usd: limits.monthly_usd },
    };
  }
  // A request was recorded in the ledger with this start time, cost and unpriced mark.
  private spent(ts: number, cost: number | null, unpriced: number) {
    const t = this.totals;
    if (!t) return;
    for (const [i, since] of [t.day, t.month].entries()) {
      if (ts < since) continue;
      t.sums[i]!.usd += cost ?? 0;
      t.sums[i]!.unpriced += unpriced;
    }
  }
  // The ledger changed by another way than a recorded request: the sums are read again.
  spendChanged() {
    this.totals = undefined;
  }

  private limits(): Limits {
    const b = settings().budget;
    return { daily_usd: b.daily_usd as number | null, monthly_usd: b.monthly_usd as number | null };
  }

  private overBudget(): string | undefined {
    const b = settings().budget;
    if (!b.daily_usd && !b.monthly_usd) return undefined;
    let s = this.spend();
    // The running sums are plain additions and the ledger's SUM is a
    // compensated one, so the two can differ in their last digits: ten
    // requests of ten cents add up to a hair under a dollar here and to a
    // dollar there. A sum that stands this close to its limit, on either
    // side, is read from the ledger again, which then decides as it did when
    // every check read it: a budget is never a request late, or early.
    const close = (usd: number, limit: unknown) => typeof limit === "number" && limit > 0 && Math.abs(usd - limit) < 1e-6;
    if (close(s.day.usd, b.daily_usd) || close(s.month.usd, b.monthly_usd)) {
      this.totals = undefined;
      s = this.spend();
    }
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
  // The work grows with the events, not with their square: copies are found
  // through an index of the steps' and results' times made for this pass
  // (two events are compared byte for byte only when they share a time), and
  // each session's calls are read once, in order, to name its results.
  private backfill() {
    const db = this.store.db;
    if (db.query("SELECT 1 FROM admin_meta WHERE key = 'telemetry_backfill'").get()) return;
    db.transaction(() => {
      db.exec("CREATE TEMP TABLE telemetry_backfill_at AS SELECT rowid AS rid, kind, ts FROM events WHERE kind IN ('assistant', 'tool_result')");
      db.exec("CREATE INDEX temp.telemetry_backfill_at_ts ON telemetry_backfill_at (kind, ts, rid)");
      // The first stored copy of an event: no earlier row of its kind has its time and its bytes.
      const first = `NOT EXISTS (SELECT 1 FROM temp.telemetry_backfill_at t JOIN events c ON c.rowid = t.rid
        WHERE t.kind = e.kind AND t.ts = e.ts AND t.rid < e.rowid AND c.data = e.data)`;
      db.exec(`INSERT INTO telemetry_calls (session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, stop)
        SELECT e.session_id, e.ts, COALESCE(json_extract(e.data, '$.model'), s.model),
          COALESCE(json_extract(e.data, '$.usage.input'), 0), COALESCE(json_extract(e.data, '$.usage.output'), 0),
          COALESCE(json_extract(e.data, '$.usage.cache_read'), 0), COALESCE(json_extract(e.data, '$.usage.cache_write'), 0),
          json_extract(e.data, '$.usage.cost'), CASE WHEN json_extract(e.data, '$.usage.unpriced') > 0 THEN 1 ELSE 0 END,
          'ok', json_extract(e.data, '$.stop')
        FROM events e JOIN sessions s ON s.id = e.session_id
        WHERE e.kind = 'assistant' AND ${first}`);
      // A session's calls, oldest first: the newest step that holds a call id names it (callEvent).
      const calls = db.query<{ id: string; model: string | null; call: string | null; name: string | null }, [string]>(
        `SELECT e.id, json_extract(e.data, '$.model') AS model, json_extract(b.value, '$.id') AS call, json_extract(b.value, '$.name') AS name
          FROM events e, json_each(e.data, '$.blocks') b
          WHERE e.session_id = ? AND e.kind = 'assistant' AND json_extract(b.value, '$.type') = 'tool_use' ORDER BY e.seq`);
      const results = db.query<{ ts: number; call: string | null; is_error: number | null; text: number; content: string | null }, [string]>(
        `SELECT e.ts, json_extract(r.value, '$.tool_use_id') AS call, json_extract(r.value, '$.is_error') AS is_error,
            json_type(r.value, '$.content') = 'text' AS text, CASE WHEN json_extract(r.value, '$.is_error') THEN json_extract(r.value, '$.content') END AS content
          FROM events e, json_each(e.data, '$.results') r
          WHERE e.session_id = ? AND e.kind = 'tool_result' AND ${first} ORDER BY e.seq`);
      const insert = db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, call_id, error, outcome, event_id, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const { id } of db.query<{ id: string }, []>("SELECT id FROM sessions ORDER BY created, id").all()) {
        const uses = new Map<string, { id: string; model: string | null; name: string | null }>();
        for (const c of calls.iterate(id)) if (c.call) uses.set(c.call, c);
        for (const r of results.iterate(id)) {
          const use = r.call ? uses.get(r.call) : undefined;
          let content: unknown = r.content;
          if (r.is_error && !r.text && typeof content === "string") { try { content = JSON.parse(content); } catch { content = ""; } }
          insert.run(id, r.ts, use?.name ?? "?", r.is_error ? 1 : 0, r.call ?? null, r.is_error ? this.scrubbed(id, excerpt(content)) : null, r.is_error ? "error" : "ok", use?.id ?? null, use?.model ?? null);
        }
      }
      db.exec("DROP TABLE temp.telemetry_backfill_at");
      db.query("INSERT INTO admin_meta (key, value) VALUES ('telemetry_backfill', ?)").run(String(Date.now()));
    })();
  }

  // The report of the model requests and tool runs, read off the loop (a
  // ledger of hundreds of thousands of rows takes seconds to read and sum).
  report(q: Filter) {
    return readsOf(this.store).run("telemetry.report", { q, limits: this.limits() });
  }

  // Where the prompt tokens went (see tokensOf), read off the loop.
  tokens(q: Filter) {
    return readsOf(this.store).run("telemetry.tokens", { q });
  }

  // Each compaction: what started it, the context before and after (the
  // engine's estimate before; after, what the provider counted on the next
  // request), what the summary kept, what it cost and took, and how the
  // requests around it read the cache: the last one before and the first
  // AFTER_REQUESTS after.
  async compactions(q: Filter & { limit?: number }) {
    const where = ["e.kind = 'compaction'"];
    const args: (string | number)[] = [];
    if (q.session) { where.push("e.session_id = ?"); args.push(q.session); }
    if (q.since !== undefined) { where.push("e.ts >= ?"); args.push(q.since); }
    if (q.until !== undefined) { where.push("e.ts < ?"); args.push(q.until); }
    // Found by their kind among every event stored: read off the loop.
    const rows = await readsOf(this.store).sql<{ id: string; session_id: string; ts: number; seq: number; data: string; title: string | null }>(
      `SELECT e.id, e.session_id, e.ts, e.seq, e.data, s.title FROM events e LEFT JOIN sessions s ON s.id = e.session_id WHERE ${where.join(" AND ")} ORDER BY e.ts DESC`, args);
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
  async compare(a: Filter, b: Filter) {
    const reads = readsOf(this.store);
    return { a: await reads.run("telemetry.side", { q: a }), b: await reads.run("telemetry.side", { q: b }) };
  }
}

// The turn_start of the branch's running turn: the last one with no turn_end after it.
function openTurn(line: readonly { id: string; kind: string }[]): string | null {
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i]!.kind === "turn_end") return null;
    if (line[i]!.kind === "turn_start") return line[i]!.id;
  }
  return null;
}

export type Filter = { since?: number; until?: number; session?: string; model?: string; bucket?: number };
export const AFTER_REQUESTS = 3;

const hit = (c: { input: number; cache_read: number; cache_write: number }) => {
  const p = c.input + c.cache_read + c.cache_write;
  return p ? c.cache_read / p : null;
};
const ratio = (list: { prompt_tokens: number; cache_read: number }[]) => {
  const p = list.reduce((n, c) => n + c.prompt_tokens, 0);
  return p ? list.reduce((n, c) => n + c.cache_read, 0) / p : null;
};
// `diff`: the parts of the prefix that differ from the last request's (null:
// not recorded for it). A recorded difference is a changed prefix whatever
// the clock says; with none recorded, a gap past the lifetime the last request
// asked for (`lifeMs`) is an expiry, and a miss inside it, or on a route that
// states no lifetime, is the provider's.
// `tookExpired`: the session took the running build's tools and prompt at this
// request because its cache had expired (src/engine/build-pin.ts): the prefix
// differs only because nothing was left to keep, so the break is an expiry.
// `switched`: the request was sent on another branch than the last one (the
// history before it is another), with no compaction since.
export function breakCause(b: { gapMs: number; lifeMs?: number | null; modelChanged: boolean; compacted: boolean; switched?: boolean; diff?: string[] | null; tookExpired?: boolean }): (typeof BREAK_CAUSES)[number] {
  if (b.modelChanged) return "model_switch";
  if (b.compacted) return "compaction";
  if (b.switched) return "branch_switch";
  if (b.tookExpired) return "expired";
  if (b.diff?.length) return "prefix_changed";
  if (b.lifeMs && b.gapMs > b.lifeMs) return "expired";
  return b.diff ? "provider_miss" : "prefix_changed";
}

// One line of a failed result, at most 140 characters: a shell failure's last
// line that says something, any other's first (src/admin/reason.ts).
const excerpt = (content: unknown): string => reasonLine(content, 140);
type ToolRow = { ts: number; tool: string; ms: number | null; is_error: number };
