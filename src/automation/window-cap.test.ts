// The daemon's spend cap over a rolling window: the running sum over the ledger (rows after the last one
// in, rows that rolled out off), and the hold it makes before a model step of a turn the owner did not start.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-window-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const core = await import("./core.ts");
const win = await import("./window-cap.ts");
const rules = await import("./window-rules.ts");
const { patchSettings } = await import("../admin/settings.ts");

const store = new Store(join(dir, "state"));
const bus = new Bus();
let listed: { id: string; price?: object }[] = [];
core.setDeps({ store, bus, errors: { capture() {} }, engine: {}, providers: { current: () => listed } } as any);
store.migrate(`CREATE TABLE IF NOT EXISTS telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost REAL, unpriced INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL, purpose TEXT);
CREATE INDEX IF NOT EXISTS telemetry_calls_ts ON telemetry_calls(ts);`);

const HOUR = 3_600_000;
win.listen(); // the automation's start does this: a change of the setting is read at once
const set = (usd: number | null, hours: number | null) => expect(patchSettings({ spend_window: { usd, hours } }).ok).toBe(true);
const row = (cost: number | null, ago: number, purpose = "turn", extra = "") =>
  store.db.query(`INSERT INTO telemetry_calls (session_id, ts, model, ${extra ? "input, output, unpriced," : ""} cost, outcome, purpose) VALUES ('s', ?, 'm', ${extra ? "1000000, 1000000, 1," : ""} ?, 'ok', ?)`).run(Date.now() - ago, cost, purpose);
const sess = (parent = false) => ({ id: "s", parent_id: parent ? "p" : null }) as any;

test("the rules: a cap needs both numbers; the view's level; when the window rolls under", () => {
  expect(rules.windowCapOf({ usd: 5, hours: null })).toBeUndefined();
  expect(rules.windowCapOf({ usd: 5, hours: 2 })).toEqual({ usd: 5, hours: 2, ms: 2 * HOUR });
  const cap = rules.windowCapOf({ usd: 10, hours: 1 })!;
  expect(["ok", "warn", "spent"]).toEqual([7.9, 8, 10].map((n) => rules.windowView(cap, n).level));
  const now = 10 * HOUR;
  const rows = [{ ts: now - 50 * 60_000, usd: 6 }, { ts: now - 30 * 60_000, usd: 5 }, { ts: now - 10 * 60_000, usd: 1 }, { ts: now - 2 * HOUR, usd: 99 }];
  // 12 in the window, the 99 is out of it: the first row leaving (6) brings it to 6, under 10.
  expect(rules.inWindow(rows, now, cap)).toBe(12);
  expect(rules.rollsUnderAt(rows, now, cap)).toBe(now - 50 * 60_000 + HOUR + 1);
  // A single row over the cap alone rolls out when its own hour is over.
  expect(rules.rollsUnderAt([{ ts: now - 1000, usd: 12 }], now, cap)).toBe(now - 1000 + HOUR + 1);
  expect(rules.rollsUnderAt([{ ts: now - 1000, usd: 3 }], now, cap)).toBe(now);
  // A time of another day names the day.
  const v = rules.windowView(cap, 11);
  expect(rules.windowHeldWhy(v, Date.now() + 30 * HOUR)).toMatch(/rolls under at about \d{4}-\d\d-\d\d \d\d:\d\d/);
  expect(rules.windowHeldWhy(v, Date.now() + 1000)).toMatch(/rolls under at about \d\d:\d\d$/);
});

test("no cap, or half a cap: nothing is read and nothing is held", async () => {
  win.reset();
  set(null, null);
  row(50, 1000);
  expect(win.hold(sess(), () => false)).toBeUndefined();
  set(5, null);
  await win.refresh();
  expect(win.hold(sess(), () => false)).toBeUndefined();
  expect(win.state().level).toBe("off");
});

test("the window sum counts every ledger row, adds the rows after the last and takes off the rows that rolled out", async () => {
  win.reset();
  store.db.query("DELETE FROM telemetry_calls").run();
  listed = [{ id: "m", price: { input: 2, output: 10 } }];
  // Turns, the judge, readers, titles and a request a stop cut: all rows.
  row(1, 60_000, "turn"); row(1, 50_000, "judge"); row(1, 40_000, "reader"); row(1, 30_000, "title"); row(1, 20_000, "turn");
  row(100, 3 * HOUR); // outside a one hour window
  set(100, 1);
  const first = await win.refresh();
  expect(first.spent).toBeCloseTo(5, 6);
  // Before the first exact read nothing is held; after it the loop's read is the sum.
  const cap = rules.windowCapOf({ usd: 100, hours: 1 })!;
  expect(win.windowSpend(cap)!.spent).toBeCloseTo(5, 6);
  // A row after the last one is added; a call with no price is counted at the listed price now ($2 + $10).
  row(2, 1000);
  row(null, 500, "turn", "np");
  expect(win.windowSpend(cap)!.spent).toBeCloseTo(5 + 2 + 12, 6);
  // Time passes: the rows that were 60, 50 s old roll out of a window ending later.
  expect(win.windowSpend(cap, Date.now() + HOUR - 45_000)!.spent).toBeCloseTo(3 + 2 + 12, 6);
  // The pulse's exact figure agrees with the kept one.
  const exact = await win.measure(Date.now() + HOUR - 45_000);
  expect(exact.spent).toBeCloseTo(3 + 2 + 12, 6);
});

test("at the cap an unattended step waits and the owner's own turn goes on with a note; it goes on when the window rolls under", async () => {
  win.reset();
  store.db.query("DELETE FROM telemetry_calls").run();
  listed = [];
  row(4, 30 * 60_000);
  row(4, 5 * 60_000);
  set(10, 1);
  await win.refresh();
  // 8 of 10: room, and told at 80 percent once.
  expect(win.hold(sess(), () => false)).toBeUndefined();
  expect(win.state().level).toBe("warn");
  row(3, 1000);
  const loop = win.hold(sess(), () => false)!;
  expect(loop.wait).toBeDefined();
  expect(loop.why).toContain("the spend cap of $10 for an hour is reached ($11 spent)");
  // An agent's turn is held even when the owner's words started its work; only a top session's own turn goes on.
  expect(win.hold(sess(true), () => true)!.wait).toBeDefined();
  const owner = win.hold(sess(), () => true)!;
  expect(owner.wait).toBeUndefined();
  expect(owner.note).toContain("goes on because the owner started it");
  // A wait ends with its signal.
  const stop = new AbortController();
  let done = false;
  const w = loop.wait!(stop.signal).then(() => { done = true; });
  await Bun.sleep(5);
  expect(done).toBe(false);
  stop.abort();
  await w;
  // Raised: the pulse's read releases what waits, and nothing is held.
  let freed = false;
  const free = win.hold(sess(), () => false)!.wait!(new AbortController().signal).then(() => { freed = true; });
  set(50, 1);
  await Bun.sleep(50);
  await free;
  expect(freed).toBe(true);
  expect(win.hold(sess(), () => false)).toBeUndefined();
  set(null, null);
});
