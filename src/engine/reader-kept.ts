// The answers of a session's reader requests, kept a while by the request they answered (src/engine/readers.ts).
//
// A reading job runs for minutes: a few hundred parts, eight at a time. A restart cut one twice in a row, each
// after four minutes of reading, and the drain waited its whole bound for it both times; the turn sent the same
// call again after each start, and every part was read again. A part's request is its question and its text, so
// the same request after a restart has the same answer: it is kept here, by a hash of the session and the
// request, and a job asks the store before it asks a reader. A restart then loses only the parts on their way,
// and the drain does not wait for a reading job (src/engine/drain-wait.ts).
//
// The rows wait a moment and go in one write (`FLUSH_MS`), so a job of many parts is not a commit a part; what
// waits when the daemon stops is lost, and those parts are read again. A row is kept `KEEP_MS`: long enough for
// the next daemon's turn to send the call again, not a cache of what a file said yesterday.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export const KEEP_MS = 2 * 3_600_000;
export const FLUSH_MS = 1_000;
const PRUNE_MS = 10 * 60_000;

// What a kept answer says: its text, the reader that wrote it, and the prompt tokens its provider counted.
export type KeptAnswer = { text: string; model: string; input: number };

export const keptKey = (session: string, prompt: string): string => createHash("sha256").update(session).update("\0").update(prompt).digest("hex");

export class ReaderKept {
  private waiting = new Map<string, { session: string; ts: number; a: KeptAnswer }>();
  private timer?: ReturnType<typeof setTimeout>;
  private pruned = 0;
  private ready = false;
  constructor(private db: Database, private now: () => number = Date.now) {}

  private table() {
    if (this.ready) return;
    this.db.exec("CREATE TABLE IF NOT EXISTS reader_kept (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, text TEXT NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS reader_kept_ts ON reader_kept(ts)");
    this.ready = true;
  }

  get(session: string, prompt: string): KeptAnswer | undefined {
    const key = keptKey(session, prompt);
    const w = this.waiting.get(key);
    if (w) return w.a;
    this.table();
    const row = this.db.query<{ text: string; model: string; input: number; ts: number }, [string]>("SELECT text, model, input, ts FROM reader_kept WHERE key = ?").get(key);
    return row && this.now() - row.ts < KEEP_MS ? { text: row.text, model: row.model, input: row.input } : undefined;
  }

  put(session: string, prompt: string, a: KeptAnswer) {
    this.waiting.set(keptKey(session, prompt), { session, ts: this.now(), a });
    if (this.timer) return;
    // A store closed meanwhile (a stop, a test's end) loses the rows: they are a saving, never a record.
    this.timer = setTimeout(() => { try { this.flush(); } catch {} }, FLUSH_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.waiting.size) return;
    const rows = [...this.waiting.entries()];
    this.waiting.clear();
    this.table();
    const now = this.now();
    const put = this.db.query("INSERT OR REPLACE INTO reader_kept (key, session_id, ts, model, input, text) VALUES (?, ?, ?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const [key, w] of rows) put.run(key, w.session, w.ts, w.a.model, w.a.input, w.a.text);
      if (now - this.pruned >= PRUNE_MS) { this.pruned = now; this.db.query("DELETE FROM reader_kept WHERE ts < ?").run(now - KEEP_MS); }
    })();
  }
}
