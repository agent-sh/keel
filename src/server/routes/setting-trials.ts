// Trials of a setting that changes what an agent costs (src/admin/setting-trials.ts), on Settings > Usage.
//
// GET  /api/trials                what can be tried (each setting's value now and the other arm's), the rate new agent
//                                 trees start at, the trial's size and time at that rate, and the newest trial of
//                                 each setting with its report: per arm what a turn and a tree cost, failures and
//                                 time, with intervals, and what the trial decided
// POST /api/trials/start          { trial }  half of the new agent trees run with the other value from now on
//                                 (409 while another live experiment runs, or when the rate is too low for a sample)
// POST /api/trials/:id/keep       the other arm's value becomes the owner's setting for agents; a running trial ends
// POST /api/trials/:id/drop       the setting stays as it was; a running trial ends
// POST /api/trials/reset          { trial }  puts the setting back to what agents did before any trial (a kept value goes)
// A trial is an experiment (GET /api/experiments/:id): the same report, the same stop.
import { METRICS, type Experiment, type Metric } from "../../admin/experiments.ts";
import { patchSettings, settings } from "../../admin/settings.ts";
import { AGENT_DEFAULTS as DEFAULTS } from "../../engine/agent-defaults.ts";
import { plan, SETTING_TRIAL_KIND, SETTING_TRIALS, settingTrial, treesPerDay, trialExperiment, type AgentSettings } from "../../admin/setting-trials.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { experiments } from "./experiments.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (message: string, status: number) => Object.assign(new Error(message), { status });
// What the card shows, in groups: what a turn and a tree cost, what failed, how long it took.
// (The card's words where the metrics' own are for a report: the time of a turn beside the time of a tree.)
const LABEL: Partial<Record<Metric, string>> = { cost_usd: "cost a turn", ms: "time a turn", error: "turns that ended in an error", successor: "contexts lost to a successor", stopped_by_owner: "turns you stopped" };
const SHOWN: Metric[] = ["cost_usd", "tree_cost_usd", "error", "tool_errors", "successor", "stopped_by_owner", "thumbs_down", "ms", "tree_ms"];

export const settingTrialRoutes: RouteModule = ({ store, errors }) => {
  const x = () => experiments!;
  const run = async <T>(f: () => T | Promise<T>, status = 200) => {
    try { return json(await f(), status); } catch (e: any) {
      if (e?.status) return json({ error: e.message }, e.status);
      errors.capture("server", e, { at: "setting trials" });
      return json({ error: String(e?.message ?? e) }, 500);
    }
  };
  const body = async (req: Request) => (await req.json().catch(() => null)) ?? {};
  const agents = () => settings().agents as AgentSettings;
  // The agents a top-level session started, with everything under them one tree each: when each started.
  const rate = (now = Date.now()) => {
    const started = store.db.query<{ created: number }, [number]>("SELECT s.created AS created FROM sessions s JOIN sessions p ON p.id = s.parent_id WHERE p.parent_id IS NULL AND s.created >= ?").all(now - 7 * 86_400_000).map((r) => r.created);
    const first = store.db.query<{ t: number | null }, []>("SELECT MIN(s.created) AS t FROM sessions s JOIN sessions p ON p.id = s.parent_id WHERE p.parent_id IS NULL").get()?.t ?? now;
    return treesPerDay(started, now, first);
  };
  const newest = (id: string) => x().list().find((e) => e.setting?.trial === id);
  // A running trial's report is read on the read thread (the loop is not held for its intervals); a stopped one's is the copy kept at its stop.
  const reportOf = (e: Experiment) => (e.state === "running" ? readsOf(store).run("experiment.report", { exp: e, now: Date.now() }) as Promise<ReturnType<ReturnType<typeof x>["report"]>> : Promise.resolve(x().report(e)));
  const view = async (e: Experiment, full: boolean) => {
    const s = x().summary(e);
    const r = full ? await reportOf(e) : undefined;
    const set = e.setting!;
    return {
      id: e.id, state: e.state, started_ms: e.started_ms, stopped_ms: e.stopped_ms, stop_reason: e.stop_reason, decision: e.decision,
      until_ms: e.stop.until_ms ?? null, per_arm: e.stop.sessions_per_arm ?? null, from: set.from, to: set.to, choice: set.choice ?? null,
      arms: e.arms.map((a) => ({ name: a.name, trees: s.sessions.find((q) => q.arm === a.name)?.n ?? 0 })),
      ...(r ? {
        judged: r.judged,
        report: {
          arms: r.arms.map((a) => ({ arm: a.arm, clusters: a.clusters, metrics: Object.fromEntries(SHOWN.flatMap((m) => (a.metrics[m] ? [[m, a.metrics[m]]] : []))) })),
          effects: r.effects.filter((f) => SHOWN.includes(f.metric) && f.arm === e.arms[1]!.name),
          guard: r.guard,
        },
      } : {}),
    };
  };

  return {
    "/api/trials": {
      GET: () => run(async () => {
        const r = rate();
        const p = plan(r.per_day);
        const other = x().running();
        return {
          rate: r, plan: p,
          metrics: Object.fromEntries(SHOWN.map((m) => [m, { label: LABEL[m] ?? METRICS[m].label, unit: METRICS[m].unit, better: METRICS[m].better }])),
          // The live experiment that blocks a start, when it is not one of these trials.
          busy: other && !other.setting ? other.name : null,
          trials: await Promise.all(SETTING_TRIALS.map(async (t) => {
            const now = t.current(agents()), tried = t.other(now);
            const e = newest(t.id);
            // `changed`: the owner's value for agents is not the one they had before any trial.
            return { id: t.id, label: t.label, ask: t.ask, now: t.say(now), other: tried === undefined ? null : t.say(tried), changed: agents()[t.key] !== DEFAULTS[t.key], ...(e ? { last: await view(e, true) } : {}) };
          })),
        };
      }),
    },
    "/api/trials/start": {
      POST: async (req: Request) => run(async () => {
        const t = settingTrial(String((await body(req)).trial));
        if (!t) throw fail(`trial is one of ${SETTING_TRIALS.map((d) => d.id).join(", ")}`, 400);
        const now = t.current(agents()), tried = t.other(now);
        if (tried === undefined) throw fail("there is nothing else to try: the setting is at its limit", 409);
        const other = x().running();
        if (other) throw fail(`${other.name} is running live: stop it first`, 409);
        const p = plan(rate().per_day);
        if (!p.startable) throw fail(p.why!, 409);
        // One call makes the experiment and starts it: none is left a draft when the start is refused.
        const made = x().create({ ...trialExperiment(t, now, tried, p, Date.now()), template: SETTING_TRIAL_KIND }, { id: Bun.randomUUIDv7(), kind: SETTING_TRIAL_KIND });
        let started: Experiment;
        try { started = x().start(made.id); } catch (e) { x().remove(made.id); throw e; }
        return { trial: await view(started, false) };
      }, 201),
    },
    "/api/trials/reset": {
      POST: async (req: Request) => run(async () => {
        const t = settingTrial(String((await body(req)).trial));
        if (!t) throw fail(`trial is one of ${SETTING_TRIALS.map((d) => d.id).join(", ")}`, 400);
        const saved = patchSettings({ agents: { [t.key]: null } });
        if (!saved.ok) throw fail(saved.error, saved.status ?? 400);
        return { ok: true };
      }),
    },
    "/api/trials/:id/keep": {
      POST: (req: Request & { params: { id: string } }) => run(async () => {
        const e = x().get(req.params.id);
        if (!e?.setting) throw fail("no such trial", 404);
        if (e.setting.choice) throw fail(`it was ${e.setting.choice.kept ? "kept" : "dropped"} already`, 409);
        const t = settingTrial(e.setting.trial)!;
        // The setting first: when it is refused the trial stays as it is, and the owner may try again.
        const saved = patchSettings({ agents: { [t.key]: e.setting.to } });
        if (!saved.ok) throw fail(saved.error, saved.status ?? 400);
        if (e.state === "running") x().stop(e.id, "kept by the owner");
        return { trial: await view(x().choose(e.id, true), true) };
      }),
    },
    "/api/trials/:id/drop": {
      POST: (req: Request & { params: { id: string } }) => run(async () => {
        const e = x().get(req.params.id);
        if (!e?.setting) throw fail("no such trial", 404);
        if (e.setting.choice) throw fail(`it was ${e.setting.choice.kept ? "kept" : "dropped"} already`, 409);
        if (e.state === "running") x().stop(e.id, "dropped by the owner");
        return { trial: await view(x().choose(e.id, false), true) };
      }),
    },
  };
};
