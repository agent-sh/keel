// What an experiment's evidence is made of, apart from the daemon: the metrics, the definition of an
// experiment, the intervals, guards and decision read from rows (`report`), and the reading of a live
// experiment's rows from a database connection. Nothing here imports the daemon, so the read thread can
// compute a running experiment's report (src/server/read-tasks.ts) while the loop goes on, and
// src/admin/experiments.ts, which keeps the experiments' life (arms, assignment, stops), re-exports it all.
import type { Database } from "bun:sqlite";
import { diffInterval, labelBet, meanInterval, msprt, type Interval, type Unit } from "./stats.ts";
import { treeFigures, type TreeSpent, type TreeTurns } from "./tree-figures.ts";

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
  stopped_by_owner: { label: "turns the owner stopped", better: "lower", unit: "share" },
  // An agent's last turn before a fresh context took its task up (src/automation/successor.ts).
  successor: { label: "agent contexts lost to a successor", better: "lower", unit: "share" },
  // How far a compaction by price's estimate of what its summary keeps was from what the next step read (|read / kept - 1|).
  keep_miss: { label: "miss of a priced summary's kept size", better: "lower", unit: "share" },
  // Read-only steps over the reads they sent (src/engine/read-run.ts): 1 is one read a step, lower is batched.
  steps_per_read: { label: "steps per read", better: "lower", unit: "share" },
  // Read once a family, over its life: whether it failed with the class a lesson is about, 0 or 1 (src/automation/lessons.ts).
  lesson_class: { label: "trees that failed with the lesson's class", better: "lower", unit: "share" },
  // Read once a tree, when it is settled (src/admin/tree-figures.ts): everything its sessions spent, summaries made
  // ahead and warm reads included, and how long it worked.
  tree_cost_usd: { label: "cost a tree", better: "lower", unit: "usd" },
  tree_ms: { label: "time a tree works", better: "lower", unit: "ms" },
} as const;
export type Metric = keyof typeof METRICS;
// The metrics read once a family rather than once a turn: a count over the
// family's life, given by the module that knows it (registerFamilyRead).
// A guard cannot read one: its observation is a family's first turns.
export const FAMILY_METRICS: ReadonlySet<Metric> = new Set<Metric>(["lesson_class", "tree_cost_usd", "tree_ms"]);
// The family metrics of a tree's settled figures: read over the first `sessions_per_arm` trees of each arm in the order
// they were assigned, so a winner on one waits until all of them are settled (src/admin/tree-figures.ts).
export const TREE_METRICS: ReadonlySet<Metric> = new Set<Metric>(["tree_cost_usd", "tree_ms"]);

export type Arm = {
  name: string;
  weight?: number;
  tools_off?: string[];
  settings?: Record<string, unknown>; // session settings: effort, speed, compact_at, idle_compact
  system_append?: string;              // text added to the system prompt (kept with the session)
  cache_life?: "short" | "long";
  tool_text?: Record<string, string>;  // a tool's description in this arm, by tool name
  model?: string;                      // offline only: the model the arm runs on
  lesson?: boolean;                    // its agents are told the experiment's lesson at their start
};

// A guard stops on evidence of any worsening of its metric: no amount is
// tolerated. `mde` is the size of worsening its test is tuned to find
// fastest, in the metric's unit (or a share of the pooled level when
// `relative`): it sizes the live bets and sets the offline mSPRT mixture.
export type Guard = { metric: Metric; mde: number; relative?: boolean };
// Live: `sessions_per_arm`, the session families per arm the winner is read
// at; a family's guard observation is read over its first `turns` turns, or
// over `window_min` minutes from its assignment when fewer have ended.
// `until_ms`: a live experiment ends by itself at this time with the sample it has (a trial of a setting sets it from the rate new trees start at).
export type Stop = { sessions_per_arm?: number | null; alpha?: number; window_min?: number; turns?: number; reps?: number; tasks?: string[]; model?: string; until_ms?: number };
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

// Live only: `unit` is what one draw of an arm covers. "session" (the
// default) is a top-level session with every agent under it. "agent" is an
// agent a top-level session started, with the agents under it, while the
// top-level session itself gets no arm: for a change only agents see (a
// lesson told at an agent's start), where one coordinator's many agents are
// many units. `repo`: only units whose folder is in this repository (its root
// folder) get an arm. `lesson`: the lesson a trial is of, whose failure class
// `lesson_class` counts.
export type Experiment = {
  id: string; name: string; hypothesis: string; mode: "offline" | "live"; template?: string;
  unit?: "session" | "agent"; repo?: string; lesson?: string;
  arms: Arm[]; primary: Metric; guards: Guard[]; stop: Stop;
  state: "draft" | "running" | "stopped"; created_ms: number; started_ms?: number; stopped_ms?: number; stop_reason?: string; decision?: Decision;
  // A trial of a setting (src/admin/setting-trials.ts): which one, and what the owner did with it once it ended.
  setting?: { trial: string; key: string; from: unknown; to: unknown; choice?: { kept: boolean; ts: number } };
};

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
// A tree metric counts the settled trees of the first `n` assigned to the arm: the sample is full when all of them are.
const familiesOf = (e: Experiment, r: ArmReport | undefined) => (TREE_METRICS.has(e.primary) ? r?.metrics[e.primary]?.n ?? 0 : r?.clusters ?? 0);
const capReached = (e: Experiment, arms: ArmReport[]) => {
  const n = e.stop.sessions_per_arm;
  return !!n && e.arms.every((a) => !((a.weight ?? 1) > 0) || familiesOf(e, arms.find((x) => x.arm === a.name)) >= n);
};
// What a stopped experiment is read from.
export type Final = { report: Report; sessions: { arm: string; n: number }[]; runs: number };

// `family`: a row of the metrics read once a family (FAMILY_METRICS), not a turn.
export type Row = { arm: string; cluster: string; stratum?: string; family?: true; m: Partial<Record<Metric, number>> };

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
    return { arm: a.name, units: mine.filter((r) => !r.family).length, clusters: new Set(mine.map((r) => r.cluster)).size, metrics: out };
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
  if (a.lesson) parts.push("the lesson told at its agents' start");
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
    const have = e.arms.filter((a) => (a.weight ?? 1) > 0).map((a) => `${a.name} ${familiesOf(e, arms.find((x) => x.arm === a.name))}`).join(", ");
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
  // (A tree metric is read over a cohort fixed by assignment, whole when the sample is full.)
  const lacking = TREE_METRICS.has(e.primary) ? [] : [control, ...compared].flatMap((a) => {
    const r = arms.find((x) => x.arm === a.name), n = r?.metrics[e.primary]?.n ?? 0;
    // (A metric read once a family is known for each family.)
    const all = FAMILY_METRICS.has(e.primary) ? r?.clusters ?? 0 : r?.units ?? 0;
    return r && n < all ? [`${n} of ${all} ${FAMILY_METRICS.has(e.primary) ? "families" : e.mode === "live" ? "turns" : "runs"} of ${a.name}`] : [];
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

// Turn rows with `successor` set: 1 on the last turn of a session whose agent
// lost that context and had a successor take its task up (the activity row the
// start of a successor writes), 0 on the others.
export function withSuccessors<T extends { session_id: string; ts: number; id: number }>(db: Database, rows: T[], since: number): (T & { successor: number })[] {
  const lost = new Set<string>();
  if (rows.length && db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity'").get()) {
    for (const r of db.query<{ s: string | null }, [number]>("SELECT json_extract(data, '$.lost_session') AS s FROM activity WHERE ts >= ? AND kind = 'agent' AND sub = 'successor'").all(since)) if (r.s) lost.add(r.s);
  }
  const last = new Map<string, T>();
  for (const r of rows) if (lost.has(r.session_id)) {
    const was = last.get(r.session_id);
    if (!was || r.ts > was.ts || (r.ts === was.ts && r.id > was.id)) last.set(r.session_id, r);
  }
  const ends = new Set(last.values());
  return rows.map((r) => ({ ...r, successor: ends.has(r) ? 1 : 0 }));
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
    stopped_by_owner: t.outcome === "stopped_by_owner" ? 1 : 0,
    ...(typeof t.successor === "number" ? { successor: t.successor } : {}),
    ...(typeof t.keep_miss === "number" ? { keep_miss: t.keep_miss } : {}),
    ...(typeof t.steps_per_read === "number" ? { steps_per_read: t.steps_per_read } : {}),
  };
}


// A live experiment's turn rows while it ran, each in its family's cluster and arm (the assignment, not the
// row's own tag), and the settled trees' figures when its primary metric is one. `ended`: only turns that had
// ended by `until` (a read after the fact; at the moment itself every stored turn has ended). The metrics a
// module reads once a family (registerFamilyRead) are not here: the loop adds them.
export function liveRows(db: Database, e: Experiment, until: number, ended = false): Row[] {
  const by = ended ? "t.ts + COALESCE(t.ms, 0)" : "t.ts";
  const rows = db.query<any, [string, number, number]>(
    `SELECT t.*, x.arm AS family_arm, x.root AS family FROM telemetry_turns t JOIN experiment_sessions x ON x.session_id = t.session_id WHERE x.exp_id = ? AND t.ts >= ? AND ${by} <= ?`).all(e.id, e.started_ms ?? 0, until);
  const out: Row[] = withSuccessors(db, rows, e.started_ms ?? 0).map((t) => ({ arm: t.family_arm, cluster: t.family, m: turnMetrics(t) }));
  if (TREE_METRICS.has(e.primary) && e.stop.sessions_per_arm) {
    const armOfRoot = new Map(out.map((r) => [r.cluster, r.arm]));
    for (const [root, m] of treesOf(db, e, until, e.stop.sessions_per_arm)) {
      const arm = armOfRoot.get(root);
      if (arm !== undefined) out.push({ arm, cluster: root, family: true, m });
    }
  }
  return out;
}

// The settled trees' figures (src/admin/tree-figures.ts): what the ledger holds of each tree's sessions since the start.
function treesOf(db: Database, e: Experiment, until: number, per_arm: number) {
  const from = e.started_ms ?? 0;
  const assigned = db.query<{ root: string; arm: string; ts: number }, [string]>("SELECT session_id AS root, arm, ts FROM experiment_sessions WHERE exp_id = ? AND root = session_id").all(e.id);
  const spent = new Map<string, TreeSpent>();
  for (const r of db.query<{ root: string; cost: number; unpriced: number; last: number }, [string, number, number]>(
    `SELECT x.root AS root, SUM(COALESCE(c.cost, 0)) AS cost, MAX(c.cost IS NULL AND c.unpriced != 0) AS unpriced, MAX(c.ts) AS last
     FROM telemetry_calls c JOIN experiment_sessions x ON x.session_id = c.session_id
     WHERE x.exp_id = ? AND c.ts >= ? AND c.ts <= ? AND NOT (c.outcome = 'error' AND c.input + c.output + c.cache_read + c.cache_write = 0 AND c.cost IS NULL) GROUP BY x.root`).all(e.id, from, until))
    spent.set(r.root, { cost: r.cost, unpriced: !!r.unpriced, last_call: r.last });
  const turns = new Map<string, TreeTurns>();
  for (const r of db.query<{ root: string; first: number; end: number }, [string, number, number]>(
    `SELECT x.root AS root, MIN(t.ts) AS first, MAX(t.ts + COALESCE(t.ms, 0)) AS end FROM telemetry_turns t JOIN experiment_sessions x ON x.session_id = t.session_id
     WHERE x.exp_id = ? AND t.ts >= ? AND t.ts + COALESCE(t.ms, 0) <= ? GROUP BY x.root`).all(e.id, from, until))
    turns.set(r.root, { first: r.first, end: r.end });
  return treeFigures({ assigned, spent, turns, per_arm, until });
}

// The fixed guard observations of a live experiment in the order they were fixed, and the families still open.
export function liveOf(db: Database, e: Experiment): Live {
  const obs = db.query<{ arm: string; metrics: string }, [string]>("SELECT arm, metrics FROM experiment_obs WHERE exp_id = ? AND turns > 0 ORDER BY seq").all(e.id).map((r) => ({ arm: r.arm, m: JSON.parse(r.metrics) }));
  const pending = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM experiment_sessions x WHERE x.exp_id = ? AND x.root = x.session_id
     AND NOT EXISTS (SELECT 1 FROM experiment_obs o WHERE o.exp_id = x.exp_id AND o.root = x.session_id)`).get(e.id)!.n;
  return { obs, pending };
}

// What a running live experiment says now, read without writing anything (no guard observation is fixed here):
// the read thread's task. The loop's `Experiments.report` fixes the open observations first.
export const liveReport = (db: Database, e: Experiment, now: number): Report => report(e, liveRows(db, e, now), liveOf(db, e));
