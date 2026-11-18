// GET /api/telemetry?since_ms=&until_ms=&session_id=&bucket_ms=
// Local measurements of the model requests and tool calls: latency and time
// to first token (p50, p95), output speed, cache hit rate, error rates, per
// bucket of time, per model and per tool. Prices and per-turn cost are the
// usage report's (/api/usage); this reports how the calls behaved.
import { Telemetry } from "../../admin/telemetry.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export let telemetry: Telemetry | undefined;

export const telemetryRoutes: RouteModule = ({ store, bus }) => {
  const t = (telemetry = new Telemetry(store, bus));
  return {
    "/api/telemetry": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
        const since = num("since_ms"), until = num("until_ms"), bucket = num("bucket_ms");
        if ([since, until, bucket].some((v) => v !== undefined && !Number.isFinite(v))) return json({ error: "a bound is not a number" }, 400);
        if (since !== undefined && until !== undefined && since > until) return json({ error: "since_ms is after until_ms" }, 400);
        if (bucket !== undefined && bucket < 60_000) return json({ error: "bucket_ms is under a minute" }, 400);
        const session = q.get("session_id") || undefined;
        if (session && !store.session(session)) return json({ error: "no such session" }, 404);
        return json(t.report({ since, until, session, bucket }));
      },
    },
  };
};
