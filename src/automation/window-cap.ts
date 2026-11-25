import { readsOf } from "../server/reads.ts";
import { onSettings, registerSettings, settings } from "../admin/settings.ts";
import type { Session } from "../core/types.ts";
import { capture, D } from "./core.ts";
import * as alerts from "./alerts.ts";
import { listedCost, type UnpricedRow } from "./caps.ts";
import { checkWindow, rollsUnderAt, windowCapOf, windowHeldAlert, windowHeldNote, windowHeldWhy, windowOwnerNote, windowView, windowWarnBody, windowWarnTitle, type WindowCap, type WindowView } from "./window-rules.ts";

// The spend cap over a rolling window for the whole daemon (rules in window-rules.ts). Every row of the
// ledger counts, whoever wrote it: turns, the policy judge, readers, titles, summaries and requests a
// stop cut.
//
// The sum is the tree cap's kind (caps.ts treeSpend): the figure, the newest ledger row it includes and
// the start of the window it covers. A read on the loop adds the rows after that row and takes off the
// rows that rolled out of the window since the last read: both are ranges of the ledger's own indexes,
// small whatever the ledger holds. The pulse reads the whole window on the read thread every ten
// seconds and puts its exact figure back (a row deleted, a price that changed), and a first read is
// that one: nothing is held before it, so the loop never reads a window whole.

registerSettings("spend_window", { usd: null, hours: null }, checkWindow);

export const EVERY_MS = 10_000;

const hasLedger = () => !!D().store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_calls'").get();

// --- what the ledger says -------------------------------------------------------

export const WINDOW_SQL = "SELECT COALESCE(SUM(cost), 0) AS spent, COALESCE(SUM(cost IS NULL AND unpriced != 0), 0) AS np, (SELECT COALESCE(MAX(id), 0) FROM telemetry_calls) AS top FROM telemetry_calls WHERE ts >= ?1";
// What came after a row the sum read to. `+id` keeps the planner on the time index for the rolled rows, and the id range for the new ones.
export const DELTA_SQL = "SELECT COALESCE(SUM(cost), 0) AS spent, COALESCE(SUM(cost IS NULL AND unpriced != 0), 0) AS np, (SELECT COALESCE(MAX(id), 0) FROM telemetry_calls) AS top FROM telemetry_calls WHERE id > ?1 AND ts >= ?2";
export const ROLLED_SQL = "SELECT COALESCE(SUM(cost), 0) AS spent, COALESCE(SUM(cost IS NULL AND unpriced != 0), 0) AS np FROM telemetry_calls WHERE +id <= ?1 AND ts >= ?2 AND ts < ?3";
// The tokens of the calls that had no price, by model, to price at the listed price now.
const UNPRICED = "SELECT model, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write FROM telemetry_calls WHERE cost IS NULL AND unpriced != 0";
export const UNPRICED_WINDOW_SQL = `${UNPRICED} AND ts >= ?1 AND id <= ?2 GROUP BY model`;
const UNPRICED_NEW_SQL = `${UNPRICED} AND id > ?1 AND id <= ?2 AND ts >= ?3 GROUP BY model`;
const UNPRICED_ROLLED_SQL = `${UNPRICED} AND +id <= ?1 AND ts >= ?2 AND ts < ?3 GROUP BY model`;
const ROWS_SQL = "SELECT ts, cost AS usd FROM telemetry_calls WHERE ts >= ?1 AND cost IS NOT NULL AND cost > 0 ORDER BY ts";

// --- the running sum ------------------------------------------------------------

type Sum = { ms: number; start: number; last: number; usd: number; none: number };
let sum: Sum | undefined;

// The window's spend now, or undefined before the pulse's first exact read. A read of the loop: the rows
// after the last one, and the rows that rolled out.
export function windowSpend(cap: WindowCap, now = Date.now()): { spent: number; none: number } | undefined {
  if (!sum || sum.ms !== cap.ms || !hasLedger()) return undefined;
  const db = D().store.db;
  const start = now - cap.ms;
  if (start > sum.start) {
    const r = db.query<{ spent: number; np: number }, [number, number, number]>(ROLLED_SQL).get(sum.last, sum.start, start);
    let off = r?.spent ?? 0;
    if (r?.np) off += listedCost(db.query<UnpricedRow, [number, number, number]>(UNPRICED_ROLLED_SQL).all(sum.last, sum.start, start)).usd;
    sum.usd = Math.max(0, sum.usd - off);
    sum.start = start;
  }
  const d = db.query<{ spent: number; np: number; top: number }, [number, number]>(DELTA_SQL).get(sum.last, sum.start);
  if (d && d.top > sum.last) {
    let add = d.spent;
    if (d.np) {
      const np = listedCost(db.query<UnpricedRow, [number, number, number]>(UNPRICED_NEW_SQL).all(sum.last, d.top, sum.start));
      add += np.usd;
      sum.none += np.none;
    }
    sum.usd += add;
    sum.last = d.top;
  }
  return { spent: sum.usd, none: sum.none };
}

// The pulse's exact figure, put back when it is not behind the sum.
function settle(cap: WindowCap, start: number, spent: number, top: number, none: number) {
  if (!sum || sum.ms !== cap.ms || top >= sum.last) sum = { ms: cap.ms, start, last: top, usd: spent, none };
}

// --- the gate -------------------------------------------------------------------

type Seen = { view: WindowView; until?: number; none: number; at: number };
let seen: Seen | undefined;
// Turns that wait, each released when the window is under the cap (or the cap is raised or cleared).
const waiting = new Set<() => void>();
// Said once for a stretch over the cap, and once for a stretch past the 80 percent.
let warned = false;
let holdTold = false;

const capNow = () => windowCapOf(settings().spend_window);

function tell(view: WindowView, until: number | undefined) {
  try {
    if (view.level === "ok") { warned = false; holdTold = false; return; }
    // A cap passed in one step is told as the cap, not as the 80 percent it passed on the way.
    if (!warned) {
      warned = true;
      if (view.level === "warn") alerts.raise("limit", null, windowWarnTitle(view), windowWarnBody(view), { cls: "window", open_settings: "usage" });
    }
    if (view.level === "warn") { holdTold = false; return; }
    if (!holdTold) {
      holdTold = true;
      alerts.raise("limit", null, "Spend window reached", windowHeldAlert(view, until), { cls: "window", ...(until ? { until } : {}), open_settings: "usage" });
    }
  } catch (e) { capture(e, { at: "spend window notice" }); }
}

function release() {
  for (const go of [...waiting]) go();
  waiting.clear();
}

// What a model step of a session waits for, asked before each step (the engine's `stepHold`):
//   nothing, while there is room or no cap;
//   a note, when the turn is the owner's own (a top session's turn their words started or steered): it goes on;
//   a wait, for any other turn (a loop run, a wake, a monitor, an agent): why, until when it is known, and
//   a wait that settles when the window is under the cap again, or the signal aborts.
export function hold(s: Session, byOwner: () => boolean): { why: string; until?: number; note?: string; wait?: (signal: AbortSignal) => Promise<void> } | undefined {
  const cap = capNow();
  if (!cap) return undefined;
  const got = windowSpend(cap);
  if (!got) return undefined;
  const view = windowView(cap, got.spent);
  seen = { view, until: view.level === "spent" ? seen?.until : undefined, none: got.none, at: Date.now() };
  tell(view, seen.until);
  if (view.level !== "spent") return undefined;
  if (!s.parent_id && byOwner()) return { why: windowHeldWhy(view), note: windowOwnerNote(view) };
  return { why: windowHeldWhy(view, seen.until), until: seen.until, note: windowHeldNote(view, seen.until), wait: (signal) => new Promise<void>((go) => {
    if (signal.aborted) return go();
    const end = () => { waiting.delete(end); signal.removeEventListener("abort", end); go(); };
    waiting.add(end);
    signal.addEventListener("abort", end, { once: true });
  }) };
}

// --- the pulse and the page -----------------------------------------------------

let busy = false;
let lastAt = 0;
let printed = "";

export type WindowState = { cap: { usd: number; hours: number } | null; spent: number; level: "off" | "ok" | "warn" | "spent"; pct: number; rolls_at: number | null; unpriced: number; at: number };

export const state = (): WindowState => {
  const cap = capNow();
  if (!cap || !seen || seen.view.usd !== cap.usd || seen.view.hours !== cap.hours) return { cap: cap ? { usd: cap.usd, hours: cap.hours } : null, spent: 0, level: cap ? "ok" : "off", pct: 0, rolls_at: null, unpriced: 0, at: Date.now() };
  return { cap: { usd: cap.usd, hours: cap.hours }, spent: seen.view.spent, level: seen.view.level, pct: seen.view.pct, rolls_at: seen.view.level === "spent" ? seen.until ?? null : null, unpriced: seen.none, at: seen.at };
};

// One exact read on the read thread: the window's spend, and when it rolls under the cap if it is over.
export async function measure(now = Date.now()): Promise<WindowState> {
  const cap = capNow();
  if (!cap) { seen = undefined; sum = undefined; warned = holdTold = false; release(); return state(); }
  if (!hasLedger()) return state();
  const reads = readsOf(D().store);
  const start = now - cap.ms;
  const [r] = await reads.sql<{ spent: number; np: number; top: number }>(WINDOW_SQL, [start]);
  const np = r?.np ? listedCost(await reads.sql<UnpricedRow>(UNPRICED_WINDOW_SQL, [start, r.top])) : { usd: 0, none: 0 };
  const spent = (r?.spent ?? 0) + np.usd;
  if (r) settle(cap, start, spent, r.top, np.none);
  // The unpriced calls' dollars are not in the rows; the estimate of the roll-under counts the priced ones.
  const over = spent >= cap.usd;
  const until = over ? rollsUnderAt(await reads.sql<{ ts: number; usd: number }>(ROWS_SQL, [start]), now, { ...cap, usd: Math.max(0, cap.usd - np.usd) }) : undefined;
  const view = windowView(cap, spent);
  seen = { view, until, none: np.none, at: now };
  tell(view, until);
  if (view.level !== "spent") release();
  return state();
}

export async function refresh(now = Date.now()): Promise<WindowState> {
  const st = await measure(now);
  const print = JSON.stringify([st.cap, Math.round(st.spent * 1e4), st.level, st.rolls_at]);
  if (print !== printed) {
    printed = print;
    D().bus.emit({ t: "feature", name: "spend_window", data: st });
  }
  return st;
}

// Called by the automation's pulse: a read every ten seconds while a cap is set.
export function pulse(now = Date.now()) {
  if (busy || now - lastAt < EVERY_MS) return;
  lastAt = now;
  if (!capNow() && !seen && !waiting.size) return;
  busy = true;
  refresh(now).catch((e) => capture(e, { at: "spend window" })).finally(() => { busy = false; });
}

// A cap set, changed or cleared now: the figure and what waits follow at once.
let tied = false;
export function listen() {
  if (tied) return;
  tied = true;
  let was = JSON.stringify(settings().spend_window);
  onSettings((all) => {
    const now = JSON.stringify(all.spend_window);
    if (now === was) return;
    was = now;
    lastAt = 0;
    sum = undefined;
    warned = holdTold = false;
    refresh().catch((e) => capture(e, { at: "spend window" }));
  });
}

export const reset = () => { sum = undefined; seen = undefined; waiting.clear(); warned = holdTold = false; busy = false; lastAt = 0; printed = ""; };
