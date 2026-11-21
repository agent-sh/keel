// GET /api/usage?group=model|session|day|provider&session_id=&children_of=&since_ms=&until_ms=&tz=&tz_offset_minutes=&sort=&limit=
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
// children_of: the requests of the agents a session started (its delegated spend).
// The ledger is summed in SQLite: what reaches JS is one row per bucket and
// purpose, however many requests they hold.
import type { RouteModule } from "../app.ts";

const GROUPS = new Set(["model", "session", "day", "provider"]);
const SORTS = new Set(["total", "fresh", "cost"]);

type Sum = {
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  calls: number; priced_cost_usd: number; unpriced_calls: number; included_calls: number; incomplete_calls: number;
};

const FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "calls", "priced_cost_usd", "unpriced_calls", "included_calls", "incomplete_calls"] as const;
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

const DAY = 86_400_000;
// Whole days since 1970 of a millisecond count, rounded down also below zero
// (SQLite divides toward zero).
const dayOf = (ms: string) => `((${ms}) - ((((${ms}) % ${DAY}) + ${DAY}) % ${DAY})) / ${DAY}`;
const isoDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

// How far a zone's clock is ahead of UTC at an instant, in milliseconds.
function zoneOffset(zone: string): (ms: number) => number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  return (ms) => {
    const sec = Math.floor(ms / 1000) * 1000;
    const p: Record<string, number> = {};
    for (const { type, value } of f.formatToParts(sec)) p[type] = Number(value);
    return Date.UTC(p.year!, p.month! - 1, p.day, p.hour, p.minute, p.second) - sec;
  };
}

// The zone's offset as a SQL expression of `ts`, right for every instant of
// the given UTC days (ascending): a step function with a step where the zone
// changes its clock. Only days that hold requests are looked at, two instants
// each; a day whose ends differ is walked to find each change to the
// millisecond. Between two days with requests a step may sit anywhere.
export function offsetSql(days: number[], at: (ms: number) => number): string {
  const steps: { from: number; off: number }[] = [];
  let cur: number | undefined;
  for (const d of days) {
    const a = d * DAY, b = a + DAY - 1;
    const first = at(a);
    if (first !== cur) steps.push({ from: a, off: (cur = first) });
    if (at(b) === cur) continue;
    for (let lo = a; lo < b;) {
      const hi = Math.min(lo + 900_000, b);
      const o = at(hi);
      if (o !== cur) {
        let l = lo, h = hi;
        while (h - l > 1) {
          const mid = Math.floor((l + h) / 2);
          if (at(mid) === cur) l = mid; else h = mid;
        }
        steps.push({ from: h, off: (cur = at(h)) });
        lo = h;
      } else lo = hi;
    }
  }
  if (steps.length < 2) return String(steps[0]?.off ?? 0);
  return `CASE ${steps.slice(1).map((s, i) => `WHEN ts < ${s.from} THEN ${steps[i]!.off}`).join(" ")} ELSE ${steps.at(-1)!.off} END`;
}

type Group = Sum & { key: string | number; purpose: string; first: number };

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
      if ([since, until, tz, limit].some((v) => v !== undefined && isNaN(v)) || !Number.isFinite(tz)) return Response.json({ error: "a bound is not a number" }, { status: 400 });
      const zone = q.get("tz");
      let offset: ((ms: number) => number) | undefined;
      if (zone) {
        try { offset = zoneOffset(zone); }
        catch { return Response.json({ error: `unknown time zone ${zone}` }, { status: 400 }); }
      }
      // A failed attempt that reported no usage is not a request to count.
      const where = ["NOT (outcome = 'error' AND input + output + cache_read + cache_write = 0 AND cost IS NULL)"];
      const args: (string | number)[] = [];
      if (q.get("session_id")) { where.push("session_id = ?"); args.push(q.get("session_id")!); }
      if (q.get("children_of")) { where.push("session_id IN (SELECT id FROM sessions WHERE parent_id = ?)"); args.push(q.get("children_of")!); }
      if (since !== undefined) { where.push("ts >= ?"); args.push(since); }
      if (until !== undefined) { where.push("ts < ?"); args.push(until); }
      const from = `FROM telemetry_calls WHERE ${where.join(" AND ")}`;
      let key = "model";
      if (group === "provider") key = "substr(model, 1, max(0, instr(model, ':') - 1))";
      else if (group === "session") key = "session_id";
      else if (group === "day") {
        // The day number of the local clock: at the zone's offset of that
        // instant (the UTC days that hold requests say where its clock changes),
        // else at the fixed offset given.
        key = offset
          ? dayOf(`ts + ${offsetSql(store.db.query<{ d: number }, any[]>(`SELECT DISTINCT ${dayOf("ts")} AS d ${from} ORDER BY d`).all(...args).map((r) => r.d), offset)}`)
          : dayOf(`CAST(ts - (${tz * 60_000}) AS INTEGER)`);
      }
      const groups = store.db
        .query<Group, any[]>(`SELECT ${key} AS key, COALESCE(purpose, 'turn') AS purpose, MIN(id) AS first, COUNT(*) AS calls,
          SUM(input) AS input_tokens, SUM(output) AS output_tokens, SUM(cache_read) AS cache_read_tokens, SUM(cache_write) AS cache_write_tokens,
          COALESCE(SUM(cost), 0) AS priced_cost_usd,
          SUM(cost IS NULL AND unpriced != 0) AS unpriced_calls,
          SUM(cost IS NULL AND unpriced = 0 AND outcome != 'ok') AS incomplete_calls,
          SUM(cost IS NULL AND unpriced = 0 AND outcome = 'ok') AS included_calls
          ${from} GROUP BY 1, 2`)
        .all(...args);
      // Buckets and purposes in the order their first request was written.
      const total = empty();
      const buckets = new Map<string, Sum & { first: number }>();
      const purposes = new Map<string, Sum & { first: number }>();
      const into = (m: Map<string, Sum & { first: number }>, k: string, g: Group) => {
        const s = m.get(k) ?? { ...empty(), first: g.first };
        m.set(k, s);
        s.first = Math.min(s.first, g.first);
        return s;
      };
      for (const g of groups) {
        const k = group === "day" ? isoDay(Number(g.key)) : String(g.key);
        for (const s of [total, into(buckets, k, g), into(purposes, g.purpose, g)]) {
          for (const f of FIELDS) s[f] += g[f];
        }
      }
      const inOrder = (m: Map<string, Sum & { first: number }>) => [...m.entries()].sort((a, b) => a[1].first - b[1].first).map(([k, { first: _, ...s }]) => [k, s] as const);
      const rank = (s: ReturnType<typeof finish>) => (sort === "fresh" ? s.input_tokens + s.output_tokens : sort === "cost" ? s.priced_cost_usd : s.total_tokens);
      const list = inOrder(buckets)
        .map(([key, s]) => ({ key, ...finish(s) }))
        .sort((a, b) => (group === "day" ? b.key.localeCompare(a.key) : rank(b) - rank(a)));
      return Response.json({
        group, sort: group === "day" ? "day" : sort, tz: zone ?? undefined, buckets: list.slice(0, limit), has_more: list.length > limit, total: finish(total),
        by_purpose: inOrder(purposes).map(([purpose, s]) => ({ purpose, ...finish(s) })),
      });
    },
  },
});
