import { D, capture, clip, cursor, emit } from "./core.ts";

// The activity list: everything the daemon and its sessions did, across
// sessions, newest first. One row per happening (an alert, a turn's end, an
// agent started or settled, a loop run or a run that did not happen, a wait
// that fired, an approval answered, a keep-awake hold, a snooze). Kept 30 days:
// older rows are never listed, and an hourly sweep deletes them.

export type ActivityKind = "alert" | "turn" | "agent" | "loop" | "wait" | "approval" | "awake" | "snooze";
export const ACTIVITY_KINDS: ActivityKind[] = ["alert", "turn", "agent", "loop", "wait", "approval", "awake", "snooze"];
// `turn_event`: the turn_start event of the turn it happened in, in the session
// it is listed under (absent between turns), so the row opens that turn's receipt.
export type Activity = { id: string; ts: number; kind: ActivityKind; sub: string; session_id: string | null; text: string; data?: any; turn_event?: string | null };

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
    D().store.db.query("INSERT INTO activity (id, ts, kind, sub, session_id, text, data, turn_event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.ts, kind, sub, sid, a.text, extra === undefined ? null : JSON.stringify(extra), turnEvent);
    emit("activity", a);
  } catch (e) {
    capture(e, { at: "activity", kind });
  }
}

type Row = Omit<Activity, "data"> & { data: string | null };
export function get(id: string): Activity | undefined {
  const r = D().store.db.query<Row, [string]>("SELECT * FROM activity WHERE id = ?").get(id);
  return r ? { ...r, data: r.data ? JSON.parse(r.data) : undefined } : undefined;
}

// Newest first, paged by the (ts, id) of the last row shown, so rows that share
// a millisecond are never skipped. Search is literal (LIKE with escapes).
export function list(opts: { before?: string; limit?: number; kinds?: string[]; session_id?: string; q?: string } = {}): { items: Activity[]; has_more: boolean } {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
  const where = ["ts >= ?"];
  const args: (string | number)[] = [Date.now() - KEEP_MS];
  const c = cursor(opts.before);
  if (c) { where.push("(ts < ? OR (ts = ? AND id < ?))"); args.push(c.ts, c.ts, c.id); }
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
    args.push(...opts.kinds);
  }
  if (opts.session_id) { where.push("session_id = ?"); args.push(opts.session_id); }
  if (opts.q?.trim()) { where.push("text LIKE ? ESCAPE '\\'"); args.push(`%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  const rows = D().store.db.query<Row, any>(`SELECT * FROM activity WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args, limit + 1);
  return { items: rows.slice(0, limit).map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : undefined })), has_more: rows.length > limit };
}

// The sessions that have activity in the window, the most recent first: the
// session filter offers these, however long ago the session itself was made.
export function sessions(): { session_id: string; last: number }[] {
  return D().store.db
    .query<{ session_id: string; last: number }, [number]>("SELECT session_id, MAX(ts) AS last FROM activity WHERE session_id IS NOT NULL AND ts >= ? GROUP BY session_id ORDER BY last DESC")
    .all(Date.now() - KEEP_MS);
}
