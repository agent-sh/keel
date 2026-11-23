// A summary settled against the stored conversation, off the loop. settle()
// checks each statement a summary quotes against every message of the branch:
// on the loop that read every body of a long session at each compaction (the
// bodies before the last checkpoint are in nobody's memory), with every other
// session held meanwhile. Here the branch's prompts and replies are read from
// the table and handed to the same settle(), on the read thread: the answer
// is the one the loop would give.
//
// It imports nothing of the daemon: the read thread loads it (read-tasks.ts).
import type { Database } from "bun:sqlite";
import { bareBy } from "../core/bare-index.ts";
import type { StoredEvent } from "../core/types.ts";
import { holdsQuote, quotesOf, settle, supportOf, type SettleAsk, type Settled } from "./compact.ts";
import { workOf } from "./trail.ts";
import { fileReader } from "./work-calls.ts";

export function settleStored(db: Database, a: SettleAsk): Settled {
  // The branch that ends at `upto`: walked back over the session's rows without their bodies.
  const rows = db.query<{ id: string; seq: number; parent: string | null; kind: string }, [string, number]>(
    `SELECT id, seq, parent, kind FROM events ${bareBy(db)} WHERE session_id = ? AND seq <= ? ORDER BY seq DESC`).all(a.session, a.upto.seq);
  const on = new Set<number>();
  const branch: { id: string; seq: number; kind: string }[] = [];
  let want: string | null = a.upto.id;
  for (const r of rows) {
    if (r.id !== want) continue;
    if (r.kind === "user" || r.kind === "assistant" || r.kind === "tool_result") on.add(r.seq);
    branch.push(r);
    want = r.parent;
    if (!want) break;
  }
  branch.reverse();
  // The span the summary covers, as checkpointAt reads it: from the event
  // the branch's last checkpoint covers (or the checkpoint) on.
  const at = branch.findLastIndex((r) => r.kind === "compaction");
  let prev: any, from = 0;
  if (at >= 0) {
    const cp = JSON.parse(db.query<{ data: string }, [string, number]>("SELECT data FROM events WHERE session_id = ? AND seq = ?").get(a.session, branch[at]!.seq)!.data);
    const k = cp.covered ? branch.findLastIndex((r, i) => i < at && r.id === cp.covered) : -1;
    from = k >= 0 ? k + 1 : at + 1;
    if (cp.mode === "summary") prev = cp;
  }
  const spanFrom = from < branch.length ? branch[from]!.seq : Infinity;
  const span: StoredEvent[] = [];
  // What settle() reads of a branch: its prompts and replies, in order, and
  // the outputs of its file reads that hold a quote of the summary (only
  // those are kept: a long session read thousands of files).
  const said: StoredEvent[] = [];
  const quotes = quotesOf(a.text);
  const holds = holdsQuote(quotes);
  const reads = fileReader(holds);
  const bodies = db.prepare<{ seq: number; kind: string; data: string }, [string, number]>(
    "SELECT seq, kind, data FROM events WHERE session_id = ? AND seq <= ? AND kind IN ('user', 'assistant', 'tool_result') ORDER BY seq");
  try {
    for (const r of bodies.iterate(a.session, a.upto.seq)) {
      if (!on.has(r.seq)) continue;
      const inSpan = r.seq >= spanFrom;
      // (A tool's output before the span is read only for a quote.)
      if (r.kind === "tool_result" && !inSpan && !quotes.length) continue;
      const e = { kind: r.kind, data: JSON.parse(r.data) } as StoredEvent;
      if (inSpan) span.push(e);
      if (r.kind !== "tool_result") said.push(e);
      if (quotes.length && (r.kind === "assistant" || r.kind === "tool_result")) reads.add(e);
    }
  } finally {
    bodies.finalize();
  }
  const settled = settle(said, a.text, a.stored, reads.texts());
  return { ...settled, work: workOf(span, prev?.trail, settled.summary, supportOf(prev)) };
}
