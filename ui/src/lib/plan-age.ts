// Whether a session's plan (its last TodoWrite, update_plan or write_todos)
// is still a fact. The model writes it again as the work moves; a plan left
// alone while the session went on is a record of what was meant, not of what
// is so, and it used to stay on the dock for days.
//
// Sessions rewrite their plan within a few turns, and nearly always within
// ten and within a few hours, so a plan left past these is folded to a line.
// Turns count at any time; the hours count only while the session is not at
// work (one long turn is not idle time).
import { useEffect, useState } from "react";
import { every } from "./clock.ts";

export const STALE_TURNS = 12;
export const STALE_MS = 6 * 3_600_000;

export type PlanFacts = {
  at: number; // when the plan was last written (the owner's edit of its list counts)
  turns: number; // turns of the session that ended since
  now: number;
  working: boolean;
  items: { status: string }[];
  // The owner marked the work finished, or archived the session, after the plan.
  endedAt?: number | null;
};

// live: the plan as it stands. stale: left alone while the session went on.
// settled: every step is done or cancelled. ended: the work was finished after it.
export type PlanState = "live" | "stale" | "settled" | "ended";

export function planState(f: PlanFacts): PlanState {
  if (f.endedAt && f.endedAt >= f.at) return "ended";
  if (f.items.length && f.items.every((i) => i.status === "completed" || i.status === "cancelled")) return "settled";
  if (f.turns >= STALE_TURNS || (!f.working && f.now - f.at >= STALE_MS)) return "stale";
  return "live";
}

const span = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

// The one quiet line a folded plan is.
export function planLine(state: Exclude<PlanState, "live">, f: Pick<PlanFacts, "at" | "now" | "items">): string {
  const age = span(f.now - f.at);
  if (state === "settled") return `Plan from ${age} ago, all ${f.items.length} done`;
  if (state === "ended") return `Plan from ${age} ago, work marked finished`;
  return `Plan from ${age} ago, not updated since`;
}

// The turns of a session that ended after `at`, from the events a page holds.
export const turnsSince = (events: readonly { kind: string; ts: number }[], at: number): number => {
  let n = 0;
  for (let i = events.length - 1; i >= 0 && events[i]!.ts > at; i--) if (events[i]!.kind === "turn_end") n++;
  return n;
};

// The time, read again each minute while the page is visible: a plan goes stale on a page left open.
export function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => every(60_000, () => setNow(Date.now())), []);
  return now;
}
