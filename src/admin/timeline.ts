// A session's story from one place: its turns (who started each, how it ended,
// what it took), the agents it started and how each ended, waits set and
// fired, loop runs, compactions, model switches, daemon restarts, approvals
// and errors, newest first, and what it is doing and waiting on now.
//
// Read only, and a page at a time: the marks of a session's events come from
// a small partial index (never the session's whole history), the rest from
// the activity list, the session's failure record and the errors table by
// their session indexes, and each row's facts from the records its ids name.
// Nothing here parses a prompt or a tool result into the answer: see
// timeline-rows.ts for what a row may say.
import type { Store } from "../core/store.ts";
import type { ErrorRecord, TurnStatus } from "../core/types.ts";
import { errorClass } from "./classes.ts";
import {
  activityRow, errorRow, failureRow, isFailure, markRow, nowLines, outcomeOf, turnRow,
  type ActivityIn, type Lookups, type NowInput, type Opener, type TimelinePage, type TimelineRow,
} from "./timeline-rows.ts";

// The event kinds that mark the story. The index holds only these, so a
// session of tens of thousands of events is read at the speed of its turns.
const MARKS = "('turn_start', 'turn_end', 'compaction', 'note', 'error')";
const SCHEMA = `
CREATE INDEX IF NOT EXISTS events_marks ON events(session_id, ts, id) WHERE kind IN ${MARKS};
CREATE INDEX IF NOT EXISTS errors_session ON errors(session_id, ts);
`;
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
  }

  // Tables of other modules are read when the daemon made them. Only a yes is
  // kept: a table made after the first look is found at the next one.
  private table(name: string): boolean {
    if (this.has.has(name)) return true;
    const there = !!this.store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (there) this.has.add(name);
    return there;
  }

  page(sessionId: string, opts: PageOpts = {}): TimelinePage {
    const as_of = Date.now();
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? PAGE), 1), PAGE_MAX);
    const since = opts.since ?? 0;
    const now = opts.now === false ? undefined : this.now(sessionId);
    // What "now" already says is not said again as a row: the running turn
    // and a card still open are there, with how long they have been.
    const told = new Set((now?.lines ?? []).flatMap((l) => [l.kind === "turn" ? l.turn_event : undefined, l.kind === "approval" ? l.refs?.approval_id : undefined]).filter(Boolean));
    const shown = (r: TimelineRow) => !(r.open && ((r.kind === "turn" && told.has(r.id)) || (r.kind === "approval" && told.has(r.refs?.approval_id))));
    let at = parseCursor(opts.before) ?? TOP;
    const rows: TimelineRow[] = [];
    let next: string | null = null;
    let scanned = 0;
    // A filter may drop most of what is read: read on, up to a bound, and say
    // where the next page starts whether or not this one is full.
    for (;;) {
      const got = this.merged(sessionId, at, limit + 1, opts.only ?? null, since);
      const part = got.slice(0, limit);
      let taken = 0;
      for (const r of part) {
        at = { ts: r.ts, id: r.id };
        taken++;
        if ((opts.only !== "failures" || isFailure(r)) && shown(r)) rows.push(r);
        if (rows.length === limit) break;
      }
      scanned += taken;
      if (!(got.length > limit || taken < part.length)) break;
      if (rows.length === limit || scanned >= SCAN_MAX) { next = `${at.ts}:${at.id}`; break; }
    }
    return { session_id: sessionId, as_of, ...(now ? { now } : {}), rows, next, ...(opts.only === "failures" ? { scanned } : {}) };
  }

  // The sources, each already newest first, as one list.
  private merged(sessionId: string, at: Cursor, n: number, only: Only | null, since: number): TimelineRow[] {
    const all = [
      ...(only === "agents" ? [] : this.marks(sessionId, at, n, only === "turns", since)),
      ...(only === "turns" ? [] : this.activity(sessionId, at, n, only === "agents", since)),
      ...(only === "turns" || only === "agents" ? [] : this.errors(sessionId, at, n, since)),
    ];
    all.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return all.slice(0, n);
  }

  // --- turns and the other marks of the event tree
  private marks(sessionId: string, at: Cursor, n: number, turnsOnly: boolean, since: number): TimelineRow[] {
    const q = this.store.db.query<MarkRow, [string, number, number, string, number]>(
      `SELECT id, ts, seq, kind, parent, ${PICK} AS data FROM events
       WHERE session_id = ? AND kind IN ${MARKS} AND kind IN (${turnsOnly ? "'turn_start'" : "'turn_start', 'compaction', 'note'"}) AND ts >= ? AND (ts, id) < (?, ?)
       ORDER BY ts DESC, id DESC LIMIT ?`);
    const out: TimelineRow[] = [];
    const byTurn = this.errorsByTurn(sessionId);
    const head = this.store.db.query<{ head: string | null }, [string]>("SELECT head FROM sessions WHERE id = ?").get(sessionId)?.head ?? null;
    for (let cur = at; out.length < n;) {
      const got = q.all(sessionId, since, cur.ts, cur.id, n + 8);
      for (const m of got) {
        const row = m.kind === "turn_start" ? this.turn(sessionId, m, byTurn, head) : markRow({ id: m.id, ts: m.ts, kind: m.kind, data: m.data ? JSON.parse(m.data) : null }, this.turnAround(sessionId, m));
        if (row) out.push(row);
        if (out.length === n) break;
      }
      if (got.length < n + 8) break;
      const last = got.at(-1)!;
      cur = { ts: last.ts, id: last.id };
    }
    return out;
  }

  // The marks after a turn's start, up to its end (or the next turn's start).
  private after(sessionId: string, start: { ts: number; id: string }): { end?: MarkRow; errorId?: string; compactions: number; nextSeq?: number } {
    const q = this.store.db.query<MarkRow, [string, number, string]>(
      `SELECT id, ts, seq, kind, parent, ${PICK} AS data FROM events
       WHERE session_id = ? AND kind IN ${MARKS} AND (ts, id) > (?, ?) ORDER BY ts, id LIMIT 16`);
    let end: MarkRow | undefined, errorId: string | undefined, compactions = 0, nextSeq: number | undefined;
    for (let cur = start, rounds = 0; rounds < 16; rounds++) {
      const got = q.all(sessionId, cur.ts, cur.id);
      for (const m of got) {
        if (m.kind === "turn_start") return { end, errorId, compactions, nextSeq: m.seq };
        if (m.kind === "turn_end") end ??= m;
        else if (m.kind === "compaction" && !end) compactions++;
        // A turn that threw: its error event follows its end and names the error.
        else if (m.kind === "error") errorId ??= JSON.parse(m.data ?? "{}").error_id ?? undefined;
      }
      if (got.length < 16) break;
      const last = got.at(-1)!;
      cur = { ts: last.ts, id: last.id };
    }
    return { end, errorId, compactions, nextSeq };
  }

  // The prompt a turn answers: the event before its start, past the notes and
  // checkpoints between. Only what says who sent it is read off it.
  private opener(sessionId: string, parent: string | null): Opener {
    const q = this.store.db.query<{ kind: string; parent: string | null; session_id: string; o: string | null }, [string]>(
      `SELECT kind, parent, session_id, CASE WHEN kind = 'user' THEN json_object('origin', data ->> '$.origin', 'kind', data ->> '$.kind', 'queue_id', data ->> '$.queue_id',
         'wait_id', data ->> '$.wait_id', 'agent_id', data ->> '$.agent_id', 'loop_id', data ->> '$.loop_id', 'run_id', data ->> '$.run_id', 'from', data ->> '$.from') END AS o
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

  // What a turn took: the replies the model gave and its tool results. Its
  // end says so (the engine counts as it goes); a turn from before that, or
  // one cut without an end of its own, is counted from its events and its
  // telemetry row; a running turn from what ran so far.
  private counts(sessionId: string, start: MarkRow, end: MarkRow | undefined, said: Record<string, any> | null, nextSeq: number | undefined) {
    const num = (v: unknown) => (typeof v === "number" && v >= 0 ? v : undefined);
    if (said && num(said.steps) !== undefined && num(said.tools) !== undefined) return { steps: said.steps as number, tools: said.tools as number, failed_tools: num(said.tool_errors) ?? 0 };
    const db = this.store.db;
    const to = end?.seq ?? nextSeq ?? Number.MAX_SAFE_INTEGER;
    const steps = db.query<{ n: number }, [string, number, number]>("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND seq > ? AND seq < ? AND kind = 'assistant'").get(sessionId, start.seq, to)!.n;
    const told = end ? this.rollup(start.id) : undefined;
    if (told) return { steps, tools: told.tool_calls, failed_tools: told.tool_errors };
    if (!this.table("telemetry_tools")) return { steps, tools: 0, failed_tools: 0 };
    const t = db.query<{ n: number; bad: number | null }, [number, number, string]>("SELECT COUNT(*) AS n, SUM(is_error) AS bad FROM telemetry_tools WHERE ts >= ? AND ts <= ? AND session_id = ?")
      .get(start.ts, end?.ts ?? Number.MAX_SAFE_INTEGER, sessionId)!;
    return { steps, tools: t.n, failed_tools: t.bad ?? 0 };
  }

  // The turn's telemetry row: all its requests (its own, a reader's, a
  // summary's) and tool runs, joined by the turn's id.
  private rollup(turnEvent: string) {
    if (!this.table("telemetry_turns")) return undefined;
    return this.store.db.query<{ tool_calls: number; tool_errors: number; requests: number; input: number; output: number; cache_read: number; cost: number | null }, [string]>(
      "SELECT tool_calls, tool_errors, requests, input, output, cache_read, cost FROM telemetry_turns WHERE turn_event = ?").get(turnEvent) ?? undefined;
  }

  private turn(sessionId: string, m: MarkRow, byTurn: Map<string, string>, head: string | null): TimelineRow {
    const f = this.after(sessionId, m);
    const end = f.end ? JSON.parse(f.end.data ?? "{}") : null;
    // What it spent, over every request made while it ran; a turn with no
    // such row (it is from before the table, or no request was recorded)
    // says what its end summed, which is its own steps only.
    const roll = f.end ? this.rollup(m.id) : undefined;
    return turnRow({
      start: { id: m.id, ts: m.ts, model: JSON.parse(m.data ?? "{}").model },
      opener: this.opener(sessionId, m.parent),
      end: end && { reason: String(end.reason ?? "error"), ms: typeof end.ms === "number" ? end.ms : undefined, ts: f.end!.ts, stopped_by: end.stopped_by, crashed: !!end.crashed, unstarted: !!end.unstarted },
      usage: roll && roll.requests > 0 ? roll : end?.usage,
      running: !f.end && this.live.turnOf?.(sessionId) === m.id,
      ...this.counts(sessionId, m, f.end, end, f.nextSeq),
      compactions: f.compactions,
      error_id: byTurn.get(m.id) ?? f.errorId,
      other_branch: !this.onBranch(sessionId, head, m),
    });
  }

  // Whether a turn is on the branch shown: its start is an ancestor of the
  // session's head. The branch is walked from the head down only as far as
  // the oldest turn asked about, and kept: the next page goes on from there,
  // and a head that moved on along the same branch adds its few new events.
  private onBranch(sessionId: string, head: string | null, turn: { id: string; seq: number }): boolean {
    if (!head) return true;
    const step = this.store.db.query<{ id: string; seq: number; parent: string | null; kind: string; session_id: string }, [string]>("SELECT id, seq, parent, kind, session_id FROM events WHERE id = ?");
    const walk = (c: Line, until: (c: Line) => boolean) => {
      while (!c.done && !until(c)) {
        const p = c.low.parent ? step.get(c.low.parent) : undefined;
        if (!p || p.session_id !== sessionId || p.seq >= c.low.seq) { c.done = true; break; }
        if (p.kind === "turn_start") c.turns.add(p.id);
        c.low = p;
      }
    };
    let c = this.lines.get(sessionId);
    if (!c || c.head !== head) {
      const h = step.get(head);
      if (!h || h.session_id !== sessionId) return true;
      const fresh: Line = { head, top: h.seq, low: h, turns: new Set(h.kind === "turn_start" ? [h.id] : []), done: false };
      const old = c;
      if (old) {
        // Down to where the old head was: reaching it means the same branch, longer.
        walk(fresh, (l) => l.low.seq <= old.top);
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
    walk(c, (l) => l.low.seq <= turn.seq);
    return c.turns.has(turn.id);
  }

  // The turn a mark belongs to: the newest turn_start before it, when that
  // turn had not ended by then (a note between turns belongs to none).
  private turnAround(sessionId: string, m: { ts: number; id: string }): string | undefined {
    const prev = this.store.db.query<{ id: string; kind: string }, [string, number, string]>(
      `SELECT id, kind FROM events WHERE session_id = ? AND kind IN ${MARKS} AND kind IN ('turn_start', 'turn_end') AND (ts, id) < (?, ?) ORDER BY ts DESC, id DESC LIMIT 1`).get(sessionId, m.ts, m.id);
    return prev?.kind === "turn_start" ? prev.id : undefined;
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
  private activity(sessionId: string, at: Cursor, n: number, agentsOnly: boolean, since: number): TimelineRow[] {
    if (!this.table("activity")) return [];
    const kinds = agentsOnly ? "kind = 'agent'"
      : "(kind IN ('agent', 'wait', 'loop', 'approval') OR (kind = 'turn' AND sub = 'goal') OR (kind = 'alert' AND sub IN ('approval', 'question', 'limit')))";
    const self = this.table("agents") ? this.store.db.query<{ parent_id: string | null; created: number }, [string]>("SELECT parent_id, created FROM sessions WHERE id = ?").get(sessionId) : undefined;
    const under = self?.parent_id ?? sessionId;
    const own = under !== sessionId;
    const q = this.store.db.query<ActivityIn & { data: string | null }, [string, number, number, string, string | null, number]>(
      `SELECT id, ts, kind, sub, text, data, turn_event FROM activity WHERE session_id = ? AND ts >= ? AND (ts, id) < (?, ?) AND ${kinds}
         AND (?5 IS NULL OR data ->> '$.child_session' = ?5) ORDER BY ts DESC, id DESC LIMIT ?6`);
    if (own) since = Math.max(since, self!.created);
    const look = this.lookups();
    const out: TimelineRow[] = [];
    for (let cur = at; out.length < n;) {
      const got = q.all(under, since, cur.ts, cur.id, own ? sessionId : null, n + 8);
      for (const a of got) {
        const row = activityRow({ ...a, data: a.data ? JSON.parse(a.data) : null }, look, own);
        if (row) out.push(row);
        if (out.length === n) break;
      }
      if (got.length < n + 8) break;
      const last = got.at(-1)!;
      cur = { ts: last.ts, id: last.id };
    }
    return out;
  }

  // --- what failed. A failed model request is told from the session's own
  // record (one row a cause, counted for this session and its agents, kept
  // whatever happens elsewhere). The errors table folds a kind of failure
  // across every session and keeps only where it last happened: its rows are
  // shown for what the record does not hold (a daemon or page failure, a
  // session from before the record), and as the way into the Errors panel.
  private errors(sessionId: string, at: Cursor, n: number, since: number): TimelineRow[] {
    const db = this.store.db;
    const mine = db.query<ErrorLite, [string, number, number, string, number]>(
      "SELECT id, ts, source, message, count, turn_event, span_id, resolved_ts FROM errors WHERE session_id = ? AND ts >= ? AND (ts, id) < (?, ?) ORDER BY ts DESC, id DESC LIMIT ?");
    const lite = (e: ErrorLite): ErrorLite => ({ ...e, turn_event: e.turn_event ?? undefined, span_id: e.span_id ?? undefined, resolved_ts: e.resolved_ts ?? undefined });
    if (!this.table("session_failures")) return mine.all(sessionId, since, at.ts, at.id, n).map((e) => errorRow(lite(e)));
    // The causes the record holds, by class, and the Errors row of each class that last happened here.
    const classes = new Set(db.query<{ cls: string }, [string]>("SELECT DISTINCT cls FROM session_failures WHERE session_id = ? AND kind = 'provider'").all(sessionId).map((r) => r.cls));
    const links = new Map<string, ErrorLite>();
    if (classes.size) {
      for (const e of db.query<ErrorLite, [string]>("SELECT id, ts, source, message, count, turn_event, span_id, resolved_ts FROM errors WHERE session_id = ? AND source = 'provider' ORDER BY ts DESC LIMIT 500").all(sessionId)) {
        const cls = errorClass({ message: e.message });
        if (cls && !links.has(cls)) links.set(cls, lite(e));
      }
    }
    const groups = db.query<{ fp: string; cls: string; count: number; last_ts: number; refs: string }, [string, number, number, string, number]>(
      "SELECT fp, cls, count, last_ts, refs FROM session_failures WHERE session_id = ? AND kind = 'provider' AND last_ts >= ? AND (last_ts, 'f:' || fp) < (?, ?) ORDER BY last_ts DESC, fp DESC LIMIT ?")
      .all(sessionId, since, at.ts, at.id, n)
      .map((g) => failureRow({ ...g, refs: JSON.parse(g.refs) }, links.get(g.cls)));
    const rest = mine.all(sessionId, since, at.ts, at.id, n)
      .filter((e) => !(e.source === "provider" && classes.has(errorClass({ message: e.message }) ?? "")))
      .map((e) => errorRow(lite(e)));
    return [...groups, ...rest];
  }

  // --- what it is doing and waiting on now
  now(sessionId: string) {
    const db = this.store.db;
    const live = this.live;
    const ts = Date.now();
    const lastStart = db.query<MarkRow, [string]>(
      `SELECT id, ts, seq, kind, parent, ${PICK} AS data FROM events WHERE session_id = ? AND kind IN ${MARKS} AND kind = 'turn_start' ORDER BY ts DESC, id DESC LIMIT 1`).get(sessionId);
    const running = live.turnOf?.(sessionId);
    let turn: NowInput["turn"] = null;
    let last: NowInput["last"] = null;
    let held: NowInput["held"] = null;
    if (lastStart) {
      const f = this.after(sessionId, lastStart);
      if (!f.end && running === lastStart.id) {
        turn = { id: lastStart.id, ts: lastStart.ts, opener: this.opener(sessionId, lastStart.parent), steps: this.counts(sessionId, lastStart, undefined, null, undefined).steps, status: live.statusOf?.(sessionId) ?? { kind: "idle" } };
      } else if (f.end) {
        const end = JSON.parse(f.end.data ?? "{}");
        const reason = String(end.reason ?? "error");
        last = { ts: f.end.ts, outcome: outcomeOf(reason, end.stopped_by) };
        // Cut and not continued: the session says why in a note, and waits.
        if (reason === "restart" && !live.isRunning?.(sessionId)) {
          const note = db.query<{ ts: number }, [string, number, string]>(
            `SELECT ts FROM events WHERE session_id = ? AND kind IN ${MARKS} AND kind = 'note' AND (ts, id) > (?, ?) AND data ->> '$.kind' = 'restart' ORDER BY ts, id LIMIT 1`).get(sessionId, f.end.ts, f.end.id);
          if (note) held = { since: note.ts };
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

// "1h", "30m", "2d", "90s", or a time in epoch milliseconds or ISO form.
export function parseSince(v: string, now = Date.now()): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(v.trim());
  if (m) return now - Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  const n = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) throw Object.assign(new Error("since is a span back from now (90s, 30m, 1h, 2d), epoch milliseconds or an ISO time"), { status: 400 });
  return n;
}
