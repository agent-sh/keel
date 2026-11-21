// A session's story from one place: its turns (who started each, how it ended,
// what it took), the agents it started and how each ended, waits set and
// fired, loop runs, compactions, model switches, daemon restarts, approvals
// and errors, newest first, and what it is doing and waiting on now.
//
// Read only, and a page at a time: the marks of a session's events come from
// small partial indexes (never the session's whole history), the rest from
// the activity list, the session's failure record and the errors table by
// their session indexes, and each row's facts from the records its ids name.
// Nothing here parses a prompt or a tool result into the answer: see
// timeline-rows.ts for what a row may say.
//
// Every statement is a seek or a read with a bound of its own, and names the
// index it reads (INDEXED BY: a statement its index cannot serve fails when
// it is prepared, instead of walking the session). What lies between two
// marks (a session of tens of thousands of notes and no turn, a turn with a
// thousand hook notes) is never walked.
import { createHash } from "node:crypto";
import type { Store } from "../core/store.ts";
import type { ErrorRecord, TurnStatus } from "../core/types.ts";
import { errorClass } from "./classes.ts";
import { TURN, TURN_IX, TURN_SCHEMA } from "./marks.ts";
import {
  activityRow, errorRow, failureRow, isFailure, markRow, NOTE_MARKS, nowLines, outcomeOf, turnRow,
  type ActivityIn, type Lookups, type NowInput, type Opener, type TimelinePage, type TimelineRow,
} from "./timeline-rows.ts";

// The events that make a row: a turn's start, a compaction, and a note of a
// kind that has a row (a plain note has none, and is not in the index).
const ROWS = `(kind IN ('turn_start', 'compaction') OR (kind = 'note' AND data ->> '$.kind' IN (${NOTE_MARKS.map((k) => `'${k}'`).join(", ")})))`;
// Named by what it holds: a build whose rows differ makes its own and drops the other.
const ROWS_IX = `events_rows_${createHash("sha256").update(ROWS).digest("hex").slice(0, 8)}`;
// The model's replies by position: a turn's steps are counted off the index.
const STEPS_IX = "events_steps";
// The activity rows the timeline tells: a session's thousands of turn ends are not read to find its agents.
const TOLD = "(kind IN ('agent', 'wait', 'loop', 'approval') OR (kind = 'turn' AND sub = 'goal') OR (kind = 'alert' AND sub IN ('approval', 'question', 'limit')))";
const TOLD_IX = "activity_told";
const SCHEMA = `
DROP INDEX IF EXISTS events_marks;
${TURN_SCHEMA}
CREATE INDEX IF NOT EXISTS ${ROWS_IX} ON events(session_id, ts, id) WHERE ${ROWS};
CREATE INDEX IF NOT EXISTS ${STEPS_IX} ON events(session_id, seq) WHERE kind = 'assistant';
CREATE INDEX IF NOT EXISTS errors_session ON errors(session_id, ts);
`;
// The marks read in one statement after a point (a turn's compactions, the
// notes after a cut turn's end): more than this many is not a shape a turn has.
const NEAR = 256;
// What one page spends walking up the branch from the session's head (see
// onBranch): a few hundred events at a time, until this long has passed.
const WALK_PART = 500;
const WALK_MS = 20;
// What a mark's data may give: a few named fields, never its text.
const PICK = `CASE WHEN kind IN ('turn_start', 'turn_end') THEN data ELSE json_object(
  'kind', data ->> '$.kind', 'from', data ->> '$.from', 'to', data ->> '$.to', 'mode', data ->> '$.mode', 'auto', data ->> '$.auto',
  'trigger', data ->> '$.trigger', 'tokens_before', data ->> '$.tokens_before', 'error_id', data ->> '$.error_id') END`;

export const PAGE = 50;
export const PAGE_MAX = 200;
// Rows a filtered page reads before it answers with what it found so far: a
// filter that matches nothing costs about ten plain pages, never the session.
export const SCAN_MAX = 500;
export type Only = "failures" | "turns" | "agents";
export const ONLY: Only[] = ["failures", "turns", "agents"];
export type PageOpts = { before?: string | null; limit?: number; only?: Only | null; since?: number | null; now?: boolean };

// What the timeline asks of the running daemon. Each is optional: a store
// read without its daemon (a test, a measurement) has rows and no "now".
export type Live = {
  isRunning?(id: string): boolean;
  turnOf?(id: string): string | undefined;
  statusOf?(id: string): TurnStatus;
  isHeld?(id: string): boolean;
  owed?(id: string): boolean; // reports and wakes waiting for the turn to end
  questions?(): { session_id: string; call_id: string; parent_id?: string }[];
};

type MarkRow = { id: string; ts: number; seq: number; kind: string; parent: string | null; data: string | null };
type Cursor = { ts: number; id: string };
const TOP: Cursor = { ts: Number.MAX_SAFE_INTEGER, id: "\uffff" };
// The branch shown, walked from its head only as far down as a page asked.
type Line = { head: string; top: number; low: { id: string; seq: number; parent: string | null }; turns: Set<string>; done: boolean };
const LINES_KEPT = 16;
type ErrorLite = Pick<ErrorRecord, "id" | "ts" | "source" | "message" | "count" | "turn_event" | "span_id" | "resolved_ts">;
// What every part of one page reads the same: looked up once, when first asked.
type Ctx = {
  look: Lookups; told: Set<string>;
  head(): string | null; byTurn(): Map<string, string>;
  walk: { until: number }; // when this page stops walking up the branch
  causes(): { classes: Set<string>; links: Map<string, ErrorLite> } | null;
};
const once = <T>(f: () => T) => { let got: { v: T } | undefined; return () => (got ??= { v: f() }).v; };

export function parseCursor(v: string | null | undefined): Cursor | undefined {
  if (!v) return undefined;
  const at = v.indexOf(":");
  const ts = Number(at < 0 ? v : v.slice(0, at));
  if (!Number.isFinite(ts)) throw Object.assign(new Error("before is a cursor (ts:id), as a page's `next` gives it"), { status: 400 });
  return { ts, id: at < 0 ? "" : v.slice(at + 1) };
}

export class Timeline {
  private has = new Set<string>();
  private lines = new Map<string, Line>();

  constructor(private store: Store, private live: Live = {}) {
    store.migrate(SCHEMA);
    // The rows index of a build that told other notes.
    for (const { name } of store.db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'events!_rows!_%' ESCAPE '!' AND name <> ?").all(ROWS_IX)) store.migrate(`DROP INDEX IF EXISTS ${name}`);
  }

  // Tables of other modules are read when the daemon made them. Only a yes is
  // kept: a table made after the first look is found at the next one.
  private table(name: string): boolean {
    if (this.has.has(name)) return true;
    const there = !!this.store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!there) return false;
    if (name === "activity") this.store.migrate(`CREATE INDEX IF NOT EXISTS ${TOLD_IX} ON activity(session_id, ts, id) WHERE ${TOLD}`);
    this.has.add(name);
    return true;
  }

  page(sessionId: string, opts: PageOpts = {}): TimelinePage {
    const as_of = Date.now();
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? PAGE), 1), PAGE_MAX);
    const since = opts.since ?? 0;
    const now = opts.now === false ? undefined : this.now(sessionId);
    // What "now" already says is not said again as a row: the running turn
    // and a card still open are there, with how long they have been.
    const told = new Set((now?.lines ?? []).flatMap((l) => [l.kind === "turn" ? l.turn_event : undefined, l.kind === "approval" ? l.refs?.approval_id : undefined, l.refs?.note_id]).filter(Boolean) as string[]);
    const shown = (r: TimelineRow) => !((r.open && ((r.kind === "turn" && told.has(r.id)) || (r.kind === "approval" && told.has(r.refs?.approval_id ?? "")))) || (r.kind === "restart" && told.has(r.id)));
    let at = parseCursor(opts.before) ?? TOP;
    const rows: TimelineRow[] = [];
    let next: string | null = null;
    let scanned = 0;
    const ctx = this.ctx(sessionId, told);
    // A filter may drop most of what is read: read on, up to a bound, and say
    // where the next page starts whether or not this one is full. What it
    // reads at a time does not shrink with the page asked for: one failure
    // asked of five hundred clean turns is ten reads, not five hundred.
    for (;;) {
      const want = opts.only === "failures" ? Math.max(limit, Math.min(PAGE, SCAN_MAX - scanned)) : limit;
      const got = this.merged(sessionId, at, want + 1, opts.only ?? null, since, ctx);
      const part = got.slice(0, want);
      let taken = 0;
      for (const r of part) {
        at = { ts: r.ts, id: r.id };
        taken++;
        if ((opts.only !== "failures" || isFailure(r)) && shown(r)) rows.push(r);
        if (rows.length === limit) break;
      }
      scanned += taken;
      if (!(got.length > want || taken < part.length)) break;
      if (rows.length === limit || scanned >= SCAN_MAX) { next = `${at.ts}:${at.id}`; break; }
    }
    return { session_id: sessionId, as_of, ...(now ? { now } : {}), rows, next, ...(opts.only === "failures" ? { scanned } : {}) };
  }

  private ctx(sessionId: string, told: Set<string>): Ctx {
    return {
      look: this.lookups(), told, walk: { until: performance.now() + WALK_MS },
      head: once(() => this.store.db.query<{ head: string | null }, [string]>("SELECT head FROM sessions WHERE id = ?").get(sessionId)?.head ?? null),
      byTurn: once(() => this.errorsByTurn(sessionId)),
      causes: once(() => this.causes(sessionId)),
    };
  }

  // The sources, each already newest first, as one list.
  // `told`: what "now" says. Its rows are not built at all (the running turn's would be counted and thrown away).
  private merged(sessionId: string, at: Cursor, n: number, only: Only | null, since: number, ctx: Ctx): TimelineRow[] {
    const all = [
      ...(only === "agents" ? [] : this.marks(sessionId, at, n, only === "turns", since, ctx)),
      // A wake or a report that started a turn is told in that turn's row, where the turns are listed with it.
      ...(only === "turns" ? [] : this.activity(sessionId, at, n, only === "agents", since, ctx.look, only === null)),
      ...(only === "turns" || only === "agents" ? [] : this.errors(sessionId, at, n, since, ctx)),
    ];
    all.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return all.slice(0, n);
  }

  // --- turns and the other marks of the event tree
  private marks(sessionId: string, at: Cursor, n: number, turnsOnly: boolean, since: number, ctx: Ctx): TimelineRow[] {
    const q = this.store.db.query<MarkRow, [string, number, number, string, number]>(
      `SELECT id, ts, seq, kind, parent, ${PICK} AS data FROM events INDEXED BY ${turnsOnly ? TURN_IX : ROWS_IX}
       WHERE session_id = ? AND ${turnsOnly ? `${TURN} AND kind = 'turn_start'` : ROWS} AND ts >= ? AND (ts, id) < (?, ?)
       ORDER BY ts DESC, id DESC LIMIT ?`);
    const out: TimelineRow[] = [];
    for (let cur = at; out.length < n;) {
      const got = q.all(sessionId, since, cur.ts, cur.id, n + 8);
      for (const m of got) {
        if (ctx.told.has(m.id)) continue;
        const row = m.kind === "turn_start" ? this.turn(sessionId, m, ctx) : markRow({ id: m.id, ts: m.ts, kind: m.kind, data: m.data ? JSON.parse(m.data) : null }, this.turnAround(sessionId, m));
        if (row) out.push(row);
        if (out.length === n) break;
      }
      if (got.length < n + 8) break;
      const last = got.at(-1)!;
      cur = { ts: last.ts, id: last.id };
    }
    return out;
  }

  // The first mark of one kind after a point, and the last before it: a seek,
  // whatever lies between (`to`: not at or past this point).
  private next(sessionId: string, kind: "turn_start" | "turn_end" | "error", from: Cursor, to: Cursor = TOP): MarkRow | undefined {
    return this.store.db.query<MarkRow, [string, string, number, string, number, string]>(
      `SELECT id, ts, seq, kind, parent, ${PICK} AS data FROM events INDEXED BY ${TURN_IX}
       WHERE session_id = ? AND ${TURN} AND kind = ? AND (ts, id) > (?, ?) AND (ts, id) < (?, ?) ORDER BY ts, id LIMIT 1`).get(sessionId, kind, from.ts, from.id, to.ts, to.id) ?? undefined;
  }
  private prev(sessionId: string, kind: "turn_start" | "turn_end", from: Cursor = TOP): MarkRow | undefined {
    return this.store.db.query<MarkRow, [string, string, number, string]>(
      `SELECT id, ts, seq, kind, parent, ${PICK} AS data FROM events INDEXED BY ${TURN_IX}
       WHERE session_id = ? AND ${TURN} AND kind = ? AND (ts, id) < (?, ?) ORDER BY ts DESC, id DESC LIMIT 1`).get(sessionId, kind, from.ts, from.id) ?? undefined;
  }

  // What follows a turn's start, up to the next turn's start: its end, the
  // compactions before it, and the error event of a turn that threw.
  private after(sessionId: string, start: Cursor): { end?: MarkRow; errorId?: string; compactions: number; nextSeq?: number } {
    const nextStart = this.next(sessionId, "turn_start", start);
    const end = this.next(sessionId, "turn_end", start, nextStart);
    const upTo = end ?? nextStart ?? TOP;
    const compactions = this.store.db.query<{ n: number }, [string, number, string, number, string]>(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM events INDEXED BY ${TURN_IX}
       WHERE session_id = ? AND ${TURN} AND kind = 'compaction' AND (ts, id) > (?, ?) AND (ts, id) < (?, ?) LIMIT ${NEAR})`).get(sessionId, start.ts, start.id, upTo.ts, upTo.id)!.n;
    // A turn that threw: its error event follows its end and names the error.
    const error = this.next(sessionId, "error", start, nextStart);
    return { end, errorId: error ? JSON.parse(error.data ?? "{}").error_id ?? undefined : undefined, compactions, nextSeq: nextStart?.seq };
  }

  // The prompt a turn answers: the event before its start, past the notes and
  // checkpoints between. Only what says who sent it is read off it.
  private opener(sessionId: string, parent: string | null): Opener {
    const q = this.store.db.query<{ kind: string; parent: string | null; session_id: string; o: string | null }, [string]>(
      `SELECT kind, parent, session_id, CASE WHEN kind = 'user' THEN json_object('origin', data ->> '$.origin', 'kind', data ->> '$.kind', 'queue_id', data ->> '$.queue_id',
                  'wait_id', data ->> '$.wait_id', 'agent_id', data ->> '$.agent_id', 'loop_id', data ->> '$.loop_id', 'run_id', data ->> '$.run_id', 'from', data ->> '$.from',
         'outcome', data ->> '$.outcome', 'status', data ->> '$.status') END AS o
       FROM events WHERE id = ?`);
    for (let id = parent, hops = 0; id && hops < 32; hops++) {
      const e = q.get(id);
      if (!e || e.session_id !== sessionId) return null;
      if (e.kind === "user") return JSON.parse(e.o!);
      if (e.kind !== "note" && e.kind !== "compaction") return null;
      id = e.parent;
    }
    return null;
  }

  // What a turn took: the replies the model gave, its tool results, the calls
  // that ran and failed and the ones a gate denied. Its end says so (the
  // engine counts as it goes); a turn from before that, or one cut without an
  // end of its own, is counted from its events and its telemetry row; a
  // running turn from what ran so far, by the turn's id.
  private steps(sessionId: string, start: MarkRow, end?: MarkRow, nextSeq?: number): number {
    const to = end?.seq ?? nextSeq ?? Number.MAX_SAFE_INTEGER;
    return this.store.db.query<{ n: number }, [string, number, number]>(`SELECT COUNT(*) AS n FROM events INDEXED BY ${STEPS_IX} WHERE session_id = ? AND seq > ? AND seq < ? AND kind = 'assistant'`).get(sessionId, start.seq, to)!.n;
  }
  private counts(sessionId: string, start: MarkRow, end: MarkRow | undefined, said: Record<string, any> | null, nextSeq: number | undefined) {
    const num = (v: unknown) => (typeof v === "number" && v >= 0 ? v : undefined);
    if (said && num(said.steps) !== undefined && num(said.tools) !== undefined) return { steps: said.steps as number, tools: said.tools as number, failed_tools: num(said.tool_errors) ?? 0, denied_tools: num(said.tool_denied) };
    const steps = this.steps(sessionId, start, end, nextSeq);
    const told = end ? this.rollup(start.id) : undefined;
    if (told) return { steps, tools: told.tool_calls, failed_tools: told.tool_errors };
    if (!this.table("telemetry_tools")) return { steps, tools: 0, failed_tools: 0 };
    const t = this.store.db.query<{ n: number; bad: number | null }, [string]>("SELECT COUNT(*) AS n, SUM(is_error) AS bad FROM telemetry_tools WHERE turn_event = ?").get(start.id)!;
    return { steps, tools: t.n, failed_tools: t.bad ?? 0 };
  }

  // The turn's telemetry row: all its requests (its own, a reader's, a
  // summary's) and tool runs, joined by the turn's id.
  private rollup(turnEvent: string) {
    if (!this.table("telemetry_turns")) return undefined;
    return this.store.db.query<{ tool_calls: number; tool_errors: number; requests: number; input: number; output: number; cache_read: number; cost: number | null }, [string]>(
      "SELECT tool_calls, tool_errors, requests, input, output, cache_read, cost FROM telemetry_turns WHERE turn_event = ?").get(turnEvent) ?? undefined;
  }

  private turn(sessionId: string, m: MarkRow, ctx: Ctx): TimelineRow {
    const look = ctx.look;
    const f = this.after(sessionId, m);
    const opener = this.opener(sessionId, m.parent);
    // What woke it is said here, and has no row of its own (see folded).
    const w = opener?.kind === "wait" && opener.outcome === "fired" && typeof opener.wait_id === "string" ? look.wait?.(opener.wait_id) : undefined;
    const g = opener?.kind === "subagent" && opener.status === "completed" && typeof opener.agent_id === "string" ? look.agent?.(opener.agent_id) : undefined;
    const end = f.end ? JSON.parse(f.end.data ?? "{}") : null;
    // What it spent, over every request made while it ran; a turn with no
    // such row (it is from before the table, or no request was recorded)
    // says what its end summed, which is its own steps only.
    const roll = f.end ? this.rollup(m.id) : undefined;
    return turnRow({
      start: { id: m.id, ts: m.ts, model: JSON.parse(m.data ?? "{}").model },
      opener,
      wake: w && { kind: w.kind, ms: w.ended && w.created !== undefined ? w.ended - w.created : undefined },
      agent: g && { title: g.title, session_id: g.session_id },
      end: end && { reason: String(end.reason ?? "error"), ms: typeof end.ms === "number" ? end.ms : undefined, ts: f.end!.ts, stopped_by: end.stopped_by, crashed: !!end.crashed, unstarted: !!end.unstarted },
      usage: roll && roll.requests > 0 ? roll : end?.usage,
      running: !f.end && this.live.turnOf?.(sessionId) === m.id,
      ...this.counts(sessionId, m, f.end, end, f.nextSeq),
      compactions: f.compactions,
      error_id: ctx.byTurn().get(m.id) ?? f.errorId,
      other_branch: !this.onBranch(sessionId, ctx.head(), m, ctx.walk),
    });
  }

  // Whether a turn is on the branch shown: its start is an ancestor of the
  // session's head. The branch is walked from the head down only as far as
  // the oldest turn asked about, and kept: the next page goes on from there,
  // and a head that moved on along the same branch adds its few new events.
  // One page walks for a bounded time (`budget`): a turn the walk has not
  // reached yet is not said to be off the branch, and the next page (or the
  // page's next refresh) goes on from where this one stopped.
  private onBranch(sessionId: string, head: string | null, turn: { id: string; seq: number }, budget: { until: number }): boolean {
    if (!head) return true;
    // From the lowest event walked, up its parents, in one statement: until an
    // event at or under `to`, the end of the chain, or `max` events.
    const climb = this.store.db.query<{ id: string; seq: number; parent: string | null; kind: string; n: number; last: number }, [string, number, string | null, number, number, string]>(
      `WITH RECURSIVE up(id, seq, parent, kind, n) AS (
         SELECT ?1, ?2, ?3, '', 0
         UNION ALL SELECT e.id, e.seq, e.parent, e.kind, up.n + 1 FROM up JOIN events e ON e.id = up.parent
           WHERE up.seq > ?4 AND up.n < ?5 AND +e.session_id = ?6 AND +e.seq < up.seq)
       SELECT * FROM (SELECT id, seq, parent, kind, n, MAX(n) OVER () AS last FROM up) WHERE n > 0 AND (kind = 'turn_start' OR n = last)`);
    const walk = (c: Line, to: number) => {
      while (!c.done && c.low.seq > to && performance.now() < budget.until) {
        const got = climb.all(c.low.id, c.low.seq, c.low.parent, to, WALK_PART, sessionId);
        const last = got.at(-1);
        for (const e of got) if (e.kind === "turn_start") c.turns.add(e.id);
        if (last) c.low = { id: last.id, seq: last.seq, parent: last.parent };
        // It stopped above `to` with events to spare: the chain ends here.
        if (c.low.seq > to && (last?.n ?? 0) < WALK_PART) c.done = true;
      }
    };
    const one = this.store.db.query<{ id: string; seq: number; parent: string | null; kind: string; session_id: string }, [string]>("SELECT id, seq, parent, kind, session_id FROM events WHERE id = ?");
    let c = this.lines.get(sessionId);
    if (!c || c.head !== head) {
      const h = one.get(head);
      if (!h || h.session_id !== sessionId) return true;
      const fresh: Line = { head, top: h.seq, low: h, turns: new Set(h.kind === "turn_start" ? [h.id] : []), done: false };
      const old = c;
      if (old) {
        // Down to where the old head was: reaching it means the same branch, longer.
        walk(fresh, old.top);
        if (fresh.low.id === old.head) {
          for (const t of old.turns) fresh.turns.add(t);
          fresh.low = old.low;
          fresh.done = old.done;
        }
      }
      c = fresh;
      this.lines.delete(sessionId);
      this.lines.set(sessionId, c);
      if (this.lines.size > LINES_KEPT) this.lines.delete(this.lines.keys().next().value!);
    }
    walk(c, turn.seq);
    return c.turns.has(turn.id) || (!c.done && c.low.seq > turn.seq);
  }

  // The turn a mark belongs to: the newest turn_start before it, when that
  // turn had not ended by then (a note between turns belongs to none).
  private turnAround(sessionId: string, m: Cursor): string | undefined {
    const start = this.prev(sessionId, "turn_start", m);
    if (!start) return undefined;
    const end = this.prev(sessionId, "turn_end", m);
    return end && (end.ts > start.ts || (end.ts === start.ts && end.id > start.id)) ? undefined : start.id;
  }

  // The session's kinds of failure by the turn each last happened in.
  private errorsByTurn(sessionId: string): Map<string, string> {
    const rows = this.store.db.query<{ id: string; turn_event: string }, [string]>("SELECT id, turn_event FROM errors WHERE session_id = ? AND turn_event IS NOT NULL ORDER BY ts DESC LIMIT 2000").all(sessionId);
    const out = new Map<string, string>();
    for (const r of rows) if (!out.has(r.turn_event)) out.set(r.turn_event, r.id);
    return out;
  }

  // --- agents, waits, loops and approvals, as the activity list recorded them
  private lookups(): Lookups {
    const db = this.store.db;
    const one = <T>(table: string, sql: string) => {
      const seen = new Map<string, T | undefined>();
      return (id: string) => {
        if (!this.table(table)) return undefined;
        if (!seen.has(id)) seen.set(id, db.query<T, [string]>(sql).get(id) ?? undefined);
        return seen.get(id);
      };
    };
    const approval = one<{ data: string }>("approvals", "SELECT data FROM approvals WHERE id = ?");
    return {
      agent: one("agents", "SELECT session_id, title, type, status, created, ended, stopped_by, end_reason FROM agents WHERE id = ?"),
      wait: one("waits", "SELECT kind, status, created, deadline, ended FROM waits WHERE id = ?"),
      loop: one("loops", "SELECT name FROM loops WHERE id = ?"),
      approval: (id) => {
        const r = approval(id);
        if (!r) return undefined;
        const a = JSON.parse(r.data);
        return { tool: a.tool, risk: a.risk, state: a.state, choice: a.choice, created: a.created, resolved: a.resolved };
      },
    };
  }

  // An agent's happenings are stored under its parent, with the agent named:
  // the agent's own timeline reads them from there, within the agent's lifetime.
  private activity(sessionId: string, at: Cursor, n: number, agentsOnly: boolean, since: number, look: Lookups, fold: boolean): TimelineRow[] {
    if (!this.table("activity")) return [];
    const kinds = agentsOnly ? `${TOLD} AND kind = 'agent'` : TOLD;
    const self = this.table("agents") ? this.store.db.query<{ parent_id: string | null; created: number }, [string]>("SELECT parent_id, created FROM sessions WHERE id = ?").get(sessionId) : undefined;
    const under = self?.parent_id ?? sessionId;
    const own = under !== sessionId;
    const q = this.store.db.query<ActivityIn & { data: string | null }, [string, number, number, string, string | null, number]>(
      `SELECT id, ts, kind, sub, text, data, turn_event FROM activity INDEXED BY ${TOLD_IX} WHERE session_id = ? AND ts >= ? AND (ts, id) < (?, ?) AND ${kinds}
         AND (?5 IS NULL OR data ->> '$.child_session' = ?5) ORDER BY ts DESC, id DESC LIMIT ?6`);
    if (own) since = Math.max(since, self!.created);
    const out: TimelineRow[] = [];
    for (let cur = at; out.length < n;) {
      const got = q.all(under, since, cur.ts, cur.id, own ? sessionId : null, n + 8);
      for (const a of got) {
        const data = a.data ? JSON.parse(a.data) : null;
        if (fold && !own && this.folded(sessionId, a, data)) continue;
        const row = activityRow({ ...a, data }, look, own);
        if (row) out.push(row);
        if (out.length === n) break;
      }
      if (got.length < n + 8) break;
      const last = got.at(-1)!;
      cur = { ts: last.ts, id: last.id };
    }
    return out;
  }

  // A wait that fired or an agent that reported, when that wake is the prompt
  // of the turn that started next: the turn's row says it ("Wait wake (a
  // timer, after 3 s)", "Agent report from ..."), so it is one row, not two.
  // The same answer on every page: it is read off the turn, not off what else is on the page.
  private folded(sessionId: string, a: { ts: number; kind: string; sub: string }, data: Record<string, any> | null): boolean {
    const wait = a.kind === "wait" && a.sub === "fired" ? data?.wait_id : undefined;
    const agent = a.kind === "agent" && a.sub === "completed" ? data?.agent_id : undefined;
    if (!wait && !agent) return false;
    const next = this.store.db.query<{ parent: string | null }, [string, number]>(
      `SELECT parent FROM events INDEXED BY ${TURN_IX} WHERE session_id = ? AND ${TURN} AND kind = 'turn_start' AND ts >= ? ORDER BY ts, id LIMIT 1`).get(sessionId, a.ts);
    if (!next) return false;
    const o = this.opener(sessionId, next.parent);
    return wait ? o?.kind === "wait" && o.outcome === "fired" && o.wait_id === wait : o?.kind === "subagent" && o.status === "completed" && o.agent_id === agent;
  }

  // --- what failed. A failed model request is told from the session's own
  // record (one row a cause, counted for this session and its agents, kept
  // whatever happens elsewhere). The errors table folds a kind of failure
  // across every session and keeps only where it last happened: its rows are
  // shown for what the record does not hold (a daemon or page failure, a
  // session from before the record), and as the way into the Errors panel.
  private errors(sessionId: string, at: Cursor, n: number, since: number, ctx: Ctx): TimelineRow[] {
    const db = this.store.db;
    const mine = db.query<ErrorLite, [string, number, number, string, number]>(
      "SELECT id, ts, source, message, count, turn_event, span_id, resolved_ts FROM errors WHERE session_id = ? AND ts >= ? AND (ts, id) < (?, ?) ORDER BY ts DESC, id DESC LIMIT ?");
    const c = ctx.causes();
    if (!c) return mine.all(sessionId, since, at.ts, at.id, n).map((e) => errorRow(lite(e)));
    const groups = db.query<{ fp: string; cls: string; count: number; last_ts: number; refs: string }, [string, number, number, string, number]>(
      "SELECT fp, cls, count, last_ts, refs FROM session_failures WHERE session_id = ? AND kind = 'provider' AND last_ts >= ? AND (last_ts, 'f:' || fp) < (?, ?) ORDER BY last_ts DESC, fp DESC LIMIT ?")
      .all(sessionId, since, at.ts, at.id, n)
      .map((g) => failureRow({ ...g, refs: JSON.parse(g.refs) }, c.links.get(g.cls)));
    const rest = mine.all(sessionId, since, at.ts, at.id, n)
      .filter((e) => !(e.source === "provider" && c.classes.has(errorClass({ message: e.message }) ?? "")))
      .map((e) => errorRow(lite(e)));
    return [...groups, ...rest];
  }

  // The causes the session's failure record holds, by class, and the Errors
  // row of each class that last happened here. Null: no record is kept.
  private causes(sessionId: string): { classes: Set<string>; links: Map<string, ErrorLite> } | null {
    if (!this.table("session_failures")) return null;
    const db = this.store.db;
    const classes = new Set(db.query<{ cls: string }, [string]>("SELECT DISTINCT cls FROM session_failures WHERE session_id = ? AND kind = 'provider'").all(sessionId).map((r) => r.cls));
    const links = new Map<string, ErrorLite>();
    if (classes.size) {
      for (const e of db.query<ErrorLite, [string]>("SELECT id, ts, source, message, count, turn_event, span_id, resolved_ts FROM errors WHERE session_id = ? AND source = 'provider' ORDER BY ts DESC LIMIT 500").all(sessionId)) {
        const cls = errorClass({ message: e.message });
        if (cls && !links.has(cls)) links.set(cls, lite(e));
      }
    }
    return { classes, links };
  }

  // --- what it is doing and waiting on now
  now(sessionId: string) {
    const db = this.store.db;
    const live = this.live;
    const ts = Date.now();
    const lastStart = this.prev(sessionId, "turn_start");
    const running = live.turnOf?.(sessionId);
    let turn: NowInput["turn"] = null;
    let last: NowInput["last"] = null;
    let held: NowInput["held"] = null;
    if (lastStart) {
      const f = this.after(sessionId, lastStart);
      if (!f.end && running === lastStart.id) {
        turn = { id: lastStart.id, ts: lastStart.ts, opener: this.opener(sessionId, lastStart.parent), steps: this.steps(sessionId, lastStart), status: live.statusOf?.(sessionId) ?? { kind: "idle" } };
      } else if (f.end) {
        const end = JSON.parse(f.end.data ?? "{}");
        const reason = String(end.reason ?? "error");
        last = { ts: f.end.ts, outcome: outcomeOf(reason, end.stopped_by) };
        // Cut and not continued: the session says why in a note, and waits.
        if (reason === "restart" && !live.isRunning?.(sessionId)) {
          // It is written at the start that found the turn cut: among the first marks after the end.
          const note = db.query<{ id: string; ts: number }, [string, number, string]>(
            `SELECT id, ts FROM (SELECT id, ts, kind, data ->> '$.kind' AS k FROM events INDEXED BY ${ROWS_IX}
               WHERE session_id = ? AND ${ROWS} AND (ts, id) > (?, ?) ORDER BY ts, id LIMIT ${NEAR}) WHERE kind = 'note' AND k = 'restart' LIMIT 1`).get(sessionId, f.end.ts, f.end.id);
          if (note) held = { since: note.ts, note_id: note.id };
        }
      }
    }
    const agents = this.table("agents")
      ? db.query<NowInput["agents"][number], [string]>("SELECT id, session_id, title, status, created FROM agents WHERE parent_id = ? AND status IN ('running', 'waiting') ORDER BY created").all(sessionId)
      : [];
    const children = new Map(agents.map((a) => [a.session_id, a.title]));
    const approvals: NowInput["approvals"] = [];
    if (this.table("approvals")) {
      const q = db.query<{ data: string }, [string]>("SELECT data FROM approvals WHERE session_id = ? AND state = 'pending' ORDER BY created, id");
      for (const sid of [sessionId, ...children.keys()]) {
        for (const r of q.all(sid)) {
          const a = JSON.parse(r.data);
          approvals.push({ id: a.id, call_id: a.call_id, tool: a.tool, risk: a.risk, created: a.created, ...(sid === sessionId ? {} : { child_session: sid, child_title: children.get(sid) }) });
        }
      }
    }
    const questions = (live.questions?.() ?? [])
      .filter((p) => p.session_id === sessionId || children.has(p.session_id))
      .map((p) => ({ call_id: p.call_id, ...(p.session_id === sessionId ? {} : { child_session: p.session_id, child_title: children.get(p.session_id) }) }));
    const waits = this.table("waits")
      ? db.query<NowInput["waits"][number], [string]>("SELECT id, kind, created, deadline FROM waits WHERE status = 'active' AND session_id = ? ORDER BY created").all(sessionId)
      : [];
    const queued = db.query<{ steer: number; n: number }, [string]>("SELECT steer, COUNT(*) AS n FROM queue WHERE session_id = ? GROUP BY steer").all(sessionId);
    const loops = this.table("loops")
      ? db.query<NowInput["loops"][number], [string, number]>("SELECT id, name, next_ms FROM loops WHERE session_id = ? AND enabled = 1 AND next_ms IS NOT NULL AND next_ms > ? ORDER BY next_ms LIMIT 3").all(sessionId, ts - 60_000)
      : [];
    return nowLines({
      ts, turn, last, held, approvals, questions, waits, agents, loops,
      // A turn the engine has taken up and not opened yet: its system prompt, its model, its first event.
      starting: !turn && !!live.isRunning?.(sessionId),
      queue: { queued: queued.find((r) => !r.steer)?.n ?? 0, steers: queued.find((r) => r.steer)?.n ?? 0, held: !!live.isHeld?.(sessionId), owed: !!live.owed?.(sessionId) },
    });
  }
}

const lite = (e: ErrorLite): ErrorLite => ({ ...e, turn_event: e.turn_event ?? undefined, span_id: e.span_id ?? undefined, resolved_ts: e.resolved_ts ?? undefined });

// "1h", "30m", "2d", "90s", or a time in epoch milliseconds or ISO form.
export function parseSince(v: string, now = Date.now()): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(v.trim());
  if (m) return now - Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  const n = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) throw Object.assign(new Error("since is a span back from now (90s, 30m, 1h, 2d), epoch milliseconds or an ISO time"), { status: 400 });
  return n;
}
