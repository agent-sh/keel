// The answers of a session's reader requests, kept a while by the request they answered (src/engine/readers.ts).
//
// A reading job runs for minutes: a few hundred parts, eight at a time. A restart cut one twice in a row, each
// after four minutes of reading, and the drain waited its whole bound for it both times; the turn sent the same
// call again after each start, and every part was read again. A part's request is its question and its text, so
// the same request to the same reader after a restart has the same answer: it is kept here, by a hash of the
// session, the reader model and the request, and a job asks the store before it asks a reader. A restart then
// loses only the parts on their way, and the drain does not wait for a reading job (src/engine/drain-wait.ts).
//
// How far each call's job got is kept beside the answers (`job`), so the result of a call a restart cut says how
// many of its parts are kept and to send the same call again (`cutWords`, src/core/stops.ts readCut).
//
// An answer is stored as every other stored text is: with the vault's secrets as their placeholders (`seal`,
// conceal and the store's redact). The rows wait a moment and go in one write (`FLUSH_MS`), so a job of many parts
// is not a commit a part; what waits when the daemon stops is lost, and those parts are read again. A row of a
// session that is gone is not written. A row is kept `KEEP_MS`: long enough for the next daemon's turn to send the
// call again, not a cache of what a file said yesterday. Old rows go at the start (`start`) and every `PRUNE_MS`
// after; a session's rows go with the session (Store.deleteSession).
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { READER_KEPT_SCHEMA } from "../core/store.ts";
import { readCut } from "../core/stops.ts";

export const KEEP_MS = 2 * 3_600_000;
export const FLUSH_MS = 1_000;
export const PRUNE_MS = 10 * 60_000;
const HOURS = KEEP_MS / 3_600_000;

// What a kept answer says: its text, the reader that wrote it, and the prompt tokens its provider counted.
export type KeptAnswer = { text: string; model: string; input: number };

export const keptKey = (session: string, model: string, prompt: string): string =>
  createHash("sha256").update(session).update("\0").update(model).update("\0").update(prompt).digest("hex");

type Opts = { now?: () => number; seal?: (session: string, text: string) => string };

export class ReaderKept {
  private waiting = new Map<string, { session: string; ts: number; a: KeptAnswer }>();
  private jobs = new Map<string, { session: string; call: string; ts: number; read: number; total: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private pruner?: ReturnType<typeof setInterval>;
  private ready = false;
  private now: () => number;
  private seal: (session: string, text: string) => string;
  constructor(private db: Database, o: Opts = {}) {
    this.now = o.now ?? Date.now;
    this.seal = o.seal ?? ((_s, t) => t);
  }

  // The tables (a store has them already; a bare database in a test gets them here), the first prune and its timer.
  private table() {
    if (this.ready) return;
    this.db.exec(READER_KEPT_SCHEMA);
    this.ready = true;
    this.prune();
    this.pruner = setInterval(() => { try { this.prune(); } catch { clearInterval(this.pruner); } }, PRUNE_MS);
    (this.pruner as { unref?: () => void }).unref?.();
  }

  prune() {
    const before = this.now() - KEEP_MS;
    this.db.query("DELETE FROM reader_kept WHERE ts < ?").run(before);
    this.db.query("DELETE FROM reader_jobs WHERE ts < ?").run(before);
  }

  // At the daemon's start: rows older than `KEEP_MS` go then, not at the first reading job.
  start() { this.table(); }

  get(session: string, model: string, prompt: string): KeptAnswer | undefined {
    const key = keptKey(session, model, prompt);
    const w = this.waiting.get(key);
    if (w) return w.a;
    this.table();
    const row = this.db.query<{ text: string; model: string; input: number; ts: number }, [string]>("SELECT text, model, input, ts FROM reader_kept WHERE key = ?").get(key);
    return row && this.now() - row.ts < KEEP_MS ? { text: row.text, model: row.model, input: row.input } : undefined;
  }

  put(session: string, model: string, prompt: string, a: KeptAnswer) {
    this.waiting.set(keptKey(session, model, prompt), { session, ts: this.now(), a: { ...a, text: this.seal(session, a.text) } });
    this.later();
  }

  // How far a call's job got: `read` of `total` parts answered.
  job(session: string, call: string, read: number, total: number) {
    this.jobs.set(`${session}\0${call}`, { session, call, ts: this.now(), read, total });
    this.later();
  }

  // What the result of a reading call a restart cut says (src/engine/turn.ts cutResult).
  cutWords(session: string, call: string): string {
    const w = this.jobs.get(`${session}\0${call}`);
    if (w) return readCut(w.read, w.total, HOURS);
    this.table();
    const row = this.db.query<{ read: number; total: number; ts: number }, [string, string]>("SELECT read, total, ts FROM reader_jobs WHERE session_id = ? AND call_id = ?").get(session, call);
    return row && this.now() - row.ts < KEEP_MS ? readCut(row.read, row.total, HOURS) : readCut(undefined, undefined, HOURS);
  }

  private later() {
    if (this.timer) return;
    // A store closed meanwhile (a stop, a test's end) loses the rows: they are a saving, never a record.
    this.timer = setTimeout(() => { try { this.flush(); } catch {} }, FLUSH_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.waiting.size && !this.jobs.size) return;
    const rows = [...this.waiting.entries()];
    const jobs = [...this.jobs.values()];
    this.waiting.clear();
    this.jobs.clear();
    this.table();
    const put = this.db.query("INSERT OR REPLACE INTO reader_kept (key, session_id, ts, model, input, text) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?2)");
    const job = this.db.query("INSERT OR REPLACE INTO reader_jobs (session_id, call_id, ts, read, total) SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?1)");
    this.db.transaction(() => {
      for (const [key, w] of rows) put.run(key, w.session, w.ts, w.a.model, w.a.input, w.a.text);
      for (const j of jobs) job.run(j.session, j.call, j.ts, j.read, j.total);
    })();
  }

  close() { clearInterval(this.pruner); }
}
