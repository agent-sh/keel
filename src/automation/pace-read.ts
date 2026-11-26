// A session's day of turns for its pace dialog, read on the read thread (src/server/read-tasks.ts): its turns of
// the last 24 hours by what started them, the owner's own words or an input nobody sent (a wake, a report, a
// loop's run), with their dollars, and how many unattended ones began within the pace of the turn before.
// Content-free: kinds, counts and dollars.
import type { Database } from "bun:sqlite";

export type PaceDayAsk = { session: string; now: number; pace_ms: number };
export type PaceDay = {
  hours: number;
  owner: { turns: number; usd: number };
  unattended: { turns: number; usd: number; close: number; close_usd: number };
  kinds: { kind: string; turns: number; usd: number }[];
};

const DAY = 24 * 3600_000;

export function paceDay(db: Database, a: PaceDayAsk): PaceDay {
  const rows = db.query<{ ts: number; ms: number | null; cost: number | null; kind: string | null; origin: string | null; sys: number | null }, [string, number]>(
    `SELECT t.ts, t.ms, t.cost, u.data ->> '$.kind' AS kind, u.data ->> '$.origin' AS origin, u.data ->> '$.system' AS sys
     FROM telemetry_turns t JOIN events e ON e.id = t.turn_event LEFT JOIN events u ON u.id = e.parent AND u.kind = 'user'
     WHERE t.session_id = ? AND t.ts > ? ORDER BY t.ts`).all(a.session, a.now - DAY);
  const out: PaceDay = { hours: 24, owner: { turns: 0, usd: 0 }, unattended: { turns: 0, usd: 0, close: 0, close_usd: 0 }, kinds: [] };
  const kinds = new Map<string, { turns: number; usd: number }>();
  let lastEnd: number | undefined;
  for (const r of rows) {
    const usd = r.cost ?? 0;
    const owner = !r.kind && r.origin !== "restart" && !r.sys;
    if (owner) { out.owner.turns++; out.owner.usd += usd; }
    else {
      out.unattended.turns++;
      out.unattended.usd += usd;
      if (lastEnd !== undefined && a.pace_ms > 0 && r.ts - lastEnd < a.pace_ms) { out.unattended.close++; out.unattended.close_usd += usd; }
      const k = r.kind ?? (r.origin === "restart" ? "restart" : "harness");
      const b = kinds.get(k) ?? { turns: 0, usd: 0 };
      b.turns++; b.usd += usd;
      kinds.set(k, b);
    }
    lastEnd = r.ts + (r.ms ?? 0);
  }
  out.kinds = [...kinds].map(([kind, b]) => ({ kind, ...b })).sort((x, y) => y.usd - x.usd);
  return out;
}
