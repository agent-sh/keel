// New models and their trials (src/providers/first-seen.ts, src/engine/model-trial.ts).
//
// GET  /api/models/new[?brief]    the models a provider listed for the first time, newest first, each with what its
//                                 listing and the catalog say (window, price, efforts) and its trial if one was made:
//                                 the experiment, its state, its families per arm and, unless `brief`, its report
//                                 (the metrics the trial judges, per arm, with intervals)
// POST /api/models/new/trial      { model, role }  makes the trial of the model in that role and starts it: half of the
//                                 new session trees try it (409 while another live experiment runs)
// POST /api/models/new/dismiss    { model }        puts the model away: it is news no more (409 while its trial runs)
// A trial is stopped like any experiment: POST /api/experiments/:id/stop.
import { METRICS, type Experiment, type Metric } from "../../admin/experiments.ts";
import { TRIAL_KIND, trialExperiment, trialIn } from "../../admin/model-trials.ts";
import { ROLES, type Role } from "../../engine/model-trial.ts";
import type { RouteModule } from "../app.ts";
import { experiments } from "./experiments.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (message: string, status: number) => Object.assign(new Error(message), { status });
// What a trial judges: its primary metric and its guards.
// The builder's agents may carry a dollar budget, and a model with no price counts no dollars: the tree's
// cap and a budget in dollars would not hold on it (src/automation/agents.ts usdRefusal).
const roleRefusal = (role: Role, m: { name: string; price?: unknown }) =>
  role === "builder" && !m.price ? `${m.name} lists no price, so the dollars an agent on it spends cannot be counted and a budget in dollars could not hold: try it as a reader or a small model` : undefined;
const SHOWN: Metric[] = ["cost_usd", "error", "tool_errors", "successor", "stopped_by_owner", "thumbs_down"];

export const modelTrialRoutes: RouteModule = ({ providers, errors }) => {
  const x = () => experiments!;
  const run = async <T>(f: () => T | Promise<T>, status = 200) => {
    try { return json(await f(), status); } catch (e: any) {
      if (e?.status) return json({ error: e.message }, e.status);
      errors.capture("server", e, { at: "model trials" });
      return json({ error: String(e?.message ?? e) }, 500);
    }
  };
  const body = async (req: Request) => (await req.json().catch(() => null)) ?? {};
  // The newest trial of a model.
  const trialOfModel = (model: string) => x().list().find((e) => trialIn(e)?.model === model);
  const view = (e: Experiment, brief: boolean) => {
    const t = trialIn(e)!;
    const s = x().summary(e);
    const r = brief ? undefined : x().report(e);
    return {
      id: e.id, role: t.role, state: e.state, started_ms: e.started_ms, stopped_ms: e.stopped_ms, stop_reason: e.stop_reason, decision: e.decision,
      sessions: s.sessions, per_arm: e.stop.sessions_per_arm ?? null, arms: e.arms.map((a) => a.name),
      ...(r ? {
        judged: r.judged,
        report: {
          arms: r.arms.map((a) => ({ arm: a.arm, clusters: a.clusters, units: a.units, metrics: Object.fromEntries(SHOWN.flatMap((m) => (a.metrics[m] ? [[m, a.metrics[m]]] : []))) })),
          effects: r.effects.filter((f) => SHOWN.includes(f.metric) && f.arm === e.arms[1]!.name),
          guard: r.guard,
        },
      } : {}),
    };
  };
  const fields = (m: ReturnType<typeof providers.newModels>[number]) => ({
    id: m.id, provider: m.provider, model: m.model, name: m.name, context: m.context, output: m.output, efforts: m.efforts,
    price: m.price, billing: m.billing, release: m.release, first_seen: m.first_seen,
    // A role the model cannot take, and why: the card shows it off.
    refused: Object.fromEntries(ROLES.flatMap((r) => { const why = roleRefusal(r, m); return why ? [[r, why]] : []; })),
  });
  // A model the listing no longer returns, kept on the page by its running trial: what the trial knows of it.
  const gone = (e: Experiment) => {
    const t = trialIn(e)!, at = t.model.indexOf(":");
    return { id: t.model, provider: t.model.slice(0, at), model: t.model.slice(at + 1), name: e.arms[1]!.name, context: 0, output: 0, efforts: [] as string[], billing: "per_token", first_seen: e.created_ms, unlisted: true, refused: {} };
  };

  return {
    "/api/models/new": {
      GET: (req: Request) => run(() => {
        const brief = new URL(req.url).searchParams.has("brief");
        const now = providers.newModels();
        // A model whose trial runs stays on the page after it is no longer news.
        const running = x().list().filter((e) => e.state === "running" && trialIn(e) && !now.some((m) => m.id === trialIn(e)!.model));
        const extra = running.map((e) => { const m = providers.current().find((c) => c.id === trialIn(e)!.model); return m ? fields({ ...m, first_seen: e.created_ms }) : gone(e); });
        return {
          roles: ROLES,
          metrics: Object.fromEntries(SHOWN.map((m) => [m, { label: METRICS[m].label, unit: METRICS[m].unit, better: METRICS[m].better }])),
          models: [...now.map(fields), ...extra].map((m) => { const e = trialOfModel(m.id); return { ...m, ...(e ? { trial: view(e, brief) } : {}) }; }),
        };
      }),
    },
    "/api/models/new/trial": {
      POST: async (req: Request) => run(async () => {
        const b = await body(req);
        const role = b.role as Role;
        if (!ROLES.includes(role)) throw fail(`role is one of ${ROLES.join(", ")}`, 400);
        const m = providers.current().find((c) => c.id === b.model);
        if (!m) throw fail("no listed model has that id", 404);
        const no = roleRefusal(role, m);
        if (no) throw fail(no, 409);
        const mine = trialOfModel(m.id);
        if (mine?.state === "running") throw fail(`${m.name} is on trial already`, 409);
        const other = x().running();
        if (other) throw fail(`${other.name} is running live: stop it first`, 409);
        // One call makes the experiment with its own id, which its arm holds: none is left a draft when the start is refused.
        const exp = Bun.randomUUIDv7();
        const made = x().create({ ...trialExperiment(m, role, exp), template: TRIAL_KIND }, { id: exp, kind: TRIAL_KIND });
        let started: Experiment;
        try { started = x().start(made.id); } catch (e) { x().remove(made.id); throw e; }
        return { trial: view(started, true) };
      }, 201),
    },
    "/api/models/new/dismiss": {
      POST: async (req: Request) => run(async () => {
        const b = await body(req);
        if (typeof b.model !== "string") throw fail("model is the id of a listed model", 400);
        if (trialOfModel(b.model)?.state === "running") throw fail("its trial is running: stop it first", 409);
        if (!providers.dismissNew(b.model)) throw fail("no listed model has that id", 404);
        return { ok: true };
      }),
    },
  };
};
