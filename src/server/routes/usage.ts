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
// group=tree sums each session with the agents under it (and theirs) into the
// session at the top: `own_cost_usd` is the top session's own, `agents` how
// many agents spent and `agents_cost_usd` what they spent. With group=session
// or tree the answer carries `sessions`: each listed id's title, parent and
// whether it is archived (an id that is not there was removed).
// The ledger is summed in SQLite: what reaches JS is one row per bucket and
// purpose, however many requests they hold. And the sums are not made from the
// ledger: a rollup (usage_rollup) holds them per quarter hour, session, model
// and purpose, kept by triggers as requests are written, so a view reads a few
// narrow rows per quarter hour instead of every request ever made. Only the
// part of a time window that is not whole quarter hours (at most the quarter
// hour at each end) is read from the ledger, by its time index.
// The daemon makes the rollup at its start and holds it against the ledger
// there (checkRollup); GET /api/usage/rollup gives that check
// ({ ok, rollup_calls, ledger_calls }) and POST makes the rollup again.
import type { Database } from "bun:sqlite";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { driversAtStart } from "../drivers-start.ts";
import { checkpointerOf } from "../../core/checkpoint.ts";
import { rewriteUsd, USAGE_ROLLUP_TRIGGER, type DriversRead } from "../../admin/cost-drivers.ts";

const GROUPS = new Set(["model", "session", "tree", "day", "provider"]);
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
export function offsetSteps(days: number[], at: (ms: number) => number): { from: number; off: number }[] {
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
  return steps;
}
export function offsetSql(days: number[], at: (ms: number) => number, steps = offsetSteps(days, at)): string {
  if (steps.length < 2) return String(steps[0]?.off ?? 0);
  return `CASE ${steps.slice(1).map((s, i) => `WHEN ts < ${s.from} THEN ${steps[i]!.off}`).join(" ")} ELSE ${steps.at(-1)!.off} END`;
}

type Group = Sum & { key: string | number; purpose: string; first: number };

// The rollup's bucket: a quarter hour of UTC. Every zone's offset from UTC and
// every clock change falls on one, so a bucket lies in one civil day of any
// zone (a view at an offset that does not is summed from the ledger).
export const BUCKET = 900_000;
const bucketOf = (ts: string) => `(${ts} - (((${ts} % ${BUCKET}) + ${BUCKET}) % ${BUCKET}))`;
// A failed attempt that reported no usage is not a request to count.
const counted = (r = "") => `NOT (${r}outcome = 'error' AND ${r}input + ${r}output + ${r}cache_read + ${r}cache_write = 0 AND ${r}cost IS NULL)`;
// The rollup's columns after its key's time, session and model, and a ledger
// row (`r`: NEW. or OLD. in a trigger) as each of them.
const COLS = ["purpose", "first", "calls", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "priced_cost_usd", "unpriced_calls", "incomplete_calls", "included_calls"];
const SUMS = COLS.slice(2);
const ledger = (r = "") => [
  `COALESCE(${r}purpose, 'turn')`, `${r}id`, "1", `${r}input`, `${r}output`, `${r}cache_read`, `${r}cache_write`, `COALESCE(${r}cost, 0)`,
  `(${r}cost IS NULL AND ${r}unpriced != 0)`, `(${r}cost IS NULL AND ${r}unpriced = 0 AND ${r}outcome != 'ok')`, `(${r}cost IS NULL AND ${r}unpriced = 0 AND ${r}outcome = 'ok')`,
];
// The triggers' name carries the version of what they write: when it changes,
// the rollup is made again from the ledger (a rollup of another shape gets
// another table).
const TRIGGER = USAGE_ROLLUP_TRIGGER;

const has = (db: Database, type: "table" | "trigger", name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);

// The rollup and the triggers that keep it, made once from the ledger as it
// stands (in the write that adds the triggers, so no request falls between).
// The triggers are part of the database: a request written by any build, or
// by hand, is counted; a row taken out or changed is taken out of its sums.
// False while the ledger's table is not there yet. The daemon makes it at its
// start (checkRollup below), not in a view's request.
export function ensureRollup(db: Database): boolean {
  if (has(db, "trigger", `${TRIGGER}_add`)) return true;
  if (!has(db, "table", "telemetry_calls")) return false;
  rebuildRollup(db);
  return true;
}

export type RollupCheck = { ok: boolean; rollup_calls: number; ledger_calls: number; rebuilt?: boolean };
// The rollup against the ledger: the requests it counts and the requests the
// ledger holds that count. They differ only when a write went past the
// triggers (a row replaced whole, a ledger changed with the triggers off).
// `repair`: a rollup that is not there yet, or differs, is made again from the
// ledger. Run once at the daemon's start, and by the rollup route.
export function checkRollup(db: Database, repair = true): RollupCheck {
  if (!has(db, "table", "telemetry_calls")) return { ok: true, rollup_calls: 0, ledger_calls: 0 };
  const count = (): RollupCheck => {
    const { ledger_calls, rollup_calls } = db.query<{ ledger_calls: number; rollup_calls: number }, []>(`SELECT (SELECT COUNT(*) FROM telemetry_calls WHERE ${counted()}) AS ledger_calls,
      ${has(db, "table", "usage_rollup") ? "(SELECT COALESCE(SUM(calls), 0) FROM usage_rollup)" : "0"} AS rollup_calls`).get()!;
    return { ok: has(db, "trigger", `${TRIGGER}_add`) && rollup_calls === ledger_calls, rollup_calls, ledger_calls };
  };
  const c = count();
  if (c.ok || !repair) return c;
  rebuildRollup(db);
  return { ...count(), rebuilt: true };
}

// The rollup made again from the ledger, and its triggers with it, in one write.
export function rebuildRollup(db: Database) {
  const key = (r: string) => `bucket = ${bucketOf(`${r}ts`)} AND session_id = ${r}session_id AND model = ${r}model AND purpose = COALESCE(${r}purpose, 'turn')`;
  const add = `INSERT INTO usage_rollup (bucket, session_id, model, ${COLS.join(", ")}) SELECT ${bucketOf("NEW.ts")}, NEW.session_id, NEW.model, ${ledger("NEW.").join(", ")} WHERE ${counted("NEW.")}
    ON CONFLICT (bucket, session_id, model, purpose) DO UPDATE SET first = MIN(first, excluded.first), ${SUMS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")};`;
  const old = ledger("OLD.").slice(2);
  // The first request of a bucket that goes is replaced by the first one left.
  const sub = `UPDATE usage_rollup SET ${SUMS.map((c, i) => `${c} = ${c} - ${old[i]}`).join(", ")},
      first = CASE WHEN first = OLD.id THEN COALESCE((SELECT MIN(id) FROM telemetry_calls WHERE session_id = OLD.session_id AND ts >= ${bucketOf("OLD.ts")} AND ts < ${bucketOf("OLD.ts")} + ${BUCKET}
        AND model = OLD.model AND COALESCE(purpose, 'turn') = COALESCE(OLD.purpose, 'turn') AND id != OLD.id AND ${counted()}), first) ELSE first END
      WHERE ${key("OLD.")} AND ${counted("OLD.")};
    DELETE FROM usage_rollup WHERE ${key("OLD.")} AND calls <= 0;`;
  db.transaction(() => {
    for (const r of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'usage_rollup_%'").all()) db.run(`DROP TRIGGER ${r.name}`);
    db.run(`CREATE TABLE IF NOT EXISTS usage_rollup (bucket INTEGER NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL, first INTEGER NOT NULL, calls INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, priced_cost_usd REAL NOT NULL,
      unpriced_calls INTEGER NOT NULL, incomplete_calls INTEGER NOT NULL, included_calls INTEGER NOT NULL, PRIMARY KEY (bucket, session_id, model, purpose)) WITHOUT ROWID`);
    db.run("CREATE INDEX IF NOT EXISTS usage_rollup_session ON usage_rollup(session_id, bucket)");
    db.run("DELETE FROM usage_rollup");
    db.run(`INSERT INTO usage_rollup (bucket, session_id, model, ${COLS.join(", ")})
      SELECT ${bucketOf("ts")}, session_id, model, COALESCE(purpose, 'turn'), MIN(id), COUNT(*), SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), COALESCE(SUM(cost), 0),
        SUM(cost IS NULL AND unpriced != 0), SUM(cost IS NULL AND unpriced = 0 AND outcome != 'ok'), SUM(cost IS NULL AND unpriced = 0 AND outcome = 'ok')
      FROM telemetry_calls WHERE ${counted()} GROUP BY 1, 2, 3, 4`);
    db.run(`CREATE TRIGGER ${TRIGGER}_add AFTER INSERT ON telemetry_calls BEGIN ${add} END`);
    db.run(`CREATE TRIGGER ${TRIGGER}_del AFTER DELETE ON telemetry_calls BEGIN ${sub} END`);
    db.run(`CREATE TRIGGER ${TRIGGER}_upd AFTER UPDATE OF session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, purpose ON telemetry_calls BEGIN ${sub} ${add} END`);
  })();
}

export const usageRoutes: RouteModule = ({ store, errors, providers }) => {
  // At the daemon's start, once every route module has made its tables and
  // off any request: the rollup is made if this is the first build with it,
  // and held against the ledger. One that differs is made again and said so.
  // A view's request never builds it (it would hold the first view for as
  // long as the whole ledger takes to read).
  // The two counts read every row of the ledger and of the rollup: they are
  // made on the read thread, and the loop only compares them. A rollup that
  // is not there yet, or differs, is then made on the loop as before (once).
  const usageAtStart = async () => {
    try {
      const had = has(store.db, "trigger", `${TRIGGER}_add`);
      if (had && has(store.db, "table", "usage_rollup")) {
        // (One statement, so one snapshot: a request written between two reads is no mismatch.)
        const [c] = await readsOf(store).sql<{ l: number; r: number }>(`SELECT (SELECT COUNT(*) FROM telemetry_calls WHERE ${counted()}) AS l, (SELECT COALESCE(SUM(calls), 0) FROM usage_rollup) AS r`);
        if (c && c.l === c.r) return;
      }
      const c = checkRollup(store.db);
      if (c.rebuilt && had) errors?.capture("server", new Error(`The usage rollup did not match the ledger and was made again from it (${c.ledger_calls} requests).`), { at: "usage rollup" });
    } catch (e) {
      errors?.capture("server", e, { at: "usage rollup" });
    }
  };
  // The cost drivers' rollup (src/admin/cost-drivers.ts): counted on the read thread, made
  // again by the checkpoint thread only when it is not there or differs (src/server/drivers-start.ts).
  const driversStart = async () => {
    try {
      const reads = readsOf(store);
      const d = await driversAtStart(store.db, () => reads.run("usage.driversCheck", {}), () => checkpointerOf(store));
      if (d.where === "none") return;
      if (d.had) errors?.capture("server", new Error(`The cost drivers' rollup did not match the ledger and was made again from it (${d.before.ledger_calls} requests, ${d.before.ledger_turns} turns).`), { at: "cost drivers rollup" });
      if (d.after && !d.after.ok) errors?.capture("server", new Error(`The cost drivers' rollup still differs from the ledger after it was made again (${d.after.rollup_calls} of ${d.after.ledger_calls} requests).`), { at: "cost drivers rollup" });
    } catch (e) {
      errors?.capture("server", e, { at: "cost drivers rollup" });
    }
  };
  const atStart = setTimeout(async () => { await usageAtStart(); await driversStart(); }, 0);
  atStart.unref?.();
  return {
  // GET: the rollup against the ledger (the counts, and whether they agree).
  // POST: the rollup made again from the ledger, then the same answer.
  "/api/usage/rollup": {
    GET: () => Response.json(checkRollup(store.db, false)),
    POST: () => {
      if (!has(store.db, "table", "telemetry_calls")) return Response.json(checkRollup(store.db, false));
      rebuildRollup(store.db);
      return Response.json({ ...checkRollup(store.db, false), rebuilt: true });
    },
  },
  // GET /api/usage/drivers?since_ms=&until_ms=: why the range cost what it did (src/admin/cost-drivers.ts):
  // turn steps by prompt size, cache rewrites by cause (with `rewrite_usd`: an estimate of the part of their cost that
  // wrote the prompt again, priced at each model's own rates; null when a price is not known), agents
  // against the sessions above them, steps per turn and the dearest trees. Read on the read thread.
  "/api/usage/drivers": {
    GET: async (req: Request) => {
      const q = new URL(req.url).searchParams;
      const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
      const since = num("since_ms"), until = num("until_ms");
      if ([since, until].some((v) => v !== undefined && !Number.isFinite(v))) return Response.json({ error: "a bound is not a number" }, { status: 400 });
      const t0 = performance.now();
      const d: DriversRead = await readsOf(store).run("usage.drivers", { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) });
      const rates = (model: string) => providers.cachedModel(model)?.price;
      return Response.json({
        ...d, breaks: d.breaks.map(({ models, ...b }) => ({ ...b, rewrite_usd: rewriteUsd(models, rates), models: models.length })), took_ms: Math.round(performance.now() - t0),
      }, { headers: { "cache-control": "no-store" } });
    },
  },
  // GET /api/usage/yield?since_ms=&until_ms=: for each builder model and agent type, how often an agent's
  // done was contradicted (a refusal, a red check on its head, a landing that had to fix it), and for each
  // reviewer model its refusals a later fix confirmed, what its reviews cost, and its rounds a lane. Counts of
  // records only (src/admin/review-yield.ts). Read on the read thread.
  "/api/usage/yield": {
    GET: async (req: Request) => {
      const q = new URL(req.url).searchParams;
      const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
      const since = num("since_ms") ?? Date.now() - 7 * 86_400_000, until = num("until_ms");
      if ([since, until].some((v) => v !== undefined && !Number.isFinite(v))) return Response.json({ error: "a bound is not a number" }, { status: 400 });
      return Response.json(await readsOf(store).run("usage.yield", { since, ...(until !== undefined ? { until } : {}) }), { headers: { "cache-control": "no-store" } });
    },
  },
  "/api/usage": {
    GET: async (req: Request) => {
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
      const reads = readsOf(store);
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (q.get("session_id")) { where.push("session_id = ?"); args.push(q.get("session_id")!); }
      if (q.get("children_of")) { where.push("session_id IN (SELECT id FROM sessions WHERE parent_id = ?)"); args.push(q.get("children_of")!); }
      // What is summed, as rows of the rollup's shape with a time: the rollup
      // for the whole quarter hours of the window, the ledger for what is left
      // at its ends (`whole` false: the ledger for all of it).
      const source = (whole: boolean): { sql: string; args: (string | number)[] } => {
        const parts: string[] = [];
        const all: (string | number)[] = [];
        const part = (table: "usage_rollup" | "telemetry_calls", from?: number, to?: number) => {
          const ts = table === "usage_rollup" ? "bucket" : "ts";
          const w = [...(table === "usage_rollup" ? [] : [counted()]), ...where, ...(from !== undefined ? [`${ts} >= ?`] : []), ...(to !== undefined ? [`${ts} < ?`] : [])];
          parts.push(`SELECT ${ts} AS ts, session_id, model, ${table === "usage_rollup" ? COLS.join(", ") : ledger().map((e, i) => `${e} AS ${COLS[i]}`).join(", ")} FROM ${table}${w.length ? ` WHERE ${w.join(" AND ")}` : ""}`);
          all.push(...args, ...(from !== undefined ? [from] : []), ...(to !== undefined ? [to] : []));
        };
        const lo = since === undefined ? undefined : Math.ceil(since / BUCKET) * BUCKET, hi = until === undefined ? undefined : Math.floor(until / BUCKET) * BUCKET;
        // (A rollup not made yet, in the moment before the start's own step: the ledger answers.)
        if (!whole || !has(store.db, "trigger", `${TRIGGER}_add`) || (lo !== undefined && hi !== undefined && lo > hi)) part("telemetry_calls", since, until);
        else {
          part("usage_rollup", lo, hi);
          if (since !== lo) part("telemetry_calls", since, lo);
          if (until !== hi) part("telemetry_calls", hi, until);
        }
        return { sql: parts.join(" UNION ALL "), args: all };
      };
      let src = source(true);
      let key = "model";
      if (group === "provider") key = "substr(model, 1, max(0, instr(model, ':') - 1))";
      else if (group === "session" || group === "tree") key = "session_id";
      else if (group === "day") {
        // The day number of the local clock: at the zone's offset of that
        // instant (the UTC days that hold requests say where its clock changes),
        // else at the fixed offset given. A quarter hour of the rollup is in one
        // local day when the offset and its changes fall on quarter hours.
        if (offset) {
          const steps = offsetSteps((await reads.sql<{ d: number }>(`SELECT DISTINCT ${dayOf("ts")} AS d FROM (${src.sql}) ORDER BY d`, src.args)).map((r) => r.d), offset);
          if (steps.some((x) => x.off % BUCKET || x.from % BUCKET)) src = source(false);
          key = dayOf(`ts + ${offsetSql([], offset, steps)}`);
        } else {
          if ((tz * 60_000) % BUCKET) src = source(false);
          key = dayOf(`CAST(ts - (${tz * 60_000}) AS INTEGER)`);
        }
      }
      // The sums are read off the loop (src/server/reads.ts): on a ledger whose
      // requests are spread thin the rollup has nearly a row a request. The
      // statement is made for this request and freed after it (a day key carries
      // the request's offset in its text: kept, one would stay for every offset asked for).
      const groups = await reads.sql<Group>(`SELECT ${key} AS key, purpose, MIN(first) AS first, ${SUMS.map((c) => `SUM(${c}) AS ${c}`).join(", ")} FROM (${src.sql}) GROUP BY 1, 2`, src.args);
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
      let list = inOrder(buckets)
        .map(([key, s]) => ({ key, ...finish(s) }))
        .sort((a, b) => (group === "day" ? b.key.localeCompare(a.key) : rank(b) - rank(a)));
      // Agent trees: every session's sums go to the session at the top of its tree.
      let sessions: Record<string, { title: string; parent_id?: string; archived?: true }> | undefined;
      if (group === "tree" || group === "session") {
        const agents = !!store.db.query("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'parent_id'").get();
        const parents = new Map<string, string>();
        if (group === "tree" && agents) for (const r of store.db.query<{ id: string; parent_id: string }, []>("SELECT id, parent_id FROM sessions WHERE parent_id IS NOT NULL").all()) parents.set(r.id, r.parent_id);
        if (group === "tree") {
          const trees = new Map<string, Sum & { own: number; agents: number; agents_cost: number }>();
          const top = (id: string) => { const seen = new Set<string>(); let at = id; for (let p = parents.get(at); p && !seen.has(p); p = parents.get(at)) { seen.add(at); at = p; } return at; };
          for (const b of list) {
            const root = top(b.key);
            const t = trees.get(root) ?? trees.set(root, { ...empty(), own: 0, agents: 0, agents_cost: 0 }).get(root)!;
            for (const f of FIELDS) t[f] += b[f];
            if (b.key === root) t.own += b.priced_cost_usd; else { t.agents++; t.agents_cost += b.priced_cost_usd; }
          }
          list = [...trees.entries()].map(([key, { own, agents: n, agents_cost, ...s }]) => ({ key, ...finish(s), own_cost_usd: own, agents: n, agents_cost_usd: agents_cost })).sort((a, b) => rank(b) - rank(a));
        }
        sessions = {};
        const shown = list.slice(0, limit).map((b) => b.key);
        for (let i = 0; i < shown.length; i += 400) {
          const part = shown.slice(i, i + 400);
          for (const r of store.db.query<{ id: string; title: string; archived: number; parent_id: string | null }, [string]>(
            `SELECT id, title, archived, ${agents ? "parent_id" : "NULL AS parent_id"} FROM sessions WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(part))) {
            sessions[r.id] = { title: r.title, ...(r.parent_id ? { parent_id: r.parent_id } : {}), ...(r.archived ? { archived: true as const } : {}) };
          }
        }
      }
      return Response.json({
        group, sort: group === "day" ? "day" : sort, tz: zone ?? undefined, buckets: list.slice(0, limit), has_more: list.length > limit, total: finish(total),
        by_purpose: inOrder(purposes).map(([purpose, s]) => ({ purpose, ...finish(s) })),
        ...(sessions ? { sessions } : {}),
      });
    },
  },
};
};
