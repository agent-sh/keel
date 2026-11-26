// What the owner's switch for compaction by price on his own session did (src/engine/owner-compact.ts): the
// session's own numbers before it was turned on and since, from the ledger (telemetry_calls, its own requests
// only: summaries and warm reads included, its agents not) and its compaction checkpoints. Read on the read thread
// (src/server/read-tasks.ts); the windows are worked out here, the sums in `numbersOf`, which is pure.
//
// The window since: from when it was turned on to when it was turned off, else now. The window before: as long,
// at least an hour and at most a day, ending when it was turned on. A session where the switch never moved has
// only the window before: the last day up to now.
import type { Database } from "bun:sqlite";
import { pct } from "./telemetry-report.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type CallFact = { ts: number; purpose: string | null; outcome: string; ttft_ms: number | null; context: number; cost: number | null };
export type Numbers = {
  from: number; to: number; hours: number;
  // Steps of the session's turns, the context each read (median and 90th percentile), the first token of each (median).
  steps: number; context_p50: number | null; context_p90: number | null; first_token_p50_ms: number | null;
  // Dollars of every request of the session (turns, summaries, warm reads), per hour of the window, and per step
  // (a session that works more steps an hour spends more an hour with the switch on or off).
  usd: number; usd_per_hour: number | null; usd_per_step: number | null;
  compactions: number;
};

// The numbers of one window from the session's calls and the times of its compactions in it.
export function numbersOf(calls: readonly CallFact[], compactions: readonly number[], from: number, to: number): Numbers {
  const within = calls.filter((c) => c.ts >= from && c.ts < to);
  const steps = within.filter((c) => (c.purpose ?? "turn") === "turn" && c.outcome === "ok");
  const usd = within.reduce((n, c) => n + (c.cost ?? 0), 0);
  const hours = Math.max(0, to - from) / HOUR;
  return {
    from, to, hours: Math.round(hours * 100) / 100,
    steps: steps.length, context_p50: pct(steps.map((c) => c.context), 0.5), context_p90: pct(steps.map((c) => c.context), 0.9),
    first_token_p50_ms: pct(steps.map((c) => c.ttft_ms), 0.5),
    usd: Math.round(usd * 1e4) / 1e4, usd_per_hour: hours > 0 ? Math.round((usd / hours) * 1e4) / 1e4 : null,
    usd_per_step: steps.length ? Math.round((usd / steps.length) * 1e4) / 1e4 : null,
    compactions: compactions.filter((t) => t >= from && t < to).length,
  };
}

// The two windows for a switch turned on at `on` (and off at `off`), at `now`.
export function windowsOf(on: number | undefined, off: number | undefined, now: number): { before: [number, number]; since?: [number, number] } {
  if (on === undefined) return { before: [now - DAY, now] };
  const end = off !== undefined && off > on ? off : now;
  const span = Math.min(DAY, Math.max(HOUR, end - on));
  return { before: [on - span, on], since: [on, end] };
}

export type OwnerCompactAsk = { session: string; on?: number; off?: number; now: number };
export type OwnerCompactNumbers = { before: Numbers; since?: Numbers };

export function ownerCompactRead(db: Database, a: OwnerCompactAsk): OwnerCompactNumbers {
  const w = windowsOf(a.on, a.off, a.now);
  const from = w.before[0], to = w.since?.[1] ?? w.before[1];
  // (The ledger's session index; purpose came with a later migration and may be missing in an old store.)
  const purpose = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('telemetry_calls')").all().some((c) => c.name === "purpose") ? "purpose" : "NULL";
  const calls = db.query<CallFact, [string, number, number]>(
    `SELECT ts, ${purpose} AS purpose, outcome, ttft_ms, input + cache_read + cache_write AS context, cost FROM telemetry_calls WHERE session_id = ? AND ts >= ? AND ts < ?`,
  ).all(a.session, from, to);
  const compactions = db.query<{ ts: number }, [string, number, number]>("SELECT ts FROM events WHERE session_id = ? AND kind = 'compaction' AND ts >= ? AND ts < ?")
    .all(a.session, from, to).map((r) => r.ts);
  return { before: numbersOf(calls, compactions, ...w.before), ...(w.since ? { since: numbersOf(calls, compactions, ...w.since) } : {}) };
}
