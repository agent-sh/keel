import * as activity from "./activity.ts";
import { D, alertHook, capture, clip, cursor, emit } from "./core.ts";
import * as snooze from "./snooze.ts";
import * as perm from "../server/routes/permissions.ts";
import { allPendingQuestions, pendingQuestions } from "../tools/interact.ts";
import { QUESTION_CUT } from "../core/stops.ts";
import { planWaits, plansWaiting } from "../server/routes/plan.ts";
import { sessionState } from "./state.ts";
import { readText } from "../core/proc.ts";
import { plainLine } from "../core/plain.ts";
import { lockedDaemon } from "../admin/daemon.ts";
import { openUrl } from "../cli/client.ts";
import { desktopNotifications } from "./desktop.ts";
import { secretsWaiting } from "../server/routes/secrets.ts";
import { ASK_KINDS, WRONG_KINDS } from "../core/state-words.ts";
import { handShell, shellShows, tellShells } from "../server/shell.ts";

// What needs the owner becomes one alert: kept in the inbox with unread state,
// sent as a frame, and delivered to the channels the settings name for its
// kind. A channel is anything with deliver(); phone push registers one later.

export const KINDS = ["approval", "question", "finished", "failed", "limit", "loop_failed", "agent", "snooze_over", "regression", "refused"] as const;
export type AlertKind = (typeof KINDS)[number];
// Each channel's handoff: pending until deliver() settles, then sent or failed.
// Sent means the channel took it, not that the owner saw it.
export type Delivery = Record<string, { state: "pending" | "sent" | "failed"; error?: string }>;
export type Alert = {
  id: string;
  ts: number;
  kind: AlertKind;
  session_id: string | null;
  title: string;
  body: string;
  read: boolean;
  data?: any;
  channels?: string[];
  delivery?: Delivery;
  // The inbox revision at which this alert last became unread (raised, or
  // marked unread). A read names the revision the page had seen.
  rev: number;
  // Marked unread by the owner: only an explicit read clears it, never the
  // page reading a session because it is on screen.
  kept: boolean;
  // An ask whose card still waits for the owner, read or not (told with a list, not stored).
  open?: boolean;
};

export type AlertChannel = {
  id: string;
  label: string;
  available(): boolean;
  deliver(a: Alert): void | Promise<void>;
  // The owner read the session: take back what is still shown for it.
  withdraw?(sessionId: string): void | Promise<void>;
};

export type AlertSettings = {
  routes: Record<AlertKind, string[]>;
  // finished alerts: never, only while the owner is not watching that session, or always
  completion: "never" | "background" | "always";
};

const channels = new Map<string, AlertChannel>();
export const registerChannel = (c: AlertChannel) => void channels.set(c.id, c);
export const channelList = () => [...channels.values()].map((c) => ({ id: c.id, label: c.label, available: c.available() }));

const KEEP_MS = 30 * 86400_000;

export function migrate() {
  const { store } = D();
  store.migrate(`
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  channels TEXT
);
CREATE INDEX IF NOT EXISTS alerts_ts ON alerts(ts DESC);
CREATE INDEX IF NOT EXISTS alerts_unread ON alerts(read, session_id);
CREATE TABLE IF NOT EXISTS alert_settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_rev (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO alert_rev (id, n) VALUES (1, 0);`);
  for (const [col, type] of [["rev", "INTEGER NOT NULL DEFAULT 0"], ["kept", "INTEGER NOT NULL DEFAULT 0"], ["delivery", "TEXT"]] as const) {
    if (!store.columnExists("alerts", col)) store.migrate(`ALTER TABLE alerts ADD COLUMN ${col} ${type}`);
  }
  sweep();
  const g = globalThis as { __keelAlertSweep?: ReturnType<typeof setInterval> };
  clearInterval(g.__keelAlertSweep);
  g.__keelAlertSweep = setInterval(sweep, 3600_000);
}

// The inbox revision: bumped by every change to an alert. Never reused, so a
// read that names an older revision cannot touch what came after it.
const nextRev = () => D().store.db.query<{ n: number }, []>("UPDATE alert_rev SET n = n + 1 WHERE id = 1 RETURNING n").get()!.n;
export const currentRev = () => D().store.db.query<{ n: number }, []>("SELECT n FROM alert_rev WHERE id = 1").get()?.n ?? 0;

// Whether the owner still has to decide what this alert is about.
function stillOpen(a: Pick<Alert, "kind" | "session_id" | "data">): boolean {
  if (a.kind === "approval") return !!a.data?.approval_id && perm.gate?.approval(a.data.approval_id)?.state === "pending";
  if (a.kind === "question" && a.data?.plan_id) return planWaits(a.data.plan_id);
  if (a.kind === "question" && a.data?.secret_id) return secretsWaiting().some((c) => c.id === a.data.secret_id);
  if (a.kind === "question") return !!a.data?.call_id && pendingQuestions(a.data.open_session ?? a.session_id ?? "").includes(a.data.call_id);
  return false;
}

// Rows older than 30 days go, except an approval or a question that still waits
// for the owner: its reminder stays until it is answered.
export function sweep() {
  try {
    const db = D().store.db;
    const old = db.query<Row, [number]>("SELECT * FROM alerts WHERE ts < ?").all(Date.now() - KEEP_MS).map(toAlert);
    const del = db.query("DELETE FROM alerts WHERE id = ?");
    for (const a of old) if (!stillOpen(a)) del.run(a.id);
  } catch (e) {
    capture(e, { at: "alert sweep" });
  }
}

const defaults = (): AlertSettings => ({
  routes: Object.fromEntries(KINDS.map((k) => [k, ["desktop", "command", "push"]])) as AlertSettings["routes"],
  completion: "background",
});

export function settings(): AlertSettings {
  const r = D().store.db.query<{ value: string }, []>("SELECT value FROM alert_settings WHERE id = 1").get();
  const d = defaults();
  if (!r) return d;
  const v = JSON.parse(r.value);
  return { routes: { ...d.routes, ...v.routes }, completion: v.completion ?? d.completion };
}

// `routes` replaces the lists of the kinds it names; `route` turns one channel
// on or off for one kind against what is saved now, so two quick toggles never
// undo each other.
export function saveSettings(p: Partial<AlertSettings> & { route?: { kind: string; channel: string; on: boolean } }): AlertSettings {
  const cur = settings();
  if (p.completion && !["never", "background", "always"].includes(p.completion)) throw new Error("completion is never, background or always");
  const routes = { ...cur.routes };
  for (const [k, v] of Object.entries(p.routes ?? {})) {
    if (!KINDS.includes(k as AlertKind)) throw new Error(`unknown alert kind ${k}`);
    if (!Array.isArray(v)) throw new Error(`routes.${k} is a list of channels`);
    routes[k as AlertKind] = v.map(String);
  }
  if (p.route) {
    const k = p.route.kind as AlertKind;
    if (!KINDS.includes(k)) throw new Error(`unknown alert kind ${k}`);
    const ch = String(p.route.channel);
    const rest = (routes[k] ?? []).filter((c) => c !== ch);
    routes[k] = p.route.on ? [...rest, ch] : rest;
  }
  const next = { routes, completion: p.completion ?? cur.completion };
  D().store.db.query("INSERT INTO alert_settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  return next;
}

type Row = Omit<Alert, "read" | "data" | "channels" | "delivery" | "kept"> & { read: number; kept: number; data: string | null; channels: string | null; delivery: string | null };
const toAlert = (r: Row): Alert => ({
  ...r, read: !!r.read, kept: !!r.kept, data: r.data ? JSON.parse(r.data) : undefined,
  channels: r.channels ? JSON.parse(r.channels) : [], delivery: r.delivery ? JSON.parse(r.delivery) : undefined,
});
// Where a row about `sessionId` (and maybe one of its agents) leads now.
export function target(sessionId: string | null, childId?: string, approvalId?: string) {
  const { store } = D();
  const parent = sessionId && store.session(sessionId) ? sessionId : null;
  const child = childId ? (store.session(childId) ? childId : null) : undefined;
  const card = approvalId ? perm.gate?.approval(approvalId) : undefined;
  return {
    parent,
    child: child ?? null,
    child_deleted: child === null,
    open: child ?? parent,
    ...(approvalId ? { approval: card ? card.state : "gone" } : {}),
  };
}

export const alertTarget = (a: Alert) =>
  target(a.session_id, a.data?.child_session ?? (a.data?.open_session !== a.session_id ? a.data?.open_session : undefined), a.data?.approval_id);

export const get = (id: string) => getAlert(id);
const getAlert = (id: string) => {
  const r = D().store.db.query<Row, [string]>("SELECT * FROM alerts WHERE id = ?").get(id);
  return r ? toAlert(r) : undefined;
};

// Newest first, paged by (ts, id). `withUnread` adds every unread alert however
// old, so a count in the header always has its rows on screen.
// Every alert says whether it is an ask whose card still waits (`open`); with `withUnread` such
// an ask is listed however old and read it is: looking at a request does not answer it.
export function list(opts: { before?: string; limit?: number; unread?: boolean; withUnread?: boolean } = {}): Alert[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const c = cursor(opts.before);
  const db = D().store.db;
  const rows = db
    .query<Row, [number, number, string, number]>(`SELECT * FROM alerts WHERE (ts < ? OR (ts = ? AND id < ?)) ${opts.unread ? "AND read = 0" : ""} ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(c?.ts ?? Number.MAX_SAFE_INTEGER, c?.ts ?? Number.MAX_SAFE_INTEGER, c?.id ?? "", limit);
  if (opts.withUnread && !opts.unread) {
    const have = new Set(rows.map((r) => r.id));
    for (const r of db.query<Row, []>("SELECT * FROM alerts WHERE read = 0 ORDER BY ts DESC, id DESC LIMIT 1000").all()) if (!have.has(r.id)) { have.add(r.id); rows.push(r); }
    for (const r of readAsksWaiting(rows.map(toAlert))) if (!have.has(r.id)) rows.push(r);
    rows.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  }
  return rows.map(toAlert).map((a) => (ASK_KINDS.includes(a.kind) && stillOpen(a) ? { ...a, open: true } : a));
}

// The read alerts of what waits on the owner now that `have` does not hold: each waiting card's
// own alert, looked up by its session (the index's key), never by a walk over the table.
function readAsksWaiting(have: Alert[]): Row[] {
  const { store } = D();
  const named = (key: string) => new Set(have.map((a) => a.data?.[key]).filter(Boolean).map(String));
  const waits: { session: string; key: string; value: string }[] = [
    ...(perm.gate?.approvals({ pending: true }) ?? []).map((a) => ({ session: a.session_id, key: "approval_id", value: a.id })),
    ...allPendingQuestions().map((q) => ({ session: q.session_id, key: "call_id", value: q.call_id })),
    ...plansWaiting().map((p) => ({ session: p.session_id, key: "plan_id", value: p.id })),
    ...secretsWaiting().map((c) => ({ session: c.session_id, key: "secret_id", value: c.id })),
  ];
  const out: Row[] = [];
  const listed: Record<string, Set<string>> = {};
  for (const w of waits) {
    if ((listed[w.key] ??= named(w.key)).has(w.value)) continue;
    const inbox = store.session(w.session)?.parent_id ?? w.session;
    const rows = store.db.query<Row, [string]>("SELECT * FROM alerts WHERE read = 1 AND session_id = ? AND kind IN ('approval', 'question') ORDER BY ts DESC LIMIT 200").all(inbox);
    const hit = rows.find((r) => { try { return String(JSON.parse(r.data ?? "{}")[w.key] ?? "") === w.value; } catch { return false; } });
    if (hit) out.push(hit);
  }
  return out;
}

// Unread counts: in all, per inbox session (a parent counts its agents'), per
// agent session (so the parent's agent list can say which one), and `fresh`:
// per session, the unread ones the owner did not keep unread on purpose.
export function unreadCounts(): { total: number; sessions: Record<string, number>; children: Record<string, number>; fresh: Record<string, number>; rev: number } {
  const rows = D().store.db
    .query<{ session_id: string | null; child: string | null; kept: number; n: number }, []>(
      "SELECT session_id, json_extract(data, '$.child_session') AS child, kept, COUNT(*) AS n FROM alerts WHERE read = 0 GROUP BY session_id, child, kept",
    ).all();
  const sessions: Record<string, number> = {};
  const children: Record<string, number> = {};
  const fresh: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    total += r.n;
    if (r.session_id) {
      sessions[r.session_id] = (sessions[r.session_id] ?? 0) + r.n;
      if (!r.kept) fresh[r.session_id] = (fresh[r.session_id] ?? 0) + r.n;
    }
    if (r.child) children[r.child] = (children[r.child] ?? 0) + r.n;
  }
  return { total, sessions, children, fresh, rev: currentRev() };
}

// Each page reports where its owner is: which session it works in, which
// sessions its panes show in view (a pane scrolled off the window, or one a
// panel lies over, is not shown), whether it has focus, and how long ago the
// owner last did something in it, fresh for 45 s.
// - The owner is watching a session while any page that shows it has focus:
//   a finish there is seen, not unread.
// - They are attending it while they also did something in that page within
//   the last minute. Only then is a notification of what calls them (an ask,
//   a failure) held back: it is in front of them. It is sent once that stops
//   being true and the thing still waits (tickWithheld), so a focused page
//   left open mutes nothing.
// One page in the background says nothing about another.
const ATTEND_MS = 60_000;
const presence = new Map<string, { at: number; session_id: string | null; focused: boolean; shown: string[]; input?: number }>();
export function setPresence(session_id: string | null, focused: boolean, page = "_", shown: string[] = [], idle_ms?: number) {
  const now = Date.now();
  for (const [k, p] of presence) if (now - p.at >= 45_000) presence.delete(k);
  presence.set(page, { at: now, session_id, focused, shown, ...(idle_ms === undefined ? {} : { input: now - idle_ms }) });
}
const freshFocused = () => [...presence.values()].filter((p) => Date.now() - p.at < 45_000 && p.focused);
export const atDesk = () => freshFocused().length > 0;
const shows = (p: { session_id: string | null; shown: string[] }, ids: (string | null | undefined)[]) => ids.some((id) => !!id && (p.session_id === id || p.shown.includes(id)));
const watching = (...ids: (string | null | undefined)[]) => freshFocused().some((p) => shows(p, ids));
const attending = (...ids: (string | null | undefined)[]) => freshFocused().some((p) => shows(p, ids) && p.input !== undefined && Date.now() - p.input < ATTEND_MS);

const SECRETS = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const scrub = (t: string) => t.replace(SECRETS, "[secret]");

// Hands the alert to each channel on its own: one that throws or rejects is
// recorded on the alert and never stops the others.
function deliverTo(a: Alert, ids: string[]) {
  for (const c of ids) {
    const ch = channels.get(c);
    if (!ch) continue;
    Promise.resolve()
      .then(() => ch.deliver(a))
      .then(() => setDelivery(a.id, c, { state: "sent" }))
      .catch((e) => {
        setDelivery(a.id, c, { state: "failed", error: clip(String((e as Error)?.message ?? e), 200) });
        capture(e, { at: "alert channel", channel: c, alert: a.id });
      });
  }
}

function setDelivery(id: string, channel: string, d: Delivery[string]) {
  try {
    const a = getAlert(id);
    if (!a) return;
    const delivery = { ...a.delivery, [channel]: d };
    D().store.db.query("UPDATE alerts SET delivery = ? WHERE id = ?").run(JSON.stringify(delivery), id);
    emit("alert", { ...a, delivery });
  } catch (e) {
    capture(e, { at: "alert delivery state", alert: id });
  }
}

// Sends again to the channels that failed for this alert, and only those.
export function retry(id: string): Alert | undefined {
  const a = getAlert(id);
  if (!a) return undefined;
  const failed = Object.entries(a.delivery ?? {}).filter(([c, d]) => d.state === "failed" && channels.get(c)?.available()).map(([c]) => c);
  if (!failed.length) return a;
  const delivery = { ...a.delivery, ...Object.fromEntries(failed.map((c) => [c, { state: "pending" as const }])) };
  D().store.db.query("UPDATE alerts SET delivery = ? WHERE id = ?").run(JSON.stringify(delivery), id);
  const next = { ...a, delivery };
  emit("alert", next);
  deliverTo(next, failed);
  return next;
}

const DECISION: Partial<Record<AlertKind, string>> = { approval: "approval_id", question: "call_id" };
// The session a question's alert was asked in (an agent's own, under its parent's inbox row).
const ASKED_IN = "COALESCE(json_extract(data, '$.open_session'), session_id)";

// The channels that interrupt the owner (a desktop banner, the phone). They
// carry what needs them or what they would want to know now: a question or an
// approval, a failure that stopped their session, a loop that failed, a usage
// limit, and what the model was told to tell them (agent). A routine finish
// stays in the inbox (its count on the bell and the row's dot), unless the
// turn ran long, or completion is "always" (they asked to hear every finish).
// Long is five minutes: a turn that short is one they are usually still at the
// desk for (watching it, or in the next pane), while one that ran minutes is
// one they left to do something else; Claude Code's own idle notice waits a
// minute of nothing to do, and a finish is less urgent than an input wait.
// A call full auto refused stays quiet too: nothing waits on the owner, the
// session goes on, and the inbox lists it with one retry to let through.
const INTERRUPTS = new Set(["desktop", "push"]);
export const LONG_TURN_MS = 5 * 60_000;
const routine = (kind: AlertKind, data: unknown, st: AlertSettings) =>
  kind === "snooze_over" || kind === "refused" || (kind === "finished" && st.completion !== "always" && !(Number((data as { ran_ms?: number } | undefined)?.ran_ms) >= LONG_TURN_MS));

export function raise(kind: AlertKind, sessionId: string | null, title: string, body: string, data?: unknown): Alert | undefined {
  try {
    const { store } = D();
    const s = sessionId ? store.session(sessionId) : undefined;
    if (sessionId && !s) return undefined;
    // A subagent's alerts belong to its parent's session in the inbox, with the
    // agent named so two agents' alerts never read alike.
    const sid = s?.parent_id ?? sessionId;
    const child = s?.parent_id ? { child_session: sessionId, child_title: s.title || undefined } : {};
    const st = settings();
    if (kind === "finished") {
      if (st.completion === "never") return undefined;
      if (st.completion === "background" && watching(sid, sessionId)) return undefined;
    }
    const key = DECISION[kind];
    const decision = key ? (data as Record<string, unknown> | undefined)?.[key] : undefined;
    if (key && decision) {
      // An approval or a question is its own decision: the same one raised again
      // replaces its row; a different one (a sibling agent's) stands beside it.
      // (A call id is its session's: another session's question under the same id is another decision.)
      store.db.query(`DELETE FROM alerts WHERE read = 0 AND kind = ? AND json_extract(data, '$.${key}') = ?${key === "call_id" ? ` AND ${ASKED_IN} = ?` : ""}`)
        .run(...[kind, String(decision), ...(key === "call_id" ? [String((data as { open_session?: string }).open_session ?? sessionId)] : [])]);
    } else if (sid) {
      // A newer notice of the same kind from the same source replaces the unread
      // one: one live row per session and kind (the activity list keeps each).
      store.db.query("DELETE FROM alerts WHERE session_id = ? AND kind = ? AND read = 0 AND COALESCE(json_extract(data, '$.child_session'), '') = ?")
        .run(sid, kind, s?.parent_id ? sessionId! : "");
    }
    const chosen = st.routes[kind] ?? [];
    const quietKind = routine(kind, data, st);
    const routed = chosen.filter((c) => channels.get(c)?.available() && !(quietKind && INTERRUPTS.has(c)));
    // A snoozed session's routine alert is put away read; a global snooze keeps
    // everything off the channels.
    const f = snooze.filter(kind, sid);
    // What calls the owner (an ask, something that went wrong) is never read because its session is
    // on screen: it stays unread until it is answered or its session is opened. Its notification is
    // held back only while they attend the session, and goes out when they no longer do and it still waits.
    // Anything else in a session they watch is seen there: read, and nothing leaves the machine for it.
    const calls = ASK_KINDS.includes(kind) || WRONG_KINDS.includes(kind);
    const watched = !calls && watching(sid, sessionId);
    const withheld = calls && f.deliver && !f.quiet && routed.length > 0 && attending(sid, sessionId);
    const sendTo = watched || withheld || !f.deliver || f.quiet ? [] : routed;
    // Why nothing left the inbox when nothing did: no route chosen, or the
    // chosen ones are not set up (judged now, when it was raised).
    const inboxOnly = sendTo.length || watched || withheld || !f.deliver || f.quiet ? {}
      : { inbox_only: !chosen.length ? { no_route: true } : quietKind && chosen.some((c) => INTERRUPTS.has(c) && channels.get(c)?.available()) ? { routine: true } : { not_set_up: chosen } };
    const flags = { ...(f.deliver ? {} : { snoozed: true }), ...(f.quiet ? { held: true } : {}), ...(withheld ? { withheld: routed } : {}) };
    if (withheld) withheldMaybe = true;
    const extra = { ...child, ...flags, ...inboxOnly };
    const stored = Object.keys(extra).length ? { ...(data as object), ...extra } : data;
    const delivery: Delivery | undefined = sendTo.length ? Object.fromEntries(sendTo.map((c) => [c, { state: "pending" as const }])) : undefined;
    const a: Alert = {
      id: Bun.randomUUIDv7(), ts: Date.now(), kind, session_id: sid, read: watched || !f.deliver,
      title: clip(scrub(title), 200), body: clip(scrub(body), 500), data: stored, channels: sendTo, delivery, rev: nextRev(), kept: false,
    };
    store.db.query("INSERT INTO alerts (id, ts, kind, session_id, title, body, read, data, channels, delivery, rev, kept) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)")
      .run(a.id, a.ts, kind, sid, a.title, a.body, a.read ? 1 : 0, stored ? JSON.stringify(stored) : null, JSON.stringify(sendTo), delivery ? JSON.stringify(delivery) : null, a.rev);
    // An ask is open from the moment it is raised: its card waits.
    if (ASK_KINDS.includes(kind) && stillOpen(a)) a.open = true;
    emit("alert", a);
    activity.record("alert", kind, sessionId, `${a.title}: ${a.body}`, { alert_id: a.id, ...flags, ...(key && decision ? { [key]: String(decision) } : {}) });
    deliverTo(a, sendTo);
    return a;
  } catch (e) {
    capture(e, { at: "raise alert", kind });
    return undefined;
  }
}
alertHook.raise = (kind, sessionId, title, body, data) => void raise(kind as AlertKind, sessionId, title, body, data);

// The notifications held back while the owner attended a session: each goes to its channels once
// they no longer attend it, if it is still unread and (an ask) its card still waits. Nothing is
// read from the table while none is held (after a start that is not known, so the first look reads).
let withheldMaybe = true;
let withheldAt = 0;
export function tickWithheld(now = Date.now()) {
  if (!withheldMaybe || now - withheldAt < 3000) return;
  withheldAt = now;
  try {
    const db = D().store.db;
    const held = db.query<Row, []>("SELECT * FROM alerts WHERE read = 0 AND json_extract(data, '$.withheld') IS NOT NULL").all().map(toAlert);
    if (!held.length) { withheldMaybe = false; return; }
    for (const a of held) {
      if (attending(a.session_id, a.data?.child_session, a.data?.open_session)) continue;
      const { withheld, ...rest } = a.data as { withheld: string[] } & Record<string, unknown>;
      const waits = !ASK_KINDS.includes(a.kind) || stillOpen(a);
      const sendTo = waits ? withheld.filter((c) => channels.get(c)?.available()) : [];
      const delivery: Delivery | undefined = sendTo.length ? Object.fromEntries(sendTo.map((c) => [c, { state: "pending" as const }])) : undefined;
      db.query("UPDATE alerts SET data = ?, channels = ?, delivery = ? WHERE id = ?").run(JSON.stringify(rest), JSON.stringify(sendTo), delivery ? JSON.stringify(delivery) : null, a.id);
      const next: Alert = { ...a, data: rest, channels: sendTo, delivery };
      emit("alert", next);
      deliverTo(next, sendTo);
    }
  } catch (e) {
    capture(e, { at: "withheld alerts" });
  }
}

// The snoozes whose time came: each session wakes with one alert, and the end
// of a global snooze says how many alerts it held.
export function tickSnoozes() {
  for (const s of snooze.due()) {
    if (s.session_id === snooze.GLOBAL_ID) {
      snooze.end(s.session_id, "its time came");
      if (s.muted) raise("snooze_over", null, "Alerts are back", `${s.muted} alert${s.muted > 1 ? "s" : ""} came while alerts were snoozed.`);
      continue;
    }
    const sess = D().store.session(s.session_id);
    snooze.end(s.session_id, "its time came");
    if (sess) raise("snooze_over", s.session_id, `Snooze over: ${sess.title || "a session"}`, s.muted ? `${s.muted} alert${s.muted > 1 ? "s" : ""} were put away while it was snoozed.` : "Back from snooze.", { open_session: s.session_id });
  }
}

// Whether the session (or one of its agents) has a card only the owner can
// answer: a pending approval, a question not yet answered, a plan to approve.
export function hasOpenCard(sessionId: string): boolean {
  const s = D().store.session(sessionId);
  return !!s && sessionState(s).watch === "need";
}

// Reads alerts: these ids, one session's, or all. `seen` is the inbox revision
// the page had when the owner acted: an alert that became unread after it (a
// new one, or one marked unread since) is left alone, so a replayed or late
// request never reads what the owner has not seen. `auto` is a page reading the
// session on screen: it leaves alone what the owner kept unread, and what calls
// them (an ask, a failure), which is read when it is answered or its session is
// opened. `touch` is the owner acting in that session's pane: that is opening it,
// so it reads those too, and still leaves what they kept unread.
export function markRead(opts: { ids?: string[]; session_id?: string; all?: boolean; seen?: number; auto?: boolean; touch?: boolean }): number {
  const db = D().store.db;
  const where = ["read = 0"];
  const args: (string | number)[] = [];
  if (opts.ids) {
    if (!opts.ids.length) return 0;
    where.push(`id IN (${opts.ids.map(() => "?").join(", ")})`);
    args.push(...opts.ids.map(String));
  } else if (opts.session_id) { where.push("session_id = ?"); args.push(opts.session_id); }
  else if (!opts.all) return 0;
  if (Number.isFinite(opts.seen)) { where.push("rev <= ?"); args.push(Number(opts.seen)); }
  if (opts.auto || opts.touch) where.push("kept = 0");
  if (opts.auto) where.push(`kind NOT IN (${CALLS.map((k) => `'${k}'`).join(", ")})`);
  const hit = db.query<{ id: string; session_id: string | null }, any>(`SELECT id, session_id FROM alerts WHERE ${where.join(" AND ")}`).all(...args);
  if (!hit.length) return 0;
  nextRev();
  const upd = db.query("UPDATE alerts SET read = 1, kept = 0 WHERE id = ?");
  db.transaction(() => { for (const h of hit) upd.run(h.id); })();
  // Each channel takes back what it shows for a session once nothing in it is unread.
  const left = unreadCounts().sessions;
  for (const sid of new Set(hit.map((h) => h.session_id).filter((x): x is string => !!x))) {
    if (left[sid]) continue;
    for (const c of channels.values()) {
      if (!c.withdraw) continue;
      Promise.resolve().then(() => c.withdraw!(sid)).catch((e) => capture(e, { at: "alert withdraw", channel: c.id }));
    }
  }
  emit("alerts_read", { ...opts, changed: hit.length, rev: currentRev() });
  return hit.length;
}

const CALLS = [...ASK_KINDS, ...WRONG_KINDS];

// Whether an alert whose data names this value was raised, read or not: a
// question put back on its card after a restart is the one the owner was told of.
// (Of that session: another session's call may carry the same id.)
export const raisedFor = (key: string, value: string, sessionId: string) =>
  !!D().store.db.query(`SELECT 1 FROM alerts WHERE json_extract(data, ?) = ? AND ${ASKED_IN} = ? LIMIT 1`).get(`$.${key}`, value, sessionId);

// Reads the unread alerts whose data names this value (an answered approval).
// `askedIn`: only the alerts of the session that asked (a question's call id is its session's).
export function readWhere(key: string, value: string, askedIn?: string) {
  const sessions = D().store.db.query<{ session_id: string | null }, [string, string]>("SELECT DISTINCT session_id FROM alerts WHERE json_extract(data, ?) = ?").all(`$.${key}`, value);
  for (const r of sessions) if (r.session_id && key === "approval_id") snooze.resume(r.session_id);
  const ids = D().store.db.query<{ id: string }, string[]>(`SELECT id FROM alerts WHERE read = 0 AND json_extract(data, ?) = ?${askedIn ? ` AND ${ASKED_IN} = ?` : ""}`)
    .all(...[`$.${key}`, value, ...(askedIn ? [askedIn] : [])]).map((r) => r.id);
  if (ids.length) markRead({ ids });
  // An ask the owner had looked at and now answered is read already: the pages are told all the same, since it waits no more.
  else if (sessions.length) emit("alerts_read", { settled: value, rev: currentRev() });
}

// The owner wants to come back to it: unread again, at a new revision, and kept
// until the owner reads it on purpose.
export function markUnread(id: string): boolean {
  const db = D().store.db;
  if (!db.query("SELECT 1 FROM alerts WHERE id = ?").get(id)) return false;
  db.query("UPDATE alerts SET read = 0, kept = 1, rev = ? WHERE id = ?").run(nextRev(), id);
  emit("alerts_read", { unread: id, rev: currentRev() });
  return true;
}

// The owner marks a session unread to come back to it: its newest alert is unread
// again and kept (a page showing the session does not read it back). A session
// nothing was raised for (they were watching when it ended) gets a row of its
// own, with what it ended with.
export function markSessionUnread(sessionId: string): boolean {
  const { store } = D();
  const s = store.session(sessionId);
  if (!s || s.parent_id) return false;
  // The session's own newest word, never an ask: a request that was answered does not come back as one that waits.
  const last = store.db.query<{ id: string }, [string]>(`SELECT id FROM alerts WHERE session_id = ? AND kind NOT IN (${ASK_KINDS.map((k) => `'${k}'`).join(", ")}) AND json_extract(data, '$.child_session') IS NULL ORDER BY ts DESC, id DESC LIMIT 1`).get(sessionId);
  if (last) return markUnread(last.id);
  const failed = !!s.settings.failed_ms;
  const a: Alert = {
    id: Bun.randomUUIDv7(), ts: Date.now(), kind: failed ? "failed" : "finished", session_id: sessionId, read: false,
    title: clip(scrub(failed ? `Failed: ${s.title || "Session"}` : s.title || "Session"), 200), body: lastLine(sessionId).line || "Marked unread.", data: { marked: true }, channels: [], rev: nextRev(), kept: true,
  };
  store.db.query("INSERT INTO alerts (id, ts, kind, session_id, title, body, read, data, channels, delivery, rev, kept) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '[]', NULL, ?, 1)")
    .run(a.id, a.ts, a.kind, sessionId, a.title, a.body, JSON.stringify(a.data), a.rev);
  emit("alert", a);
  return true;
}

// What a session last said, in one line: the reply its last turn ended with, or
// the failure it ended in. For a list that shows a session it has not opened.
export function lastLine(sessionId: string): { line: string; ts?: number } {
  const rows = D().store.db.query<{ kind: string; data: string; ts: number }, [string]>("SELECT kind, data, ts FROM events WHERE session_id = ? AND kind IN ('assistant', 'error') ORDER BY seq DESC LIMIT 12").all(sessionId);
  for (const r of rows) {
    try {
      const d = JSON.parse(r.data);
      const text = r.kind === "error" ? String(d.message ?? "").split("\n")[0]!.trim() : ((d.blocks ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      if (text) return { line: clip(scrub(r.kind === "error" ? text : plainLine(text)), 300), ts: r.ts };
    } catch {}
  }
  return { line: "" };
}

// --- channels ------------------------------------------------------------------

// Desktop: one silent notification per session, replaced by the next and
// closed when the session is read. On GNOME, GJS also receives the click;
// retain passive delivery where GJS is absent or cannot start.
const shown = new Map<string, number>();
const gdbusArgs = ["call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications"];
let desktop: ReturnType<typeof desktopNotifications> | undefined;

// Where an alert's click leads: a path of the page (with its query). The
// session it names, at the card or the message it is about; the inbox when
// the session is gone.
export function alertPath(id: string): string {
  const a = getAlert(id);
  const t = a && alertTarget(a);
  const approval = a?.kind === "approval" ? a.data?.approval_id : undefined;
  const session = approval ? (t?.approval === "pending" ? t.parent ?? t.open : null) : t?.open;
  if (!session) return "/?inbox=1";
  const q = new URLSearchParams();
  if (approval) q.set("approval", approval);
  else if (a?.data?.event_id && !t?.child_deleted) q.set("e", a.data.event_id);
  return `/s/${encodeURIComponent(session)}${q.size ? `?${q}` : ""}`;
}

function openDesktopAlert(id: string, token?: string) {
  try {
    const base = lockedDaemon(D().store.stateDir)?.url;
    if (!base) return;
    const url = new URL(alertPath(id), base);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "localhost";
    if (!openUrl(url.href, token)) throw new Error("could not start the browser");
  } catch (e) {
    capture(e, { at: "desktop notification click", alert: id });
  }
}

// gdbus reads every argument as GVariant text. A bare string works only by its
// fallback (wrap in double quotes, escaping the quotes and nothing else), which
// refuses a backslash before a quote (JSON in a body) or at the end, and gdbus
// takes text that starts with a dash for an option of its own. So each string
// goes quoted: backslash and quote escaped, a line break as \n, no NUL (an
// argument cannot hold one).
export function gvariantString(s: string) {
  return `'${s.replace(/\0/g, "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

registerChannel({
  id: "desktop",
  label: "Desktop notification",
  // An attached desktop app shows them itself, whatever this daemon could do alone.
  available: () => shellShows() || (process.env.KEEL_DESKTOP_NOTIFY !== "off" && !!(process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR) && !!(Bun.which("gjs") || Bun.which("gdbus"))),
  async deliver(a) {
    const key = a.session_id ?? "_";
    const urgency = a.kind === "approval" || a.kind === "question" || a.kind === "failed" || a.kind === "loop_failed" ? 2 : 1;
    // The desktop app's to show while one is attached: its click opens the
    // app's window. It is the app's once the app said the notification is on
    // screen; with no word in a few seconds it is shown here instead. Never
    // both: one this daemon showed for the session before the app came is
    // taken down first, and so is this daemon's copy when the app's word
    // comes late.
    if (await handShell({ key, alert: a.id, title: a.title.replaceAll("\0", ""), body: a.body.replaceAll("\0", ""), urgency, kind: a.kind }, { late: () => void withdrawOwn(key).catch(() => {}) })) {
      void withdrawOwn(key).catch(() => {});
      return;
    }
    if (process.env.KEEL_DESKTOP_NOTIFY === "off") throw new Error("no desktop app showed the alert, and this daemon shows none itself");
    const gjs = Bun.which("gjs");
    if (gjs) {
      if (!desktop || desktop.ended) {
        try { desktop = desktopNotifications(gjs, openDesktopAlert); }
        catch (e) { if (!Bun.which("gdbus")) throw e; }
      }
      const helper = desktop;
      if (helper && await helper.ready && !helper.ended) {
        // The service may have shown this even if it never acknowledged.
        // No retry through gdbus after the request has left this daemon.
        return helper.send({ key, alert: a.id, title: a.title.replaceAll("\0", ""), body: a.body.replaceAll("\0", ""), urgency, kind: a.kind });
      }
    }
    const p = Bun.spawn([
      "gdbus", ...gdbusArgs, "--method", "org.freedesktop.Notifications.Notify",
      "Keel", String(shown.get(key) ?? 0), "", gvariantString(a.title), gvariantString(a.body), "[]",
      `{'suppress-sound': <true>, 'urgency': <byte ${urgency}>, 'desktop-entry': <'keel'>, 'category': <${gvariantString(`keel.${a.kind}`)}>}`,
      "int32 -1",
    ], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([readText(p.stdout), readText(p.stderr), p.exited]);
    if (code !== 0) throw new Error(`gdbus Notify failed: ${err.trim()}`);
    const m = out.match(/uint32 (\d+)/);
    if (m) shown.set(key, Number(m[1]));
  },
  async withdraw(sessionId) {
    tellShells("withdraw", { key: sessionId });
    await withdrawOwn(sessionId);
  },
});

// Takes down the notification this daemon itself showed for a session, if any.
async function withdrawOwn(sessionId: string) {
  const helper = desktop;
  if (helper && await helper.ready && !helper.ended) await helper.send({ key: sessionId });
  const id = shown.get(sessionId);
  if (!id) return;
  shown.delete(sessionId);
  await Bun.spawn(["gdbus", ...gdbusArgs, "--method", "org.freedesktop.Notifications.CloseNotification", String(id)], { stdout: "ignore", stderr: "ignore" }).exited;
}

// Command: KEEL_NOTIFY_COMMAND (split on spaces) gets the alert as JSON in one
// more argument. Nothing waits for it but the alert's own handoff state: sent
// when it exits 0, failed with its error output otherwise.
registerChannel({
  id: "command",
  label: "KEEL_NOTIFY_COMMAND",
  available: () => !!process.env.KEEL_NOTIFY_COMMAND?.trim(),
  async deliver(a) {
    const argv = process.env.KEEL_NOTIFY_COMMAND!.trim().split(/\s+/);
    const p = Bun.spawn([...argv, JSON.stringify(a)], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [err, code] = await Promise.all([readText(p.stderr), p.exited]);
    if (code !== 0) throw new Error(`KEEL_NOTIFY_COMMAND exited ${code}: ${err.trim().slice(0, 300)}`);
  },
});

// --- turn outcomes -------------------------------------------------------------

const LIMIT = /rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded|throttl/i;

// Called after a turn has fully ended, when nothing else is lined up for the
// session (a subagent's turns are its parent's to report; a loop run reports
// only when it fails). Only this turn's events speak for it: a turn with no
// reply of its own never quotes an earlier one. The alert names the reply it
// quotes, so opening it shows that reply.
export function onTurnEnd(sessionId: string, reason: string, opts: { subagent: boolean; loopRun: boolean; more: boolean }) {
  if (opts.subagent || opts.more) return;
  // Parked for a daemon stop: the turn has not finished, the next daemon goes on with it.
  if (reason === "restart") return;
  const { store } = D();
  const s = store.session(sessionId);
  if (!s || s.archived) return;
  const title = s.title || "Session";
  const all = store.events(sessionId, Math.max(0, store.lastSeq(sessionId) - 200));
  const start = all.findLastIndex((e) => e.kind === "turn_start");
  const evs = start >= 0 ? all.slice(start) : all;
  if (reason === "error") {
    const err = [...evs].reverse().find((e) => e.kind === "error")?.data.message ?? "The turn failed.";
    if (opts.loopRun) return; // the loop reports its own failure
    raise(LIMIT.test(err) ? "limit" : "failed", sessionId, LIMIT.test(err) ? `Usage limit: ${title}` : `Failed: ${title}`, err.split("\n")[0]!);
    return;
  }
  if (reason === "max_tokens") { raise("failed", sessionId, `Cut off: ${title}`, "The reply reached the model's output limit."); return; }
  if (reason === "interrupted" || opts.loopRun) return;
  // A question that expired unanswered in this turn, with none answered after
  // it: the owner still owes that decision, so the turn is not filed as finished.
  const results = evs.flatMap((e) => (e.kind === "tool_result" ? (e.data.results as any[]).map((r) => ({ r, answered: !!e.data.shown?.[r.tool_use_id]?.answers })) : []));
  const expired = results.findLast((x) => x.r.content === QUESTION_CUT);
  if (expired && !results.slice(results.indexOf(expired) + 1).some((x) => x.answered)) {
    const use = all.flatMap((e) => (e.kind === "assistant" ? (e.data.blocks as any[]) : [])).find((b) => b.type === "tool_use" && b.id === expired.r.tool_use_id);
    const q = use?.input?.questions?.[0]?.question ?? use?.input?.question ?? use?.input?.prompt;
    raise("question", sessionId, `Unanswered question: ${title}`, q ? `Expired before you answered: ${q}` : "A question expired before you answered it.", { call_id: expired.r.tool_use_id, open_session: sessionId, expired: true });
    return;
  }
  let text = "";
  let event: string | undefined;
  for (let i = evs.length - 1; i >= 0 && !text; i--) {
    const e = evs[i]!;
    if (e.kind !== "assistant") continue;
    text = (e.data.blocks as any[]).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (text) event = e.id;
  }
  // How long the turn ran: a long one is worth a desktop notice (LONG_TURN_MS).
  const ran_ms = start >= 0 ? Date.now() - all[start]!.ts : undefined;
  raise("finished", sessionId, title, plainLine(text) || "The turn finished.", event || ran_ms !== undefined ? { ...(event ? { event_id: event } : {}), ...(ran_ms !== undefined ? { ran_ms } : {}) } : undefined);
}
