// The reads that run on the read thread (reads.ts), by name: each takes a
// database connection and plain arguments and returns plain data, so the same
// function serves the thread and a call on the loop. They import nothing of
// the daemon: the thread loads only this file and what it names.
import type { Database } from "bun:sqlite";
import { reportOf, sideOf, tokensOf, type Limits } from "../admin/telemetry-report.ts";
import type { Filter } from "../admin/telemetry.ts";
import { marksOf, type MarkArgs } from "../safety/marks.ts";
import { searchContent, type ContentQuery } from "./routes/search-content.ts";
import { callAnswered, callsNamed, type AnsweredAsk, type NamedAsk } from "./routes/calls-read.ts";
import { sessionWhole, type WholeAsk } from "./routes/session-read.ts";
import { settleStored } from "../engine/settle-read.ts";
import { claudeMcpChoices } from "../mcp/claude-choices.ts";
import type { SettleAsk } from "../engine/compact.ts";

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
  // The replies of a session that hold a call by one of some names, and whether a call was answered (the last-call route).
  "calls.named": (db: Database, a: NamedAsk) => callsNamed(db, a),
  "calls.answered": (db: Database, a: AnsweredAsk) => callAnswered(db, a),
  // A whole session as the bytes of its answer (GET /api/sessions/:id with no page).
  "session.whole": (db: Database, a: WholeAsk) => sessionWhole(db, a),
  // The owner's approvals in Claude Code of project MCP servers (src/mcp/project.ts):
  // ~/.claude.json is large, so it is parsed here and only what is asked comes back.
  "claude.mcpChoices": (_db: Database, a: { files: string[]; roots: string[] }) => claudeMcpChoices(a.files, a.roots),
  // A summary checked against every message of its branch (a compaction).
  "compact.settle": (db: Database, a: SettleAsk) => settleStored(db, a),
};

export type Tasks = typeof tasks;
export type TaskName = keyof Tasks;
