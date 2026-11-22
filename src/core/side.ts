// Side writes: rows that say what happened beside the conversation (spans,
// the telemetry ledgers and what is summed from them, the activity list, the
// facts idle compaction keeps of a context). Each was a commit of its own, and
// a commit writes every page it touched to the log whole: a row of a hundred
// bytes in a table with four indexes cost five pages, 20 KB, several times a
// step.
//
// A side write is not made when it is asked for. It waits, in order, and the
// ones that wait are made together, as one commit, SIDE_MS after the first
// of them was asked for (sooner when a reader needs them, see below). Rows
// that land on the same pages meanwhile cost those pages once: a step's
// spans, its ledger rows and its activity rows are one commit of each page,
// where they were a dozen commits. They are not written with each event's
// commit: an event's commit would then carry the pages of every side table,
// and a turn commits seven or eight events.
//
// What a reader sees is as before. A statement of the daemon's connection
// that names one of the side tables has the waiting writes made first (the
// wrapper below), in the order they were asked for, and a read on the read
// thread asks for the same before it is posted (Reads.run). So nothing reads
// a side table without the rows that were asked for before it. A writer that
// reads its own table at every step would have them written at every step:
// the span and ledger writers keep in memory what they went back for.
//
// What a kill can lose: the side writes asked for in the last SIDE_MS (and
// never more than SIDE_MAX of them): rows of the tables named in
// SIDE_TABLES, nothing else. No event, no session row, no queue row, no
// card and no alert waits here: those are written as they were. A span
// whose start was lost has no row for its end to change; a ledger misses a
// call; the activity list misses a line. A daemon that stops makes what
// waits before it ends.
import type { Database } from "bun:sqlite";

// The tables whose writes may wait. A statement that names one of them makes the waiting writes first.
export const SIDE_TABLES = ["spans", "telemetry_calls", "telemetry_tools", "telemetry_turns", "telemetry_toolsets", "usage_rollup", "activity", "idle_facts", "token_ratios", "search_idx", "search_docs", "search_in"] as const;
const NAMES = new RegExp(`\\b(${SIDE_TABLES.join("|")})\\b`);
// How long a side write waits for the others (KEEL_SIDE_MS sets another: a test of what a kill loses sets it long).
export const SIDE_MS = Number(process.env.KEEL_SIDE_MS) > 0 ? Number(process.env.KEEL_SIDE_MS) : 500;
// And how many wait at most: past it they are made at once.
export const SIDE_MAX = 512;

const TRACE = process.env.KEEL_TRACE_SIDE;

type Waiting = { what: string; write: () => void };

export class Side {
  private waiting: Waiting[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private making = false;
  // Counted for the tests: writes asked for, the commits they were made in, and the ones that failed.
  readonly counts = { asked: 0, commits: 0, failed: 0 };

  // `failed`: told of a side write that could not be made (it is dropped: a gap in a ledger, never a failure of what asked).
  constructor(private db: Database, private failed: (e: unknown, what: string) => void = () => {}, private ms = SIDE_MS) {
    aware(db, this);
  }

  // `write` is made later, in the order asked for (see above). Inside a flush (a side write that asks for another) it is made at once.
  later(what: string, write: () => void) {
    this.counts.asked++;
    if (this.making) return this.make({ what, write });
    this.waiting.push({ what, write });
    if (this.waiting.length >= SIDE_MAX) return this.flush();
    this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, this.ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  get pending(): number { return this.waiting.length; }

  private make(w: Waiting) {
    try { w.write(); } catch (e) { this.counts.failed++; try { this.failed(e, w.what); } catch {} }
  }

  // Inside a transaction: what waits is made in it, in order, and commits with it.
  private join() {
    if (this.making || !this.waiting.length) return;
    const all = this.waiting;
    this.waiting = [];
    clearTimeout(this.timer);
    this.timer = undefined;
    this.making = true;
    try { for (const w of all) this.make(w); } finally { this.making = false; }
  }

  // What waits is made now, as one commit. A store that takes no write keeps it waiting (within
  // SIDE_MAX) for the next try, a few times; a store that is closed has nothing written again.
  private tries = 0;
  flush() {
    if (this.making || !this.waiting.length) return;
    const n = this.waiting.length;
    const kept = this.waiting;
    try {
      if (this.db.inTransaction) return this.join();
      this.db.transaction(() => this.join())();
      this.counts.commits++;
      this.tries = 0;
    } catch (e) {
      // The transaction did not begin or did not commit (the store takes no write, its lock was not had): nothing of it is stored.
      clearTimeout(this.timer);
      this.timer = undefined;
      const closed = /closed|not open/i.test(String((e as Error)?.message ?? e));
      if (closed || ++this.tries > 5) { this.waiting = []; this.tries = 0; if (!closed) try { this.failed(e, `${n} side writes`); } catch {} return; }
      if (!this.waiting.length) this.waiting = kept.slice(-SIDE_MAX);
      try { this.failed(e, `${n} side writes`); } catch {}
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.ms * 5);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }
}

// A statement of this connection that names a side table has the waiting
// writes made first. Wrapped where the statement is made: `query` keeps one
// statement a text, so once each; a statement that names none is left as it is.
function aware(db: Database, side: Side) {
  const d = db as unknown as Record<string, (...a: any[]) => any>;
  const touches = new Map<string, boolean>();
  const names = (sql: string) => {
    let t = touches.get(sql);
    if (t === undefined) { if (touches.size > 4096) touches.clear(); touches.set(sql, (t = NAMES.test(sql))); }
    return t;
  };
  const wrapped = new WeakSet<object>();
  // KEEL_TRACE_SIDE=1: each statement that had the waiting writes made early is a line of the log, with who ran it.
  const said = (sql: string) => {
    if (!TRACE) return;
    const who = (new Error().stack ?? "").split("\n").slice(3, 7).map((l) => l.trim().replace(/^at /, "").replace(/\(.*[\\/]/, "(")).join(" < ");
    console.log(`[side] ${side.pending} written before: ${sql.slice(0, 90).replace(/\s+/g, " ")} (${who})`);
  };
  for (const m of ["query", "prepare"] as const) {
    const make = d[m]!.bind(db);
    d[m] = (sql: string, ...a: unknown[]) => {
      const st = make(sql, ...a);
      if (!st || typeof st !== "object" || wrapped.has(st) || !names(sql)) return st;
      wrapped.add(st);
      for (const k of ["run", "get", "all", "values", "iterate"] as const) {
        const f = st[k];
        if (typeof f !== "function") continue;
        st[k] = function (...args: unknown[]) { if (side.pending) { said(sql); side.flush(); } return f.apply(st, args); };
      }
      return st;
    };
  }
  for (const m of ["run", "exec"] as const) {
    const call = d[m]!.bind(db);
    d[m] = (sql: string, ...a: unknown[]) => { if (side.pending && names(sql)) { said(sql); side.flush(); } return call(sql, ...a); };
  }
}
