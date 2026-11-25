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
// the assignment. A template whose change only agents see (`unit: "agent"`)
// draws for each agent a top-level session starts instead, and that agent is
// the root of its tree: the report, the guards and the cap count agent trees.
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
import { repoRoot } from "../core/repo-root.ts";
import { registerHooks } from "../engine/hooks.ts";
import { registerTrialRunning } from "../engine/model-trial.ts";
import { registerToolsOff } from "../tools/registry.ts";
import { assignArm } from "./stats.ts";
import { liveOf, liveRows, turnMetrics, withSuccessors, FAMILY_METRICS, METRICS, unitWord, TREE_METRICS, report, liveGuards, familyObs, ALPHA, WINDOW_MIN, TURNS, FAMILIES_PER_ARM, worse, type Metric, type Arm, type Experiment, type Decision, type Live, type Report, type Final, type Row, type ArmReport, type Effect } from "./experiment-report.ts";
export * from "./experiment-report.ts";


export type FamilyRead = (e: Experiment, roots: string[], until: number) => Map<string, Partial<Record<Metric, number>>> | undefined;
const familyReads = new Map<string, FamilyRead>();
// A reader of family metrics, by the module's name; returns what takes it back.
export function registerFamilyRead(id: string, read: FamilyRead): () => void {
  familyReads.set(id, read);
  return () => { if (familyReads.get(id) === read) familyReads.delete(id); };
}


// A request with the arm's tool descriptions in place (one per session, so its prefix holds).
export function withToolText(req: ProviderRequest, arm: Arm | undefined): ProviderRequest {
  const text = arm?.tool_text;
  if (!text || req.purpose === "reader" || req.purpose === "title") return req;
  return { ...req, tools: req.tools.map((t) => (typeof text[t.name] === "string" ? { ...t, description: text[t.name]! } : t)) };
}
export type RunUpload = { receipt: string; arm: string; task?: string; rep?: number; metrics: Record<string, number> };
const sorted = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

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
      // What a summary that lost the work would show: a turn that fails, more failed calls, a context lost to a
      // successor, the owner's Stop, a reply rated down. (keep_miss is reported: only the price arm has it.)
      guards: [{ metric: "error", mde: 0.1 }, { metric: "tool_errors", mde: 0.25, relative: true }, { metric: "successor", mde: 0.05 },
        { metric: "stopped_by_owner", mde: 0.1 }, { metric: "thumbs_down", mde: 0.1 }], stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
  },
  {
    // A quarter of the new agent trees each (the unit is an agent a top-level session starts, with the agents under
    // it): they are told nothing at a run of reads, are told to send them in parallel, are told that and offered an
    // Explore agent on the reader model, or are told that and offered run_code for the reads they know they need
    // (src/engine/read-run.ts). The last two overlap: compare them, do not add their savings. Agents are what the
    // note is about, and a coordinator starts many of them for each session the owner opens.
    id: "read_runs", label: "Agents batch their reads",
    make: () => ({ name: "Reads in batches", mode: "live", template: "read_runs", unit: "agent",
      hypothesis: "Agents told at a run of read-only steps what each step costs, and to send the reads they know they need in one step (or to hand a search to an Explore agent on the reader model, or to make them in one run_code program that prints only what matters), cost less per turn and take fewer steps a read, without more errors or failed tool calls.",
      arms: [{ name: "plain" }, { name: "batch", settings: { read_runs: "batch" } }, { name: "reader", settings: { read_runs: "reader" } }, { name: "code", settings: { read_runs: "code" } }], primary: "cost_usd",
      // What a read the agent needed and did not make would show: a turn that fails, more failed calls (an edit
      // of a file it did not read), a context lost to a successor, the owner's Stop, a reply rated down.
      // (steps_per_read is reported: it says whether the agents followed the note. The replay's savings assume they
      // always do, so read steps_per_read before the cost: an arm whose agents ignore the note saves nothing.)
      guards: [{ metric: "error", mde: 0.1 }, { metric: "tool_errors", mde: 0.25, relative: true }, { metric: "successor", mde: 0.05 },
        { metric: "stopped_by_owner", mde: 0.1 }, { metric: "thumbs_down", mde: 0.1 }], stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
  },
  {
    // Half of the new agent trees (the unit is an agent a top-level session starts, with the agents under it; a
    // top-level session gets no arm): when their cache has lapsed, old tool results are sent as stubs and the
    // thinking of earlier turns is left out (src/engine/cold-clear.ts). Agents start about twenty times as often
    // as the owner opens a session, so the sample size is reached in days, not weeks.
    id: "cold_clear", label: "Clear old results after a lapse",
    make: () => ({ name: "Clearing at a cold point", mode: "live", template: "cold_clear", unit: "agent",
      hypothesis: "Sessions whose cache lapsed, sent with old tool results as one-line stubs and without the thinking of earlier turns, cost less per turn than the same sessions whole, without more failed calls or more steps.",
      arms: [{ name: "whole" }, { name: "clear", settings: { cold_clear: true } }], primary: "cost_usd",
      // What a result the model needed and no longer has would show: a turn that fails, more failed calls, more steps
      // (it reads a stub's file or makes the call again), a context lost to a successor, the owner's Stop, a reply rated down.
      guards: [{ metric: "error", mde: 0.1 }, { metric: "tool_errors", mde: 0.25, relative: true }, { metric: "successor", mde: 0.05 },
        { metric: "stopped_by_owner", mde: 0.1 }, { metric: "thumbs_down", mde: 0.1 }], stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
  },
  {
    id: "speed", label: "Speed tier",
    make: () => ({ name: "Speed tier", mode: "live", template: "speed",
      hypothesis: "A faster tier shortens turns enough to be worth its price.",
      arms: [{ name: "standard" }, { name: "fast", settings: { speed: "" } }], primary: "ms",
      guards: [{ metric: "cost_usd", mde: 0.5, relative: true }, { metric: "error", mde: 0.1 }], stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
  },
];

// A lesson's trial (src/automation/lessons.ts makes it from an accepted
// lesson, with its repository and the lesson), not offered in the list: half
// of the repository's new agent trees are told the lesson at their start.
// Does its failure class fall?
export const LESSON_TEMPLATE: (typeof TEMPLATES)[number] = {
  id: "lesson", label: "A lesson for a repository's agents",
  make: () => ({ name: "Lesson", mode: "live", template: "lesson", unit: "agent",
    hypothesis: "Agents told the lesson at their start fail with its class less often, without more errors or cost.",
    arms: [{ name: "without" }, { name: "with lesson", lesson: true }], primary: "lesson_class",
    // What a lesson that misleads would show: turns that fail, more failed calls, the cost of the words it adds.
    guards: [{ metric: "error", mde: 0.1 }, { metric: "tool_errors", mde: 0.25, relative: true }, { metric: "cost_usd", mde: 0.25, relative: true }],
    stop: { sessions_per_arm: FAMILIES_PER_ARM } }),
};

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
  if (e.unit !== undefined && e.unit !== "session" && e.unit !== "agent") throw bad("unit is session or agent");
  if ((e.unit || e.repo) && e.mode !== "live") throw bad("unit and repo shape who gets a live arm; an offline experiment has none");
  if (e.lesson !== undefined && !(typeof e.lesson === "string" && e.lesson)) throw bad("lesson is the id of a lesson");
  if (e.arms.some((a) => a.lesson) && !e.lesson) throw bad("an arm that tells the lesson needs the experiment's lesson");
  if (FAMILY_METRICS.has(e.primary) && e.mode !== "live") throw bad(`${e.primary} is read over a live family's life`);
  for (const g of e.guards ?? []) {
    if (!(g.metric in METRICS)) throw bad(`guard metric ${g.metric} is unknown`);
    if (FAMILY_METRICS.has(g.metric)) throw bad(`guard ${g.metric}: a guard reads a family's first turns, and ${g.metric} is read over its life`);
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
  if (TREE_METRICS.has(e.primary) && !n) throw bad(`${e.primary} is read over the first sessions_per_arm trees of each arm: name how many`);
  const until = e.stop?.until_ms;
  if (until !== undefined && !(typeof until === "number" && Number.isFinite(until) && until > 0)) throw bad("until_ms, the time a live experiment ends at, is a time in milliseconds");
  if (until !== undefined && e.mode !== "live") throw bad("until_ms ends a live experiment; an offline one ends with its runs");
}


export class Experiments {
  constructor(private store: Store, private onStop: (e: Experiment) => void = () => {}) {
    experimentTables(store);
    registerToolsOff("experiments", (sid) => this.armFor(sid)?.tools_off ?? []);
    registerTrialRunning((id) => this.get(id)?.state === "running");
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

  // `own`: an experiment a feature makes for itself (a model trial): it names its own id, so its arms can hold it,
  // and its own kind in `template`, which is not one of the owner's templates.
  create(body: Partial<Experiment> & { template?: string }, own?: { id: string; kind: string }): Experiment {
    const base = body.template && !own ? [...TEMPLATES, LESSON_TEMPLATE].find((t) => t.id === body.template)?.make() : undefined;
    if (body.template && !own && !base) throw bad(`no template ${body.template}`);
    const merged = { ...base, ...Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && k !== "template")) } as Partial<Experiment>;
    merged.guards ??= [];
    merged.stop ??= {};
    validate(merged);
    return this.save({ ...(merged as Experiment), template: own?.kind ?? body.template ?? merged.template, id: own?.id ?? Bun.randomUUIDv7(), state: "draft", created_ms: Date.now() });
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

  stop(id: string, reason = "stopped by the owner", at = Date.now()): Experiment {
    const e = this.must(id);
    if (e.state !== "running") throw Object.assign(new Error(`it is ${e.state}`), { status: 409 });
    const stopped_ms = at;
    this.fix(e, stopped_ms);
    const r = { ...report({ ...e, state: "stopped" }, this.rows(e, stopped_ms), this.live(e)), final_ms: stopped_ms };
    const out = this.store.db.transaction(() => {
      this.freeze(e, { report: r, sessions: this.sessions(e), runs: this.runs(e) });
      return this.save({ ...e, state: "stopped", stopped_ms, stop_reason: reason, decision: r.decision });
    })();
    try { this.onStop(out); } catch { /* the stop stands; the caller's notice is best effort */ }
    return out;
  }

  // What the owner did with a trial of a setting once it ended: kept it or dropped it (src/admin/setting-trials.ts).
  choose(id: string, kept: boolean): Experiment {
    const e = this.must(id);
    if (!e.setting) throw bad("it is not a trial of a setting");
    if (e.state !== "stopped") throw Object.assign(new Error("it is still running: stop it first"), { status: 409 });
    if (e.setting.choice) throw Object.assign(new Error(`it was ${e.setting.choice.kept ? "kept" : "dropped"} already`), { status: 409 });
    return this.save({ ...e, setting: { ...e.setting, choice: { kept, ts: Date.now() } } });
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
  // An experiment whose unit is an agent tree draws for an agent its
  // top-level session started (that session has none), and its agents take
  // that agent's; an arm the top-level session kept from a stopped
  // experiment is not passed down to it then.
  assign(s: Session) {
    if (armOf(this.store, s.id)) return;
    const db = this.store.db;
    if (s.parent_id) {
      const p = armOf(this.store, s.parent_id);
      const e = this.running();
      const unit = e?.unit === "agent" && !this.store.session(s.parent_id)?.parent_id;
      if (p && !(unit && p.exp_id !== e!.id)) {
        db.query("INSERT OR IGNORE INTO experiment_sessions (session_id, exp_id, arm, ts, root) VALUES (?, ?, ?, ?, ?)").run(s.id, p.exp_id, p.arm, Date.now(), p.root);
        return;
      }
      if (unit) this.draw(e!, s);
      return;
    }
    const e = this.running();
    if (e && e.unit !== "agent") this.draw(e, s);
  }

  // A unit's arm, drawn once: a session made since the start that ran no turn yet, in the experiment's repository.
  private draw(e: Experiment, s: Session) {
    const db = this.store.db;
    if (s.created < (e.started_ms ?? Infinity)) return;
    if (db.query("SELECT 1 FROM events WHERE session_id = ? AND kind = 'turn_start' LIMIT 1").get(s.id)) return;
    if (e.repo && (s.machine || repoRoot(s.workspace) !== e.repo)) return;
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
    const out = liveRows(this.store.db, e, until, ended);
    // The metrics read once a family, for the families with a turn.
    const armOfRoot = new Map(out.map((r) => [r.cluster, r.arm]));
    for (const read of familyReads.values()) {
      for (const [root, m] of read(e, [...armOfRoot.keys()], until) ?? []) {
        const arm = armOfRoot.get(root);
        if (arm !== undefined) out.push({ arm, cluster: root, family: true, m });
      }
    }
    return out;
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
      const o = familyObs(withSuccessors(db, turns.all(e.id, f.root, e.started_ms ?? 0), e.started_ms ?? 0).map((t) => ({ end: t.ts + (t.ms ?? 0), m: turnMetrics(t) })), f.ts, now, k, window);
      return o ? [{ ...f, ...o }] : [];
    }).sort((a, b) => a.at - b.at);
    const add = db.query("INSERT OR IGNORE INTO experiment_obs (exp_id, root, arm, ts, turns, metrics) VALUES (?, ?, ?, ?, ?, ?)");
    for (const f of due) add.run(e.id, f.root, f.arm, f.at, f.turns, JSON.stringify(f.m));
  }

  // The fixed guard observations in the order they were fixed, and the families still open.
  private live(e: Experiment): Live | undefined {
    return e.mode === "live" ? liveOf(this.store.db, e) : undefined;
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
    if (hurt) return this.stop(e.id, `guard: ${hurt.arm} made ${METRICS[hurt.metric].label} worse`, now);
    // Its time: it ends with the sample it has (no winner is named on a part of it).
    if (e.stop.until_ms && now >= e.stop.until_ms) return this.stop(e.id, "reached its time limit", now);
    const n = e.stop.sessions_per_arm;
    if (!n) return;
    // A tree metric needs the ledger's sums over every call of the trial: looked at once a minute, not at every turn's end.
    const tree = TREE_METRICS.has(e.primary);
    if (tree && now - (this.looked.get(e.id) ?? 0) < TREE_LOOK_MS) return;
    this.looked.set(e.id, now);
    const rows = this.rows(e, now);
    // An arm with weight 0 gets no sessions, so the cap is over the arms that do.
    const enabled = e.arms.filter((a) => (a.weight ?? 1) > 0);
    const have = (arm: string) => new Set(rows.filter((r) => r.arm === arm && (!tree || (r.family && typeof r.m[e.primary] === "number"))).map((r) => r.cluster)).size;
    if (enabled.every((a) => have(a.name) >= n)) return this.stop(e.id, tree ? `all ${n} trees per arm are settled` : `reached ${n} ${unitWord(e)} per arm`, now);
  }
  private looked = new Map<string, number>();
}
// How often a running trial's settled trees are counted (check).
const TREE_LOOK_MS = 60_000;
