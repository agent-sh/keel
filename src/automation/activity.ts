import { localDay, zoned } from "../core/clock.ts";
import { saidOf } from "./activity-words.ts";
import { D, capture, clip, cursor, emit } from "./core.ts";

export { saidOf };

// The activity list: everything the daemon and its sessions did, across
// sessions, newest first. One row per happening (an alert, a turn's end, an
// agent started or settled, a loop run or a run that did not happen, a wait
// that fired, an approval answered, a keep-awake hold, a snooze, a daemon
// restart with the turns it cut, a correction sent to the memory store). Kept 30 days:
// older rows are never listed, and an hourly sweep deletes them.

export type ActivityKind = "alert" | "turn" | "agent" | "loop" | "wait" | "approval" | "awake" | "snooze" | "daemon" | "memory";
export const ACTIVITY_KINDS: ActivityKind[] = ["alert", "turn", "agent", "loop", "wait", "approval", "awake", "snooze", "daemon", "memory"];
// `turn_event`: the turn_start event of the turn it happened in, in the session
// it is listed under (absent between turns), so the row opens that turn's receipt.
// `said`: on a turn's row, what the alert its end raised said (one row a turn). `more`: on the last row shown of a
// session in a list across sessions, how many more rows that session has.
export type Activity = { id: string; ts: number; kind: ActivityKind; sub: string; session_id: string | null; text: string; data?: any; turn_event?: string | null; said?: string; more?: number };

export const KEEP_MS = 30 * 86400_000;
export const prune = () => D().store.db.query("DELETE FROM activity WHERE ts < ?").run(Date.now() - KEEP_MS);

export function migrate() {
  D().store.migrate(`
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  sub TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  text TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts DESC);
CREATE INDEX IF NOT EXISTS activity_session ON activity(session_id, ts DESC);`);
  if (!D().store.columnExists("activity", "turn_event")) D().store.migrate("ALTER TABLE activity ADD COLUMN turn_event TEXT");
  // A turn's row and the alert its end raised are found by the turn (one row a turn in the list).
  D().store.migrate("CREATE INDEX IF NOT EXISTS activity_turn ON activity(turn_event)");
  // The list across sessions holds a session to its newest rows: each session's rows, newest first, are read in this order.
  D().store.migrate("CREATE INDEX IF NOT EXISTS activity_group ON activity(COALESCE(session_id, kind), ts DESC, id DESC)");
  prune();
  const g = globalThis as { __keelActivitySweep?: ReturnType<typeof setInterval> };
  clearInterval(g.__keelActivitySweep);
  g.__keelActivitySweep = setInterval(() => { try { prune(); } catch (e) { capture(e, { at: "activity sweep" }); } }, 3600_000);
}

// The turn that just ended in a session, while what its end sets off is
// written (a loop run's outcome, the alert that it finished): by then no turn
// runs there, or the next one already does.
const ended = new Map<string, string>();
export function ofTurn<T>(sessionId: string, turn: string | undefined, f: () => T): T {
  if (!turn) return f();
  ended.set(sessionId, turn);
  try { return f(); } finally { ended.delete(sessionId); }
}

// `turn`: the turn it belongs to when the caller knows (a turn's own end, told
// after the turn is over); otherwise the turn whose end is being settled
// (ofTurn), else the turn running now in the session the row is listed under.
// A later turn never changes it.
export function record(kind: ActivityKind, sub: string, sessionId: string | null, text: string, data?: unknown, turn?: string) {
  try {
    // A subagent's happenings are listed under its parent, with the child named.
    const s = sessionId ? D().store.session(sessionId) : undefined;
    const sid = s?.parent_id ?? sessionId;
    const running = (id: string | null) => (id ? ended.get(id) ?? D().engine?.turnOf?.(id) : undefined);
    const childTurn = s?.parent_id ? turn ?? running(sessionId) : undefined;
    const extra = s?.parent_id ? { ...(data as object), child_session: sessionId, child_title: s.title || undefined, ...(childTurn ? { child_turn: childTurn } : {}) } : data;
    const turnEvent = (s?.parent_id ? running(sid) : turn ?? running(sid)) ?? null;
    const a: Activity = { id: Bun.randomUUIDv7(), ts: Date.now(), kind, sub, session_id: sid, text: clip(text, 500), data: extra, turn_event: turnEvent };
    // (A row of the list: written with the next commit, src/core/side.ts. A reader of the list has it written first.)
    const store = D().store, json = extra === undefined ? null : JSON.stringify(extra);
    store.side.later("an activity row", () => void store.db.query("INSERT INTO activity (id, ts, kind, sub, session_id, text, data, turn_event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.ts, kind, sub, sid, a.text, json, turnEvent));
    emit("activity", a);
    return a;
  } catch (e) {
    capture(e, { at: "activity", kind });
  }
}

// Update the one outage row in place; never append a row per waiting session.
export function outageCount(id: string, sessions: number, text: string) {
  const r = D().store.db.query<Row, [string, number, string]>(`UPDATE activity SET text = ?1, data = json_set(data, '$.sessions', ?2)
    WHERE id = ?3 AND kind = 'daemon' AND sub = 'outage' AND json_extract(data, '$.sessions') < ?2 RETURNING *`).get(clip(text, 500), sessions, id);
  if (r) emit("activity", { ...r, data: JSON.parse(r.data!) });
}

type Row = Omit<Activity, "data" | "said" | "more"> & { data: string | null; said?: string | null; rn?: number; of_session?: number };
export function get(id: string): Activity | undefined {
  const r = D().store.db.query<Row, [string]>("SELECT * FROM activity WHERE id = ?").get(id);
  if (!r) return undefined;
  const { said: _, rn: _n, of_session: _o, ...row } = r;
  return { ...row, data: r.data ? JSON.parse(r.data) : undefined };
}

// What the list is asked for. `since`, `until`: a time range. `failures`: only
// what went wrong. `cap`: at most this many rows a session, the newest (a busy
// session does not fill the list; its last row shown says how many more it
// has), for a list across sessions.
export type ListOpts = { before?: string; limit?: number; kinds?: string[]; session_id?: string; q?: string; since?: number; until?: number; failures?: boolean; cap?: number };

// The alerts a turn's end raises (alerts.onTurnEnd): each is the same
// happening as the turn's own row, so the list shows one row a turn: the
// turn's, with what the alert said (`said`). Asked for alerts alone, the
// alerts are listed as they are.
const END_ALERTS = "'finished', 'failed', 'limit', 'declined'";
// Rows of kind "turn" that are not a turn's end.
const NOT_ENDS = "'goal', 'mcp', 'mcp-failed'";
// What went wrong, by kind: a turn that failed, was cut off or declined, a failed alert, agent, loop or wait, a
// tool call refused, a daemon that went down by itself, a memory correction that did not arrive.
const FAILED = `((kind = 'turn' AND sub IN ('error', 'max_tokens', 'refusal', 'mcp-failed')) OR (kind = 'alert' AND sub IN ('failed', 'limit', 'loop_failed', 'refused', 'regression', 'declined'))
  OR (kind IN ('agent', 'loop', 'wait') AND sub IN ('failed', 'incomplete')) OR (kind = 'approval' AND (sub LIKE 'refused%' OR sub = 'denied'))
  OR (kind = 'daemon' AND sub IN ('killed', 'crash')) OR (kind = 'memory' AND sub LIKE '%failed'))`;

// The statement and its arguments (run here, or on the read thread by the route).
export function listSql(opts: ListOpts, now = Date.now()): { sql: string; args: (string | number)[]; limit: number } {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 500);
  const where = ["a.ts >= ?"];
  const args: (string | number)[] = [Math.max(now - KEEP_MS, opts.since ?? 0)];
  if (opts.until !== undefined) { where.push("a.ts < ?"); args.push(opts.until); }
  if (opts.kinds?.length) {
    where.push(`a.kind IN (${opts.kinds.map(() => "?").join(", ")})`);
    args.push(...opts.kinds);
  }
  if (opts.session_id) { where.push("a.session_id = ?"); args.push(opts.session_id); }
  if (opts.q?.trim()) { where.push("a.text LIKE ? ESCAPE '\\'"); args.push(`%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  if (opts.failures) where.push(FAILED.replace(/\b(kind|sub)\b/g, "a.$1"));
  // One row a turn: the alert its end raised is folded into the turn's row, unless alerts alone are asked for
  // (or turns are filtered out, when the alert is the only row left of it).
  const fold = !opts.kinds?.length || (opts.kinds.includes("turn") && opts.kinds.includes("alert"));
  const turnsListed = !opts.kinds?.length || opts.kinds.includes("turn");
  // A turn's row and its alert are found by the turn (the index on turn_event): the session and the time
  // only confirm the pair (the + keeps the planner from walking a whole session's rows for each).
  const ended = (t: string, al: string) => `${t}.kind = 'turn' AND ${t}.sub NOT IN (${NOT_ENDS}) AND ${t}.turn_event = ${al}.turn_event AND +${t}.session_id IS +${al}.session_id AND +${t}.ts <= +${al}.ts`;
  if (fold) where.push(`NOT (a.kind = 'alert' AND a.sub IN (${END_ALERTS}) AND a.turn_event IS NOT NULL AND EXISTS (SELECT 1 FROM activity t WHERE ${ended("t", "a")}))`);
  const said = turnsListed
    ? `CASE WHEN a.kind = 'turn' AND a.turn_event IS NOT NULL AND a.sub NOT IN (${NOT_ENDS}) THEN (SELECT al.text FROM activity al WHERE al.kind = 'alert' AND al.sub IN (${END_ALERTS}) AND ${ended("a", "al")} ORDER BY +al.ts LIMIT 1) END`
    : "NULL";
  const c = cursor(opts.before);
  const cap = opts.cap && opts.cap > 0 && !opts.session_id ? Math.min(20, Math.floor(opts.cap)) : 0;
  const page = c ? "(ts < ? OR (ts = ? AND id < ?))" : "1 = 1";
  const pageArgs = c ? [c.ts, c.ts, c.id] : [];
  if (!cap) {
    return { sql: `SELECT a.*, ${said} AS said FROM activity a WHERE ${where.join(" AND ")} AND ${page.replace(/\b(ts|id)\b/g, "a.$1")} ORDER BY a.ts DESC, a.id DESC LIMIT ?`, args: [...args, ...pageArgs, limit + 1], limit };
  }
  // Rows with no session (the daemon's own: keep-awake holds, restarts) are capped by their kind.
  // Not a window over every row of the range: the groups are stepped through in the order of an
  // index (activity_group), each gives its newest `cap` rows by a seek, and the page is cut from
  // those. How many more a group has is counted only for a group whose last shown row is on the page.
  const group = "COALESCE(a.session_id, a.kind)";
  const filters = where.join(" AND ");
  const groups = "SELECT MIN(COALESCE(session_id, kind)) FROM activity UNION ALL SELECT (SELECT MIN(COALESCE(session_id, kind)) FROM activity WHERE COALESCE(session_id, kind) > g.v) FROM g WHERE g.v IS NOT NULL";
  const top = Array.from({ length: cap }, (_, n) => `SELECT g.v AS v, ${n + 1} AS rn, (SELECT a.id FROM activity a WHERE ${group} = g.v AND ${filters} ORDER BY a.ts DESC, a.id DESC LIMIT 1 OFFSET ${n}) AS id FROM g WHERE g.v IS NOT NULL`);
  return {
    sql: `WITH RECURSIVE g(v) AS (${groups}), top AS (${top.join(" UNION ALL ")}),
      p AS (SELECT t.id, t.rn, t.v FROM top t JOIN activity a ON a.id = t.id WHERE ${page.replace(/\b(ts|id)\b/g, "a.$1")} ORDER BY a.ts DESC, a.id DESC LIMIT ?)
      SELECT a.*, ${said} AS said, p.rn AS rn, CASE WHEN p.rn = ${cap} THEN (SELECT COUNT(*) FROM activity a WHERE ${group} = p.v AND ${filters}) END AS of_session
      FROM p JOIN activity a ON a.id = p.id ORDER BY a.ts DESC, a.id DESC`,
    args: [...Array.from({ length: cap }, () => args).flat(), ...pageArgs, limit + 1, ...args], limit,
  };
}

// The rows as the list gives them: a turn's row with what its alert said, and
// on a session's last row shown, how many more that session has.
export function listRows(rows: Row[], limit: number, cap = 0): { items: Activity[]; has_more: boolean } {
  return {
    items: rows.slice(0, limit).map(({ rn, of_session, said, ...r }) => ({
      ...r, data: r.data ? JSON.parse(r.data) : undefined,
      ...(said ? { said } : {}),
      ...(cap && rn === cap && (of_session ?? 0) > cap ? { more: of_session! - cap } : {}),
    })),
    has_more: rows.length > limit,
  };
}

// Newest first, paged by the (ts, id) of the last row shown, so rows that share
// a millisecond are never skipped. Search is literal (LIKE with escapes).
export function list(opts: ListOpts = {}): { items: Activity[]; has_more: boolean } {
  const q = listSql(opts);
  return listRows(D().store.db.query<Row, any>(q.sql).all(...q.args), q.limit, opts.session_id ? 0 : opts.cap);
}

// --- the text form (keel activity): a line a row, newest first, the day once where it changes.
const KIND_PAD = 8;
export function activityText(items: Activity[], o: { titleOf: (id: string) => string | undefined; has_more?: boolean; now?: number; ids?: boolean; what?: string }): string {
  const z = zoned(o.now);
  const out = [`Activity${o.what ? `, ${o.what}` : ""}, newest first. ${z.note}.`];
  if (!items.length) out.push("Nothing happened.");
  let day = "";
  for (const a of items) {
    if (localDay(a.ts) !== day) { day = localDay(a.ts); out.push(day); }
    const title = a.session_id ? o.titleOf(a.session_id) : undefined;
    const said = saidOf(a, title);
    const text = `${a.text.replace(/\s+/g, " ")}${said && !a.text.includes(said) ? ` (${clip(said.replace(/\s+/g, " "), 160)})` : ""}`;
    out.push(`  ${z.time(a.ts)}  ${a.kind.padEnd(KIND_PAD)} ${clip(text, 300)}${a.session_id && o.ids !== false ? `  [session=${a.session_id.slice(-12)}]` : ""}`);
    if (a.more) out.push(a.session_id ? `            ${a.more} more in ${title ? `"${title}"` : "this session"}: keel activity --session ${a.session_id.slice(-12)}` : `            ${a.more} more of this kind: keel activity --kind ${a.kind} --all`);
  }
  if (o.has_more && items.length) out.push(`Older rows: --before ${items.at(-1)!.ts}:${items.at(-1)!.id}`);
  return out.join("\n");
}

// The sessions that have activity in the window, the most recent first: the
// session filter offers these, however long ago the session itself was made.
export function sessions(): { session_id: string; last: number }[] {
  return D().store.db
    .query<{ session_id: string; last: number }, [number]>("SELECT session_id, MAX(ts) AS last FROM activity WHERE session_id IS NOT NULL AND ts >= ? GROUP BY session_id ORDER BY last DESC")
    .all(Date.now() - KEEP_MS);
}
