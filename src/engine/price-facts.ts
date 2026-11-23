// What compaction by price (src/engine/price-compact.ts) reads from the
// ledger: the finished agents of the last two weeks with their kind, model
// and step count, and per model how long a summary request took and how many
// tokens its summary was. Read on the read thread (a group by over every
// request of two weeks: read-tasks.ts, "compact.priceFacts"), at most once an
// hour, in the background: a step never waits for it, and one that comes
// before the first read has only its own history to go on.
//
// The read imports nothing of the daemon: the read thread loads it.
import type { Database } from "bun:sqlite";
import type { AgentLife } from "./price-compact.ts";

export const FACTS_SPAN_MS = 14 * 86_400_000;
// An agent whose last step is this old is taken to have finished (a follow-up may still come: it is counted then).
export const FACTS_QUIET_MS = 3_600_000;
const REFRESH_MS = 3_600_000;

export type SummaryFacts = { out: number; ms: number; n: number };
export type FactsRead = { lives: AgentLife[]; summaries: { model: string; out: number; ms: number; n: number }[] };
export type LedgerFacts = { lives: AgentLife[]; summaries: Map<string, SummaryFacts>; ts: number };

const has = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };

// (since, quiet): agents with a step since `since` and none after `quiet`.
export function priceFactsRead(db: Database, a: { since: number; quiet: number }): FactsRead {
  if (!has(db, "telemetry_calls") || !has(db, "agents")) return { lives: [], summaries: [] };
  const lives = db.query<AgentLife, [number, number]>(`SELECT a.type AS type, a.model AS model, c.steps AS steps
    FROM (SELECT session_id, COUNT(*) AS steps, MAX(ts) AS last FROM telemetry_calls
          WHERE ts >= ?1 AND outcome = 'ok' AND COALESCE(purpose, 'turn') = 'turn' GROUP BY session_id) c
    JOIN agents a ON a.session_id = c.session_id
    WHERE c.last < ?2 AND a.status NOT IN ('running', 'waiting') GROUP BY a.session_id`).all(a.since, a.quiet);
  const rows = db.query<{ model: string; output: number; ms: number }, [number]>(`SELECT model, output, latency_ms AS ms FROM telemetry_calls
    WHERE ts >= ? AND outcome = 'ok' AND purpose = 'summary' AND output > 0 AND latency_ms IS NOT NULL`).all(a.since);
  const by = new Map<string, { out: number[]; ms: number[] }>();
  for (const r of rows) {
    const b = by.get(r.model) ?? by.set(r.model, { out: [], ms: [] }).get(r.model)!;
    b.out.push(r.output);
    b.ms.push(r.ms);
  }
  return { lives, summaries: [...by].map(([model, b]) => ({ model, out: median(b.out), ms: median(b.ms), n: b.out.length })) };
}

// The engine's copy, read again when it is an hour old. `read`: the read on
// the thread (store.priceFactsOff); none (a unit test's store): no facts.
export class PriceFacts {
  private facts?: LedgerFacts;
  private loading = false;
  private tried = 0;
  constructor(private read: () => ((a: { since: number; quiet: number }) => Promise<FactsRead>) | undefined, private failed: (e: unknown) => void) {}

  get(now = Date.now()): LedgerFacts | undefined {
    const read = this.read();
    if (read && !this.loading && now - Math.max(this.facts?.ts ?? 0, this.tried) > REFRESH_MS) {
      this.tried = now;
      this.loading = true;
      read({ since: now - FACTS_SPAN_MS, quiet: now - FACTS_QUIET_MS })
        .then((r) => { this.facts = { lives: r.lives, summaries: new Map(r.summaries.map(({ model, ...s }) => [model, s])), ts: now }; })
        .catch(this.failed)
        .finally(() => { this.loading = false; });
    }
    return this.facts;
  }
}
