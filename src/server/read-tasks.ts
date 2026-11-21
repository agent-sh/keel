// The reads that run on the read thread (reads.ts), by name: each takes a
// database connection and plain arguments and returns plain data, so the same
// function serves the thread and a call on the loop. They import nothing of
// the daemon: the thread loads only this file and what it names.
import type { Database } from "bun:sqlite";
import { reportOf, sideOf, tokensOf, type Limits } from "../admin/telemetry-report.ts";
import type { Filter } from "../admin/telemetry.ts";
import { marksOf, type MarkArgs } from "../safety/marks.ts";
import { searchContent, type ContentQuery } from "./routes/search-content.ts";

export const tasks = {
  // One statement and its rows. The statement is not kept: its text may carry
  // values of one request.
  sql: (db: Database, a: { sql: string; params?: (string | number | null)[] }): unknown[] => {
    const st = db.prepare<unknown, (string | number | null)[]>(a.sql);
    try { return st.all(...(a.params ?? [])); } finally { st.finalize(); }
  },
  "telemetry.report": (db: Database, a: { q: Filter; limits: Limits }) => reportOf(db, a.q, a.limits),
  "telemetry.tokens": (db: Database, a: { q: Filter }) => tokensOf(db, a.q),
  "telemetry.side": (db: Database, a: { q: Filter }) => sideOf(db, a.q),
  "search.content": (db: Database, a: ContentQuery) => searchContent(db, a),
  // What the transcript marks on the calls of a page's events: every command of them is parsed here.
  "calls.marks": (db: Database, a: MarkArgs) => marksOf(db, a),
};

export type Tasks = typeof tasks;
export type TaskName = keyof Tasks;
