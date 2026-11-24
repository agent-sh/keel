// What the owner presses, kept on this machine and nowhere else. The page
// (and the desktop app, and the page on a phone: one page) sends a batch of
// presses every few seconds while the owner is pressing: the control's name,
// the view, the session in view and the time. Never a word the owner typed and
// never a value: a control's name is a fixed name from the page's own source
// (`data-press`, else its `data-testid`), made of letters, digits and a few
// marks, with the digits that name a thing (an id, a count) taken out by the
// page and refused here when any are left.
//
// Two tables, both bounded:
//   presses       one row per press. Kept PRESS_DAYS days and at most PRESS_ROWS rows.
//   press_seen    one row per control and view the page has drawn, with when it was first and last seen:
//                 what "never pressed" is measured against. At most SEEN_ROWS rows.
// Both are pruned when a batch is stored (at most once a minute). The owner
// can turn recording off (setting `presses.record`) and clear the tables.
import type { Database } from "bun:sqlite";

export const PRESS_DAYS = 90;
export const PRESS_ROWS = 50_000;
export const SEEN_ROWS = 4_000;
export const BATCH_MAX = 200;
export const SEEN_BATCH_MAX = 400;
// The window "what you press" and "never pressed" are read over.
export const READ_DAYS = 30;
const DAY = 86_400_000;
const PRUNE_EVERY_MS = 60_000;

export const PRESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS presses (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  control TEXT NOT NULL,
  view TEXT NOT NULL,
  session_id TEXT,
  surface TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS presses_ts ON presses(ts);
CREATE INDEX IF NOT EXISTS presses_control ON presses(control, ts);
CREATE TABLE IF NOT EXISTS press_seen (
  control TEXT NOT NULL,
  view TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (control, view)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS press_seen_last ON press_seen(last_ts);
`;

export const SURFACES = ["page", "desktop", "phone"] as const;
export type Surface = (typeof SURFACES)[number];

export type Press = { control: string; view: string; session: string | null; ts: number };
export type Seen = { control: string; view: string };
export type Batch = { surface: Surface; presses: Press[]; seen: Seen[] };

// A name the page's source gave a control or a view: letters, digits and . _ : / * -, at most 64 (the * stands for a digit run the page took out).
// Anything else (a space, a quote, a long run of digits or hex that is an id) is not a name and is dropped.
const NAME = /^[A-Za-z][A-Za-z0-9_.:/*-]{0,63}$/;
const ID_LIKE = /\d{3,}|[0-9a-f]{8,}/i;
export const nameOf = (v: unknown): string | null => (typeof v === "string" && NAME.test(v) && !ID_LIKE.test(v) ? v : null);
// A session id: letters, digits and dashes.
const sessionOf = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null);

// A posted body as a batch: what is not a name is dropped, never repaired; the counts are held to
// the batch limits; a time from the future or from before the last day is the receipt's.
export function cleanBatch(body: unknown, now: number): Batch {
  const b = (body && typeof body === "object" ? body : {}) as { surface?: unknown; presses?: unknown; seen?: unknown };
  const surface = SURFACES.find((s) => s === b.surface) ?? "page";
  const presses: Press[] = [];
  for (const p of (Array.isArray(b.presses) ? b.presses : []).slice(0, BATCH_MAX)) {
    const control = nameOf(p?.c), view = nameOf(p?.v);
    if (!control || !view) continue;
    const t = Number(p?.t);
    presses.push({ control, view, session: sessionOf(p?.s), ts: Number.isFinite(t) && t <= now && t > now - DAY ? Math.round(t) : now });
  }
  const seen: Seen[] = [];
  for (const s of (Array.isArray(b.seen) ? b.seen : []).slice(0, SEEN_BATCH_MAX)) {
    const control = nameOf(s?.c), view = nameOf(s?.v);
    if (control && view) seen.push({ control, view });
  }
  return { surface, presses, seen };
}

const pruned = new WeakMap<Database, number>();

// Stores a batch in one transaction, and keeps the tables to their bounds.
export function storePresses(db: Database, b: Batch, now: number) {
  db.transaction(() => {
    const put = db.prepare("INSERT INTO presses (ts, control, view, session_id, surface) VALUES (?, ?, ?, ?, ?)");
    const see = db.prepare("INSERT INTO press_seen (control, view, first_ts, last_ts) VALUES (?, ?, ?, ?) ON CONFLICT (control, view) DO UPDATE SET last_ts = MAX(last_ts, excluded.last_ts)");
    for (const p of b.presses) {
      put.run(p.ts, p.control, p.view, p.session, b.surface);
      see.run(p.control, p.view, p.ts, p.ts);
    }
    for (const s of b.seen) see.run(s.control, s.view, now, now);
    put.finalize();
    see.finalize();
  })();
  if (now - (pruned.get(db) ?? 0) >= PRUNE_EVERY_MS) { pruned.set(db, now); prunePresses(db, now); }
}

// Past PRESS_DAYS, and past the row bounds, the oldest go first.
export function prunePresses(db: Database, now: number) {
  db.run("DELETE FROM presses WHERE ts < ?", [now - PRESS_DAYS * DAY]);
  db.run("DELETE FROM presses WHERE id <= (SELECT id FROM presses ORDER BY id DESC LIMIT 1 OFFSET ?)", [PRESS_ROWS]);
  db.run("DELETE FROM press_seen WHERE last_ts < ?", [now - PRESS_DAYS * DAY]);
  db.run("DELETE FROM press_seen WHERE (control, view) IN (SELECT control, view FROM press_seen ORDER BY last_ts DESC LIMIT -1 OFFSET ?)", [SEEN_ROWS]);
}

export const clearPresses = (db: Database) => void db.transaction(() => { db.run("DELETE FROM presses"); db.run("DELETE FROM press_seen"); })();

export type ControlRow = { control: string; presses: number; last_ms: number; surfaces: string };
export type ViewRow = { view: string; presses: number; controls: ControlRow[] };
export type NeverRow = { control: string; views: string; seen_since_ms: number };
export type PressReport = {
  since_ms: number; days: number; presses: number; first_ms: number | null; rows: number; row_cap: number; kept_days: number;
  views: ViewRow[]; never: NeverRow[];
};

const PER_VIEW = 30;
const NEVER_MAX = 200;

// The window's presses by view, the most used control first, and the controls the page drew in the
// window that were not pressed in it, over any view. Read on the read thread.
export function pressReport(db: Database, a: { now?: number; days?: number } = {}): PressReport {
  const now = a.now ?? Date.now();
  const days = a.days && a.days >= 1 ? Math.min(Math.floor(a.days), PRESS_DAYS) : READ_DAYS;
  const since = now - days * DAY;
  const per = db.query<{ view: string; control: string; n: number; last: number; surfaces: string }, [number]>(
    `SELECT view, control, COUNT(*) AS n, MAX(ts) AS last, GROUP_CONCAT(DISTINCT surface) AS surfaces FROM presses WHERE ts >= ? GROUP BY view, control ORDER BY view, n DESC, control`).all(since);
  const byView = new Map<string, ViewRow>();
  for (const r of per) {
    const v = byView.get(r.view) ?? { view: r.view, presses: 0, controls: [] };
    v.presses += r.n;
    if (v.controls.length < PER_VIEW) v.controls.push({ control: r.control, presses: r.n, last_ms: r.last, surfaces: r.surfaces });
    byView.set(r.view, v);
  }
  const never = db.query<{ control: string; views: string; since: number }, [number, number, number]>(
    `SELECT control, GROUP_CONCAT(view) AS views, MIN(first_ts) AS since FROM press_seen
      WHERE last_ts >= ? AND control NOT IN (SELECT DISTINCT control FROM presses WHERE ts >= ?)
      GROUP BY control ORDER BY since, control LIMIT ?`).all(since, since, NEVER_MAX);
  const total = db.query<{ n: number; first: number | null }, []>("SELECT COUNT(*) AS n, MIN(ts) AS first FROM presses").get()!;
  return {
    since_ms: since, days, presses: [...byView.values()].reduce((n, v) => n + v.presses, 0), first_ms: total.first, rows: total.n, row_cap: PRESS_ROWS, kept_days: PRESS_DAYS,
    views: [...byView.values()].sort((x, y) => y.presses - x.presses || x.view.localeCompare(y.view)),
    never: never.map((r) => ({ control: r.control, views: r.views, seen_since_ms: r.since })),
  };
}
