import { D, capture, emit } from "./core.ts";

// The activity list: everything the daemon and its sessions did, across
// sessions, newest first. One row per happening (an alert, a turn's end, an
// agent started or settled, a loop run or a run that did not happen, a wait
// that fired, an approval answered, a keep-awake hold, a snooze). Kept 30 days.

export type ActivityKind = "alert" | "turn" | "agent" | "loop" | "wait" | "approval" | "awake" | "snooze";
export const ACTIVITY_KINDS: ActivityKind[] = ["alert", "turn", "agent", "loop", "wait", "approval", "awake", "snooze"];
export type Activity = { id: string; ts: number; kind: ActivityKind; sub: string; session_id: string | null; text: string; data?: any };

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
  D().store.db.query("DELETE FROM activity WHERE ts < ?").run(Date.now() - 30 * 86400_000);
}

export function record(kind: ActivityKind, sub: string, sessionId: string | null, text: string, data?: unknown) {
  try {
    // A subagent's happenings are listed under its parent, with the child named.
    const s = sessionId ? D().store.session(sessionId) : undefined;
    const sid = s?.parent_id ?? sessionId;
    const extra = s?.parent_id ? { ...(data as object), child_session: sessionId } : data;
    const a: Activity = { id: Bun.randomUUIDv7(), ts: Date.now(), kind, sub, session_id: sid, text: text.slice(0, 500), data: extra };
    D().store.db.query("INSERT INTO activity (id, ts, kind, sub, session_id, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.ts, kind, sub, sid, a.text, extra === undefined ? null : JSON.stringify(extra));
    emit("activity", a);
  } catch (e) {
    capture(e, { at: "activity", kind });
  }
}

type Row = Omit<Activity, "data"> & { data: string | null };

export function list(opts: { before?: number; limit?: number; kinds?: string[]; session_id?: string; q?: string } = {}): { items: Activity[]; has_more: boolean } {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
  const where = ["ts < ?"];
  const args: (string | number)[] = [opts.before ?? Number.MAX_SAFE_INTEGER];
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
    args.push(...opts.kinds);
  }
  if (opts.session_id) { where.push("session_id = ?"); args.push(opts.session_id); }
  if (opts.q?.trim()) { where.push("text LIKE ? ESCAPE '\\'"); args.push(`%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  const rows = D().store.db.query<Row, any>(`SELECT * FROM activity WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`).all(...args, limit + 1);
  return { items: rows.slice(0, limit).map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : undefined })), has_more: rows.length > limit };
}
