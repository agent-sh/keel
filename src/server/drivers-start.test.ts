// The cost drivers' rollup made at the first start with it: on the checkpoint thread, never on the
// loop while a thread can take it (drivers-start.ts); the check reads both sides from one snapshot.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDrivers, driversReady } from "../admin/cost-drivers.ts";
import { Checkpointer } from "../core/checkpoint.ts";
import { Store } from "../core/store.ts";
import { storePath } from "../core/store-files.ts";
import { driversAtStart, DRIVERS_WHAT } from "./drivers-start.ts";

const LEDGER = `CREATE TABLE IF NOT EXISTS telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost REAL, unpriced INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL,
  cache_break TEXT, purpose TEXT, turn_event TEXT)`;
const row = (db: Database, i: number) => db.run("INSERT INTO telemetry_calls (session_id, ts, model, input, cache_read, cost, outcome, turn_event) VALUES ('s', ?, 'p:m', 1000, 50000, 0.01, 'ok', ?)", [1_700_000_000_000 + i * 60_000, `t${Math.floor(i / 5)}`]);
const own = (t: Database, k: string | symbol) => { const v = Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; };
const until = async (f: () => boolean, ms = 20_000) => { for (const t0 = Date.now(); !f() && Date.now() - t0 < ms;) await Bun.sleep(5); return f(); };

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "keel-drivers-"));
  const store = new Store(dir);
  store.migrate(LEDGER);
  store.db.transaction(() => { for (let i = 0; i < 2_000; i++) row(store.db, i); })();
  return { dir, store, end: () => { try { store.db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
// The loop's connection, with every statement it makes counted.
function watched(db: Database) {
  const made: string[] = [];
  const at = <F extends (...a: any[]) => any>(name: string, f: F) => ((...a: any[]) => { made.push(`${name}: ${String(a[0]).slice(0, 60)}`); return f.apply(db, a); }) as F;
  return { made, db: new Proxy(db, { get: (t, k) => (k === "exec" || k === "run" ? at(String(k), (t as any)[k]) : k === "transaction" ? at("transaction", t.transaction) : own(t, k)) }) as Database };
}

test("the first start makes the rollup on the checkpoint thread: the loop makes none of it", async () => {
  const l = ledger();
  const failures: unknown[] = [];
  const c = new Checkpointer(l.store, (e) => failures.push(e), undefined, { tickMs: 10, syncMs: 30 });
  try {
    c.start();
    expect(await until(() => c.armed)).toBe(true);
    const asked: string[] = [];
    const thread = { build: (sql: string, what: string) => { asked.push(what); return c.build(sql, what); } };
    const loop = watched(l.store.db);
    // The check of the read thread, here on a connection of its own (read only).
    const reader = new Database(storePath(l.dir), { readonly: true });
    const d = await driversAtStart(loop.db, async () => checkDrivers(reader, false), () => thread);
    reader.close();
    expect([d.where, d.had, d.before.ok, d.after?.ok, d.after?.ledger_calls, d.after?.ledger_turns]).toEqual(["thread", false, false, true, 2_000, 400]);
    expect(asked).toEqual([DRIVERS_WHAT]);
    expect(loop.made).toEqual([]);
    expect([driversReady(l.store.db), failures]).toEqual([true, []]);
    // Kept by its triggers from there: a request written is counted, and a start after it has nothing to do.
    row(l.store.db, 2_000);
    expect(checkDrivers(l.store.db, false)).toMatchObject({ ok: true, ledger_calls: 2_001 });
    expect((await driversAtStart(l.store.db, async () => checkDrivers(l.store.db, false), () => thread)).where).toBe("none");
  } finally { c.stop(); l.end(); }
}, 60_000);

test("a thread busy at first is waited for; with no thread the rollup is made on the loop", async () => {
  const l = ledger();
  try {
    let tries = 0;
    const busy = { build: (sql: string) => (++tries < 3 ? undefined : Promise.resolve((l.store.db.transaction(() => l.store.db.exec(sql))(), true))) };
    const d = await driversAtStart(l.store.db, async () => checkDrivers(l.store.db, false), () => busy, { tryMs: 1 });
    expect([d.where, tries, d.after?.ok]).toEqual(["thread", 3, true]);
    l.store.db.run("DROP TABLE cost_rollup");
    const loop = watched(l.store.db);
    const e = await driversAtStart(loop.db, async () => checkDrivers(l.store.db, false), () => undefined);
    expect([e.where, e.had, e.after?.ok, loop.made.length]).toEqual(["loop", true, true, 2]);
  } finally { l.end(); }
}, 60_000);

test("the check reads the ledger and the rollup from one snapshot: a request written meanwhile is no mismatch", () => {
  const l = ledger();
  try {
    checkDrivers(l.store.db);
    const other = new Database(storePath(l.dir));
    // A writer that adds a request right after each statement the check reads the ledger with.
    let n = 0;
    const racing = new Proxy(l.store.db, {
      get: (t, k) => k !== "query" ? own(t, k) : (sql: string) => {
        const st = t.query(sql);
        if (!/FROM telemetry_calls/.test(sql)) return st;
        return { get: (...a: any[]) => { const r = st.get(...a); row(other, 3_000 + n++); return r; } };
      },
    }) as Database;
    expect(checkDrivers(racing, false)).toMatchObject({ ok: true });
    expect(n).toBeGreaterThan(0);
    other.close();
  } finally { l.end(); }
});
