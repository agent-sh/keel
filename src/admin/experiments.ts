// Experiments: a hypothesis, arms that differ in configuration, the metric
// that judges them, guards that must not get worse, and a stop rule.
//
// Offline: scripts/bench/run.ts runs the arms over a fixed task set and
// uploads one row per run. Live: while one runs, every new top-level session
// gets an arm by a hash of the experiment and session ids, keeps it for its
// life, and every telemetry row of it carries the experiment and the arm. A
// guard regression stops it by itself.
//
// The randomized unit of a live experiment is the session family: the
// top-level session that drew the arm (the root) with every subagent session
// under it. Subagents take the root's arm and its family key, so their turns
// count in the report, but the family is one independent sample: intervals
// resample families, guards read one value per family, and the cap
// (`stop.sessions_per_arm`) counts families per arm. The key is stored with
// the assignment.
//
// Live guards stop the experiment on sequential evidence that is valid at
// every look:
// - One observation per family, read once. A family's guard observation is
//   the mean of the metric over its first `stop.turns` turns to end (2 by
//   default), or, when fewer have ended by then, over the turns that ended
//   within its window: `stop.window_min` minutes from its assignment (a day
//   by default, the cycle sessions are used in). It is fixed at the first
//   look after that turn ended or the window closed, whichever came first,
//   stored, and never revised: later turns and later ratings stay out of
//   the guards (the report still counts them). Which turns it holds
//   follows from the family's own turns, not from when anyone looked.
//   Looks that reread a growing per-session mean are the within-unit
//   peeking that inflates sequential tests on open-ended metrics; an
//   observation fixed once per unit avoids it.
// - Why two turns: the first pays for the cold start, and the second is
//   the first to run on what the first left (the cache, the history), so
//   two is the smallest count that is not the cold start alone, and a
//   rating given to the first reply before the second ends is in it. More
//   turns would make each observation steadier and every family slower to
//   fix, and an arm that breaks turns is found by reading many families
//   early: with a day's window alone no guard could stop anything in the
//   first day. What only shows later in a family (a long context, a return
//   after a pause) the guards do not see; the report's intervals do.
// - Each enabled arm is tested against the control on each guard by
//   labelBet (stats.ts): observations enter in the order they were fixed,
//   and the bet is on which of the two arms each one came from. Any
//   worsening is evidence. `mde` (or `mde` times the pooled level when
//   `relative`) is the size the bets are tuned to find fastest, not an
//   amount that is tolerated.
// - The false-stop rule: the experiment stops when the average evidence
//   over all its tests (arms times guards) reaches 1 / alpha. The null is
//   "no arm changes anything about a family": not its observation, not
//   whether it has one, not when it is fixed. Then the arm of each family
//   is a draw by the weights that nothing observed predicts, in whatever
//   order the observations were fixed (the order may depend on what the
//   families did, since that does not depend on their arms). So each test
//   is a martingale in that one order, their average is one too (e-values
//   merge by averaging), and the chance that such an experiment is ever
//   stopped by a guard is at most alpha (0.05 unless `stop.alpha` says
//   otherwise), over all arms, guards and looks together. The stop names
//   the test with the most evidence.
// Offline guards are read once over the uploaded runs (mSPRT, each test at
// alpha): the run set is fixed in advance, so no look is repeated.
//
// A live winner on the primary metric is read once too. Its interval is for
// a sample size set in advance (`stop.sessions_per_arm`, session families
// per arm): read at a moment picked from the data, it has no stated error
// rate. So a live experiment names a winner only once every arm that gets
// sessions has that many families (it stops itself there), and one stopped
// sooner, or with no size set, ends without a winner.
//
// An offline run is uploaded under a receipt, a name the runner gives it
// once and keeps on disk. Uploading a receipt again with the same payload
// adds nothing and is acknowledged (the first answer may have been lost on
// the way); the same receipt with another payload is refused, and so is the
// whole batch it came in.
//
// A stop is final. The report the decision was read from is stored with it
// (the counts, the intervals, the guards, the families per arm), and a
// stopped experiment is read from that copy: a turn that started before the
// stop and ended after it, a rating changed later or a late upload does not
// revise what was decided.
//
// An arm is a configuration difference for the life of its experiment, never
// a kept switch: the decision names what the losing side was, so its code
// path is removed.
import type { Session } from "../core/types.ts";
import type { Store } from "../core/store.ts";
import type { ProviderRequest } from "../providers/types.ts";
import { registerHooks } from "../engine/hooks.ts";
import { registerToolsOff } from "../tools/registry.ts";
import { assignArm, diffInterval, labelBet, meanInterval, msprt, type Interval, type Unit } from "./stats.ts";

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
  if (!text || req.purpose === "reader" || req.purpose === "title") return req;
  return { ...req, tools: req.tools.map((t) => (typeof text[t.name] === "string" ? { ...t, description: text[t.name]! } : t)) };
}
// A guard stops on evidence of any worsening of its metric: no amount is
// tolerated. `mde` is the size of worsening its test is tuned to find
// fastest, in the metric's unit (or a share of the pooled level when
// `relative`): it sizes the live bets and sets the offline mSPRT mixture.
export type Guard = { metric: Metric; mde: number; relative?: boolean };
// Live: `sessions_per_arm`, the session families per arm the winner is read
// at; a family's guard observation is read over its first `turns` turns, or
// over `window_min` minutes from its assignment when fewer have ended.
export type Stop = { sessions_per_arm?: number | null; alpha?: number; window_min?: number; turns?: number; reps?: number; tasks?: string[]; model?: string };
export const WINDOW_MIN = 24 * 60;
export const TURNS = 2;
// The sample size a live template sets in advance: 64 session families per
// arm tell apart a difference of half a standard deviation of the family
// values with 80% power at 5%, two-sided (Lehr's rule, n = 16 / d squared,
// at d = 0.5). A starting point, edited before the start to fit the
// difference worth acting on.
export const FAMILIES_PER_ARM = 64;
// The chance a guard stops an experiment whose arms do not differ, unless `stop.alpha` names another.
export const ALPHA = 0.05;
export type Decision = { winner: string | null; verdict: "won" | "inconclusive" | "regression"; text: string; remove: string; ts: number };
export type RunUpload = { receipt: string; arm: string; task?: string; rep?: number; metrics: Record<string, number> };
const sorted = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
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
CREATE TABLE IF NOT EXISTS experiment_obs (seq INTEGER PRIMARY KEY, exp_id TEXT NOT NULL, root TEXT NOT NULL, arm TEXT NOT NULL, ts INTEGER NOT NULL, turns INTEGER NOT NULL, metrics TEXT NOT NULL, UNIQUE (exp_id, root));
CREATE TABLE IF NOT EXISTS experiment_reports (exp_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, data TEXT NOT NULL);
`;
export function experimentTables(store: Store) {
  store.migrate(SCHEMA);
  const db = store.db;
  if (!store.columnExists("experiment_sessions", "root")) db.exec("ALTER TABLE experiment_sessions ADD COLUMN root TEXT");
  if (!store.columnExists("experiment_runs", "receipt")) db.exec("ALTER TABLE experiment_runs ADD COLUMN receipt TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS experiment_runs_receipt ON experiment_runs(exp_id, receipt) WHERE receipt IS NOT NULL");
  // A family's sessions are read by its key (its turns, at every look).
  db.exec("CREATE INDEX IF NOT EXISTS experiment_sessions_root ON experiment_sessions(exp_id, root)");
  // Assignments from before the family key: the root is the highest ancestor
  // in the same experiment. All of them or none, so every row has a key once
  // this has run and no reader has to allow for a missing one.
  const old = db.query<{ session_id: string; exp_id: string }, []>("SELECT session_id, exp_id FROM experiment_sessions WHERE root IS NULL").all();
  if (!old.length) return;
  const inExp = db.query<{ exp_id: string }, [string]>("SELECT exp_id FROM experiment_sessions WHERE session_id = ?");
  const parent = store.columnExists("sessions", "parent_id") ? db.query<{ parent_id: string | null }, [string]>("SELECT parent_id FROM sessions WHERE id = ?") : null;
  const set = db.query("UPDATE experiment_sessions SET root = ? WHERE session_id = ?");
  db.transaction(() => {
    for (const r of old) {
      let root = r.session_id;
      for (let up = parent?.get(root)?.parent_id; up && inExp.get(up)?.exp_id === r.exp_id; up = parent?.get(up)?.parent_id) root = up;
      set.run(root, r.session_id);
    }
  })();
}

// The arm a session runs in, for tagging rows: null when it is in none.
// `root` is its family: the top-level session that drew the arm.
export function armOf(store: Store, sessionId: string): { exp_id: string; arm: string; root: string } | null {
  return store.db.query<{ exp_id: string; arm: string; root: string }, [string]>("SELECT exp_id, arm, root FROM experiment_sessions WHERE session_id = ?").get(sessionId) ?? null;
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
      guards: [{ metric: "cost_usd", mde: 0.25, relative: true }, { metric: "error", mde: 0.1 }], stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
  },
  {
    id: "prompt", label: "System prompt variant",
    make: () => ({ name: "System prompt variant", mode: "live", template: "prompt",
      hypothesis: "An added instruction changes outcomes without raising cost or errors.",
      arms: [{ name: "current" }, { name: "variant", system_append: "" }], primary: "thumbs_down",
      guards: [{ metric: "error", mde: 0.1 }, { metric: "cost_usd", mde: 0.25, relative: true }], stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
  },
  {
    id: "effort", label: "Effort level",
    make: () => ({ name: "Effort level", mode: "live", template: "effort",
      hypothesis: "A lower effort cuts cost per turn without more errors or replies rated down.",
      arms: [{ name: "default" }, { name: "low", settings: { effort: "low" } }], primary: "cost_usd",
      guards: [{ metric: "error", mde: 0.1 }, { metric: "thumbs_down", mde: 0.1 }], stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
  },
  {
    // Half of the new session trees: in the price arm their agents compact by price (src/engine/price-compact.ts).
    id: "compact_price", label: "Agents compact by price",
    make: () => ({ name: "Compaction by price", mode: "live", template: "compact_price",
      hypothesis: "Agents that compact when a summary costs less than reading their context over the steps ahead cost less per turn, without more errors or failed tool calls.",
      arms: [{ name: "window" }, { name: "price", settings: { compact_by_price: true } }], primary: "cost_usd",
      guards: [{ metric: "error", mde: 0.1 }, { metric: "tool_errors", mde: 0.25, relative: true }], stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
  },
  {
    id: "speed", label: "Speed tier",
    make: () => ({ name: "Speed tier", mode: "live", template: "speed",
      hypothesis: "A faster tier shortens turns enough to be worth its price.",
      arms: [{ name: "standard" }, { name: "fast", settings: { speed: "" } }], primary: "ms",
      guards: [{ metric: "cost_usd", mde: 0.5, relative: true }, { metric: "error", mde: 0.1 }], stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
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
  if (e.mode === "live" && !((e.arms[0]!.weight ?? 1) > 0)) throw bad(`arm ${e.arms[0]!.name} is the control, which every arm is compared with: in a live experiment its weight is above 0`);
  if (!e.primary || !(e.primary in METRICS)) throw bad(`primary is one of ${Object.keys(METRICS).join(", ")}`);
  for (const g of e.guards ?? []) {
    if (!(g.metric in METRICS)) throw bad(`guard metric ${g.metric} is unknown`);
    if (!(g.mde > 0)) throw bad(`guard ${g.metric}: mde, the size of worsening the guard is tuned to find fastest, is above 0`);
  }
  const alpha = e.stop?.alpha;
  if (alpha !== undefined && !(typeof alpha === "number" && alpha > 0 && alpha < 1)) throw bad("alpha, the chance a guard stops an experiment whose arms do not differ, is a number above 0 and below 1");
  const w = e.stop?.window_min;
  if (w !== undefined && !(typeof w === "number" && w > 0 && Number.isFinite(w))) throw bad("window_min, the minutes a family's guard observation is read over, is above 0");
  const k = e.stop?.turns;
  if (k !== undefined && !(Number.isInteger(k) && k >= 1)) throw bad("turns, the first turns of a family its guard observation is read over, is a whole number of 1 or more");
  const n = e.stop?.sessions_per_arm;
  if (n !== undefined && n !== null && !(Number.isInteger(n) && n >= 2)) throw bad("sessions_per_arm, the session families per arm, is a whole number of 2 or more, or null");
}

// A guard's or primary's verdict by its direction: is the change good or bad.
export const worse = (m: Metric, diff: number) => (METRICS[m].better === "lower" ? diff > 0 : diff < 0);

export type ArmReport = { arm: string; units: number; clusters: number; metrics: Partial<Record<Metric, Interval>> };
export type Effect = { arm: string; metric: Metric; diff: Interval & { significant: boolean; relative: number | null }; better: boolean | null };
// A guard test: `lr` its evidence, `n` the independent samples it read (the
// control's and the arm's), `diff` the arm's mean minus the control's over them.
export type GuardTest = { arm: string; metric: Metric; lr: number; reject: boolean; diff: number; worse: boolean; n: [number, number] };
// Live: the evidence the stop rule reads (the average over `tests`), what it
// stops at, and the families read and still open (not read yet).
export type GuardState = { evidence: number; threshold: number; tests: number; window_min: number; turns: number; fixed: number; pending: number };
// `final_ms`: when the experiment stopped and this report was frozen.
// `threshold`: the evidence a guard needs, 1 / alpha (live: the average over the tests).
// `judged`: the primary metric's winner can be read (offline: always; live:
// every arm that gets sessions has the families per arm set in advance).
export type Report = { mode: Experiment["mode"]; unit: string; arms: ArmReport[]; effects: Effect[]; guards: GuardTest[]; threshold: number; judged: boolean; guard?: GuardState; decision: Decision; final_ms?: number };
// A family's fixed guard observation: its mean of each metric over its window.
export type Obs = { arm: string; m: Partial<Record<Metric, number>> };
export type Live = { obs: Obs[]; pending: number };
// A family's turn as its guard observation reads it: when it ended and its metric values.
export type FamilyTurn = { end: number; m: Partial<Record<Metric, number>> };

// A family's guard observation by `now`, or null while it is still open:
// the mean of each metric over its first `k` turns to end, or over the turns
// that ended within `windowMs` of its assignment when fewer than `k` did.
// `at` is when it became fixed. The same turns give the same answer at every
// later `now`, so it does not matter when the look came.
export function familyObs(turns: FamilyTurn[], assigned: number, now: number, k: number, windowMs: number): { at: number; turns: number; m: Partial<Record<Metric, number>> } | null {
  const close = assigned + windowMs;
  const read = turns.filter((t) => t.end <= close && t.end <= now).sort((a, b) => a.end - b.end).slice(0, k);
  const full = read.length >= k;
  if (!full && now < close) return null;
  const m: Partial<Record<Metric, number>> = {};
  for (const key of Object.keys(METRICS) as Metric[]) {
    const vs = read.map((t) => t.m[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (vs.length) m[key] = vs.reduce((a, v) => a + v, 0) / vs.length;
  }
  return { at: full ? read.at(-1)!.end : close, turns: read.length, m };
}

// Whether a live experiment has the sample size it set in advance: every arm that gets sessions has that many families.
const capReached = (e: Experiment, arms: ArmReport[]) => {
  const n = e.stop.sessions_per_arm;
  return !!n && e.arms.every((a) => !((a.weight ?? 1) > 0) || (arms.find((x) => x.arm === a.name)?.clusters ?? 0) >= n);
};
// What a stopped experiment is read from.
export type Final = { report: Report; sessions: { arm: string; n: number }[]; runs: number };

type Row = { arm: string; cluster: string; stratum?: string; m: Partial<Record<Metric, number>> };

// Per-arm means with intervals, each arm's effect against the control, the
// guards' tests, and what the data says now. `live`: a live experiment's
// fixed guard observations, in the order they were fixed.
export function report(e: Experiment, rows: Row[], live?: Live): Report {
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
  const seq = e.mode === "live" ? liveGuards(e, live?.obs ?? []) : undefined;
  const guards = seq?.guards ?? guardTests(e, rows);
  const guard = seq && { evidence: seq.evidence, threshold: seq.threshold, tests: seq.tests, window_min: e.stop.window_min ?? WINDOW_MIN, turns: e.stop.turns ?? TURNS, fixed: live?.obs.length ?? 0, pending: live?.pending ?? 0 };
  const judged = e.mode === "offline" || capReached(e, arms);
  return { mode: e.mode, unit: e.mode === "live" ? "turn (resampled by session family)" : "run (resampled within task)", arms, effects, guards, threshold: 1 / (e.stop.alpha ?? ALPHA), judged, ...(guard ? { guard } : {}), decision: decide(e, effects, guards, arms) };
}

// Live guards over the fixed family observations, in the order they were
// fixed: each enabled arm against the control on each guard, and the average
// evidence the stop rule reads (see the top of this file). `look` is told
// the evidence after each observation: every one is a valid place to stop.
export function liveGuards(e: Experiment, obs: Obs[], look?: (seen: number, evidence: number) => void) {
  const control = e.arms[0]!, w0 = control.weight ?? 1;
  const tests = e.arms.slice(1).flatMap((a) => {
    const w = a.weight ?? 1;
    if (!(w0 > 0) || !(w > 0)) return [];
    return e.guards.map((g) => ({
      arm: a.name, metric: g.metric, sign: METRICS[g.metric].better === "lower" ? 1 : -1, n: [0, 0] as [number, number], sum: [0, 0],
      bet: labelBet(w / (w0 + w), (level) => (g.relative ? g.mde * Math.abs(level) : g.mde)),
    }));
  });
  const threshold = 1 / (e.stop.alpha ?? ALPHA);
  const average = () => (tests.length ? tests.reduce((n, t) => n + t.bet.evidence, 0) / tests.length : 1);
  obs.forEach((o, i) => {
    for (const t of tests) {
      const v = o.m[t.metric];
      const side = o.arm === control.name ? 0 : o.arm === t.arm ? 1 : null;
      if (side === null || typeof v !== "number" || !Number.isFinite(v)) continue;
      t.n[side]++;
      t.sum[side] = t.sum[side]! + v;
      t.bet.add(t.sign * v, side === 1);
    }
    look?.(i + 1, average());
  });
  const evidence = average();
  const top = evidence >= threshold ? tests.reduce((a, t) => (t.bet.evidence > a.bet.evidence ? t : a), tests[0]!) : undefined;
  const guards: GuardTest[] = tests.map((t) => ({
    arm: t.arm, metric: t.metric, lr: t.bet.evidence, reject: t === top, worse: t === top, n: t.n,
    diff: t.n[0] && t.n[1] ? t.sum[1]! / t.n[1] - t.sum[0]! / t.n[0] : NaN,
  }));
  return { guards, evidence, threshold, tests: tests.length };
}

// Offline guards on run values, each arm against the control, by mSPRT,
// read once over the uploaded runs.
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
    const t = msprt(ca, cb, tau, e.stop.alpha ?? ALPHA);
    return { arm: a.name, metric: g.metric, lr: t.lr, reject: t.reject, diff: t.diff, worse: t.reject && worse(g.metric, t.diff), n: [ca.length, cb.length] as [number, number] };
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
// significantly worse wins; a guard regression loses its arm; the control
// wins when every arm compared with it is significantly worse; otherwise the
// result is inconclusive and the current path (the control) stays. A live
// experiment has no winner before the sample size it set in advance.
export function decide(e: Experiment, effects: Effect[], guards: Report["guards"], arms: ArmReport[]): Decision {
  const control = e.arms[0]!;
  const ts = Date.now();
  const hurt = guards.find((g) => g.worse);
  if (hurt) {
    const a = e.arms.find((x) => x.name === hurt.arm)!;
    return { winner: control.name, verdict: "regression", ts,
      text: `${hurt.arm} made ${METRICS[hurt.metric].label} worse (${e.mode === "live" ? "sequential evidence" : "likelihood ratio"} ${hurt.lr >= 1000 ? "above 1000" : hurt.lr.toFixed(1)}): ${control.name} stays.`,
      remove: `Drop arm ${hurt.arm} (${describe(a)}).` };
  }
  if (e.mode === "live" && !capReached(e, arms)) {
    const n = e.stop.sessions_per_arm;
    const have = e.arms.filter((a) => (a.weight ?? 1) > 0).map((a) => `${a.name} ${arms.find((x) => x.arm === a.name)?.clusters ?? 0}`).join(", ");
    return { winner: null, verdict: "inconclusive", ts,
      text: n && e.state === "stopped"
        ? `No winner: it stopped before the ${n} session families per arm it set (it had: ${have}). The interval of ${METRICS[e.primary].label} is for that sample size; read at a moment picked from the data, it has no stated error rate.`
        : n
        ? `No winner yet: ${METRICS[e.primary].label} is judged once, when every arm has ${n} session families (now: ${have}). Its interval is for a sample size set in advance; read sooner, at a moment picked from the data, it has no stated error rate.`
        : `No winner is named: this experiment set no sample size in advance (stop.sessions_per_arm), and an interval read at a moment picked from the data has no stated error rate. The intervals describe the data so far (session families: ${have}).`,
      remove: "Nothing proven: the variant does not ship, and the current path stays." };
  }
  // The arms the control is compared with.
  const compared = e.arms.slice(1).filter((a) => e.mode === "offline" || (a.weight ?? 1) > 0);
  // A winner is named only on a primary metric every unit of the arms has. A
  // unit without it (a cost with no price) is left out of the mean, and the
  // units that do have it are not a fair sample of their arm: which ones
  // could be priced can depend on what the arm did.
  const lacking = [control, ...compared].flatMap((a) => {
    const r = arms.find((x) => x.arm === a.name), n = r?.metrics[e.primary]?.n ?? 0;
    return r && n < r.units ? [`${n} of ${r.units} ${e.mode === "live" ? "turns" : "runs"} of ${a.name}`] : [];
  });
  if (lacking.length) {
    return { winner: null, verdict: "inconclusive", ts,
      text: `No winner is named: ${METRICS[e.primary].label} is known for ${lacking.join(" and ")} only, and an arm is not judged on a part of it.`,
      remove: "Nothing proven: the variant does not ship, and the current path stays." };
  }
  const primary = effects.filter((f) => f.metric === e.primary && f.better === true && !guards.some((g) => g.arm === f.arm && g.worse));
  const best = primary.sort((x, y) => Math.abs(y.diff.estimate) - Math.abs(x.diff.estimate))[0];
  if (best) {
    const a = e.arms.find((x) => x.name === best.arm)!;
    return { winner: best.arm, verdict: "won", ts,
      text: `${best.arm} is better on ${METRICS[e.primary].label} by ${fmtValue(e.primary, Math.abs(best.diff.estimate))} (95% interval of the change ${fmtValue(e.primary, best.diff.lo)} to ${fmtValue(e.primary, best.diff.hi)}), with no guard worse.`,
      remove: `Make ${describe(a)} the only path and remove what ${control.name} had (${describe(control)}).` };
  }
  // The control wins only against every arm it was compared with: one
  // variant that lost says nothing about one not measured yet or not told apart.
  const lost = effects.filter((f) => f.metric === e.primary && f.better === false && compared.some((a) => a.name === f.arm));
  const by = (f: Effect) => `${f.arm} is worse by ${fmtValue(e.primary, Math.abs(f.diff.estimate))} (95% interval of the change ${fmtValue(e.primary, f.diff.lo)} to ${fmtValue(e.primary, f.diff.hi)})`;
  const drop = (fs: Effect[]) => fs.map((f) => `${f.arm} (${describe(e.arms.find((x) => x.name === f.arm)!)})`).join(", ");
  if (lost.length && lost.length === compared.length) {
    return { winner: control.name, verdict: "won", ts,
      text: `${control.name} is better on ${METRICS[e.primary].label}: ${lost.map(by).join("; ")}.`,
      remove: `Drop ${lost.length > 1 ? "arms" : "arm"} ${drop(lost)}; ${control.name} stays as it is.` };
  }
  if (lost.length) {
    const open = compared.filter((a) => !lost.some((f) => f.arm === a.name)).map((a) => `${a.name} ${effects.some((f) => f.metric === e.primary && f.arm === a.name) ? "does not differ beyond chance" : "is not measured yet"}`);
    return { winner: null, verdict: "inconclusive", ts,
      text: `${lost.map(by).join("; ")} on ${METRICS[e.primary].label}, but ${open.join(" and ")}: no arm has won.`,
      remove: `${lost.length > 1 ? "Arms" : "Arm"} ${drop(lost)} can be dropped; nothing else is proven, and the current path stays.` };
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
      // The arm's text is the owner's side of the block (hooks.ts SystemBlock).
      sessionSystem: (s) => { const text = this.armFor(s.id)?.system_append ?? ""; return { name: "experiment arm", text, data: text }; },
      beforeRequest: (s, req) => {
        const arm = this.armFor(s.id);
        const life = req.purpose !== "reader" && req.purpose !== "title" ? arm?.cache_life : undefined;
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
      this.store.db.query("DELETE FROM experiment_reports WHERE exp_id = ?").run(id);
      this.store.db.query("DELETE FROM experiment_obs WHERE exp_id = ?").run(id);
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
    const stopped_ms = Date.now();
    this.fix(e, stopped_ms);
    const r = { ...report({ ...e, state: "stopped" }, this.rows(e, stopped_ms), this.live(e)), final_ms: stopped_ms };
    const out = this.store.db.transaction(() => {
      this.freeze(e, { report: r, sessions: this.sessions(e), runs: this.runs(e) });
      return this.save({ ...e, state: "stopped", stopped_ms, stop_reason: reason, decision: r.decision });
    })();
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
  // turn; a subagent takes its parent's arm and family. Sessions from before
  // the start, and ones that already ran a turn, stay out.
  assign(s: Session) {
    if (armOf(this.store, s.id)) return;
    const db = this.store.db;
    if (s.parent_id) {
      const p = armOf(this.store, s.parent_id);
      if (p) db.query("INSERT OR IGNORE INTO experiment_sessions (session_id, exp_id, arm, ts, root) VALUES (?, ?, ?, ?, ?)").run(s.id, p.exp_id, p.arm, Date.now(), p.root);
      return;
    }
    const e = this.running();
    if (!e || s.created < (e.started_ms ?? Infinity)) return;
    if (db.query("SELECT 1 FROM events WHERE session_id = ? AND kind = 'turn_start' LIMIT 1").get(s.id)) return;
    const arm = e.arms[assignArm(e.id, s.id, e.arms.map((a) => a.weight ?? 1))]!;
    db.query("INSERT OR IGNORE INTO experiment_sessions (session_id, exp_id, arm, ts, root) VALUES (?, ?, ?, ?, ?)").run(s.id, e.id, arm.name, Date.now(), s.id);
    if (arm.settings && Object.keys(arm.settings).length) this.store.mergeSettings(s.id, arm.settings);
  }

  // Offline runs from the runner, each under its receipt. Returns how many
  // were new and how many the experiment already had. A stopped experiment
  // still acknowledges what it has; anything new for it is refused.
  addRuns(id: string, runs: RunUpload[]): { added: number; duplicates: number } {
    const e = this.must(id);
    const names = new Set(e.arms.map((a) => a.name));
    for (const r of runs) {
      if (typeof r?.receipt !== "string" || !r.receipt.trim()) throw bad("a run has a receipt: the name it is uploaded under, the same at every attempt");
      if (!names.has(r.arm)) throw bad(`no arm ${r.arm}`);
      if (!r.metrics || typeof r.metrics !== "object" || Object.values(r.metrics).some((v) => typeof v !== "number" || !Number.isFinite(v))) throw bad("a run has metrics, each a number; one that could not be measured is left out");
    }
    const db = this.store.db;
    const had = db.query<{ arm: string; task: string | null; rep: number | null; metrics: string }, [string, string]>("SELECT arm, task, rep, metrics FROM experiment_runs WHERE exp_id = ? AND receipt = ?");
    const add = db.query("INSERT INTO experiment_runs (exp_id, arm, task, rep, ts, metrics, receipt) VALUES (?, ?, ?, ?, ?, ?, ?)");
    return db.transaction(() => {
      let added = 0, duplicates = 0;
      for (const r of runs) {
        const payload = { arm: r.arm, task: r.task ?? null, rep: r.rep ?? null, metrics: sorted(r.metrics) };
        const old = had.get(id, r.receipt);
        if (old) {
          if (JSON.stringify({ ...old, metrics: sorted(JSON.parse(old.metrics)) }) !== JSON.stringify(payload)) throw Object.assign(new Error(`receipt ${r.receipt} was uploaded before with another payload`), { status: 409 });
          duplicates++;
          continue;
        }
        if (e.state !== "running") throw Object.assign(new Error(e.state === "stopped" ? "it is stopped: its report is final" : "it is a draft: start it first"), { status: 409 });
        add.run(id, payload.arm, payload.task, payload.rep, Date.now(), JSON.stringify(payload.metrics), r.receipt);
        added++;
      }
      return { added, duplicates };
    })();
  }

  private freeze(e: Experiment, f: Final) {
    this.store.db.query("INSERT OR IGNORE INTO experiment_reports (exp_id, ts, data) VALUES (?, ?, ?)").run(e.id, f.report.final_ms ?? Date.now(), JSON.stringify(f));
  }

  // A stopped experiment's frozen evidence. One stopped before reports were
  // kept is frozen at its first read: from the turns that had ended by its
  // stop, under the decision it was stopped with. A live one's guards are
  // left out of that copy, since what they read then was not kept and what
  // would be computed now is not what stopped it.
  final(e: Experiment): Final | undefined {
    if (e.state !== "stopped") return undefined;
    const q = this.store.db.query<{ data: string }, [string]>("SELECT data FROM experiment_reports WHERE exp_id = ?");
    const kept = q.get(e.id);
    if (kept) return JSON.parse(kept.data);
    const { guard: _unread, ...r } = report(e, this.rows(e, e.stopped_ms, true));
    this.freeze(e, { report: { ...r, ...(e.mode === "live" ? { guards: [] } : {}), decision: e.decision ?? r.decision, final_ms: e.stopped_ms }, sessions: this.sessions(e), runs: this.runs(e) });
    return JSON.parse(q.get(e.id)!.data);
  }

  runs(e: Experiment): number {
    return this.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM experiment_runs WHERE exp_id = ?").get(e.id)!.n;
  }

  // The experiment with its counts, as the list and the detail show it.
  summary(e: Experiment) {
    const f = this.final(e);
    return { ...e, sessions: f?.sessions ?? this.sessions(e), runs: f?.runs ?? this.runs(e) };
  }

  // `ended`: only turns that had ended by `until` (a read after the fact;
  // at the moment itself every stored turn has ended).
  rows(e: Experiment, until = Date.now(), ended = false): Row[] {
    if (e.mode === "offline") {
      return this.store.db.query<{ id: number; arm: string; task: string | null; metrics: string }, [string]>("SELECT id, arm, task, metrics FROM experiment_runs WHERE exp_id = ?").all(e.id)
        .map((r) => ({ arm: r.arm, cluster: `run-${r.id}`, stratum: r.task ?? undefined, m: JSON.parse(r.metrics) }));
    }
    // Turns of the experiment's sessions while it ran, each in its family's
    // cluster and arm (the assignment, not the row's own tag).
    const by = ended ? "t.ts + COALESCE(t.ms, 0)" : "t.ts";
    return this.store.db.query<any, [string, number, number]>(
      `SELECT t.*, x.arm AS family_arm, x.root AS family FROM telemetry_turns t JOIN experiment_sessions x ON x.session_id = t.session_id WHERE x.exp_id = ? AND t.ts >= ? AND ${by} <= ?`).all(e.id, e.started_ms ?? 0, until)
      .map((t) => ({ arm: t.family_arm, cluster: t.family, m: turnMetrics(t) }));
  }

  // What the data says now; for a stopped experiment, what it said at the stop.
  report(e: Experiment, now = Date.now()): Report {
    const f = this.final(e);
    if (f) return f.report;
    this.fix(e, now);
    return report(e, this.rows(e, now), this.live(e));
  }

  // Fixes the guard observation of every open family of a running live
  // experiment that can be read by `now` (familyObs), in the order they
  // became fixed. A row is written once and never updated; a family with no
  // turn in its window has none to read.
  private fix(e: Experiment, now: number) {
    if (e.mode !== "live" || e.state !== "running") return;
    const db = this.store.db, window = (e.stop.window_min ?? WINDOW_MIN) * 60_000, k = e.stop.turns ?? TURNS;
    const open = db.query<{ root: string; arm: string; ts: number }, [string]>(
      `SELECT x.session_id AS root, x.arm, x.ts FROM experiment_sessions x WHERE x.exp_id = ? AND x.root = x.session_id
       AND NOT EXISTS (SELECT 1 FROM experiment_obs o WHERE o.exp_id = x.exp_id AND o.root = x.session_id) ORDER BY x.ts, x.session_id`).all(e.id);
    const turns = db.query<any, [string, string, number]>(
      `SELECT t.* FROM telemetry_turns t JOIN experiment_sessions x ON x.session_id = t.session_id
       WHERE x.exp_id = ? AND x.root = ? AND t.ts >= ? ORDER BY t.ts + COALESCE(t.ms, 0), t.id`);
    const due = open.flatMap((f) => {
      const o = familyObs(turns.all(e.id, f.root, e.started_ms ?? 0).map((t) => ({ end: t.ts + (t.ms ?? 0), m: turnMetrics(t) })), f.ts, now, k, window);
      return o ? [{ ...f, ...o }] : [];
    }).sort((a, b) => a.at - b.at);
    const add = db.query("INSERT OR IGNORE INTO experiment_obs (exp_id, root, arm, ts, turns, metrics) VALUES (?, ?, ?, ?, ?, ?)");
    for (const f of due) add.run(e.id, f.root, f.arm, f.at, f.turns, JSON.stringify(f.m));
  }

  // The fixed guard observations in the order they were fixed, and the families still open.
  private live(e: Experiment): Live | undefined {
    if (e.mode !== "live") return undefined;
    const db = this.store.db;
    const obs = db.query<{ arm: string; metrics: string }, [string]>("SELECT arm, metrics FROM experiment_obs WHERE exp_id = ? AND turns > 0 ORDER BY seq").all(e.id).map((r) => ({ arm: r.arm, m: JSON.parse(r.metrics) }));
    const pending = db.query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM experiment_sessions x WHERE x.exp_id = ? AND x.root = x.session_id
       AND NOT EXISTS (SELECT 1 FROM experiment_obs o WHERE o.exp_id = x.exp_id AND o.root = x.session_id)`).get(e.id)!.n;
    return { obs, pending };
  }

  // Session families per arm: a root with its subagents is one.
  sessions(e: Experiment) {
    return this.store.db.query<{ arm: string; n: number }, [string]>("SELECT arm, COUNT(DISTINCT root) AS n FROM experiment_sessions WHERE exp_id = ? GROUP BY arm").all(e.id);
  }

  // After a turn ends while a live experiment runs (a turn of any session:
  // a window can close while the experiment's own sessions are quiet): the
  // guards' evidence stops it; so does reaching the families per arm it asked
  // for, in every arm that gets sessions (session families with a turn, so
  // a subagent adds none).
  check(sessionId: string, now = Date.now()) {
    // The session's own experiment while that one runs; else the running one
    // (a session of an earlier, stopped experiment is any other session to it).
    const tag = armOf(this.store, sessionId);
    const own = tag && this.get(tag.exp_id);
    const e = own?.state === "running" ? own : this.running();
    if (!e || e.state !== "running" || e.mode !== "live") return;
    this.fix(e, now);
    const hurt = liveGuards(e, this.live(e)!.obs).guards.find((g) => g.worse);
    if (hurt) return this.stop(e.id, `guard: ${hurt.arm} made ${METRICS[hurt.metric].label} worse`);
    const n = e.stop.sessions_per_arm;
    if (!n) return;
    const rows = this.rows(e, now);
    // An arm with weight 0 gets no sessions, so the cap is over the arms that do.
    const enabled = e.arms.filter((a) => (a.weight ?? 1) > 0);
    if (enabled.every((a) => new Set(rows.filter((r) => r.arm === a.name).map((r) => r.cluster)).size >= n)) return this.stop(e.id, `reached ${n} session families per arm`);
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
