// The pace of a session's unattended turns (the rule is pure, in ./pace-rules.ts). The owner's
// default is the settings section `pace` (`unattended_min`, for the sessions he talks to); a session's
// own `pace_min` (its menu) takes its place, 0 for off. The flush of what waits for a session
// (./core.ts) asks `held` before it starts a turn; the turn-end hook says when an unattended turn ended
// (`ended`). What waits, and until when, is a `pace` frame of the session, read by its dock, and
// `GET /api/sessions/:id/pace` says the same with what the pace did since the daemon started.
//
// A paced input waits in memory, so what it is must survive a restart somewhere else: a report, a wake, a
// monitor's batch and the helper's digest are owed in their senders' own tables, and an input whose sender
// keeps none (a background command's end, a scheduled loop's run) is owed here, in `paced_owed`, by its key:
// stored when it is lined up, gone in the write that stores its prompt, sent again by the next daemon
// (`restore`). The last unattended end is kept too (`pace_ends`), so the next daemon keeps the same pace.
import type { Database } from "bun:sqlite";
import type { StoredEvent } from "../core/types.ts";
import { registerSettings, settings } from "../admin/settings.ts";
import { capture, D, deliver, flush, paceGate, type Pending } from "./core.ts";
import { badPace, decide, paceMsOf, PACE_DEFAULT_MIN, type PacePart } from "./pace-rules.ts";

registerSettings("pace", { unattended_min: PACE_DEFAULT_MIN }, (v) => badPace(v.unattended_min));

const defaultMin = () => Number((settings().pace as { unattended_min?: number } | undefined)?.unattended_min ?? PACE_DEFAULT_MIN);

// When each session's last unattended turn ended, how long its cache surely lives, and from when (its last
// request that used the cache was sent then).
type End = { at: number; life: number; cached?: number };
const ends = new Map<string, End>();
// What waits now: until when, how many inputs, and whether its timer already fired.
const waiting = new Map<string, { at: number; n: number; timer: ReturnType<typeof setTimeout>; fired?: boolean }>();
// Since the daemon started: inputs that waited, and turns they did not start (inputs that went with another).
const done = new Map<string, { waited: number; joined: number }>();

// The two tables, made once for each store.
const made = new WeakSet<Database>();
function db(): Database {
  const d = D().store.db;
  if (made.has(d)) return d;
  D().store.migrate(`
CREATE TABLE IF NOT EXISTS pace_ends (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL, life INTEGER NOT NULL DEFAULT 0, cached INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS paced_owed (session_id TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, meta TEXT NOT NULL, by INTEGER, ts INTEGER NOT NULL, PRIMARY KEY (session_id, key)) WITHOUT ROWID;`);
  made.add(d);
  return d;
}

const keepEnd = (sessionId: string, e: End) => {
  try { db().query("INSERT OR REPLACE INTO pace_ends (session_id, at, life, cached) VALUES (?, ?, ?, ?)").run(sessionId, e.at, e.life, e.cached ?? null); } catch (err) { capture(err, { at: "pace: keep end", session: sessionId }); }
};
const dropEnd = (sessionId: string) => {
  ends.delete(sessionId);
  try { db().query("DELETE FROM pace_ends WHERE session_id = ?").run(sessionId); } catch (err) { capture(err, { at: "pace: drop end", session: sessionId }); }
};

export type PaceView = {
  session_id: string;
  pace_min: number;
  from: "session" | "default" | "agent";
  waiting: number;
  at?: number;
  last_end?: number;
  waited: number;
  joined: number;
};

export function paceMs(sessionId: string): number {
  const s = D().store.session(sessionId);
  if (!s) return 0;
  return paceMsOf(s.settings.pace_min, defaultMin(), !s.parent_id);
}

export function view(sessionId: string): PaceView {
  const s = D().store.session(sessionId);
  const own = s?.settings.pace_min;
  const w = waiting.get(sessionId), d = done.get(sessionId), e = ends.get(sessionId);
  return {
    session_id: sessionId,
    pace_min: paceMs(sessionId) / 60_000,
    from: own !== undefined ? "session" : s?.parent_id ? "agent" : "default",
    waiting: w?.n ?? 0,
    ...(w ? { at: w.at } : {}),
    ...(e ? { last_end: e.at } : {}),
    waited: d?.waited ?? 0,
    joined: d?.joined ?? 0,
  };
}

const tell = (sessionId: string) => {
  try { D().bus.emit({ t: "feature", name: "pace", session_id: sessionId, data: view(sessionId) }); } catch (e) { capture(e, { at: "pace", session: sessionId }); }
};

const stop = (sessionId: string) => {
  const w = waiting.get(sessionId);
  if (!w) return false;
  clearTimeout(w.timer);
  waiting.delete(sessionId);
  return true;
};

// The flush asks before it starts a turn: true holds what is lined up until the pace lets it go.
paceGate.held = (sessionId, list) => {
  const e = ends.get(sessionId);
  const parts: PacePart[] = list.map((p) => ({ paced: !!p.pace, ...(p.pace?.by !== undefined ? { by: p.pace.by } : {}) }));
  const out = decide({ paceMs: paceMs(sessionId), lastEnd: e?.at, life: e?.life, ...(e?.cached ? { cachedAt: e.cached } : {}), now: Date.now(), parts });
  if (out.go) { if (stop(sessionId)) tell(sessionId); return false; }
  const w = waiting.get(sessionId);
  if (w && !w.fired && w.at === out.at && w.n === parts.length) return true;
  if (w) clearTimeout(w.timer);
  const timer = setTimeout(() => {
    const cur = waiting.get(sessionId);
    if (cur?.timer !== timer) return;
    // Kept: a timer that fires a moment early finds the same wait, and arms again without counting it twice.
    cur.fired = true;
    flush(sessionId);
  }, Math.max(0, out.at - Date.now()));
  // A wait that is still owed keeps nothing alive at exit (the inputs are owed in tables, see above).
  (timer as { unref?: () => void }).unref?.();
  waiting.set(sessionId, { at: out.at, n: parts.length, timer });
  const d = done.get(sessionId) ?? { waited: 0, joined: 0 };
  d.waited += w ? Math.max(0, parts.length - w.n) : parts.length;
  done.set(sessionId, d);
  tell(sessionId);
  return true;
};

// The flush started a turn of `n` inputs: the wait is over, and n - 1 turns were not started.
paceGate.sent = (sessionId, n) => {
  const was = stop(sessionId);
  if (n > 1) {
    const d = done.get(sessionId) ?? { waited: 0, joined: 0 };
    d.joined += n - 1;
    done.set(sessionId, d);
  }
  if (was || n > 1) tell(sessionId);
};

// Nothing waits for the session any more (its inputs were dropped or moved).
paceGate.dropped = (sessionId) => { if (stop(sessionId)) tell(sessionId); };

// --- inputs owed here -------------------------------------------------------------------------------------

// Lined up with a key of its own (`pace.owe`): stored before the sender is told it is taken.
paceGate.owe = (sessionId, p) => {
  if (!p.pace?.owe) return;
  db().query("INSERT OR REPLACE INTO paced_owed (session_id, key, text, meta, by, ts) VALUES (?, ?, ?, ?, ?, ?)").run(sessionId, p.pace.owe, p.text, JSON.stringify(p.meta), p.pace.by ?? null, Date.now());
};
// Sent (in the write that stores its prompt), taken back or dropped: no longer owed.
paceGate.settle = (sessionId, list) => {
  const keys = list ? list.flatMap((p) => (p.pace?.owe ? [p.pace.owe] : [])) : undefined;
  if (keys && !keys.length) return;
  if (!keys) return void db().query("DELETE FROM paced_owed WHERE session_id = ?").run(sessionId);
  const q = db().query("DELETE FROM paced_owed WHERE session_id = ? AND key = ?");
  for (const k of keys) q.run(sessionId, k);
};
paceGate.moved = (from, to) => {
  db().query("UPDATE OR REPLACE paced_owed SET session_id = ? WHERE session_id = ?").run(to, from);
};

export type OwedRow = { session_id: string; key: string; text: string; meta: Record<string, unknown>; by: number | null; ts: number };
// A sender that keeps more than the input (a loop's run row): at a restore, what sending it settles, or
// undefined when it is no longer owed (its row is then gone). The others are told once by their key in
// `input_keys`, as a sender's key is.
export const restorers: Record<string, (r: OwedRow) => { onSent?: (e: StoredEvent) => void } | undefined> = {};

// The keys owed for a kind, with their deadlines (a loop's recover leaves those runs open for `restore`).
export function owedOf(kind: string): { key: string; by: number | null }[] {
  return db().query<{ key: string; by: number | null; meta: string }, []>("SELECT key, by, meta FROM paced_owed").all()
    .filter((r) => { try { return JSON.parse(r.meta).kind === kind; } catch { return false; } })
    .map((r) => ({ key: r.key, by: r.by }));
}

// After a restart, before anything is delivered: the pace the last daemon kept.
export function recover() {
  ends.clear();
  for (const r of db().query<{ session_id: string; at: number; life: number; cached: number | null }, []>("SELECT session_id, at, life, cached FROM pace_ends").all())
    ends.set(r.session_id, { at: r.at, life: r.life, ...(r.cached ? { cached: r.cached } : {}) });
}

// After the senders' own recovery: what the last daemon held for the pace and kept here goes again, paced
// as it was, once.
export function restore() {
  const rows = db().query<{ session_id: string; key: string; text: string; meta: string; by: number | null; ts: number }, []>("SELECT * FROM paced_owed ORDER BY ts").all();
  for (const raw of rows) {
    const gone = () => db().query("DELETE FROM paced_owed WHERE session_id = ? AND key = ?").run(raw.session_id, raw.key);
    try {
      const r: OwedRow = { ...raw, meta: JSON.parse(raw.meta) };
      const kind = String(r.meta.kind ?? "");
      const own = restorers[kind];
      if (!own && D().engine.hasInput?.(r.session_id, r.key)) { gone(); continue; }
      const how = own ? own(r) : { onSent: () => void D().store.db.query("INSERT OR IGNORE INTO input_keys (session_id, key, ts) VALUES (?, ?, ?)").run(r.session_id, r.key, Date.now()) };
      if (!how) { gone(); continue; }
      gone(); // deliver stores it again under its key, as it is lined up
      if (!deliver(r.session_id, r.text, r.meta, { pace: { owe: r.key, ...(r.by !== null ? { by: r.by } : {}) }, ...(how.onSent ? { onSent: how.onSent } : {}) })) continue;
    } catch (e) {
      capture(e, { at: "pace: restore", session: raw.session_id });
    }
  }
}

// A turn of the session ended. One that carried the owner's word sets no pace: the next unattended
// input after it goes at once. The cache's lifetime is read from the turn that just ran; until it is
// known the pace alone holds, and what waits then is decided again with it.
export function ended(sessionId: string, owned: boolean) {
  if (owned) return void (ends.has(sessionId) && dropEnd(sessionId));
  const at = Date.now();
  const e: End = { at, life: 0 };
  ends.set(sessionId, e);
  keepEnd(sessionId, e);
  D().engine.cacheSure?.(sessionId).then((c) => {
    const cur = ends.get(sessionId);
    if (cur !== e) return;
    cur.life = c.life;
    if (c.at) cur.cached = c.at;
    keepEnd(sessionId, cur);
    if (waiting.has(sessionId)) flush(sessionId);
  }, (err) => capture(err, { at: "pace: cache life", session: sessionId }));
}

// The pace each session was last told with: a session frame that moves it decides what waits again.
const told = new Map<string, number | undefined>();
// The turn-end hook. A session with no pace reads nothing; whether the turn carried the owner's word is
// read from before its own end, which would close the search (src/engine/turn.ts byOwner).
export function turnEnded(sessionId: string) {
  try {
    if (!paceMs(sessionId)) return void (ends.has(sessionId) && dropEnd(sessionId));
    const line = D().engine.lineage(sessionId);
    const from = line.length - (line.at(-1)?.kind === "turn_end" ? 2 : 1);
    ended(sessionId, D().engine.byOwner(sessionId, line, from));
  } catch (e) { capture(e, { at: "pace", session: sessionId }); }
}

// The session's own pace changed: what waits is decided again now.
export function changed(sessionId: string) {
  if (waiting.has(sessionId)) { stop(sessionId); flush(sessionId); }
  tell(sessionId);
}
export function onSession(s: { id: string; settings: { pace_min?: number } }) {
  if (told.has(s.id) ? told.get(s.id) === s.settings.pace_min : s.settings.pace_min === undefined) return;
  told.set(s.id, s.settings.pace_min);
  changed(s.id);
}

export function forget(sessionId: string) {
  stop(sessionId);
  told.delete(sessionId);
  dropEnd(sessionId);
  done.delete(sessionId);
  try { paceGate.settle?.(sessionId); } catch (e) { capture(e, { at: "pace: forget", session: sessionId }); }
}

// New parts (a test's, a restart's): nothing of the old ones waits.
paceGate.reset = () => {
  for (const w of waiting.values()) clearTimeout(w.timer);
  waiting.clear();
  ends.clear();
  done.clear();
  told.clear();
};
