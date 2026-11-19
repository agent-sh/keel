import * as activity from "./activity.ts";
import { D, emit } from "./core.ts";

// Snooze. A session snoozed until a time, or until it needs the owner, keeps
// working; its routine alerts (finished, from the agent, a failed loop run) go
// to the inbox already read and reach no channel. Something only the owner can
// answer (an approval, a question) suspends the snooze and goes out; once a
// permission card is answered before the time, the session is snoozed again.
// A failed turn or a spent usage limit ends the snooze. A message from the owner
// ends it. When the time passes the session wakes with one alert.
//
// The global snooze holds every channel until its time: alerts still land in
// the inbox, and when it ends one alert says how many came meanwhile.

export type Snooze = { session_id: string; until_ms: number | null; until_needed: boolean; suspended: boolean; set_ms: number; muted: number };
const GLOBAL = "*";
const NEEDS_OWNER = new Set(["approval", "question"]);
const ENDS = new Set(["failed", "limit"]);

export function migrate() {
  D().store.migrate(`
CREATE TABLE IF NOT EXISTS snoozes (
  session_id TEXT PRIMARY KEY,
  until_ms INTEGER,
  until_needed INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  set_ms INTEGER NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0
);`);
}

type Row = Omit<Snooze, "until_needed" | "suspended"> & { until_needed: number; suspended: number };
const toRec = (r: Row): Snooze => ({ ...r, until_needed: !!r.until_needed, suspended: !!r.suspended });
const db = () => D().store.db;
const row = (id: string) => db().query<Row, [string]>("SELECT * FROM snoozes WHERE session_id = ?").get(id);

export const get = (sessionId: string) => { const r = row(sessionId); return r ? toRec(r) : undefined; };
export const all = () => db().query<Row, []>("SELECT * FROM snoozes").all().map(toRec);
export const global = () => get(GLOBAL);

function changed(sessionId: string) {
  emit("snooze", { session_id: sessionId, snooze: get(sessionId) ?? null });
}

const check = (until_ms: unknown, until_needed: unknown) => {
  const t = until_ms === undefined || until_ms === null ? null : Number(until_ms);
  if (t !== null && (!Number.isFinite(t) || t <= Date.now())) throw new Error("until_ms is a time in the future");
  if (t === null && !until_needed) throw new Error("a snooze needs until_ms, until_needed or both");
  return t;
};

export function set(sessionId: string, input: { until_ms?: number | null; until_needed?: boolean }, hasOpenCard: boolean): Snooze {
  const s = D().store.session(sessionId);
  if (!s) throw Object.assign(new Error("no such session"), { status: 404 });
  if (s.parent_id) throw new Error("a subagent is snoozed with its parent");
  if (hasOpenCard) throw Object.assign(new Error("the session waits for an answer: answer it first"), { status: 409 });
  const until = check(input.until_ms, input.until_needed);
  db().query("INSERT OR REPLACE INTO snoozes (session_id, until_ms, until_needed, suspended, set_ms, muted) VALUES (?, ?, ?, 0, ?, 0)")
    .run(sessionId, until, input.until_needed ? 1 : 0, Date.now());
  activity.record("snooze", "set", sessionId, `Snoozed ${describe(get(sessionId)!)}`);
  changed(sessionId);
  return get(sessionId)!;
}

export function setGlobal(until_ms: number): Snooze {
  const until = check(until_ms, false)!;
  db().query("INSERT OR REPLACE INTO snoozes (session_id, until_ms, until_needed, suspended, set_ms, muted) VALUES (?, ?, 0, 0, ?, 0)").run(GLOBAL, until, Date.now());
  activity.record("snooze", "global", null, `Alerts snoozed until ${new Date(until).toLocaleString()}`);
  changed(GLOBAL);
  return get(GLOBAL)!;
}

export function end(sessionId: string, why: string, wake?: (s: Snooze) => void): boolean {
  const s = get(sessionId);
  if (!s) return false;
  db().query("DELETE FROM snoozes WHERE session_id = ?").run(sessionId);
  activity.record("snooze", "end", sessionId === GLOBAL ? null : sessionId, `${sessionId === GLOBAL ? "Global snooze" : "Snooze"} ended: ${why}`);
  wake?.(s);
  changed(sessionId);
  return true;
}

export function describe(s: Snooze): string {
  const t = s.until_ms ? `until ${new Date(s.until_ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
  return [t, s.until_needed ? "until it needs you" : ""].filter(Boolean).join(" or ");
}

const activeGlobal = () => {
  const g = global();
  return g && g.until_ms && g.until_ms > Date.now() ? g : undefined;
};

// Called by alerts.raise before delivery. `deliver: false` keeps the alert
// in the inbox already read and off every channel; `quiet` keeps it unread
// but off the channels (the global snooze).
export function filter(kind: string, sessionId: string | null): { deliver: boolean; quiet?: boolean } {
  const r = sessionFilter(kind, sessionId);
  // Every alert, a session's own snooze ending included, stays off the
  // channels until the global snooze ends.
  if (r.deliver && activeGlobal()) {
    db().query("UPDATE snoozes SET muted = muted + 1 WHERE session_id = ?").run(GLOBAL);
    return { deliver: true, quiet: true };
  }
  return r;
}

function sessionFilter(kind: string, sessionId: string | null): { deliver: boolean } {
  if (!sessionId || kind === "snooze_over") return { deliver: true };
  const s = get(sessionId);
  if (!s) return { deliver: true };
  if (NEEDS_OWNER.has(kind)) {
    if (s.until_needed) end(sessionId, "it needs you");
    else if (!s.suspended) { db().query("UPDATE snoozes SET suspended = 1 WHERE session_id = ?").run(sessionId); changed(sessionId); }
    return { deliver: true };
  }
  if (ENDS.has(kind) || (s.until_needed && kind === "finished")) {
    end(sessionId, kind === "finished" ? "its work is done" : kind === "limit" ? "it hit a usage limit" : "a turn failed");
    return { deliver: true };
  }
  if (s.suspended) return { deliver: true };
  db().query("UPDATE snoozes SET muted = muted + 1 WHERE session_id = ?").run(sessionId);
  return { deliver: false };
}

// A permission card was answered: snoozed again while its time has not come.
export function resume(sessionId: string) {
  const s = get(sessionId);
  if (!s?.suspended) return;
  if (s.until_ms && s.until_ms <= Date.now()) return;
  db().query("UPDATE snoozes SET suspended = 0 WHERE session_id = ?").run(sessionId);
  changed(sessionId);
}

export const isSnoozed = (sessionId: string) => {
  const s = get(sessionId);
  return !!s && !s.suspended && (!s.until_ms || s.until_ms > Date.now());
};

// Ends what is due; the caller raises the wake alerts.
export function due(): Snooze[] {
  return db().query<Row, [number]>("SELECT * FROM snoozes WHERE until_ms IS NOT NULL AND until_ms <= ?").all(Date.now()).map(toRec);
}

export const GLOBAL_ID = GLOBAL;
