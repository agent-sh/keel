import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rebuildRollup } from "../server/routes/usage.ts";
import { checkDrivers, DRIVER_BUCKET, driversOf, rebuildDrivers, rewriteFigure } from "./cost-drivers.ts";

function ledger() {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost REAL, unpriced INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL, cache_break TEXT, purpose TEXT, turn_event TEXT)`);
  db.run("CREATE INDEX telemetry_calls_turn ON telemetry_calls(turn_event)");
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT)");
  db.run("INSERT INTO sessions VALUES ('root', 'Coordinator', NULL), ('lane', 'Lane', 'root'), ('review', 'Review', 'lane'), ('solo', 'Solo', NULL)");
  return db;
}
const add = (db: Database, r: { s: string; ts: number; prompt: number; cost: number | null; turn?: string; purpose?: string; brk?: string; outcome?: string; unpriced?: number }) =>
  db.run("INSERT INTO telemetry_calls (session_id, ts, model, input, output, cache_read, cache_write, cost, unpriced, outcome, cache_break, purpose, turn_event) VALUES (?, ?, 'p:m', ?, 10, ?, ?, ?, ?, ?, ?, ?, ?)",
    [r.s, r.ts, Math.round(r.prompt * 0.1), Math.round(r.prompt * 0.8), r.prompt - Math.round(r.prompt * 0.1) - Math.round(r.prompt * 0.8), r.cost, r.unpriced ?? 0, r.outcome ?? "ok", r.brk ?? null, r.purpose ?? null, r.turn ?? null]);

// Spread over a few hours, ends off the quarter hours: rollup and ledger edges both answer.
function fill(db: Database) {
  let t = 10 * DRIVER_BUCKET + 7_000;
  const sessions = ["root", "lane", "review", "solo"];
  for (let i = 0; i < 400; i++) {
    t += 37_000 + (i % 7) * 11_000;
    const s = sessions[i % 4]!;
    add(db, { s, ts: t, prompt: 20_000 + ((i * 7919) % 600_000), cost: i % 50 === 0 ? null : 0.01 * (1 + (i % 9)), unpriced: i % 50 === 0 ? 1 : 0, turn: `${s}-t${Math.floor(i / 12)}`,
      purpose: i % 23 === 0 ? "summary" : undefined, brk: i % 13 === 0 ? "expired" : i % 17 === 0 ? "model_switch" : undefined });
    // A failed attempt that reported nothing is not counted, here or in usage.
    if (i % 31 === 0) add(db, { s, ts: t + 1, prompt: 0, cost: null, outcome: "error", turn: `${s}-t${Math.floor(i / 12)}` });
  }
  return t;
}

// What the card says, made straight from the ledger.
function direct(db: Database, since: number, until: number) {
  const w = "ts >= ? AND ts < ? AND NOT (outcome = 'error' AND input + output + cache_read + cache_write = 0 AND cost IS NULL)";
  return db.query<any, number[]>(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost), 0) AS cost,
      SUM(COALESCE(purpose, 'turn') = 'turn' AND input + cache_read + cache_write >= 300000) AS big_steps,
      COALESCE(SUM(CASE WHEN COALESCE(purpose, 'turn') = 'turn' AND input + cache_read + cache_write >= 300000 THEN cost END), 0) AS big_cost,
      COALESCE(SUM(CASE WHEN cache_break = 'expired' THEN cost END), 0) AS expired_cost,
      COALESCE(SUM(CASE WHEN session_id IN ('lane', 'review') THEN cost END), 0) AS agents_cost,
      COUNT(DISTINCT CASE WHEN COALESCE(purpose, 'turn') = 'turn' THEN turn_event END) AS turns,
      SUM(COALESCE(purpose, 'turn') = 'turn') AS steps FROM telemetry_calls WHERE ${w}`).get(since, until);
}
const round = (v: number) => Math.round(v * 1e9) / 1e9;

test("the drivers read from the rollup match the ledger, over whole and cut quarter hours", () => {
  const db = ledger();
  rebuildDrivers(db); // made on an empty ledger, then kept by the triggers
  rebuildRollup(db); // what each session spent comes from usage's own rollup
  const end = fill(db);
  expect(checkDrivers(db, false)).toMatchObject({ ok: true });
  for (const [since, until] of [[0, end + 1], [12 * DRIVER_BUCKET + 123, 30 * DRIVER_BUCKET - 77], [15 * DRIVER_BUCKET, 16 * DRIVER_BUCKET]] as [number, number][]) {
    const d = driversOf(db, { since, until });
    const x = direct(db, since, until);
    expect(d.total.calls).toBe(x.calls);
    expect(round(d.total.cost)).toBe(round(x.cost));
    const big = d.bands.filter((b) => b.from >= 300_000);
    expect(big.reduce((n, b) => n + b.calls, 0)).toBe(x.big_steps);
    expect(round(big.reduce((n, b) => n + b.cost, 0))).toBe(round(x.big_cost));
    expect(round(d.breaks.find((b) => b.cause === "expired")?.cost ?? 0)).toBe(round(x.expired_cost));
    expect(round(d.agents.cost)).toBe(round(x.agents_cost));
    expect(d.turns.steps).toBe(x.steps);
    // A turn cut by the window's edge is counted where its first step is.
    if (since === 0) expect(d.turns.turns).toBe(x.turns);
  }
  const all = driversOf(db, {});
  expect(all.trees[0]!.root).toBe("root");
  expect(all.trees[0]!.agents).toBe(2);
  expect(round(all.trees[0]!.own + all.trees[0]!.agents_cost)).toBe(round(all.trees[0]!.cost));
});

test("a turn whose first step is taken out is counted with its next one", () => {
  const db = ledger();
  fill(db);
  rebuildDrivers(db); // made from a ledger that has rows
  expect(checkDrivers(db, false)).toMatchObject({ ok: true });
  // Retention takes the oldest rows, mid-turn.
  db.run("DELETE FROM telemetry_calls WHERE id IN (SELECT id FROM telemetry_calls ORDER BY ts LIMIT 61)");
  const c = checkDrivers(db, false);
  expect(c.ok).toBe(true);
  expect(c.rollup_turns).toBe(c.ledger_turns);
  db.run("UPDATE telemetry_calls SET cost = cost * 2 WHERE id % 5 = 0");
  const x = direct(db, 0, Number.MAX_SAFE_INTEGER);
  expect(round(driversOf(db, {}).total.cost)).toBe(round(x.cost));
});

test("a rewrite's dollars from the rates are said as an estimate; with no price, the whole cost is marked", () => {
  const usd = (v: number) => `$${v.toFixed(2)}`;
  expect(rewriteFigure({ rewrite_usd: 1.234, cost: 3 }, usd).figure).toBe("about $1.23");
  expect(rewriteFigure({ rewrite_usd: 1.234, cost: 3 }, usd).note).toContain("estimated");
  expect(rewriteFigure({ rewrite_usd: null, cost: 3 }, usd).figure).toBe("$3.00*");
});
