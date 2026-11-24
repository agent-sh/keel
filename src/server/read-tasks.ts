// The reads that run on the read thread (reads.ts), by name: each takes a
// database connection and plain arguments and returns plain data, so the same
// function serves the thread and a call on the loop. They import nothing of
// the daemon: the thread loads only this file and what it names.
import type { Database } from "bun:sqlite";
import { reportOf, sideOf, tokensOf, type Limits } from "../admin/telemetry-report.ts";
import type { Filter } from "../admin/telemetry.ts";
import { marksOf, type MarkArgs } from "../safety/marks.ts";
import { searchContent, type ContentQuery } from "./routes/search-content.ts";
import { findInSession, type FindAsk } from "./routes/find-read.ts";
import { callAnswered, callsNamed, type AnsweredAsk, type NamedAsk } from "./routes/calls-read.ts";
import { sessionWhole, type WholeAsk } from "./routes/session-read.ts";
import { settleStored } from "../engine/settle-read.ts";
import { claudeMcpChoices } from "../mcp/claude-choices.ts";
import type { SettleAsk } from "../engine/compact.ts";
import { readHours, type HoursAsk } from "../admin/hours-read.ts";
import { checkDrivers, driversOf, type DriversAsk } from "../admin/cost-drivers.ts";
import { boardChecks, boardFacts, boardPictures } from "../board/facts.ts";
import { parseDiff } from "../board/tree.ts";
import { earlierCandidates, earlierOutcomes } from "../automation/earlier-facts.ts";
import { priceFactsRead } from "../engine/price-facts.ts";
import { pressReport } from "../admin/presses.ts";
import { egressReport, type EgressAsk } from "../safety/egress-report.ts";
import { scanFiles, type FilesAsk } from "../admin/health-files.ts";
import { mineRead, untagged } from "../automation/lessons-mine.ts";
import { BUDGET_MS, trialRead, type TrialAsk } from "../safety/trial-read.ts";
import { readProcs, type ProcAsk } from "../admin/proc-read.ts";

export const tasks = {
  // What /proc says of the processes under the daemon (the resource sampler's pass, src/admin/proc-read.ts).
  "proc.sample": (_db: Database, a: ProcAsk) => readProcs(a),
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
  // The page's Find in one conversation: what the part it does not hold has of the text (routes/find-read.ts).
  "find.session": (db: Database, a: FindAsk) => findInSession(db, a),
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
  // What compaction by price forecasts from: finished agents' step counts, and summaries' sizes and times (src/engine/price-facts.ts).
  "compact.priceFacts": (db: Database, a: { since: number; quiet: number }) => priceFactsRead(db, a),
  // Where a session's agent tree spent its time: its spans, turns, agents and waits (src/admin/hours-read.ts).
  "hours.tree": (db: Database, a: HoursAsk) => readHours(db, a),
  // Why a range cost what it did, from the cost drivers' rollup; and that rollup held against the ledger (no repair: the thread reads only).
  "usage.drivers": (db: Database, a: DriversAsk) => driversOf(db, a),
  "usage.driversCheck": (db: Database, _a: Record<string, never>) => checkDrivers(db, false),
  // The work board of a session's tree (src/board/board.ts): its agents and what is known of their branches,
  // and the check runs on their heads' trees.
  "board.facts": (db: Database, a: { root: string }) => boardFacts(db, a),
  "board.checks": (db: Database, a: { trees: string[]; heads?: { head: string; session: string }[] }) => boardChecks(db, a),
  // One branch head's diff against the base, parsed for the tree review (src/board/tree-review.ts).
  "tree.parse": (_db: Database, a: { text: string }) => parseDiff(a.text),
  "board.pictures": (db: Database, a: { heads: string[] }) => boardPictures(db, a),
  // The agents of a repository with their task words, and what the review and landing rows say of some branches (src/automation/earlier.ts).
  "agents.earlier": (db: Database, a: { repo: string; skip?: string[] }) => earlierCandidates(db, a),
  "agents.earlierOutcomes": (db: Database, a: { repo: string; branches: string[]; agents: string[] }) => earlierOutcomes(db, a),
  // What left the daemon in a range, by host and session (src/safety/egress-report.ts).
  // What the owner presses, most used first per view (src/admin/presses.ts).
  "presses.report": (db: Database, a: { days?: number }) => pressReport(db, a),
  "egress.report": (db: Database, a: EgressAsk) => egressReport(db, a),
  // The health check's walk over the owner's skill, command, agent and plugin files (src/admin/health-files.ts).
  "health.files": (_db: Database, a: FilesAsk) => scanFiles(a),
  // The causes that recur across a repository's agent trees (src/automation/lessons-mine.ts).
  "lessons.mine": (db: Database, a: { now: number; days?: number; trees?: number }) => mineRead(db, a),
  // The review findings no kind was asked for yet.
  "lessons.untagged": (db: Database, a: { since: number; max: number }) => untagged(db, a.since, a.max),
  // A safety rule change tried on the stored calls of the last days (src/safety/trial-read.ts). Answers in time,
  // within its budget; the rules are the daemon's own (nothing of the request names code to load).
  "safety.trial": (db: Database, a: TrialAsk) => trialRead(db, a, { budget: BUDGET_MS }),
};

export type Tasks = typeof tasks;
export type TaskName = keyof Tasks;
