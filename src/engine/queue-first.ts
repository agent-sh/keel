// Where "Next" puts a queued prompt: first among the ordinary queued prompts,
// so it is the next turn's without stopping the one that runs. Pure: the
// engine stores the place in one write (Engine.queueFirst).
//
// Steers stay ahead of it (the queue is stored steers first: the running turn
// takes them, or they start the next turn before any queued prompt). A row
// that carries a decision another session waits on (an agent's question about
// a write outside its scope, `write_asks`) keeps its place too: Next never
// moves a prompt past one, so the prompt goes right behind the last such row
// ahead of it.
import type { QueueItem } from "../core/types.ts";

type Row = Pick<QueueItem, "id" | "pos" | "steer" | "meta">;

// The kinds of queued input that carry a decision someone waits on.
const DECISIONS = new Set(["write_asks"]);

export const decision = (r: Row): boolean => DECISIONS.has(String(r.meta?.kind ?? ""));

// The row's new `pos`, or null when it is already as far up as it may go (or
// is a steer, or a decision, which Next does not move).
// `rows`: the session's queue, in any order.
export function firstPos(rows: readonly Row[], id: string): number | null {
  const line = rows.filter((r) => !r.steer).sort((a, b) => a.pos - b.pos);
  const at = line.findIndex((r) => r.id === id);
  if (at < 0 || decision(line[at]!)) return null;
  let start = 0;
  for (let i = 0; i < at; i++) if (decision(line[i]!)) start = i + 1;
  if (start >= at) return null;
  const after = line[start]!.pos;
  const before = start > 0 ? line[start - 1]!.pos : after - 2;
  return (before + after) / 2;
}
