// How often the owner took back what the judge or Keel's rules decided without them: a refusal they let one
// retry of through, or a call they later allowed on a card in the same shape. Counted per day and per class from
// judge_verdicts (gate.ts), on the read thread.

export type VerdictCount = { day: string; by: string; class: string; place: string; decision: string; n: number; taken_back: number };
export type PrecisionRow = { key: string; reviewed: number; allowed: number; refused: number; taken_back: number; precision: number | null };
export type Precision = { since: number; days: PrecisionRow[]; classes: PrecisionRow[]; total: PrecisionRow };

// The statement the read thread runs: verdicts since a time, grouped.
export const PRECISION_SQL = `SELECT date(created / 1000, 'unixepoch', 'localtime') AS day, by, class, place, decision, COUNT(*) AS n, SUM(overridden IS NOT NULL) AS taken_back
FROM judge_verdicts WHERE created > ? GROUP BY day, by, class, place, decision`;

// A class as the owner reads it: what it was flagged for, where, and who decided.
export function classKey(r: Pick<VerdictCount, "by" | "class" | "place">): string {
  return `${r.by}:${r.class}:${r.place}`;
}

// Precision of the refusals: the share the owner did not take back. Nothing refused: no precision to say.
export function precisionOf(rows: VerdictCount[], since: number): Precision {
  const sum = (key: string, of: VerdictCount[]): PrecisionRow => {
    let reviewed = 0, allowed = 0, refused = 0, taken = 0;
    for (const r of of) {
      reviewed += r.n;
      if (r.decision === "deny") { refused += r.n; taken += r.taken_back; } else allowed += r.n;
    }
    return { key, reviewed, allowed, refused, taken_back: taken, precision: refused ? (refused - taken) / refused : null };
  };
  const group = (f: (r: VerdictCount) => string) => {
    const m = new Map<string, VerdictCount[]>();
    for (const r of rows) { const k = f(r); m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m].map(([k, of]) => sum(k, of));
  };
  return {
    since,
    days: group((r) => r.day).sort((a, b) => b.key.localeCompare(a.key)),
    classes: group(classKey).sort((a, b) => b.refused - a.refused || b.reviewed - a.reviewed || a.key.localeCompare(b.key)),
    total: sum("all", rows),
  };
}
