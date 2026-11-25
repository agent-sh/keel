// What the helper has been told of an alert. The inbox puts a frame on the bus for every change of an alert (its
// delivery to a channel, its mark, a card raised again after a restart), so one open card is many frames. The helper
// takes the news of it once, and again only when its words changed.
import type { Database } from "bun:sqlite";

export const TOLD_SCHEMA = "CREATE TABLE IF NOT EXISTS helper_told (key TEXT PRIMARY KEY, fp TEXT NOT NULL, ts INTEGER NOT NULL);";
const KEEP_MS = 30 * 86400_000;

type AlertLike = { id: string; title: string; body: string; session_id?: string | null; data?: Record<string, any> | null };

// A decision (an approval, a question, a plan, a secret) is one wait whatever its row is called: a card put back at a
// restart is a new row of the same wait. Anything else is its row.
export function toldKey(a: AlertLike): string {
  const d = a.data ?? {};
  if (typeof d.approval_id === "string") return `approval:${d.approval_id}`;
  if (typeof d.plan_id === "string") return `plan:${d.plan_id}`;
  if (typeof d.secret_id === "string") return `secret:${d.secret_id}`;
  if (typeof d.call_id === "string") return `question:${d.open_session ?? a.session_id ?? ""}:${d.call_id}`;
  return `alert:${a.id}`;
}

// Whether this frame of an alert is news: its wait or row was not told before, or its words are not as they were told.
export function isNews(db: Database, a: AlertLike, now = Date.now()): boolean {
  const r = db.query(
    "INSERT INTO helper_told (key, fp, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fp = excluded.fp, ts = excluded.ts WHERE helper_told.fp != excluded.fp",
  ).run(toldKey(a), `${a.title}\n${a.body}`, now);
  if (r.changes) db.query("DELETE FROM helper_told WHERE ts < ?").run(now - KEEP_MS);
  return r.changes > 0;
}
