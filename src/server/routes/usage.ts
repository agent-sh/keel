// GET /api/usage?group=model|session|day|provider&session_id=&since_ms=&until_ms=&tz_offset_minutes=&limit=
// Tokens and cost of every model call (one stored assistant step each),
// grouped. `total` covers every call the filter matches whatever the grouping.
// A call without a known price is counted in `unpriced_calls`; `cost_usd` is
// present only when every per-token call had a price (unknown is never zero).
// Calls on a plan (no per-call price, nothing unpriced) are `included_calls`.
import type { RouteModule } from "../app.ts";

const GROUPS = new Set(["model", "session", "day", "provider"]);

type Sum = {
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  calls: number; priced_cost_usd: number; unpriced_calls: number; included_calls: number;
};

const empty = (): Sum => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, calls: 0, priced_cost_usd: 0, unpriced_calls: 0, included_calls: 0 });

function finish(s: Sum) {
  const prompt = s.input_tokens + s.cache_read_tokens + s.cache_write_tokens;
  return {
    ...s,
    cost_usd: s.unpriced_calls ? undefined : s.priced_cost_usd,
    cache_hit_ratio: prompt ? s.cache_read_tokens / prompt : 0,
  };
}

export const usageRoutes: RouteModule = ({ store }) => ({
  "/api/usage": {
    GET: (req: Request) => {
      const q = new URL(req.url).searchParams;
      const group = q.get("group") ?? "model";
      if (!GROUPS.has(group)) return Response.json({ error: `unknown group ${group}` }, { status: 400 });
      const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
      const since = num("since_ms"), until = num("until_ms"), tz = num("tz_offset_minutes") ?? 0;
      const limit = Math.min(5000, Math.max(1, num("limit") ?? 500));
      if ([since, until, tz, limit].some((v) => v !== undefined && isNaN(v))) return Response.json({ error: "a bound is not a number" }, { status: 400 });
      const where = ["kind = 'assistant'"];
      const args: (string | number)[] = [];
      if (q.get("session_id")) { where.push("session_id = ?"); args.push(q.get("session_id")!); }
      if (since !== undefined) { where.push("ts >= ?"); args.push(since); }
      if (until !== undefined) { where.push("ts < ?"); args.push(until); }
      const rows = store.db
        .query<{ session_id: string; ts: number; model: string | null; usage: string | null }, any[]>(
          `SELECT session_id, ts, json_extract(data, '$.model') AS model, json_extract(data, '$.usage') AS usage FROM events WHERE ${where.join(" AND ")}`,
        )
        .all(...args);
      const total = empty();
      const buckets = new Map<string, Sum>();
      for (const r of rows) {
        const u = r.usage ? JSON.parse(r.usage) : {};
        const model = r.model ?? "";
        const key = group === "model" ? model
          : group === "provider" ? model.slice(0, model.indexOf(":"))
          : group === "session" ? r.session_id
          : new Date(r.ts - tz * 60_000).toISOString().slice(0, 10);
        const b = buckets.get(key) ?? empty();
        buckets.set(key, b);
        for (const s of [total, b]) {
          s.calls++;
          s.input_tokens += u.input ?? 0;
          s.output_tokens += u.output ?? 0;
          s.cache_read_tokens += u.cache_read ?? 0;
          s.cache_write_tokens += u.cache_write ?? 0;
          if (typeof u.cost === "number") s.priced_cost_usd += u.cost;
          else if (u.unpriced) s.unpriced_calls++;
          else s.included_calls++;
        }
      }
      const list = [...buckets.entries()]
        .map(([key, s]) => ({ key, ...finish(s) }))
        .sort((a, b) => (group === "day" ? b.key.localeCompare(a.key) : b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)));
      return Response.json({ group, buckets: list.slice(0, limit), has_more: list.length > limit, total: finish(total) });
    },
  },
});
