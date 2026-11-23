// What a wait on the owner costs, read when it begins (src/core/wait-rank.ts
// says what the cost is and how the queue is ordered by it). Kept with the
// alert that tells of the wait, so every list and channel reads one key.
//
// - The agents idle behind it: the session that asks, when it is an agent at
//   work on a task, and each session above it that waits on its report (a
//   call of its blocked on it, or no turn of its own running), the session
//   that started the tree included. A session the owner stopped waits on
//   nothing. The walk stops at the first one that goes on with work of its own.
// - Their spend rate: each agent's own dollars since its task began, over the
//   minutes of that task, a minute at least (the ledger's session index, one read each). The
//   session that started the tree has no task of its own to read a rate from.
// - The cache: what the asking session's cache plan holds while its tool step
//   waits (src/engine/cache-plans.ts). A session with no plan has none at stake.
import { PAUSE_MARGIN_MS } from "../engine/cachewarn.ts";
import { waitKey, type WaitCost, type WaitFacts, type WaitNow } from "../core/wait-rank.ts";
import { D } from "./core.ts";
import * as agents from "./agents.ts";

const OWN_SPEND_SQL = "SELECT COALESCE(SUM(cost), 0) AS c FROM telemetry_calls WHERE session_id = ? AND ts >= ?";
const DEPTH = 16;

export function waitCost(sessionId: string, now = Date.now()): WaitCost | undefined {
  const f = factsOf(sessionId, now);
  return f && { ...f, key: waitKey(f, PAUSE_MARGIN_MS) };
}

// What the wait costs as it stands now, for its line (the key stays the one it began with):
// the agents that wait now, and the cache plan's life now (a warm ping lengthens it).
export function waitNow(sessionId: string, now = Date.now()): WaitNow | undefined {
  const f = factsOf(sessionId, now);
  if (!f) return undefined;
  const { at: _, ...rest } = f;
  return rest;
}

function factsOf(sessionId: string, now: number): WaitFacts | undefined {
  const { engine, store } = D();
  if (!store.session(sessionId)) return undefined;
  let n = 0, rate = 0;
  let cur = sessionId;
  for (let i = 0; i < DEPTH; i++) {
    const a = agents.byChild(cur);
    if (!a || agents.isEnded(a) || engine.isHeld(cur)) break;
    // The asking agent waits; one above it waits only while no turn of its own runs, or a call of its waits on this one.
    n++;
    rate += rateOf(a.session_id, a.task_at ?? a.created, now);
    const up = a.parent_id;
    if (engine.isHeld(up) || (engine.isRunning(up) && agents.waitersOn(a.id) === 0)) break;
    // The session that started the tree waits too; it spends nothing of a task of its own.
    if (!agents.byChild(up)) { if (store.session(up)) n++; break; }
    cur = up;
  }
  const cache = engine.cachePlans?.stake(sessionId);
  return { at: now, agents: n, rate: round(rate), ...(cache ? { tokens: cache.tokens, usd: cache.usd, until: cache.until } : {}) };
}

function rateOf(sessionId: string, since: number, now: number): number {
  const ms = now - since;
  if (ms <= 0) return 0;
  try {
    const c = D().store.db.query<{ c: number }, [string, number]>(OWN_SPEND_SQL).get(sessionId, since)?.c ?? 0;
    // A rate a minute from less than a minute of work would be a guess: a task that short spent what it spent in its first minute.
    return (c / Math.max(ms, 60_000)) * 60_000;
  } catch {
    return 0; // a store without the ledger
  }
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
