// GET /api/telemetry?since_ms=&until_ms=&session_id=&model=&bucket_ms=
// Local measurements of the model requests and tool calls: latency and time
// to first token (p50, p95), output speed, cache hit rate, error rates and
// error classes per provider and model, per bucket of time, per model and per
// tool. Prices and per-turn cost are the usage report's (/api/usage); this
// reports how the calls behaved. /tokens splits the prompts into zones,
// /compactions reports each compaction, /compare puts two ranges or two
// models side by side.
import { ERROR_CLASSES } from "../../admin/classes.ts";
import { AFTER_REQUESTS, BREAK_CAUSES, type Filter, Telemetry } from "../../admin/telemetry.ts";
import { ZONES } from "../../admin/zones.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export let telemetry: Telemetry | undefined;

type Bad = { error: string; status: number };

export const telemetryRoutes: RouteModule = ({ store, bus }) => {
  const t = (telemetry = new Telemetry(store, bus));
  // The filters every report takes; `prefix` reads one side of a comparison.
  const filter = (q: URLSearchParams, prefix = ""): Filter | Bad => {
    const num = (k: string) => (q.get(prefix + k) ? Number(q.get(prefix + k)) : undefined);
    const since = num("since_ms"), until = num("until_ms"), bucket = num("bucket_ms");
    if ([since, until, bucket].some((v) => v !== undefined && !Number.isFinite(v))) return { error: "a bound is not a number", status: 400 };
    if (since !== undefined && until !== undefined && since > until) return { error: `${prefix}since_ms is after ${prefix}until_ms`, status: 400 };
    if (bucket !== undefined && bucket < 60_000) return { error: "bucket_ms is under a minute", status: 400 };
    const session = q.get("session_id") || undefined;
    if (session && !store.session(session)) return { error: "no such session", status: 404 };
    return { since, until, bucket, session, model: q.get(prefix + "model") || q.get("model") || undefined };
  };
  const bad = (f: Filter | Bad): f is Bad => "error" in f;
  const route = (run: (f: Filter, q: URLSearchParams) => unknown) => (req: Request) => {
    const q = new URL(req.url).searchParams;
    const f = filter(q);
    return bad(f) ? json({ error: f.error }, f.status) : json(run(f, q));
  };
  return {
    "/api/telemetry": { GET: route((f) => t.report(f)) },
    // GET /api/telemetry/tokens: the zones of the prompts, in total, over time, by purpose; per turn with session_id.
    "/api/telemetry/tokens": { GET: route((f) => t.tokens(f)) },
    // GET /api/telemetry/compactions?limit=: each compaction, newest first, with the sums.
    "/api/telemetry/compactions": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const f = filter(q);
        if (bad(f)) return json({ error: f.error }, f.status);
        const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
        if (limit !== undefined && !Number.isFinite(limit)) return json({ error: "limit is not a number" }, 400);
        return json(t.compactions({ ...f, limit }));
      },
    },
    // GET /api/telemetry/compare?a_since_ms&a_until_ms&a_model&b_since_ms&b_until_ms&b_model (and session_id)
    "/api/telemetry/compare": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const a = filter(q, "a_"), b = filter(q, "b_");
        if (bad(a)) return json({ error: a.error }, a.status);
        if (bad(b)) return json({ error: b.error }, b.status);
        return json(t.compare(a, b));
      },
    },
    // GET /api/telemetry/examples?tool=&session_id=&limit=  the last failed tool calls
    "/api/telemetry/examples": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
        if (limit !== undefined && !Number.isFinite(limit)) return json({ error: "limit is not a number" }, 400);
        return json({ examples: t.examples({ tool: q.get("tool") || undefined, session: q.get("session_id") || undefined, limit }) });
      },
    },
    "/api/telemetry/vocabulary": {
      GET: () => json({
        cache_break_causes: BREAK_CAUSES, outcomes: ["ok", "error", "interrupted"], error_classes: ERROR_CLASSES, zones: ZONES,
        compaction_modes: ["summary", "clear"], compaction_triggers: ["threshold", "overflow", "owner"], after_requests: AFTER_REQUESTS,
      }),
    },
  };
};
