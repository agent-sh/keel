// Why a range cost what it did, in causes: the turn steps by the size of the
// prompt they sent, the cache rewrites by what broke the cache, the agents
// against the sessions the owner works in, the steps a turn takes, and the
// dearest agent trees. Read from the request ledger (telemetry_calls)
// through a rollup of its own, kept by triggers as requests are written (as
// usage_rollup is, src/server/routes/usage.ts): per quarter hour, model,
// purpose, prompt band and cache break, so a month is a few narrow rows per
// quarter hour, never every request. What each session spent (agents against
// roots, the trees) is read from usage_rollup itself, which keeps it per
// session. The ends of a range that are not whole quarter hours are read
// from the ledger by its time index.
//
// Imports nothing of the daemon: the read thread runs it (src/server/read-tasks.ts).
import type { Database } from "bun:sqlite";

export const DRIVER_BUCKET = 900_000;
// The name of usage_rollup's triggers (src/server/routes/usage.ts keeps that rollup; it takes the name from here).
export const USAGE_ROLLUP_TRIGGER = "usage_rollup_v1";
// The prompt bands, by their lower edge in tokens: the window most models had
// (200K) and the price tier some put there, and the long contexts above it.
export const BANDS = [0, 50_000, 100_000, 200_000, 300_000, 500_000, 1_000_000] as const;
// The triggers' name carries the version of what they write: another shape is made again from the ledger.
export const DRIVERS_TRIGGER = `cost_rollup_v2_${BANDS.length}`;

const bucketOf = (ts: string) => `(${ts} - (((${ts} % ${DRIVER_BUCKET}) + ${DRIVER_BUCKET}) % ${DRIVER_BUCKET}))`;
const bandOf = (r: string) => `CASE ${[...BANDS].reverse().filter((b) => b > 0).map((b) => `WHEN ${r}input + ${r}cache_read + ${r}cache_write >= ${b} THEN ${b}`).join(" ")} ELSE 0 END`;
// The rows usage counts: a failed attempt that reported no usage is not a request.
const counted = (r = "") => `NOT (${r}outcome = 'error' AND ${r}input + ${r}output + ${r}cache_read + ${r}cache_write = 0 AND ${r}cost IS NULL)`;
const isTurn = (r: string) => `COALESCE(${r}purpose, 'turn') = 'turn'`;
// A row that is the first counted turn step of its turn: the turn is counted once, with it.
const firstOf = (r: string) => `(${isTurn(r)} AND ${r}turn_event IS NOT NULL AND NOT EXISTS (SELECT 1 FROM telemetry_calls x WHERE x.turn_event = ${r}turn_event AND x.id < ${r}id AND ${isTurn("x.")} AND ${counted("x.")}))`;
const KEY = ["bucket", "model", "purpose", "band", "cause"];
const keyOf = (r: string) => [bucketOf(`${r}ts`), `${r}model`, `COALESCE(${r}purpose, 'turn')`, bandOf(r), `COALESCE(${r}cache_break, '')`];
const SUMS = ["calls", "turns", "input", "output", "cache_read", "cache_write", "cost", "unpriced", "incomplete"] as const;
const sumsOf = (r: string) => ["1", `${firstOf(r)}`, `${r}input`, `${r}output`, `${r}cache_read`, `${r}cache_write`, `COALESCE(${r}cost, 0)`,
  `(${r}cost IS NULL AND ${r}unpriced != 0)`, `(${r}cost IS NULL AND ${r}unpriced = 0 AND ${r}outcome != 'ok')`];

const has = (db: Database, type: "table" | "trigger", name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);
// The ledger with the columns the rollup reads (the telemetry module adds them to an older one).
const NEEDS = ["purpose", "cache_break", "turn_event"];
const ledgerReady = (db: Database) => has(db, "table", "telemetry_calls")
  && db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM pragma_table_info('telemetry_calls') WHERE name IN (${NEEDS.map((c) => `'${c}'`).join(", ")})`).get()!.n === NEEDS.length;

// The rollup made again from the ledger, and its triggers with it, as the
// statements of one write (the caller holds the transaction: the checkpoint
// thread under its write lock, or rebuildDrivers below). The triggers of an
// earlier shape are named from the schema as it is now.
export function rebuildDriversSql(db: Database): string {
  const add = (r: string) => `INSERT INTO cost_rollup (${KEY.join(", ")}, ${SUMS.join(", ")}) SELECT ${keyOf(r).join(", ")}, ${sumsOf(r).join(", ")} WHERE ${counted(r)}
    ON CONFLICT (${KEY.join(", ")}) DO UPDATE SET ${SUMS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")};`;
  const where = (r: string) => KEY.map((k, i) => `${k} = ${keyOf(r)[i]}`).join(" AND ");
  const old = sumsOf("OLD.");
  const sub = `UPDATE cost_rollup SET ${SUMS.map((c, i) => `${c} = ${c} - ${old[i]}`).join(", ")} WHERE ${where("OLD.")} AND ${counted("OLD.")};
    DELETE FROM cost_rollup WHERE ${where("OLD.")} AND calls <= 0;`;
  // The first step of a turn gone (retention takes the oldest rows first): the turn is counted with its next step.
  const next = `(SELECT MIN(n.id) FROM telemetry_calls n WHERE n.turn_event = OLD.turn_event AND n.id > OLD.id AND ${isTurn("n.")} AND ${counted("n.")})`;
  const pass = `UPDATE cost_rollup SET turns = turns + 1 WHERE ${firstOf("OLD.")} AND ${counted("OLD.")} AND (${KEY.join(", ")}) = (SELECT ${keyOf("n.").join(", ")} FROM telemetry_calls n WHERE n.id = ${next});`;
  const drop = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cost_rollup_%'").all().map((r) => `DROP TRIGGER IF EXISTS ${r.name};`);
  return [
    ...drop,
    "DROP TABLE IF EXISTS cost_rollup;",
    `CREATE TABLE cost_rollup (bucket INTEGER NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL, band INTEGER NOT NULL, cause TEXT NOT NULL,
      calls INTEGER NOT NULL, turns INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
      cost REAL NOT NULL, unpriced INTEGER NOT NULL, incomplete INTEGER NOT NULL, PRIMARY KEY (${KEY.join(", ")})) WITHOUT ROWID;`,
    `INSERT INTO cost_rollup (${KEY.join(", ")}, ${SUMS.join(", ")})
      SELECT ${keyOf("t.").join(", ")}, COUNT(*), ${sumsOf("t.").slice(1).map((e) => `SUM(${e})`).join(", ")}
      FROM telemetry_calls t WHERE ${counted("t.")} GROUP BY ${KEY.map((_, i) => i + 1).join(", ")};`,
    `CREATE TRIGGER ${DRIVERS_TRIGGER}_add AFTER INSERT ON telemetry_calls BEGIN ${add("NEW.")} END;`,
    // (After the row is gone: a turn's first step is found among the rows that are left.)
    `CREATE TRIGGER ${DRIVERS_TRIGGER}_del AFTER DELETE ON telemetry_calls BEGIN ${sub} ${pass} END;`,
    // Rows are written once; an update moves the row's sums. (A turn's first step that changes its turn is not followed.)
    `CREATE TRIGGER ${DRIVERS_TRIGGER}_upd AFTER UPDATE OF session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, purpose, cache_break, turn_event ON telemetry_calls BEGIN ${sub} ${add("NEW.")} END;`,
  ].join("\n");
}
export function rebuildDrivers(db: Database) {
  db.transaction(() => db.exec(rebuildDriversSql(db)))();
}

export type DriversCheck = { ok: boolean; rollup_calls: number; ledger_calls: number; rollup_turns: number; ledger_turns: number; rebuilt?: boolean };
// The rollup against the ledger: requests and turns. Made again when it differs (`repair`).
// Both sides are read by one statement, so from one snapshot: a request
// written between two reads would look like a rollup that differs.
export function checkDrivers(db: Database, repair = true): DriversCheck {
  if (!ledgerReady(db)) return { ok: true, rollup_calls: 0, ledger_calls: 0, rollup_turns: 0, ledger_turns: 0 };
  const count = (): DriversCheck => {
    const rollup = has(db, "table", "cost_rollup");
    const r = db.query<{ ln: number; lt: number; rn: number; rt: number }, []>(`SELECT
      (SELECT COUNT(*) FROM telemetry_calls WHERE ${counted()}) AS ln,
      (SELECT COUNT(DISTINCT CASE WHEN ${isTurn("")} THEN turn_event END) FROM telemetry_calls WHERE ${counted()}) AS lt,
      ${rollup ? "(SELECT COALESCE(SUM(calls), 0) FROM cost_rollup)" : "0"} AS rn,
      ${rollup ? "(SELECT COALESCE(SUM(turns), 0) FROM cost_rollup)" : "0"} AS rt`).get()!;
    return { ok: has(db, "trigger", `${DRIVERS_TRIGGER}_add`) && r.rn === r.ln && r.rt === r.lt, rollup_calls: r.rn, ledger_calls: r.ln, rollup_turns: r.rt, ledger_turns: r.lt };
  };
  const c = count();
  if (c.ok || !repair) return c;
  rebuildDrivers(db);
  return { ...count(), rebuilt: true };
}
export const driversReady = (db: Database) => has(db, "trigger", `${DRIVERS_TRIGGER}_add`);

export type DriversAsk = { since?: number; until?: number };
type Row = { model: string; purpose: string; band: number; cause: string } & { [K in (typeof SUMS)[number]]: number };
export type Sums = { calls: number; cost: number; unpriced: number; incomplete: number };
const zero = (): Sums => ({ calls: 0, cost: 0, unpriced: 0, incomplete: 0 });
const into = (s: Sums, r: Row) => { s.calls += r.calls; s.cost += r.cost; s.unpriced += r.unpriced; s.incomplete += r.incomplete; };

export type DriversRead = {
  since_ms: number | null; until_ms: number | null;
  total: Sums & { tokens: number };
  // Turn steps by prompt band: steps, what they cost, the prompt tokens they sent.
  bands: (Sums & { from: number; to: number | null; prompt: number })[];
  // Every other purpose (summaries, readers, side answers, warm requests), each once.
  beside: (Sums & { purpose: string })[];
  // What each cache break cost, by model: priced on the loop (its tokens at the model's own rates).
  breaks: (Sums & { cause: string; models: { model: string; input: number; output: number; cache_read: number; cache_write: number; cost: number }[] })[];
  // Sessions the owner works in, and the agents under them.
  roots: Sums & { sessions: number };
  agents: Sums & { sessions: number };
  turns: { turns: number; steps: number; cost: number };
  trees: { root: string; title: string | null; cost: number; own: number; agents_cost: number; agents: number; calls: number; unpriced: number }[];
};

export function driversOf(db: Database, a: DriversAsk): DriversRead {
  const empty: DriversRead = { since_ms: a.since ?? null, until_ms: a.until ?? null, total: { ...zero(), tokens: 0 }, bands: [], beside: [], breaks: [], roots: { ...zero(), sessions: 0 }, agents: { ...zero(), sessions: 0 }, turns: { turns: 0, steps: 0, cost: 0 }, trees: [] };
  if (!ledgerReady(db)) return empty;
  const parts: string[] = [];
  const args: number[] = [];
  const cols = `model, purpose, band, cause, ${SUMS.join(", ")}`;
  const rollup = (from?: number, to?: number) => {
    const w = [...(from !== undefined ? ["bucket >= ?"] : []), ...(to !== undefined ? ["bucket < ?"] : [])];
    parts.push(`SELECT ${cols} FROM cost_rollup${w.length ? ` WHERE ${w.join(" AND ")}` : ""}`);
    if (from !== undefined) args.push(from);
    if (to !== undefined) args.push(to);
  };
  const ledger = (from?: number, to?: number) => {
    const w = [counted("t."), ...(from !== undefined ? ["t.ts >= ?"] : []), ...(to !== undefined ? ["t.ts < ?"] : [])];
    const key = keyOf("t.").slice(1);
    parts.push(`SELECT ${key.join(", ")}, ${sumsOf("t.").join(", ")} FROM telemetry_calls t WHERE ${w.join(" AND ")}`);
    if (from !== undefined) args.push(from);
    if (to !== undefined) args.push(to);
  };
  const lo = a.since === undefined ? undefined : Math.ceil(a.since / DRIVER_BUCKET) * DRIVER_BUCKET;
  const hi = a.until === undefined ? undefined : Math.floor(a.until / DRIVER_BUCKET) * DRIVER_BUCKET;
  if (!driversReady(db) || (lo !== undefined && hi !== undefined && lo > hi)) ledger(a.since, a.until);
  else {
    rollup(lo, hi);
    if (a.since !== lo) ledger(a.since, lo);
    if (a.until !== hi) ledger(hi, a.until);
  }
  const rows = db.query<Row, number[]>(`SELECT model, purpose, band, cause, ${SUMS.map((c) => `SUM(${c}) AS ${c}`).join(", ")}
    FROM (${parts.join(" UNION ALL ")}) GROUP BY model, purpose, band, cause`).all(...args);

  const out = empty;
  const band = new Map<number, Sums & { prompt: number }>();
  const beside = new Map<string, Sums>();
  const breaks = new Map<string, Sums & { models: Map<string, DriversRead["breaks"][number]["models"][number]> }>();
  for (const r of rows) {
    into(out.total, r);
    out.total.tokens += r.input + r.output + r.cache_read + r.cache_write;
    if (r.purpose === "turn") {
      const b = band.get(r.band) ?? band.set(r.band, { ...zero(), prompt: 0 }).get(r.band)!;
      into(b, r);
      b.prompt += r.input + r.cache_read + r.cache_write;
      out.turns.steps += r.calls;
      out.turns.turns += r.turns;
      out.turns.cost += r.cost;
    } else into(beside.get(r.purpose) ?? beside.set(r.purpose, zero()).get(r.purpose)!, r);
    if (r.cause) {
      const b = breaks.get(r.cause) ?? breaks.set(r.cause, { ...zero(), models: new Map() }).get(r.cause)!;
      into(b, r);
      const m = b.models.get(r.model) ?? b.models.set(r.model, { model: r.model, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 }).get(r.model)!;
      m.input += r.input; m.output += r.output; m.cache_read += r.cache_read; m.cache_write += r.cache_write; m.cost += r.cost;
    }
  }
  out.bands = BANDS.map((from, i) => ({ from, to: BANDS[i + 1] ?? null, ...(band.get(from) ?? { ...zero(), prompt: 0 }) })).filter((b) => b.calls);
  out.beside = [...beside.entries()].map(([purpose, s]) => ({ purpose, ...s })).sort((x, y) => y.cost - x.cost);
  out.breaks = [...breaks.entries()].map(([cause, { models, ...s }]) => ({ cause, ...s, models: [...models.values()] })).sort((x, y) => y.cost - x.cost);

  // Roots and agents, and the trees, from what each session spent: usage_rollup for the whole
  // quarter hours (its triggers keep it per session), the ledger for the ends.
  const bySession = new Map<string, Sums>();
  const sp: string[] = [];
  const sa: number[] = [];
  const bounds = (col: string, from?: number, to?: number, w: string[] = []) => {
    if (from !== undefined) { w.push(`${col} >= ?`); sa.push(from); }
    if (to !== undefined) { w.push(`${col} < ?`); sa.push(to); }
    return w.length ? ` WHERE ${w.join(" AND ")}` : "";
  };
  const fromLedger = (from?: number, to?: number) => sp.push(`SELECT session_id, 1 AS calls, COALESCE(cost, 0) AS cost, (cost IS NULL AND unpriced != 0) AS unpriced, (cost IS NULL AND unpriced = 0 AND outcome != 'ok') AS incomplete FROM telemetry_calls${bounds("ts", from, to, [counted()])}`);
  if (!has(db, "trigger", `${USAGE_ROLLUP_TRIGGER}_add`) || (lo !== undefined && hi !== undefined && lo > hi)) fromLedger(a.since, a.until);
  else {
    sp.push(`SELECT session_id, calls, priced_cost_usd AS cost, unpriced_calls AS unpriced, incomplete_calls AS incomplete FROM usage_rollup${bounds("bucket", lo, hi)}`);
    if (a.since !== lo) fromLedger(a.since, lo);
    if (a.until !== hi) fromLedger(hi, a.until);
  }
  for (const r of db.query<Sums & { session_id: string }, number[]>(`SELECT session_id, SUM(calls) AS calls, SUM(cost) AS cost, SUM(unpriced) AS unpriced, SUM(incomplete) AS incomplete FROM (${sp.join(" UNION ALL ")}) GROUP BY session_id`).all(...sa)) {
    bySession.set(r.session_id, { calls: r.calls, cost: r.cost, unpriced: r.unpriced, incomplete: r.incomplete });
  }
  const parents = new Map<string, string>();
  if (db.query("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'parent_id'").get()) {
    for (const r of db.query<{ id: string; parent_id: string }, []>("SELECT id, parent_id FROM sessions WHERE parent_id IS NOT NULL").all()) parents.set(r.id, r.parent_id);
  }
  const top = (id: string) => { const seen = new Set<string>(); let at = id; for (let p = parents.get(at); p && !seen.has(p); p = parents.get(at)) { seen.add(at); at = p; } return at; };
  const trees = new Map<string, DriversRead["trees"][number]>();
  for (const [id, s] of bySession) {
    const agent = parents.has(id);
    const side = agent ? out.agents : out.roots;
    side.calls += s.calls; side.cost += s.cost; side.unpriced += s.unpriced; side.incomplete += s.incomplete; side.sessions++;
    const root = top(id);
    const t = trees.get(root) ?? trees.set(root, { root, title: null, cost: 0, own: 0, agents_cost: 0, agents: 0, calls: 0, unpriced: 0 }).get(root)!;
    t.cost += s.cost; t.calls += s.calls; t.unpriced += s.unpriced;
    if (id === root) t.own += s.cost; else { t.agents++; t.agents_cost += s.cost; }
  }
  out.trees = [...trees.values()].sort((x, y) => y.cost - x.cost).slice(0, 5);
  const title = db.query<{ title: string }, [string]>("SELECT title FROM sessions WHERE id = ?");
  for (const t of out.trees) t.title = title.get(t.root)?.title ?? null;
  return out;
}

// What a break's rewrite cost: of each of its requests' cost, the part that
// went on the prompt written again (written to the cache, or sent at full
// price), each kind at the model's own rate and scaled to the cost recorded.
// Null when a model's price is not known.
export type Rates = { input: number; output: number; cache_read?: number; cache_write?: number };
export function rewriteUsd(models: DriversRead["breaks"][number]["models"], rates: (model: string) => Rates | undefined): number | null {
  let usd = 0;
  for (const m of models) {
    const p = rates(m.model);
    if (!p) return null;
    const written = m.cache_write * (p.cache_write ?? p.input) + m.input * p.input;
    const all = written + m.cache_read * (p.cache_read ?? p.input) + m.output * p.output;
    usd += all > 0 ? (written / all) * m.cost : 0;
  }
  return usd;
}

// What a break's row shows for its dollars: an estimate from the rates is said
// as one ("about"); with no price known, the whole cost of its requests, marked.
export function rewriteFigure(b: { rewrite_usd: number | null; cost: number }, usd: (v: number) => string): { figure: string; note: string } {
  return b.rewrite_usd === null
    ? { figure: `${usd(b.cost)}*`, note: " (* the whole cost of those requests: a price is not known)" }
    : { figure: `about ${usd(b.rewrite_usd)}`, note: "; about: the part of their cost that wrote the prompt again, estimated from each model's rates" };
}
