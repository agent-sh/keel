// Where "Next" puts a queued prompt: first among the ordinary queued prompts,
// so it is the next turn's without stopping the one that runs. Pure: the
// engine stores the place in one write (Engine.queueFirst).
//
// Steers stay ahead of it (the queue is stored steers first: the running turn
// takes them, or they start the next turn before any queued prompt). A row
// that carries a decision another session waits on (an agent's question about
// a write outside its scope, `write_asks`) keeps its place too: ordinary
// prompts can move within their side of a decision, but not across it.
import type { QueueItem } from "../core/types.ts";

type Row = Pick<QueueItem, "id" | "pos" | "steer" | "meta">;

// The kinds of queued input that carry a decision someone waits on.
const DECISIONS = new Set(["write_asks"]);

export const decision = (r: Row): boolean => DECISIONS.has(String(r.meta?.kind ?? ""));
export const DECISION_AHEAD = "a queued write decision must keep its place";

type Place = Pick<Row, "steer" | "pos">;
const before = (a: Place, b: Place): boolean => a.steer === b.steer ? a.pos < b.pos : a.steer;
export function decisionBlocks(rows: readonly Row[], row: Row, to: Place): boolean {
  if (row.steer === to.steer && row.pos === to.pos) return false;
  return decision(row) || rows.some((r) => r.id !== row.id && decision(r) && before(r, row) !== before(r, to));
}
export const nextBlocked = (rows: readonly Row[], row: Row): boolean => decision(row) || rows.some((r) => decision(r) && before(r, row));

// The row's new `pos`, or null when it cannot or need not go first.
// `rows`: the session's queue, in any order.
export function firstPos(rows: readonly Row[], id: string): number | null {
  const line = rows.filter((r) => !r.steer).sort((a, b) => a.pos - b.pos);
  const at = line.findIndex((r) => r.id === id);
  return at > 0 && !nextBlocked(rows, line[at]!) ? line[0]!.pos - 1 : null;
}
