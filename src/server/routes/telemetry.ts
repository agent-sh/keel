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
import { promptOf } from "../../engine/prompt-store.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export let telemetry: Telemetry | undefined;

type Bad = { error: string; status: number };
const PERIODS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };

export const telemetryRoutes: RouteModule = ({ store, bus }) => {
  const t = (telemetry = new Telemetry(store, bus));
  // The filters every report takes; `prefix` reads one side of a comparison.
  // `period` (day, week, month) is the last 24 hours, 7 days or 30 days up
  // to now; it does not mix with explicit bounds, and another word is refused.
  const filter = (q: URLSearchParams, prefix = ""): Filter | Bad => {
    const num = (k: string) => (q.get(prefix + k) ? Number(q.get(prefix + k)) : undefined);
    let since = num("since_ms"), until = num("until_ms");
    const bucket = num("bucket_ms");
    const period = q.get(prefix + "period");
    if (period !== null) {
      if (!(period in PERIODS)) return { error: `unknown period ${period}: day, week or month`, status: 400 };
      if (since !== undefined || until !== undefined) return { error: "period and since_ms/until_ms do not mix", status: 400 };
      until = Date.now();
      since = until - PERIODS[period as keyof typeof PERIODS];
    }
    if ([since, until, bucket].some((v) => v !== undefined && !Number.isFinite(v))) return { error: "a bound is not a number", status: 400 };
    if (since !== undefined && until !== undefined && since > until) return { error: `${prefix}since_ms is after ${prefix}until_ms`, status: 400 };
    if (bucket !== undefined && bucket < 60_000) return { error: "bucket_ms is under a minute", status: 400 };
    const session = q.get("session_id") || undefined;
    if (session && !store.session(session)) return { error: "no such session", status: 404 };
    return { since, until, bucket, session, model: q.get(prefix + "model") || q.get("model") || undefined };
  };
  const bad = (f: Filter | Bad): f is Bad => "error" in f;
  const route = (run: (f: Filter, q: URLSearchParams) => unknown) => async (req: Request) => {
    const q = new URL(req.url).searchParams;
    const f = filter(q);
    return bad(f) ? json({ error: f.error }, f.status) : json(await run(f, q));
  };
  return {
    "/api/telemetry": { GET: route((f) => t.report(f)) },
    // GET /api/telemetry/tokens: the zones of the prompts, in total, over time, by purpose; per turn with session_id.
    "/api/telemetry/tokens": { GET: route((f) => t.tokens(f)) },
    // GET /api/telemetry/compactions?limit=: each compaction, newest first, with the sums.
    "/api/telemetry/compactions": {
      GET: async (req: Request) => {
        const q = new URL(req.url).searchParams;
        const f = filter(q);
        if (bad(f)) return json({ error: f.error }, f.status);
        const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
        if (limit !== undefined && !Number.isFinite(limit)) return json({ error: "limit is not a number" }, 400);
        return json(await t.compactions({ ...f, limit }));
      },
    },
    // GET /api/telemetry/compare?a_since_ms&a_until_ms&a_model&b_since_ms&b_until_ms&b_model (and session_id)
    "/api/telemetry/compare": {
      GET: async (req: Request) => {
        const q = new URL(req.url).searchParams;
        const a = filter(q, "a_"), b = filter(q, "b_");
        if (bad(a)) return json({ error: a.error }, a.status);
        if (bad(b)) return json({ error: b.error }, b.status);
        return json(await t.compare(a, b));
      },
    },
    // GET /api/telemetry/examples?tool=&session_id=&limit=&since_ms=&until_ms=  the last failed tool calls (in that interval)
    "/api/telemetry/examples": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const f = filter(q);
        if (bad(f)) return json({ error: f.error }, f.status);
        const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
        if (limit !== undefined && !Number.isFinite(limit)) return json({ error: "limit is not a number" }, 400);
        return json({ examples: t.examples({ tool: q.get("tool") || undefined, session: f.session, limit, since: f.since, until: f.until }) });
      },
    },
    // GET /api/telemetry/prompt?session_id=: the system prompt kept with the
    // session (a subagent's is its parent's): its blocks with their sizes and
    // fingerprints, when it was rendered, and the blocks that differed the
    // last time it changed. `text=1` adds the text itself.
    "/api/telemetry/prompt": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const p = promptOf(store, q.get("session_id") ?? "");
        if (!p) return json({ error: "no prompt is kept for this session: it has sent no request yet" }, 404);
        const { text, ...rest } = p;
        return json({ ...rest, bytes: Buffer.byteLength(text), hash: Bun.hash(text).toString(36), ...(q.get("text") === "1" ? { text } : {}) });
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
