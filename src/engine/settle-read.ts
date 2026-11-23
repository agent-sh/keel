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
import { holdsQuote, quotesOf, settle, type SettleAsk, type Settled } from "./compact.ts";
import { fileReader } from "./work-calls.ts";

export function settleStored(db: Database, a: SettleAsk): Settled {
  // The branch that ends at `upto`: walked back over the session's rows without their bodies.
  const rows = db.query<{ id: string; seq: number; parent: string | null; kind: string }, [string, number]>(
    `SELECT id, seq, parent, kind FROM events ${bareBy(db)} WHERE session_id = ? AND seq <= ? ORDER BY seq DESC`).all(a.session, a.upto.seq);
  const on = new Set<number>();
  let want: string | null = a.upto.id;
  for (const r of rows) {
    if (r.id !== want) continue;
    if (r.kind === "user" || r.kind === "assistant" || r.kind === "tool_result") on.add(r.seq);
    want = r.parent;
    if (!want) break;
  }
  // What settle() reads of a branch: its prompts and replies, in order, and
  // the outputs of its file reads that hold a quote of the summary (only
  // those are kept: a long session read thousands of files).
  const said: StoredEvent[] = [];
  const quotes = quotesOf(a.text);
  const holds = holdsQuote(quotes);
  const reads = fileReader(holds);
  const bodies = db.prepare<{ seq: number; kind: string; data: string }, [string, number]>(
    `SELECT seq, kind, data FROM events WHERE session_id = ? AND seq <= ? AND kind IN ('user', 'assistant'${quotes.length ? ", 'tool_result'" : ""}) ORDER BY seq`);
  try {
    for (const r of bodies.iterate(a.session, a.upto.seq)) {
      if (!on.has(r.seq)) continue;
      const e = { kind: r.kind, data: JSON.parse(r.data) } as StoredEvent;
      if (r.kind !== "tool_result") said.push(e);
      if (!quotes.length) continue;
      if (r.kind === "assistant" || r.kind === "tool_result") reads.add(e);
    }
  } finally {
    bodies.finalize();
  }
  return settle(said, a.text, a.stored, reads.texts());
}
