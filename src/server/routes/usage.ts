// GET /api/usage?group=model|session|day|provider&session_id=&since_ms=&until_ms=&tz=&tz_offset_minutes=&sort=&limit=
// Tokens and cost of every model request, grouped, read from the telemetry
// ledger (one row per request attempt: turn steps, summaries, side answers
// and advisor consults alike; a fork's copied history is not a new request).
// `total` covers every request the filter matches whatever the grouping.
// A request without a known price is counted in `unpriced_calls`; one that
// ended before its usage arrived (stopped, cut) in `incomplete_calls`;
// `cost_usd` is present only when neither happened (unknown is never zero).
// Requests on a plan (answered, no per-call price, nothing unpriced) are
// `included_calls`. A failed attempt that reported no usage is not counted.
// Days are civil dates in `tz` (an IANA zone) when given, else at the fixed
// `tz_offset_minutes` (0: UTC). `sort` orders non-day groups: total tokens
// (default), fresh (input without cache plus output) or cost.
import type { RouteModule } from "../app.ts";

const GROUPS = new Set(["model", "session", "day", "provider"]);
const SORTS = new Set(["total", "fresh", "cost"]);

type Sum = {
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  calls: number; priced_cost_usd: number; unpriced_calls: number; included_calls: number; incomplete_calls: number;
};

const empty = (): Sum => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, calls: 0, priced_cost_usd: 0, unpriced_calls: 0, included_calls: 0, incomplete_calls: 0 });

function finish(s: Sum) {
  const prompt = s.input_tokens + s.cache_read_tokens + s.cache_write_tokens;
  return {
    ...s,
    total_tokens: prompt + s.output_tokens,
    cost_usd: s.unpriced_calls || s.incomplete_calls ? undefined : s.priced_cost_usd,
    cache_hit_ratio: prompt ? s.cache_read_tokens / prompt : 0,
  };
}

type Row = { session_id: string; ts: number; model: string; input: number; output: number; cache_read: number; cache_write: number; cost: number | null; unpriced: number; outcome: string; purpose: string | null };

export const usageRoutes: RouteModule = ({ store }) => ({
  "/api/usage": {
    GET: (req: Request) => {
      const q = new URL(req.url).searchParams;
      const group = q.get("group") ?? "model";
      if (!GROUPS.has(group)) return Response.json({ error: `unknown group ${group}` }, { status: 400 });
      const sort = q.get("sort") ?? "total";
      if (!SORTS.has(sort)) return Response.json({ error: `unknown sort ${sort}: total, fresh or cost` }, { status: 400 });
      const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
      const since = num("since_ms"), until = num("until_ms"), tz = num("tz_offset_minutes") ?? 0;
      const limit = Math.min(5000, Math.max(1, num("limit") ?? 500));
      if ([since, until, tz, limit].some((v) => v !== undefined && isNaN(v))) return Response.json({ error: "a bound is not a number" }, { status: 400 });
      const zone = q.get("tz");
      let civil: Intl.DateTimeFormat | undefined;
      if (zone) {
        try { civil = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }); }
        catch { return Response.json({ error: `unknown time zone ${zone}` }, { status: 400 }); }
      }
      const where = ["1 = 1"];
      const args: (string | number)[] = [];
      if (q.get("session_id")) { where.push("session_id = ?"); args.push(q.get("session_id")!); }
      if (since !== undefined) { where.push("ts >= ?"); args.push(since); }
      if (until !== undefined) { where.push("ts < ?"); args.push(until); }
      const rows = store.db
        .query<Row, any[]>(`SELECT session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, purpose FROM telemetry_calls WHERE ${where.join(" AND ")}`)
        .all(...args);
      const total = empty();
      const buckets = new Map<string, Sum>();
      const purposes = new Map<string, Sum>();
      for (const r of rows) {
        const tokens = r.input + r.output + r.cache_read + r.cache_write;
        if (r.outcome === "error" && !tokens && r.cost === null) continue;
        const key = group === "model" ? r.model
          : group === "provider" ? r.model.slice(0, Math.max(0, r.model.indexOf(":")))
          : group === "session" ? r.session_id
          : civil ? civil.format(new Date(r.ts)) : new Date(r.ts - tz * 60_000).toISOString().slice(0, 10);
        const b = buckets.get(key) ?? empty();
        buckets.set(key, b);
        const purpose = r.purpose ?? "turn";
        const p = purposes.get(purpose) ?? empty();
        purposes.set(purpose, p);
        for (const s of [total, b, p]) {
          s.calls++;
          s.input_tokens += r.input;
          s.output_tokens += r.output;
          s.cache_read_tokens += r.cache_read;
          s.cache_write_tokens += r.cache_write;
          if (typeof r.cost === "number") s.priced_cost_usd += r.cost;
          else if (r.unpriced) s.unpriced_calls++;
          else if (r.outcome !== "ok") s.incomplete_calls++;
          else s.included_calls++;
        }
      }
      const rank = (s: ReturnType<typeof finish>) => (sort === "fresh" ? s.input_tokens + s.output_tokens : sort === "cost" ? s.priced_cost_usd : s.total_tokens);
      const list = [...buckets.entries()]
        .map(([key, s]) => ({ key, ...finish(s) }))
        .sort((a, b) => (group === "day" ? b.key.localeCompare(a.key) : rank(b) - rank(a)));
      return Response.json({
        group, sort: group === "day" ? "day" : sort, tz: zone ?? undefined, buckets: list.slice(0, limit), has_more: list.length > limit, total: finish(total),
        by_purpose: [...purposes.entries()].map(([purpose, s]) => ({ purpose, ...finish(s) })),
      });
    },
  },
});
