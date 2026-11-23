// The compiled statements of a connection, by their text.
//
// bun:sqlite's query() keeps the statements of its first 20 distinct texts
// (Database.MAX_QUERY_CACHE_SIZE) and compiles every later text again at each
// call: the store has hundreds, so most of its reads and writes compiled their
// statement each time (eight times the cost of a cached read, and a statement
// object left for the collector each call). Here query() keeps them all, past
// `kept` the one used longest ago let go (not finalized: a statement made once
// and held for the daemon's life, as the sends and the vault's ledger do, is
// the oldest entry and must go on working; the collector frees it once nothing
// holds it). A text is compiled once only when it is the same each call: a
// value goes in as a bound parameter, a list as one JSON array (`json_each(?)`),
// never into the text, so the bound is not reached in practice. The ones kept
// are finalized when the connection closes.
import type { Database, Statement } from "bun:sqlite";

export const STATEMENTS_KEPT = 2048;

export function cacheStatements(db: Database, kept = STATEMENTS_KEPT): void {
  const prepare = db.prepare.bind(db) as (sql: string) => Statement;
  const cache = new Map<string, Statement>();
  (db as { query: (sql: string) => Statement }).query = (sql: string) => {
    const had = cache.get(sql);
    if (had) {
      cache.delete(sql);
      cache.set(sql, had);
      return had;
    }
    const st = prepare(sql);
    cache.set(sql, st);
    if (cache.size > kept) {
      const [old] = cache.entries().next().value!;
      cache.delete(old);
    }
    return st;
  };
  // A close finalizes what is kept first: a statement left open keeps the connection (and its log) open.
  const close = db.close.bind(db) as (throwOnError?: boolean) => void;
  (db as { close: (throwOnError?: boolean) => void }).close = (throwOnError?: boolean) => {
    for (const st of cache.values()) try { st.finalize(); } catch {}
    cache.clear();
    close(throwOnError);
  };
}
