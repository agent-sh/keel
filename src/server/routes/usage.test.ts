// The usage ledger over a generated store, where the e2e cannot reach: the
// answer of every grouping and sort is the one a walk over every request
// gives (the calculation the route did before it summed in SQLite), and what
// SQLite hands to JS does not grow with the number of requests. The route
// sums a rollup that triggers keep as requests are written, taken out or
// changed: the walk reads the ledger itself, so the two agree only while the
// rollup is right.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { allHooks } from "../../engine/hooks.ts";
import { BUCKET, checkRollup, ensureRollup, usageRoutes } from "./usage.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "usage-routes-"));
const store = new Store(dir);
store.migrate(`CREATE TABLE telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL, unpriced INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL, purpose TEXT);
  CREATE INDEX telemetry_calls_ts ON telemetry_calls(ts);
  CREATE INDEX telemetry_calls_session ON telemetry_calls(session_id, ts);
  ALTER TABLE sessions ADD COLUMN parent_id TEXT`);
const hooksBefore = allHooks().length; // the hooks are process-wide: other test files run without this file's
afterAll(() => {
  allHooks().length = hooksBefore;
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Every row a statement gives to JS is counted, and every statement the
// database keeps (`query` keeps one per text; `prepare` makes one for the call).
let handed = 0;
const keptSql = new Set<string>();
let lastSql = "";
const query = store.db.query.bind(store.db);
const counted = (make: (sql: string) => any, keep: boolean) => (sql: string) => {
  const st = make(sql);
  if (keep) keptSql.add(sql);
  lastSql = sql;
  return new Proxy(st, {
    get: (t, k) => (k === "all"
      ? (...a: any[]) => { const rows = t.all(...a); handed += rows.length; return rows; }
      : typeof t[k] === "function" ? t[k].bind(t) : t[k]),
  });
};
(store.db as any).query = counted(query, true);
(store.db as any).prepare = counted(store.db.prepare.bind(store.db), false);
const captured: string[] = [];
const routes = usageRoutes({ store, errors: { capture: (_s: string, e: Error) => void captured.push(e.message) } } as any) as any;
const route = routes["/api/usage"].GET as (req: Request) => Promise<Response>;
// The daemon's own step at its start: the rollup is made off any request.
expect(checkRollup(store.db)).toEqual({ ok: true, rollup_calls: 0, ledger_calls: 0, rebuilt: true });
const ask = async (params: Record<string, string | number>) => {
  const before = handed;
  const r = await route(new Request(`http://x/api/usage?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`));
  const rows = handed - before;
  expect(r.status).toBe(200);
  return { body: (await r.json()) as any, rows };
};

// The calculation as it was: every matching request read and counted in JS.
type Row = { id: number; session_id: string; ts: number; model: string; input: number; output: number; cache_read: number; cache_write: number; cost: number | null; unpriced: number; outcome: string; purpose: string | null };
function walked(p: Record<string, string | number>) {
  const group = String(p.group ?? "model"), sort = String(p.sort ?? "total"), limit = Math.min(5000, Math.max(1, Number(p.limit ?? 500)));
  const tz = Number(p.tz_offset_minutes ?? 0);
  const civil = p.tz ? new Intl.DateTimeFormat("en-CA", { timeZone: String(p.tz), year: "numeric", month: "2-digit", day: "2-digit" }) : undefined;
  const kids = p.children_of ? new Set(query<{ id: string }, [string]>("SELECT id FROM sessions WHERE parent_id = ?").all(String(p.children_of)).map((s) => s.id)) : null;
  const rows = query<Row, []>("SELECT * FROM telemetry_calls ORDER BY id").all().filter((r) =>
    (!p.session_id || r.session_id === p.session_id) && (!kids || kids.has(r.session_id)) && (p.since_ms === undefined || r.ts >= Number(p.since_ms)) && (p.until_ms === undefined || r.ts < Number(p.until_ms)));
  const empty = () => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, calls: 0, priced_cost_usd: 0, unpriced_calls: 0, included_calls: 0, incomplete_calls: 0 });
  const finish = (s: ReturnType<typeof empty>) => {
    const prompt = s.input_tokens + s.cache_read_tokens + s.cache_write_tokens;
    return { ...s, total_tokens: prompt + s.output_tokens, cost_usd: s.unpriced_calls || s.incomplete_calls ? undefined : s.priced_cost_usd, cache_hit_ratio: prompt ? s.cache_read_tokens / prompt : 0 };
  };
  const total = empty();
  const buckets = new Map<string, ReturnType<typeof empty>>();
  const purposes = new Map<string, ReturnType<typeof empty>>();
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
    const u = purposes.get(purpose) ?? empty();
    purposes.set(purpose, u);
    for (const s of [total, b, u]) {
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
  const list = [...buckets.entries()].map(([key, s]) => ({ key, ...finish(s) })).sort((a, b) => (group === "day" ? b.key.localeCompare(a.key) : rank(b) - rank(a)));
  return JSON.parse(JSON.stringify({
    group, sort: group === "day" ? "day" : sort, tz: p.tz ?? undefined, buckets: list.slice(0, limit), has_more: list.length > limit, total: finish(total),
    by_purpose: [...purposes.entries()].map(([purpose, s]) => ({ purpose, ...finish(s) })),
  }));
}
// The purposes came in the order the table was read, which the query plan
// picked; they are compared by name.
const named = (r: any) => ({ ...r, by_purpose: [...r.by_purpose].sort((a: any, b: any) => a.purpose.localeCompare(b.purpose)) });
// The same answer: every count and token sum exactly, a cost to the rounding
// of its additions (SQLite adds a bucket's costs before JS adds the buckets).
function same(got: any, want: any, at = "") {
  if (typeof want === "number" && typeof got === "number" && !Number.isInteger(want)) return expect([at, Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want))]).toEqual([at, true]);
  if (want === null || typeof want !== "object") return expect([at, got]).toEqual([at, want]);
  expect([at, Object.keys(got ?? {})]).toEqual([at, Object.keys(want)]);
  for (const k of Object.keys(want)) same(got[k], want[k], `${at}/${k}`);
}

// A fixed set of buckets: models of three providers (one name without a
// provider), four sessions (two of them agents of the first), five purposes,
// and requests of every kind: priced, on a plan, unpriced, cut before usage
// came, failed with nothing reported (not counted), failed after some usage.
const MODELS = ["alpha:big", "alpha:small", "beta:one", "gamma:x:y", "bare"];
const SESSIONS = ["s-parent", "s-child-1", "s-child-2", "s-other"];
const PURPOSES = [null, "summary", "side", "advisor", "reader"];
const add = store.db.prepare("INSERT INTO telemetry_calls (session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
for (const id of SESSIONS) store.db.run("INSERT INTO sessions (id, title, model, workspace, created, updated, parent_id) VALUES (?, ?, 'alpha:big', ?, 0, 0, ?)", [id, id, dir, id.startsWith("s-child") ? "s-parent" : null]);
let seed = 7;
const rnd = (n: number) => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
// Instants around clock changes: New York (March and November 2026), Berlin
// (March 2026), Lord Howe (half an hour, April 2026), and a quiet month, so a
// change also falls between two days that hold requests.
const WINDOWS = [Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 28), Date.UTC(2026, 3, 4), Date.UTC(2026, 5, 10), Date.UTC(2026, 9, 31)];
function generate(n: number) {
  store.db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const kind = rnd(10);
      const tokens = [rnd(9000), rnd(700), rnd(50_000), rnd(3000)];
      const row = kind < 5 ? { cost: (1 + rnd(99_999)) / 1e6, unpriced: 0, outcome: "ok" } // priced
        : kind === 5 ? { cost: null, unpriced: 0, outcome: "ok" } // on a plan
        : kind === 6 ? { cost: null, unpriced: 1, outcome: "ok" } // no known price
        : kind === 7 ? { cost: null, unpriced: 0, outcome: "aborted" } // cut before its usage came
        : kind === 8 ? { cost: null, unpriced: 0, outcome: "error", none: true } // failed, nothing reported
        : { cost: (1 + rnd(999)) / 1e6, unpriced: 0, outcome: "error" }; // failed after it was billed
      const t = (row as any).none ? [0, 0, 0, 0] : tokens;
      // Spread over three days from each window's start, to the millisecond.
      add.run(SESSIONS[rnd(SESSIONS.length)]!, WINDOWS[rnd(WINDOWS.length)]! + rnd(3 * 86_400_000), MODELS[rnd(MODELS.length)]!, t[0]!, t[1]!, t[2]!, t[3]!, row.cost, row.unpriced, row.outcome, PURPOSES[rnd(PURPOSES.length)]!);
    }
  })();
}

const ZONES = ["America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "Asia/Kathmandu", "Pacific/Chatham"];
const CASES: Record<string, string | number>[] = [
  ...["model", "provider", "session"].flatMap((group) => ["total", "fresh", "cost"].map((sort) => ({ group, sort }))),
  { group: "day" }, { group: "day", tz_offset_minutes: 330 }, { group: "day", tz_offset_minutes: -570 },
  ...ZONES.map((tz) => ({ group: "day", tz })),
  { group: "model", limit: 2 }, { group: "day", tz: "America/New_York", limit: 3 },
  { group: "model", session_id: "s-other" }, { group: "session", children_of: "s-parent", sort: "cost" }, { group: "day", children_of: "s-parent", tz: "Europe/Berlin" },
  { group: "model", since_ms: Date.UTC(2026, 2, 8, 6, 30), until_ms: Date.UTC(2026, 3, 5, 15) }, { group: "day", tz: "America/New_York", since_ms: Date.UTC(2026, 2, 8, 6, 59, 59, 999), until_ms: Date.UTC(2026, 2, 8, 7, 0, 0, 1) },
  { group: "provider", session_id: "nobody" },
  // Windows that are not whole quarter hours (their ends are read from the ledger), one inside a quarter hour,
  // and day offsets a quarter hour does not fit (summed from the ledger).
  { group: "model", since_ms: Date.UTC(2026, 2, 7, 3, 7, 11, 5), until_ms: Date.UTC(2026, 5, 11, 9, 52, 0, 1) }, { group: "session", since_ms: Date.UTC(2026, 2, 28, 4, 1), until_ms: Date.UTC(2026, 2, 28, 4, 9) },
  { group: "day", tz: "Europe/Berlin", since_ms: Date.UTC(2026, 2, 28, 22, 59, 30), until_ms: Date.UTC(2026, 2, 30, 1, 0, 1), session_id: "s-parent" },
  { group: "day", tz_offset_minutes: 7 }, { group: "day", tz_offset_minutes: -121, children_of: "s-parent" },
];

test("every grouping, sort, filter and civil day is what a walk over every request gives", async () => {
  generate(4000);
  // Requests on the very milliseconds around New York's two clock changes.
  for (const t of [Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 10, 1, 6)]) for (const d of [-1, 0, 1]) add.run("s-other", t + d, "alpha:big", 10, 1, 0, 0, 0.001, 0, "ok", null);
  for (const c of CASES) same(named((await ask(c)).body), named(walked(c)), JSON.stringify(c));
  // The totals and the purposes do not depend on how many buckets are returned.
  const all = (await ask({ group: "model" })).body, two = (await ask({ group: "model", limit: 2 })).body;
  expect(two.buckets.length).toBe(2);
  expect(two.has_more).toBe(true);
  expect([two.total, two.by_purpose]).toEqual([all.total, all.by_purpose]);
  // Days across New York's change in March are civil days, not 24 h steps.
  const days = (await ask({ group: "day", tz: "America/New_York", since_ms: Date.UTC(2026, 2, 7), until_ms: Date.UTC(2026, 2, 10) })).body.buckets.map((b: any) => b.key);
  expect(days).toEqual(["2026-03-09", "2026-03-08", "2026-03-07", "2026-03-06"]);
});

test("ten times the requests in the same buckets hand no more rows to JS", async () => {
  const rows = async () => {
    const n: Record<string, number> = {};
    for (const c of CASES) n[JSON.stringify(c)] = (await ask(c)).rows;
    return n;
  };
  const before = await rows();
  const calls = (await ask({ group: "model" })).body.total.calls;
  // Every request nine more times: the same days, models, sessions and purposes.
  const { last } = query<{ last: number }, []>("SELECT MAX(id) AS last FROM telemetry_calls").get()!;
  for (let i = 0; i < 9; i++) store.db.run("INSERT INTO telemetry_calls (session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, purpose) SELECT session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, purpose FROM telemetry_calls WHERE id <= ?", [last]);
  expect((await ask({ group: "model" })).body.total.calls).toBe(calls * 10);
  expect(await rows()).toEqual(before);
  // At most a row per bucket and purpose (and per day, to place a zone's clock changes).
  console.log("rows handed to JS per query:", JSON.stringify(Object.values(before)));
  for (const n of Object.values(before)) expect(n).toBeLessThanOrEqual(25 * PURPOSES.length + 25);
  for (const c of CASES) same(named((await ask(c)).body), named(walked(c)), JSON.stringify(c));
});

test("a day's offset leaves no statement behind, and a time window of sessions is searched by its index", async () => {
  await ask({ group: "day", tz: "Europe/Berlin" });
  const kept = keptSql.size;
  for (let m = -720; m <= 840; m += 45) await ask({ group: "day", tz_offset_minutes: m });
  for (const tz of ZONES) await ask({ group: "day", tz, limit: 4 });
  expect(keptSql.size).toBe(kept);
  // Sessions since a time: the rollup's quarter hours by its time key, and the part of a quarter hour at the
  // window's start from the ledger by its time index, never a walk of the ledger.
  const since = Date.UTC(2026, 9, 31) + 61_000, whole = Date.UTC(2026, 9, 31) + BUCKET;
  same(named((await ask({ group: "session", since_ms: since })).body), named(walked({ group: "session", since_ms: since })), "sessions since");
  const plan = query<{ detail: string }, number[]>(`EXPLAIN QUERY PLAN ${lastSql}`).all(whole, since, whole).map((r) => r.detail).join("; ");
  expect(plan).toContain("SEARCH usage_rollup USING PRIMARY KEY (bucket>?)");
  expect(plan).toContain("SEARCH telemetry_calls USING INDEX telemetry_calls_ts (ts>? AND ts<?)");
  expect(plan).not.toContain("SCAN telemetry_calls");
  // Every request ever made, by model: nothing of the ledger is read.
  await ask({ group: "model" });
  expect(query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${lastSql}`).all().map((r) => r.detail).join("; ")).not.toContain("telemetry_calls");
});

test("requests taken out, changed or moved leave every sum what a walk gives", async () => {
  const rollup = () => query<{ n: number; calls: number }, []>("SELECT COUNT(*) AS n, SUM(calls) AS calls FROM usage_rollup").get()!;
  const before = rollup();
  store.db.run("DELETE FROM telemetry_calls WHERE id % 7 = 0");
  // Priced requests lose their price, others fail with nothing reported (no longer counted) or get usage (counted now).
  store.db.run("UPDATE telemetry_calls SET cost = NULL, unpriced = 1 WHERE id % 11 = 0");
  store.db.run("UPDATE telemetry_calls SET outcome = 'error', input = 0, output = 0, cache_read = 0, cache_write = 0, cost = NULL WHERE id % 13 = 0");
  store.db.run("UPDATE telemetry_calls SET input = 5, outcome = 'ok' WHERE outcome = 'error' AND input + output + cache_read + cache_write = 0 AND cost IS NULL AND id % 2 = 0");
  // Moved to another quarter hour, model, session and purpose.
  store.db.run("UPDATE telemetry_calls SET ts = ts + 3 * 3600000 + 17, model = 'beta:one', session_id = 's-child-2', purpose = 'advisor' WHERE id % 17 = 0");
  expect(rollup().calls).toBeLessThan(before.calls);
  for (const c of CASES) same(named((await ask(c)).body), named(walked(c)), JSON.stringify(c));
  // A session's requests all gone: no row of it is left behind.
  store.db.run("DELETE FROM telemetry_calls WHERE session_id = 's-other'");
  expect(query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_rollup WHERE session_id = 's-other' OR calls <= 0").get()!.n).toBe(0);
  for (const c of CASES) same(named((await ask(c)).body), named(walked(c)), JSON.stringify(c));
  // Made again from the ledger, the rollup is the one the triggers kept.
  const kept = query<any, []>("SELECT * FROM usage_rollup ORDER BY bucket, session_id, model, purpose").all();
  store.db.run("DROP TRIGGER usage_rollup_v1_add");
  expect(ensureRollup(store.db)).toBe(true);
  const made = query<any, []>("SELECT * FROM usage_rollup ORDER BY bucket, session_id, model, purpose").all();
  expect(made.length).toBe(kept.length);
  for (let i = 0; i < made.length; i++) same(kept[i], made[i], `rollup row ${i}`);
});

// A write that goes past the triggers (a row replaced whole: SQLite runs no
// delete trigger for the row it replaces) leaves the rollup counting a request
// the ledger no longer holds. The check at the daemon's start finds it by the
// two counts and makes the rollup again; the route gives the same check and
// the rebuild by hand. No view builds the rollup in its own request.
test("a rollup that drifted from the ledger is found by its count and made again", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5)); // the start's own step runs
  expect(checkRollup(store.db, false)).toMatchObject({ ok: true });
  const { id } = query<{ id: number }, []>("SELECT id FROM telemetry_calls ORDER BY id LIMIT 1").get()!;
  store.db.run("INSERT OR REPLACE INTO telemetry_calls (id, session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, purpose) VALUES (?, 's-parent', ?, 'alpha:big', 1, 1, 0, 0, 0.5, 0, 'ok', NULL)", [id, Date.UTC(2026, 5, 11)]);
  const drift = checkRollup(store.db, false);
  expect(drift).toEqual({ ok: false, rollup_calls: drift.ledger_calls + 1, ledger_calls: drift.ledger_calls });
  expect(await (routes["/api/usage/rollup"].GET() as Response).json()).toEqual(drift);
  // The start's check repairs it, and the answers are the walk's again.
  const whole = { ok: true, rollup_calls: drift.ledger_calls, ledger_calls: drift.ledger_calls };
  expect(checkRollup(store.db)).toEqual({ ...whole, rebuilt: true });
  for (const c of CASES) same(named((await ask(c)).body), named(walked(c)), JSON.stringify(c));
  // By hand, through the route.
  store.db.run("UPDATE usage_rollup SET calls = calls + 3 WHERE bucket = (SELECT MIN(bucket) FROM usage_rollup)");
  expect(checkRollup(store.db, false).ok).toBe(false);
  expect(await (routes["/api/usage/rollup"].POST() as Response).json()).toEqual({ ...whole, rebuilt: true });

  // A daemon that starts on a ledger with no rollup makes it at its start, off any request; a view asked
  // before that reads the ledger and builds nothing.
  for (const t of ["add", "del", "upd"]) store.db.run(`DROP TRIGGER usage_rollup_v1_${t}`);
  store.db.run("DELETE FROM usage_rollup");
  const errors = { capture: (_s: string, e: Error) => void captured.push(e.message) };
  const fresh = usageRoutes({ store, errors } as any) as any;
  const early = await ((await fresh["/api/usage"].GET(new Request("http://x/api/usage?group=model"))) as Response).json();
  expect(query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_rollup").get()!.n).toBe(0);
  same(named(early), named(walked({ group: "model" })), "a view before the start's step");
  await tick();
  expect(checkRollup(store.db, false)).toEqual(whole);
  expect(captured).toEqual([]);
  // A start that finds the rollup wrong makes it again and says so, once.
  store.db.run("UPDATE usage_rollup SET calls = calls + 1 WHERE bucket = (SELECT MIN(bucket) FROM usage_rollup)");
  usageRoutes({ store, errors } as any);
  await tick();
  expect(checkRollup(store.db, false).ok).toBe(true);
  expect(captured).toEqual([`The usage rollup did not match the ledger and was made again from it (${drift.ledger_calls} requests).`]);
});
