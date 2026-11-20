// Experiments: a hypothesis, arms that differ in configuration, the metric
// that judges them, guards that must not get worse, and a stop rule.
//
// Offline: scripts/bench/run.ts runs the arms over a fixed task set and
// uploads one row per run. Live: while one runs, every new top-level session
// gets an arm by a hash of the experiment and session ids (a subagent takes
// its parent's), keeps it for its life, and every telemetry row of it carries
// the experiment and the arm. A guard regression stops it by itself.
//
// An arm is a configuration difference for the life of its experiment, never
// a kept switch: the decision names what the losing side was, so its code
// path is removed.
import type { Session } from "../core/types.ts";
import type { Store } from "../core/store.ts";
import type { ProviderRequest } from "../providers/types.ts";
import { registerHooks } from "../engine/hooks.ts";
import { registerToolsOff } from "../tools/registry.ts";
import { assignArm, diffInterval, meanInterval, msprt, type Interval, type Unit } from "./stats.ts";

export const METRICS = {
  cost_usd: { label: "cost per turn", better: "lower", unit: "usd" },
  prompt_tokens: { label: "prompt tokens", better: "lower", unit: "tokens" },
  output_tokens: { label: "output tokens", better: "lower", unit: "tokens" },
  cache_read_share: { label: "cache read share", better: "higher", unit: "share" },
  ms: { label: "duration", better: "lower", unit: "ms" },
  // Live: the turn ended normally (no error, refusal, stop or cut); offline: the run passed its task's check.
  ok: { label: "ok rate", better: "higher", unit: "share" },
  error: { label: "ended in an error", better: "lower", unit: "share" },
  tool_errors: { label: "failed tool calls", better: "lower", unit: "count" },
  thumbs_down: { label: "replies rated down", better: "lower", unit: "share" },
  requests: { label: "model requests", better: "lower", unit: "count" },
} as const;
export type Metric = keyof typeof METRICS;

export type Arm = {
  name: string;
  weight?: number;
  tools_off?: string[];
  settings?: Record<string, unknown>; // session settings: effort, speed, compact_at, idle_compact
  system_append?: string;              // text added to the system prompt (kept with the session)
  cache_life?: "short" | "long";
  tool_text?: Record<string, string>;  // a tool's description in this arm, by tool name
  model?: string;                      // offline only: the model the arm runs on
};

// A request with the arm's tool descriptions in place (one per session, so its prefix holds).
export function withToolText(req: ProviderRequest, arm: Arm | undefined): ProviderRequest {
  const text = arm?.tool_text;
  if (!text || req.purpose === "reader") return req;
  return { ...req, tools: req.tools.map((t) => (typeof text[t.name] === "string" ? { ...t, description: text[t.name]! } : t)) };
}
// `mde`: the smallest change worth stopping for, in the metric's unit (or a
// share of the control's mean when `relative`). It sets the mSPRT mixture.
export type Guard = { metric: Metric; mde: number; relative?: boolean };
export type Stop = { sessions_per_arm?: number | null; alpha?: number; reps?: number; tasks?: string[]; model?: string };
export type Decision = { winner: string | null; verdict: "won" | "inconclusive" | "regression"; text: string; remove: string; ts: number };
export type Experiment = {
  id: string; name: string; hypothesis: string; mode: "offline" | "live"; template?: string;
  arms: Arm[]; primary: Metric; guards: Guard[]; stop: Stop;
  state: "draft" | "running" | "stopped"; created_ms: number; started_ms?: number; stopped_ms?: number; stop_reason?: string; decision?: Decision;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS experiment_sessions (session_id TEXT PRIMARY KEY, exp_id TEXT NOT NULL, arm TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS experiment_sessions_exp ON experiment_sessions(exp_id);
CREATE TABLE IF NOT EXISTS experiment_runs (id INTEGER PRIMARY KEY, exp_id TEXT NOT NULL, arm TEXT NOT NULL, task TEXT, rep INTEGER, ts INTEGER NOT NULL, metrics TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS experiment_runs_exp ON experiment_runs(exp_id);
`;
export const experimentTables = (store: Store) => store.migrate(SCHEMA);

// The arm a session runs in, for tagging rows: null when it is in none.
export function armOf(store: Store, sessionId: string): { exp_id: string; arm: string } | null {
  return store.db.query<{ exp_id: string; arm: string }, [string]>("SELECT exp_id, arm FROM experiment_sessions WHERE session_id = ?").get(sessionId) ?? null;
}

const READERS = ["AskReaders", "ask_readers"];
// Starting points; every field is editable before the experiment starts.
export const TEMPLATES: { id: string; label: string; make: () => Omit<Experiment, "id" | "state" | "created_ms"> }[] = [
  {
    id: "readers", label: "Readers on or off",
    make: () => ({ name: "Readers on or off", mode: "offline", template: "readers",
      hypothesis: "Handing reading jobs to cheaper reader models lowers the cost of a reading task without lowering how often it passes.",
      arms: [{ name: "readers on" }, { name: "readers off", tools_off: READERS }], primary: "cost_usd",
      guards: [{ metric: "ok", mde: 0.2 }], stop: { reps: 3 } }),
  },
  {
    id: "run_code", label: "Code mode on or off",
    make: () => ({ name: "Code mode on or off", mode: "offline", template: "run_code",
      hypothesis: "run_code lowers prompt tokens on multi-step tasks without more failures.",
      arms: [{ name: "run_code on" }, { name: "run_code off", tools_off: ["run_code"] }], primary: "prompt_tokens",
      guards: [{ metric: "ok", mde: 0.2 }], stop: { reps: 3 } }),
  },
  {
    id: "cache_life", label: "Cache lifetime short or long",
    make: () => ({ name: "Cache lifetime", mode: "live", template: "cache_life",
      hypothesis: "Asking for the long cache lifetime lowers cost per turn: the reads it saves after pauses outweigh its dearer writes.",
      arms: [{ name: "long", cache_life: "long" }, { name: "short", cache_life: "short" }], primary: "cost_usd",
      guards: [{ metric: "cost_usd", mde: 0.25, relative: true }, { metric: "error", mde: 0.1 }], stop: { sessions_per_arm: null } }),
  },
  {
    id: "prompt", label: "System prompt variant",
    make: () => ({ name: "System prompt variant", mode: "live", template: "prompt",
      hypothesis: "An added instruction changes outcomes without raising cost or errors.",
      arms: [{ name: "current" }, { name: "variant", system_append: "" }], primary: "thumbs_down",
      guards: [{ metric: "error", mde: 0.1 }, { metric: "cost_usd", mde: 0.25, relative: true }], stop: { sessions_per_arm: null } }),
  },
  {
    id: "effort", label: "Effort level",
    make: () => ({ name: "Effort level", mode: "live", template: "effort",
      hypothesis: "A lower effort cuts cost per turn without more errors or replies rated down.",
      arms: [{ name: "default" }, { name: "low", settings: { effort: "low" } }], primary: "cost_usd",
      guards: [{ metric: "error", mde: 0.1 }, { metric: "thumbs_down", mde: 0.1 }], stop: { sessions_per_arm: null } }),
  },
  {
    id: "speed", label: "Speed tier",
    make: () => ({ name: "Speed tier", mode: "live", template: "speed",
      hypothesis: "A faster tier shortens turns enough to be worth its price.",
      arms: [{ name: "standard" }, { name: "fast", settings: { speed: "" } }], primary: "ms",
      guards: [{ metric: "cost_usd", mde: 0.5, relative: true }, { metric: "error", mde: 0.1 }], stop: { sessions_per_arm: null } }),
  },
];

const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

// Checks a definition; throws a 400 with what is wrong.
export function validate(e: Partial<Experiment>): void {
  if (!e.name?.trim()) throw bad("an experiment has a name");
  if (!e.hypothesis?.trim()) throw bad("an experiment states its hypothesis");
  if (e.mode !== "offline" && e.mode !== "live") throw bad("mode is offline or live");
  if (!Array.isArray(e.arms) || e.arms.length < 2) throw bad("an experiment has at least two arms; the first is the control");
  const names = new Set<string>();
  for (const a of e.arms) {
    if (!a?.name?.trim()) throw bad("every arm has a name");
    if (names.has(a.name)) throw bad(`two arms are named ${a.name}`);
    names.add(a.name);
    if (a.weight !== undefined && !(a.weight >= 0)) throw bad(`arm ${a.name}: weight is a number of 0 or more`);
    if (a.cache_life !== undefined && a.cache_life !== "short" && a.cache_life !== "long") throw bad(`arm ${a.name}: cache_life is short or long`);
    if (a.tool_text !== undefined && (typeof a.tool_text !== "object" || Object.values(a.tool_text).some((v) => typeof v !== "string" || !v.trim()))) throw bad(`arm ${a.name}: tool_text maps tool names to their descriptions`);
    if (a.model && e.mode === "live") throw bad(`arm ${a.name}: a live arm keeps the owner's model; compare models offline`);
  }
  if (!e.arms.some((a) => (a.weight ?? 1) > 0)) throw bad("no arm has a weight above 0");
  if (!e.primary || !(e.primary in METRICS)) throw bad(`primary is one of ${Object.keys(METRICS).join(", ")}`);
  for (const g of e.guards ?? []) {
    if (!(g.metric in METRICS)) throw bad(`guard metric ${g.metric} is unknown`);
    if (!(g.mde > 0)) throw bad(`guard ${g.metric}: mde, the smallest change worth stopping for, is above 0`);
  }
  const n = e.stop?.sessions_per_arm;
  if (n !== undefined && n !== null && !(Number.isInteger(n) && n >= 2)) throw bad("sessions_per_arm is a whole number of 2 or more, or null");
}

// A guard's or primary's verdict by its direction: is the change good or bad.
export const worse = (m: Metric, diff: number) => (METRICS[m].better === "lower" ? diff > 0 : diff < 0);

export type ArmReport = { arm: string; units: number; clusters: number; metrics: Partial<Record<Metric, Interval>> };
export type Effect = { arm: string; metric: Metric; diff: Interval & { significant: boolean; relative: number | null }; better: boolean | null };
export type Report = { mode: Experiment["mode"]; unit: string; arms: ArmReport[]; effects: Effect[]; guards: { arm: string; metric: Metric; lr: number; reject: boolean; diff: number; worse: boolean }[]; decision: Decision };

type Row = { arm: string; cluster: string; stratum?: string; m: Partial<Record<Metric, number>> };

// Per-arm means with intervals, each arm's effect against the control, the
// guards' sequential tests, and what the data says now.
export function report(e: Experiment, rows: Row[]): Report {
  const control = e.arms[0]!.name;
  const metrics = [...new Set([e.primary, ...e.guards.map((g) => g.metric), ...(Object.keys(METRICS) as Metric[])])];
  const units = (arm: string, m: Metric): Unit[] => rows.filter((r) => r.arm === arm && typeof r.m[m] === "number" && Number.isFinite(r.m[m]))
    .map((r) => ({ v: r.m[m]!, cluster: r.cluster, stratum: r.stratum }));
  const arms = e.arms.map((a) => {
    const mine = rows.filter((r) => r.arm === a.name);
    const out: Partial<Record<Metric, Interval>> = {};
    for (const m of metrics) { const u = units(a.name, m); if (u.length) out[m] = meanInterval(u); }
    return { arm: a.name, units: mine.length, clusters: new Set(mine.map((r) => r.cluster)).size, metrics: out };
  });
  const effects: Effect[] = [];
  for (const a of e.arms.slice(1)) for (const m of metrics) {
    const ua = units(control, m), ub = units(a.name, m);
    if (!ua.length || !ub.length) continue;
    const diff = diffInterval(ua, ub);
    effects.push({ arm: a.name, metric: m, diff, better: diff.significant ? !worse(m, diff.estimate) : null });
  }
  const guards = guardTests(e, rows);
  return { mode: e.mode, unit: e.mode === "live" ? "turn (resampled by session)" : "run (resampled within task)", arms, effects, guards, decision: decide(e, effects, guards) };
}

// Guards on cluster means (one value per session or run: the randomized
// unit), each arm against the control, by mSPRT.
export function guardTests(e: Experiment, rows: Row[]): Report["guards"] {
  const control = e.arms[0]!.name;
  const perCluster = (arm: string, m: Metric) => {
    const by = new Map<string, number[]>();
    for (const r of rows) {
      const v = r.m[m];
      if (r.arm !== arm || typeof v !== "number" || !Number.isFinite(v)) continue;
      (by.get(r.cluster) ?? by.set(r.cluster, []).get(r.cluster)!).push(v);
    }
    return [...by.values()].map((v) => v.reduce((x, y) => x + y, 0) / v.length);
  };
  return e.arms.slice(1).flatMap((a) => e.guards.map((g) => {
    const ca = perCluster(control, g.metric), cb = perCluster(a.name, g.metric);
    const base = ca.length ? ca.reduce((x, y) => x + y, 0) / ca.length : 0;
    const tau = g.relative ? g.mde * Math.abs(base) : g.mde;
    const t = msprt(ca, cb, tau, e.stop.alpha ?? 0.05);
    return { arm: a.name, metric: g.metric, lr: t.lr, reject: t.reject, diff: t.diff, worse: t.reject && worse(g.metric, t.diff) };
  }));
}

function describe(a: Arm): string {
  const parts: string[] = [];
  if (a.tools_off?.length) parts.push(`without ${a.tools_off.join(", ")}`);
  for (const [k, v] of Object.entries(a.settings ?? {})) parts.push(`${k} ${JSON.stringify(v)}`);
  if (a.system_append) parts.push("the added system prompt text");
  if (a.cache_life) parts.push(`the ${a.cache_life} cache lifetime`);
  if (a.tool_text) parts.push(`the description of ${Object.keys(a.tool_text).join(", ")} it was given`);
  if (a.model) parts.push(`model ${a.model}`);
  return parts.join(", ") || "the current configuration";
}

// The arm that is significantly better on the primary metric with no guard
// significantly worse wins; a guard regression loses its arm; otherwise the
// result is inconclusive and the current path (the control) stays.
export function decide(e: Experiment, effects: Effect[], guards: Report["guards"]): Decision {
  const control = e.arms[0]!;
  const ts = Date.now();
  const hurt = guards.find((g) => g.worse);
  if (hurt) {
    const a = e.arms.find((x) => x.name === hurt.arm)!;
    return { winner: control.name, verdict: "regression", ts,
      text: `${hurt.arm} made ${METRICS[hurt.metric].label} worse (sequential test, likelihood ratio ${hurt.lr.toFixed(1)}): ${control.name} stays.`,
      remove: `Drop arm ${hurt.arm} (${describe(a)}).` };
  }
  const primary = effects.filter((f) => f.metric === e.primary && f.better === true && !guards.some((g) => g.arm === f.arm && g.worse));
  const best = primary.sort((x, y) => Math.abs(y.diff.estimate) - Math.abs(x.diff.estimate))[0];
  if (best) {
    const a = e.arms.find((x) => x.name === best.arm)!;
    return { winner: best.arm, verdict: "won", ts,
      text: `${best.arm} is better on ${METRICS[e.primary].label} by ${fmtValue(e.primary, Math.abs(best.diff.estimate))} (95% interval of the change ${fmtValue(e.primary, best.diff.lo)} to ${fmtValue(e.primary, best.diff.hi)}), with no guard worse.`,
      remove: `Make ${describe(a)} the only path and remove what ${control.name} had (${describe(control)}).` };
  }
  const worseArm = effects.find((f) => f.metric === e.primary && f.better === false);
  if (worseArm) {
    const a = e.arms.find((x) => x.name === worseArm.arm)!;
    return { winner: control.name, verdict: "won", ts,
      text: `${control.name} is better on ${METRICS[e.primary].label}: ${worseArm.arm} is worse by ${fmtValue(e.primary, Math.abs(worseArm.diff.estimate))} (95% interval of the change ${fmtValue(e.primary, worseArm.diff.lo)} to ${fmtValue(e.primary, worseArm.diff.hi)}).`,
      remove: `Drop arm ${worseArm.arm} (${describe(a)}); ${control.name} stays as it is.` };
  }
  return { winner: null, verdict: "inconclusive", ts,
    text: `No arm differs from ${control.name} on ${METRICS[e.primary].label} beyond chance at this sample size.`,
    remove: "Nothing proven: the variant does not ship, and the current path stays." };
}
// A value in the metric's unit.
export function fmtValue(m: Metric, v: number): string {
  const unit = METRICS[m].unit;
  const a = Math.abs(v), sign = v < 0 ? "-" : "";
  if (unit === "usd") return `${sign}$${a < 0.01 && a !== 0 ? a.toPrecision(2) : a.toFixed(4)}`;
  if (unit === "share") return `${(v * 100).toFixed(a < 0.1 && a !== 0 ? 1 : 0)} points`;
  if (unit === "ms") return `${(v / 1000).toFixed(1)} s`;
  return a < 10 ? Number(v.toFixed(2)).toString() : Math.round(v).toString();
}

export class Experiments {
  constructor(private store: Store, private onStop: (e: Experiment) => void = () => {}) {
    experimentTables(store);
    registerToolsOff("experiments", (sid) => this.armFor(sid)?.tools_off ?? []);
    registerHooks({
      turnStart: (s) => this.assign(s),
      // After the cache split: the prefix every session shares stays the same in both arms.
      sessionSystem: (s) => this.armFor(s.id)?.system_append ?? "",
      beforeRequest: (s, req) => {
        const arm = this.armFor(s.id);
        const life = req.purpose !== "reader" ? arm?.cache_life : undefined;
        return withToolText(life && !s.parent_id ? { ...req, cacheLife: life } : req, arm);
      },
    });
  }

  list(): Experiment[] {
    return this.store.db.query<{ data: string }, []>("SELECT data FROM experiments ORDER BY created DESC").all().map((r) => JSON.parse(r.data));
  }
  get(id: string): Experiment | undefined {
    const r = this.store.db.query<{ data: string }, [string]>("SELECT data FROM experiments WHERE id = ?").get(id);
    return r ? JSON.parse(r.data) : undefined;
  }
  private save(e: Experiment) {
    this.store.db.query("INSERT INTO experiments (id, state, created, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data")
      .run(e.id, e.state, e.created_ms, JSON.stringify(e));
    return e;
  }

  create(body: Partial<Experiment> & { template?: string }): Experiment {
    const base = body.template ? TEMPLATES.find((t) => t.id === body.template)?.make() : undefined;
    if (body.template && !base) throw bad(`no template ${body.template}`);
    const merged = { ...base, ...Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && k !== "template")) } as Partial<Experiment>;
    merged.guards ??= [];
    merged.stop ??= {};
    validate(merged);
    return this.save({ ...(merged as Experiment), template: body.template ?? merged.template, id: Bun.randomUUIDv7(), state: "draft", created_ms: Date.now() });
  }

  update(id: string, patch: Partial<Experiment>): Experiment {
    const e = this.must(id);
    if (e.state !== "draft") throw Object.assign(new Error("only a draft is edited: its arms are fixed once it starts"), { status: 409 });
    const next = { ...e, ...patch, id: e.id, state: e.state, created_ms: e.created_ms };
    validate(next);
    return this.save(next);
  }

  remove(id: string) {
    const e = this.must(id);
    if (e.state === "running") throw Object.assign(new Error("stop it first"), { status: 409 });
    this.store.db.transaction(() => {
      this.store.db.query("DELETE FROM experiments WHERE id = ?").run(id);
      this.store.db.query("DELETE FROM experiment_runs WHERE exp_id = ?").run(id);
    })();
  }

  private must(id: string) {
    const e = this.get(id);
    if (!e) throw Object.assign(new Error("no such experiment"), { status: 404 });
    return e;
  }

  // Live: one at a time, since two would split the same sessions.
  start(id: string): Experiment {
    const e = this.must(id);
    if (e.state !== "draft") throw Object.assign(new Error(`it is ${e.state}`), { status: 409 });
    if (e.mode === "live") {
      const other = this.running();
      if (other) throw Object.assign(new Error(`${other.name} is running live: stop it first`), { status: 409 });
    }
    return this.save({ ...e, state: "running", started_ms: Date.now() });
  }

  stop(id: string, reason = "stopped by the owner"): Experiment {
    const e = this.must(id);
    if (e.state !== "running") throw Object.assign(new Error(`it is ${e.state}`), { status: 409 });
    const r = this.report(e);
    const out = this.save({ ...e, state: "stopped", stopped_ms: Date.now(), stop_reason: reason, decision: r.decision });
    try { this.onStop(out); } catch { /* the stop stands; the caller's notice is best effort */ }
    return out;
  }

  running(): Experiment | undefined {
    return this.list().find((e) => e.state === "running" && e.mode === "live");
  }

  // The arm config a session runs with, for its life (after its experiment
  // stopped too: a frozen prompt and tool list stay as they were).
  armFor(sessionId: string): Arm | undefined {
    const tag = armOf(this.store, sessionId);
    if (!tag) return undefined;
    return this.get(tag.exp_id)?.arms.find((a) => a.name === tag.arm);
  }

  // A new top-level session joins the running live experiment at its first
  // turn; a subagent takes its parent's arm. Sessions from before the start,
  // and ones that already ran a turn, stay out.
  assign(s: Session) {
    if (armOf(this.store, s.id)) return;
    const db = this.store.db;
    if (s.parent_id) {
      const p = armOf(this.store, s.parent_id);
      if (p) db.query("INSERT OR IGNORE INTO experiment_sessions (session_id, exp_id, arm, ts) VALUES (?, ?, ?, ?)").run(s.id, p.exp_id, p.arm, Date.now());
      return;
    }
    const e = this.running();
    if (!e || s.created < (e.started_ms ?? Infinity)) return;
    if (db.query("SELECT 1 FROM events WHERE session_id = ? AND kind = 'turn_start' LIMIT 1").get(s.id)) return;
    const arm = e.arms[assignArm(e.id, s.id, e.arms.map((a) => a.weight ?? 1))]!;
    db.query("INSERT OR IGNORE INTO experiment_sessions (session_id, exp_id, arm, ts) VALUES (?, ?, ?, ?)").run(s.id, e.id, arm.name, Date.now());
    if (arm.settings && Object.keys(arm.settings).length) this.store.mergeSettings(s.id, arm.settings);
  }

  addRuns(id: string, runs: { arm: string; task?: string; rep?: number; metrics: Record<string, number> }[]) {
    const e = this.must(id);
    const names = new Set(e.arms.map((a) => a.name));
    for (const r of runs) {
      if (!names.has(r.arm)) throw bad(`no arm ${r.arm}`);
      if (!r.metrics || typeof r.metrics !== "object") throw bad("a run has metrics");
    }
    const q = this.store.db.query("INSERT INTO experiment_runs (exp_id, arm, task, rep, ts, metrics) VALUES (?, ?, ?, ?, ?, ?)");
    this.store.db.transaction(() => { for (const r of runs) q.run(id, r.arm, r.task ?? null, r.rep ?? null, Date.now(), JSON.stringify(r.metrics)); })();
    return runs.length;
  }

  rows(e: Experiment): Row[] {
    if (e.mode === "offline") {
      return this.store.db.query<{ id: number; arm: string; task: string | null; metrics: string }, [string]>("SELECT id, arm, task, metrics FROM experiment_runs WHERE exp_id = ?").all(e.id)
        .map((r) => ({ arm: r.arm, cluster: `run-${r.id}`, stratum: r.task ?? undefined, m: JSON.parse(r.metrics) }));
    }
    // Turns of the experiment's sessions while it ran.
    const until = e.stopped_ms ?? Date.now();
    return this.store.db.query<any, [string, number, number]>(
      `SELECT t.* FROM telemetry_turns t JOIN experiment_sessions x ON x.session_id = t.session_id WHERE x.exp_id = ? AND t.ts >= ? AND t.ts <= ?`).all(e.id, e.started_ms ?? 0, until)
      .map((t) => ({ arm: t.arm ?? "", cluster: t.session_id, m: turnMetrics(t) }));
  }

  report(e: Experiment) {
    return report(e, this.rows(e));
  }

  sessions(e: Experiment) {
    return this.store.db.query<{ arm: string; n: number }, [string]>("SELECT arm, COUNT(*) AS n FROM experiment_sessions WHERE exp_id = ? GROUP BY arm").all(e.id);
  }

  // After each turn of a session in the running live experiment: a guard
  // regression stops it; so does reaching the sessions per arm it asked for.
  check(sessionId: string) {
    const tag = armOf(this.store, sessionId);
    if (!tag) return;
    const e = this.get(tag.exp_id);
    if (!e || e.state !== "running" || e.mode !== "live") return;
    const rows = this.rows(e);
    const hurt = guardTests(e, rows).find((g) => g.worse);
    if (hurt) return this.stop(e.id, `guard: ${hurt.arm} made ${METRICS[hurt.metric].label} worse`);
    const n = e.stop.sessions_per_arm;
    if (n && e.arms.every((a) => new Set(rows.filter((r) => r.arm === a.name).map((r) => r.cluster)).size >= n)) return this.stop(e.id, `reached ${n} sessions per arm`);
  }
}

// A turn row's metric values.
export function turnMetrics(t: any): Partial<Record<Metric, number>> {
  const prompt = (t.input ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0);
  return {
    ...(t.cost !== null && t.cost !== undefined ? { cost_usd: t.cost } : {}),
    prompt_tokens: prompt, output_tokens: t.output ?? 0,
    ...(prompt ? { cache_read_share: (t.cache_read ?? 0) / prompt } : {}),
    ms: t.ms ?? 0, ok: t.outcome === "ok" ? 1 : 0, error: t.outcome === "error" ? 1 : 0,
    tool_errors: t.tool_errors ?? 0, thumbs_down: t.rating === -1 ? 1 : 0, requests: t.requests ?? 0,
  };
}
