// Experiments and feature observability.
//
// GET    /api/experiments                 every experiment, the templates and the metrics
// POST   /api/experiments                 { template?, name, hypothesis, mode, arms, primary, guards, stop }
// GET    /api/experiments/:id             the experiment, its report and its sessions per arm
//                                         (a stopped one: the report frozen at its stop)
// PATCH  /api/experiments/:id             a draft's fields
// DELETE /api/experiments/:id             a draft or a stopped one
// POST   /api/experiments/:id/start       live: new sessions get arms from now on
// POST   /api/experiments/:id/stop        ends it and records the decision with its report
// POST   /api/experiments/:id/runs        { runs: [{ arm, task, rep, metrics }] } from the offline runner
// GET    /api/features?period=|since_ms&until_ms   each feature's turns, savings, trend, regression state
// POST   /api/features/check              the regression check now (it also runs hourly)
// POST   /api/features/rating             { event_id, value: 1 | -1 | 0 }
// GET    /api/features/ratings?session_id the session's ratings by reply
import { raise } from "../../automation/alerts.ts";
import { armOf, Experiments, METRICS, TEMPLATES, type Experiment } from "../../admin/experiments.ts";
import { registerSessionTags } from "../../admin/otlp.ts";
import { OUTCOMES, Outcomes } from "../../admin/outcomes.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const PERIODS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };
const HOUR = 3_600_000;

export let experiments: Experiments | undefined;
export let outcomes: Outcomes | undefined;

export const experimentRoutes: RouteModule = ({ store, errors }) => {
  const notice = (e: Experiment) => {
    if (!e.stop_reason?.startsWith("guard")) return;
    raise("regression", null, `Experiment stopped: ${e.name}`, `${e.stop_reason}. ${e.decision?.text ?? ""} ${e.decision?.remove ?? ""}`.trim(), { experiment: e.id, open_settings: "experiments" });
  };
  const x = (experiments = new Experiments(store, notice));
  const o = (outcomes = new Outcomes(store, x));
  // Exported traces carry the experiment and arm too.
  registerSessionTags((sid) => { const t = armOf(store, sid); return t ? { "keel.experiment.id": t.exp_id, "keel.experiment.arm": t.arm } : {}; });
  // The hourly regression check; a reload replaces the last one's timer.
  const g = globalThis as { __keelRegressionTimer?: ReturnType<typeof setInterval> };
  if (g.__keelRegressionTimer) clearInterval(g.__keelRegressionTimer);
  g.__keelRegressionTimer = setInterval(() => { try { o.regressions(); } catch (e) { errors.capture("server", e, { at: "regression check" }); } }, HOUR);
  g.__keelRegressionTimer.unref?.();

  const run = async (f: () => unknown | Promise<unknown>, status = 200) => {
    try { return json(await f(), status); } catch (e: any) {
      if (e?.status) return json({ error: e.message }, e.status);
      errors.capture("server", e, { at: "experiments" });
      return json({ error: String(e?.message ?? e) }, 500);
    }
  };
  const body = async (req: Request) => (await req.json().catch(() => null)) ?? {};
  const summary = (e: Experiment) => x.summary(e);
  type P = Request & { params: { id: string } };

  return {
    "/api/experiments": {
      GET: () => json({ experiments: x.list().map(summary), templates: TEMPLATES.map((t) => ({ id: t.id, label: t.label, ...t.make() })), metrics: METRICS, outcomes: OUTCOMES }),
      POST: async (req: Request) => run(async () => ({ experiment: x.create(await body(req)) }), 201),
    },
    "/api/experiments/:id": {
      GET: (req: P) => run(() => {
        const e = x.get(req.params.id);
        if (!e) throw Object.assign(new Error("no such experiment"), { status: 404 });
        return { experiment: summary(e), report: x.report(e) };
      }),
      PATCH: async (req: P) => run(async () => ({ experiment: x.update(req.params.id, await body(req)) })),
      DELETE: (req: P) => run(() => { x.remove(req.params.id); return { ok: true }; }),
    },
    "/api/experiments/:id/start": { POST: (req: P) => run(() => ({ experiment: x.start(req.params.id) })) },
    "/api/experiments/:id/stop": { POST: async (req: P) => run(async () => ({ experiment: x.stop(req.params.id, (await body(req)).reason || undefined) })) },
    "/api/experiments/:id/runs": {
      POST: async (req: P) => run(async () => {
        const b = await body(req);
        if (!Array.isArray(b.runs)) throw Object.assign(new Error("runs is a list"), { status: 400 });
        return { added: x.addRuns(req.params.id, b.runs) };
      }, 201),
    },
    "/api/features": {
      GET: (req: Request) => run(() => {
        const q = new URL(req.url).searchParams;
        const period = q.get("period");
        if (period && !(period in PERIODS)) throw Object.assign(new Error(`unknown period ${period}: day, week or month`), { status: 400 });
        const until = q.get("until_ms") ? Number(q.get("until_ms")) : Date.now();
        const since = period ? until - PERIODS[period as keyof typeof PERIODS] : q.get("since_ms") ? Number(q.get("since_ms")) : undefined;
        if (!Number.isFinite(until) || (since !== undefined && !Number.isFinite(since))) throw Object.assign(new Error("a bound is not a number"), { status: 400 });
        return o.features({ since, until });
      }),
    },
    "/api/features/check": { POST: () => run(() => ({ regressions: o.regressions() })) },
    "/api/features/rating": {
      POST: async (req: Request) => run(async () => {
        const b = await body(req);
        return o.rate(String(b.event_id ?? ""), Number(b.value));
      }),
    },
    "/api/features/ratings": {
      GET: (req: Request) => run(() => ({ ratings: o.ratings(new URL(req.url).searchParams.get("session_id") ?? "") })),
    },
  };
};
