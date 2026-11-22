// Which statement the daemon's connection is in right now, for the stall
// watcher (src/admin/stall-watch.ts). The watcher sees the system call the
// main thread sleeps in and the file it is on; a read of the database, a
// write to its log or a wait for its write lock says nothing about which
// query made it. Here every statement of the store's connection writes one
// number before it runs and puts the last one back after: the number of its
// label. The watcher's thread reads that number with its samples.
//
// A label is built from a fixed vocabulary, never copied from the
// statement's text: SQL's own words, the names of the store's tables,
// columns and indexes (read from the schema), and punctuation. Every other
// piece of the text is written as `?`: a number, a string in any kind of
// quotes, a comment's words, an alias, a name the schema does not hold. So
// no value can reach a label, whatever the text looks like;
// what is bound to a statement was never in its text. It is cut to
// LABEL_MAX characters.
//
// The cost on the path of every query is one call more and two writes of a
// number (measured: see the test beside this file).
import type { Database } from "bun:sqlite";

const LABEL_MAX = 160;
// Statements with a text of their own are few (some hundreds). A program
// that makes texts without end (values written into the text) gets one
// label for all of them past this many.
const LABELS_MAX = 4_000;
const OTHER = 1;

// [0]: the label of the statement that runs, 0 when none does.
export const statementCell = new Int32Array(new SharedArrayBuffer(4));
const texts: string[] = ["", "another statement"];
const ids = new Map<string, number>();
const listeners = new Set<(id: number, text: string) => void>();

// SQL's own words, the functions and the pragmas the daemon's statements use.
const SQL_WORDS = new Set(`
  select from where and or not in is null like between exists insert into values update set delete join left right inner
  outer cross on as order by group having limit offset union all distinct case when then else end asc desc create table
  index if drop alter add column rename to primary key unique default check references pragma begin commit rollback
  savepoint release immediate exclusive deferred transaction with recursive returning replace ignore conflict do nothing
  indexed vacuum analyze attach detach database explain query plan trigger view temp temporary using collate nocase glob
  match escape cast integer text real blob numeric rowid over partition window filter without strict virtual fts5 rank
  count sum max min avg total coalesce ifnull nullif length substr instr lower upper trim ltrim rtrim abs round random
  json json_extract json_valid json_each json_tree json_object json_array json_group_array json_group_object json_set
  json_insert json_remove json_patch json_type json_array_length group_concat strftime datetime date time julianday
  unixepoch total_changes changes last_insert_rowid typeof hex quote printf format iif likely unlikely zeroblob true
  false current_timestamp excluded new old value sqlite_master sqlite_schema sqlite_sequence pragma_table_info
  journal_mode synchronous wal_autocheckpoint wal_checkpoint busy_timeout cache_size temp_store foreign_keys
  journal_size_limit page_size page_count freelist_count data_version schema_version user_version integrity_check
  quick_check foreign_key_check table_info table_list index_list index_info query_only optimize mmap_size auto_vacuum
  incremental_vacuum passive full restart truncate wal normal memory off name type tbl_name sql
`.split(/\s+/).filter(Boolean));
// The names in the stores' schemas this process has seen: tables, columns, indexes, triggers.
const schemaWords = new Set<string>();
const known = (word: string) => {
  const w = word.toLowerCase();
  return SQL_WORDS.has(w) || schemaWords.has(w);
};

// The label of a statement's text. Each name in it that is in the
// vocabulary (`knows`) stays; every other run of characters that is not
// white space or SQL's punctuation becomes `?` (a number, a quote, a name
// the vocabulary does not hold, an alias). That step alone decides what a
// label can hold. Before it, comments and quoted strings are taken out
// whole, so a label reads as its statement does; a text that fools that
// still passes the step above.
export function labelText(sql: string, knows: (word: string) => boolean = known): string {
  const t = sql
    // (One pass from the left: a `--` inside a string is the string's, and an apostrophe in a comment is the comment's.)
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("--") || m.startsWith("/*") ? " " : "?"))
    .replace(/[A-Za-z_][A-Za-z0-9_]*|[^\sA-Za-z_(),.*=<>!+\-/|;%?]+/g, (tok) => (/^[A-Za-z_]/.test(tok) && knows(tok) ? tok : "?"))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\?(?:[ \-+/|%*]*\?)+/g, "?");
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 3)}...` : t;
}

// The schema's names of a connection, taken into the vocabulary. Read with
// the connection's own statements as they were before they were labelled.
// (Each statement is finalized here: one left open would keep the connection
// from closing, and a store that does not close leaves its log behind.)
type Prepared = { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown; finalize: () => void };
type Reader = (sql: string) => Prepared;
const once = <T>(prepare: Reader, sql: string, use: (st: Prepared) => T): T => {
  const st = prepare(sql);
  try { return use(st); } finally { try { st.finalize(); } catch {} }
};
function learn(prepare: Reader) {
  try {
    for (const r of once(prepare, "SELECT name, tbl_name FROM sqlite_master", (st) => st.all()) as { name?: string; tbl_name?: string }[]) {
      for (const n of [r.name, r.tbl_name]) if (n) schemaWords.add(n.toLowerCase());
    }
    for (const r of once(prepare, "SELECT p.name AS name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'", (st) => st.all()) as { name?: string }[]) {
      if (r.name) schemaWords.add(r.name.toLowerCase());
    }
  } catch {} // a schema that cannot be read now: its names are `?` until it can
}
// How a new label's vocabulary is brought up to date: set by the labelled connection.
let relearn: (() => void) | undefined;

export function labelId(sql: string): number {
  const had = ids.get(sql);
  if (had) return had;
  if (texts.length >= LABELS_MAX) return OTHER;
  // The store's transactions begin as writers (its `immediate`): their start is where a write waits for the write lock.
  // A new statement's text may name what the schema got since the last one: the names are read again (once a text).
  if (sql !== "BEGIN") relearn?.();
  const text = sql === "BEGIN" ? "BEGIN (the start of a transaction: a write waits here for the store's write lock)" : labelText(sql);
  const id = texts.push(text) - 1;
  ids.set(sql, id);
  for (const l of listeners) { try { l(id, text); } catch {} }
  return id;
}

// Every label made so far, then each new one as it is made. Returns what ends it.
export function onLabels(l: (id: number, text: string) => void): () => void {
  for (let id = 1; id < texts.length; id++) l(id, texts[id]!);
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// How deep in transactions the connection is: a statement inside one leaves
// its label standing when it ends, so the commit that follows (where the
// transaction's pages are written to the log) is named by the transaction's
// last statement. The transaction puts back what stood before it.
let inTransaction = 0;
const ENDS = /^\s*(BEGIN|COMMIT|END|ROLLBACK|RELEASE|SAVEPOINT)\b/i;
const METHODS = ["run", "get", "all", "values", "iterate"] as const;

// Labels every statement of this connection. bun:sqlite gives each statement
// object its own get, all, run, values and iterate: they are wrapped where
// the statement is made (`query` keeps one statement a text, so once each).
// `failed`: told of an error a statement or a transaction of this connection ended with (the store
// looks for a write lock that was not had), before it is thrown on, with how many times this call
// was tried again before. True: it is tried again (a wait for the write lock that is made a part at
// a time: the error came before anything was done). An error: that one is thrown in its place.
export function labelled(db: Database, failed?: (e: unknown, tries: number) => boolean | Error | void) {
  const next = (e: unknown, tries: number): true | unknown => { const r = failed?.(e, tries); return r === true ? true : r instanceof Error ? r : e; };
  const d = db as unknown as Record<string, (...a: any[]) => any>;
  const cell = statementCell;
  const wrapped = new WeakSet<object>();
  const wrap = (st: any, sql: string) => {
    if (!st || typeof st !== "object" || wrapped.has(st) || ENDS.test(sql)) return st;
    wrapped.add(st);
    const id = labelId(sql);
    for (const k of METHODS) {
      const f = st[k];
      if (typeof f !== "function") continue;
      st[k] = function (...a: unknown[]) {
        const was = cell[0]!;
        for (let tries = 0; ; tries++) {
          cell[0] = id;
          try { return f.apply(st, a); } catch (e) { const r = next(e, tries); if (r === true) continue; throw r; } finally { cell[0] = inTransaction ? id : was; }
        }
      };
    }
    return st;
  };
  // The schema's names, read through the connection's own prepare (not the labelled one), again whenever the schema changed.
  const plain = d.prepare!.bind(db) as unknown as Reader;
  let version = -1;
  relearn = () => {
    try {
      const v = once(plain, "PRAGMA schema_version", (st) => st.get() as { schema_version: number }).schema_version;
      if (v === version) return;
      version = v;
    } catch { return; }
    learn(plain);
  };
  relearn();
  for (const m of ["query", "prepare"] as const) {
    const make = d[m]!.bind(db);
    d[m] = (sql: string, ...a: unknown[]) => wrap(make(sql, ...a), sql);
  }
  // Each way a transaction is begun (plain, deferred, immediate, exclusive) runs inside the transaction's label.
  const transaction = d.transaction!.bind(db);
  d.transaction = (fn: (...a: unknown[]) => unknown) => {
    const t = transaction(fn) as ((...a: unknown[]) => unknown) & Record<string, (...a: unknown[]) => unknown>;
    const within = (f: (...a: unknown[]) => unknown) => function (this: unknown, ...a: unknown[]) {
      for (let tries = 0; ; tries++) { try { return inTransactionOf(() => f.apply(this, a)); } catch (e) { const r = next(e, tries); if (r === true) continue; throw r; } }
    };
    return Object.assign(within(t), { deferred: within(t.deferred!), immediate: within(t.immediate!), exclusive: within(t.exclusive!) });
  };
  for (const m of ["run", "exec"] as const) {
    const call = d[m]!.bind(db);
    d[m] = (sql: string, ...a: unknown[]) => {
      const was = cell[0]!;
      const id = labelId(sql);
      for (let tries = 0; ; tries++) {
        cell[0] = id;
        try { return call(sql, ...a); } catch (e) { const r = next(e, tries); if (r === true) continue; throw r; } finally { cell[0] = inTransaction ? id : was; }
      }
    };
  }
}

// A transaction of a labelled connection. Its own BEGIN and COMMIT are made
// by bun:sqlite out of sight of the wrappers above: the BEGIN is labelled
// here, and the commit keeps the label of the transaction's last statement.
function inTransactionOf<T>(run: () => T): T {
  const was = statementCell[0]!;
  if (!inTransaction) statementCell[0] = (begin ||= labelId("BEGIN"));
  inTransaction++;
  try { return run(); } finally { inTransaction--; statementCell[0] = was; }
}
let begin = 0;
