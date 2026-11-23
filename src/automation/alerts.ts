import * as activity from "./activity.ts";
import { D, alertHook, capture, clip, cursor, emit, inboxCounts } from "./core.ts";
import * as snooze from "./snooze.ts";
import * as perm from "../server/routes/permissions.ts";
import { allPendingQuestions, closedQuestions, pendingQuestions } from "../tools/interact.ts";
import { answerSaid } from "../safety/card.ts";
import { QUESTION_CUT } from "../core/stops.ts";
import { planWaits, plansWaiting } from "../server/routes/plan.ts";
import { sessionState } from "./state.ts";
import { readText } from "../core/proc.ts";
import { plainLine } from "../core/plain.ts";
import { lockedDaemon } from "../core/daemon-lock.ts";
import { openUrl } from "../cli/client.ts";
import { desktopNotifications } from "./desktop.ts";
import { secretsWaiting } from "../server/routes/secrets.ts";
import { ASK_KINDS, STATE_WORD, WRONG_KINDS, failWord, limitWord } from "../core/state-words.ts";
import { classOfText } from "../admin/classes.ts";
import { groupsOf } from "./failures.ts";
import { exampleOf, OTHERS, SELF } from "./failure-groups.ts";
import { handShell, shellShows, tellShells } from "../server/shell.ts";
import { costLine, costs, rankWaiting, type WaitCost, type WaitNow } from "../core/wait-rank.ts";

// What needs the owner becomes one alert: kept in the inbox with unread state,
// sent as a frame, and delivered to the channels the settings name for its
// kind. A channel is anything with deliver(); phone push registers one later.

// `machine`: about a machine of the fleet, not a session (it went out of reach; more of its alerts came than are listed).
// `review`: a pull request review from GitHub is ready, was posted, or failed (src/prreview/watch.ts).
// `outage`: an incident of the daemon's, across sessions (src/automation/incidents.ts): a provider down
// or failing, a refused credential, the judge, a stall, a stop of the daemon, the disk. One an incident.
// `mcp`: an MCP server changed its tool definitions and they wait for the owner (src/mcp/pins.ts).
export const KINDS = ["approval", "question", "finished", "failed", "limit", "loop_failed", "agent", "snooze_over", "regression", "refused", "declined", "machine", "outage", "review", "mcp"] as const;
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
  // What the wait costs as the list is read, for its line (told with a list, not stored; the
  // order's key is the one kept with it as it began: src/core/wait-rank.ts).
  wait_now?: WaitNow;
  // What became of an ask that waits no more, in words (told with a list): how an approval was
  // answered (its choice, from where, by a rule), whether a question was answered or declined.
  outcome?: string;
  // The machine it is about, or the one its session runs on when that is not this one, by its name now.
  machine?: { id: string; name: string };
};

export type AlertChannel = {
  id: string;
  label: string;
  available(): boolean;
  deliver(a: Alert): void | Promise<void>;
  // The owner read the session: take back what is still shown for it.
  withdraw?(sessionId: string): void | Promise<void>;
  // One alert was read (an approval answered) while its session still has another unread:
  // take back what is shown for that alert alone.
  take?(a: Alert): void | Promise<void>;
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
  // `far_session`, `far_id`: an alert kept here for a session of another daemon (see mirror).
  for (const [col, type] of [["rev", "INTEGER NOT NULL DEFAULT 0"], ["kept", "INTEGER NOT NULL DEFAULT 0"], ["delivery", "TEXT"], ["far_session", "TEXT"], ["far_id", "TEXT"]] as const) {
    if (!store.columnExists("alerts", col)) store.migrate(`ALTER TABLE alerts ADD COLUMN ${col} ${type}`);
  }
  store.migrate(`
CREATE UNIQUE INDEX IF NOT EXISTS alerts_far ON alerts(far_id) WHERE far_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_far_session ON alerts(far_session) WHERE far_session IS NOT NULL;
CREATE TABLE IF NOT EXISTS alert_far (machine TEXT PRIMARY KEY, ts INTEGER NOT NULL);
-- An ask's alerts by the card they tell of: the row a card raised again replaces, and the cost
-- its wait began with, read for the cards that wait and nothing else (waitsOf).
CREATE INDEX IF NOT EXISTS alerts_approval_id ON alerts(json_extract(data, '$.approval_id')) WHERE kind = 'approval';
CREATE INDEX IF NOT EXISTS alerts_call_id ON alerts(json_extract(data, '$.call_id')) WHERE kind = 'question';
CREATE INDEX IF NOT EXISTS alerts_plan_id ON alerts(json_extract(data, '$.plan_id')) WHERE kind = 'question';
CREATE TABLE IF NOT EXISTS alert_far_reads (machine TEXT NOT NULL, alert TEXT NOT NULL, PRIMARY KEY (machine, alert));`);
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
// (An ask of another daemon's session is that daemon's to know: here it waits while it is unread,
// and is read when that daemon says it was answered. See `waits`.)
function stillOpen(a: Pick<Alert, "kind" | "session_id" | "data">): boolean {
  if (a.kind === "approval") return !!a.data?.approval_id && perm.gate?.approval(a.data.approval_id)?.state === "pending";
  if (a.kind === "question" && a.data?.plan_id) return planWaits(a.data.open_session ?? a.session_id ?? "", a.data.plan_id);
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

type Row = Omit<Alert, "read" | "data" | "channels" | "delivery" | "kept"> & { read: number; kept: number; data: string | null; channels: string | null; delivery: string | null; far_session?: string | null; far_id?: string | null };
// An alert of another daemon's session reads like any other: its session is the id the pages know it by.
// A machine is named as it is called now (a rename is followed), in the alert's own title too when it is about the machine.
const toAlert = ({ far_session, far_id: _far, ...r }: Row): Alert => named({
  ...r, session_id: r.session_id ?? far_session ?? null, read: !!r.read, kept: !!r.kept, data: r.data ? JSON.parse(r.data) : undefined,
  channels: r.channels ? JSON.parse(r.channels) : [], delivery: r.delivery ? JSON.parse(r.delivery) : undefined,
});
function named(a: Alert): Alert {
  const id = a.data?.far?.machine ?? a.data?.machine_offline ?? a.data?.machine_more;
  if (typeof id !== "string") return a;
  const name = farHook.name?.(id);
  if (!name) return a;
  return { ...a, machine: { id, name }, ...(a.data?.machine_offline ? { title: offlineTitle(name, a.data) } : {}) };
}
// A machine's absence in a few words: "devbox is offline", and once it is back "devbox is back after 42 min".
const outFor = (ms: number) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; };
const offlineTitle = (name: string, d: { since_ms?: number; back_ms?: number }) =>
  typeof d.back_ms === "number" && typeof d.since_ms === "number" ? `${name} is back after ${outFor(d.back_ms - d.since_ms)}` : `${name} is offline`;
// What this daemon asks of the fleet for an alert of another daemon's session (set by the fleet's routes):
// whether that session is still listed, where the alert leads as its own daemon judges it,
// telling that daemon the owner read it here (or wants to come back to it), and what a machine is called.
export type Target = { parent: string | null; child: string | null; child_deleted: boolean; open: string | null; approval?: string };
export const farHook: {
  has?: (session: string) => boolean;
  target?: (machine: string, alert: string) => Promise<Target | null>;
  read?: (machine: string, alerts: string[]) => Promise<unknown>;
  unread?: (machine: string, alert: string) => Promise<unknown>;
  name?: (machine: string) => string | undefined;
} = {};
const FAR_ID = /^([A-Za-z0-9]+)--([\w-]+)$/;
// Where a row about `sessionId` (and maybe one of its agents) leads now.
export function target(sessionId: string | null, childId?: string, approvalId?: string): Target {
  const { store } = D();
  // Another daemon's session is there while its machine lists it.
  const has = (id: string) => (FAR_ID.test(id) ? farHook.has?.(id) ?? false : !!store.session(id));
  const parent = sessionId && has(sessionId) ? sessionId : null;
  const child = childId ? (has(childId) ? childId : null) : undefined;
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

// The same, asked of the daemon the alert came from when it is another's: it
// knows whether its agent is gone and whether its approval still waits. When
// it does not answer, what this daemon knows stands (an unread request counts as waiting).
export async function alertTargetNow(a: Alert): Promise<Target> {
  const here = alertTarget(a);
  const far = a.data?.far as { machine: string; alert: string } | undefined;
  if (!far) return here;
  const told = await farHook.target?.(far.machine, far.alert).catch(() => null);
  const map = (id: string | null) => (id ? `${far.machine}--${id}` : null);
  if (told) return { parent: map(told.parent), child: map(told.child), child_deleted: !!told.child_deleted, open: map(told.open), ...(told.approval ? { approval: told.approval } : {}) };
  return a.data?.approval_id ? { ...here, approval: a.read ? "answered" : "pending" } : here;
}

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
  const memo = new Map<string, WaitNow | undefined>();
  return rows.map(toAlert).map((a) => {
    if (!ASK_KINDS.includes(a.kind)) return withNow(a, false, memo);
    if (waits(a)) return withNow({ ...a, open: true }, true, memo);
    const outcome = outcomeOf(a);
    return outcome ? { ...a, outcome } : a;
  });
}

// What became of an ask that waits no more. An approval is read from its stored record; a question
// from the answers this daemon took (one answered before it started is not known here).
function outcomeOf(a: Alert): string | undefined {
  if (a.kind === "approval" && a.data?.approval_id) {
    const r = perm.gate?.approval(String(a.data.approval_id));
    return r ? answerSaid(r) : undefined;
  }
  if (a.kind === "question" && typeof a.data?.outcome === "string") return a.data.outcome;
  // (An alert from before the outcome was kept with it: what this daemon took, while it remembers.)
  if (a.kind === "question" && a.data?.call_id) {
    const q = closedQuestions(0).findLast((x) => x.call_id === a.data.call_id);
    return q?.how;
  }
  return undefined;
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
      "SELECT COALESCE(session_id, far_session) AS session_id, json_extract(data, '$.child_session') AS child, kept, COUNT(*) AS n FROM alerts WHERE read = 0 GROUP BY 1, child, kept",
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
// A decision's key as the text of its JSON path: written in the statement (a bound path cannot use the
// card's index: alerts_approval_id, alerts_call_id), one fixed text a key.
const KEY_PATH: Record<string, string> = { approval_id: "'$.approval_id'", call_id: "'$.call_id'", plan_id: "'$.plan_id'" };
// The session a question's alert was asked in (an agent's own, under its parent's inbox row).
const ASKED_IN = "COALESCE(json_extract(data, '$.open_session'), session_id, far_session)";

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
const waits = (a: Pick<Alert, "kind" | "session_id" | "data" | "read">) => (a.data?.far ? !a.read : stillOpen(a));
// A word about a machine is a notice, not a failure of work: it stays in the inbox too.
const routine = (kind: AlertKind, data: unknown, st: AlertSettings) =>
  kind === "snooze_over" || kind === "refused" || kind === "machine" || (kind === "finished" && st.completion !== "always" && !(Number((data as { ran_ms?: number } | undefined)?.ran_ms) >= LONG_TURN_MS));

// `silent`: kept in the inbox and told on no channel (an update of a row the owner was told of already).
// An open incident a session's failure is part of (src/automation/incidents.ts): its one alert
// stands for the failure alerts of every session it touched, so these are filed silently. Only a
// failure that names its class (`data.cls`, src/admin/classes.ts) and the session it is about
// (`data.agent_session` for an agent's alert on its parent) can be part of one: the incident
// takes it only when the class is of its cause. A reply cut at its limit and a loop's failure
// name none and are always told.
export const absorbHook: { of?: (sessionId: string, cls: string | undefined) => string | undefined } = {};
const ABSORBED = new Set<AlertKind>(["failed", "limit"]);
const absorbedBy = (kind: AlertKind, sessionId: string, data: unknown) => {
  if (!ABSORBED.has(kind)) return undefined;
  const d = data as { cls?: unknown; agent_session?: unknown } | undefined;
  if (typeof d?.cls !== "string") return undefined;
  return absorbHook.of?.(typeof d.agent_session === "string" ? d.agent_session : sessionId, d.cls);
};

// What a wait on the owner costs as it begins (src/automation/wait-cost.ts), kept with the alert of
// an ask or a failure: the next-look queue's key (src/core/wait-rank.ts).
// `now`: what it costs as it stands, for the line an alert says when it is listed or told.
export const waitHook: { of?: (sessionId: string) => WaitCost | undefined; now?: (sessionId: string) => WaitNow | undefined } = {};
const COSTED = new Set<AlertKind>(["approval", "question", "failed"]);

// The cost each card that waits began with, and the time it was first asked: what the phone
// orders its cards by. Read by the card's own key on its index, one row a card: an approval by
// its id, a question by its call and a plan by its id, each in the session that asks.
export type WaitOf = { wait?: WaitCost; ts: number };
export type WaitCard = { approval: string } | { call: string; session: string } | { plan: string; session: string };
const FIRST = "SELECT ts AS t, json_extract(data, '$.wait') AS w FROM alerts WHERE far_id IS NULL AND ";
export const WAIT_OF_SQL = {
  approval: `${FIRST}kind = 'approval' AND json_extract(data, '$.approval_id') = ? ORDER BY ts LIMIT 1`,
  call: `${FIRST}kind = 'question' AND json_extract(data, '$.call_id') = ? AND ${ASKED_IN} = ? ORDER BY ts LIMIT 1`,
  plan: `${FIRST}kind = 'question' AND json_extract(data, '$.plan_id') = ? AND ${ASKED_IN} = ? ORDER BY ts LIMIT 1`,
};
export function waitOf(card: WaitCard): WaitOf | undefined {
  const db = D().store.db;
  const r = "approval" in card ? db.query<{ t: number; w: string | null }, [string]>(WAIT_OF_SQL.approval).get(card.approval)
    : "call" in card ? db.query<{ t: number; w: string | null }, [string, string]>(WAIT_OF_SQL.call).get(card.call, card.session)
    : db.query<{ t: number; w: string | null }, [string, string]>(WAIT_OF_SQL.plan).get(card.plan, card.session);
  if (!r) return undefined;
  let wait: WaitCost | undefined;
  if (r.w) try { wait = JSON.parse(r.w); } catch {}
  return { ts: r.t, ...(wait ? { wait } : {}) };
}

// What a wait costs now, for the line of an alert that waits on the owner (an ask whose card waits,
// a failure of a session still failed that the owner has not looked at). `memo`: one walk a session.
const askerOfAlert = (a: Alert): string | null => a.data?.child_session ?? a.data?.open_session ?? a.session_id;
function nowOf(a: Alert, open: boolean, memo: Map<string, WaitNow | undefined>): WaitNow | undefined {
  if (!waitHook.now || a.data?.far) return undefined;
  const asker = askerOfAlert(a);
  if (!asker) return undefined;
  if (!open && !(a.kind === "failed" && !a.read && D().store.session(asker)?.settings?.failed_ms)) return undefined;
  if (!memo.has(asker)) {
    let w: WaitNow | undefined;
    try { w = waitHook.now(asker); } catch (e) { capture(e, { at: "the cost of a wait now", kind: a.kind }); }
    memo.set(asker, w);
  }
  return memo.get(asker);
}
const withNow = (a: Alert, open: boolean, memo: Map<string, WaitNow | undefined>): Alert => {
  const w = nowOf(a, open, memo);
  return w ? { ...a, wait_now: w } : a;
};

// What an alert's wait costs as it is told (a notification, a push, sent now or released later):
// as it stands now, else as it began. Only an alert whose wait was costed as it began says one.
export function liveWait(a: Pick<Alert, "session_id" | "data">): WaitNow | undefined {
  if (!a.data?.wait) return undefined;
  const asker = askerOfAlert(a as Alert);
  try { return (asker ? waitHook.now?.(asker) : undefined) ?? a.data.wait; } catch { return a.data.wait; }
}

// What the waits of these alerts cost now, by alert id (the page's line, again on its clock).
export function waitsNow(ids: string[]): Record<string, WaitNow> {
  const db = D().store.db;
  const memo = new Map<string, WaitNow | undefined>();
  const out: Record<string, WaitNow> = {};
  for (const id of ids.slice(0, 200)) {
    const r = db.query<Row, [string]>("SELECT * FROM alerts WHERE id = ?").get(id);
    if (!r) continue;
    const a = toAlert(r);
    const w = nowOf(a, ASK_KINDS.includes(a.kind) && waits(a), memo);
    if (w) out[id] = w;
  }
  return out;
}

export function raise(kind: AlertKind, sessionId: string | null, title: string, body: string, data?: unknown, silent = false): Alert | undefined {
  try {
    const { store } = D();
    if (COSTED.has(kind) && sessionId && !(data as { expired?: boolean } | undefined)?.expired) {
      let wait: WaitCost | undefined;
      try { wait = waitHook.of?.(sessionId); } catch (e) { capture(e, { at: "the cost of a wait", kind }); }
      if (wait) data = { ...(data as object), wait };
    }
    const incident = !silent && sessionId ? absorbedBy(kind, sessionId, data) : undefined;
    if (incident) { silent = true; data = { ...(data as object), in_incident: incident }; }
    const s = sessionId ? store.session(sessionId) : undefined;
    if (sessionId && !s) return undefined;
    // A subagent's alerts belong to its parent's session in the inbox, with the
    // agent named so two agents' alerts never read alike.
    const sid = s?.parent_id ?? sessionId;
    const child = s?.parent_id ? { child_session: sessionId, child_title: s.title || undefined } : {};
    return file({ kind, sid, from: sessionId, source: s?.parent_id ? sessionId! : "", title, body, data, child, ...(silent ? { silent: true } : {}) });
  } catch (e) {
    capture(e, { at: "raise alert", kind });
    return undefined;
  }
}

// One alert into the inbox, by this daemon's rules: its completion setting,
// who is watching, its snoozes and its routes. `sid`: the inbox session;
// `from`: the session it is about (an agent's own); `source`: that agent's
// session when it is not the inbox session's own, else "". `far`: the alert
// was raised by another daemon for one of its sessions (see mirror).
// `silent`: kept in the inbox and told on no channel (one of many that came at once).
type Filing = {
  kind: AlertKind; sid: string | null; from: string | null; source: string; title: string; body: string; data?: unknown; child?: object;
  far?: { machine: string; id: string; read: boolean };
  silent?: boolean;
};
// Alerts filed in one go keep their order: each is a millisecond after the last at least.
let lastTs = 0;
function file(x: Filing): Alert | undefined {
  const { store } = D();
  const { kind, sid, data } = x;
  // Another daemon's session is no row of this daemon's sessions: it is kept beside, under the id pages know it by.
  const col = x.far ? "far_session" : "session_id";
  const st = settings();
  if (kind === "finished") {
    if (st.completion === "never") return undefined;
    if (st.completion === "background" && watching(sid, x.from)) return undefined;
  }
  const key = DECISION[kind];
  const decision = key ? (data as Record<string, unknown> | undefined)?.[key] : undefined;
  // A decision raised again (a daemon restart puts its card back, a redelivery) is the same wait: its row
  // keeps the time it was first asked, so its age is one everywhere and does not start again at a restart.
  // Of the same origin only: an id another daemon names is that daemon's, and never stands for,
  // hides or removes an alert of this one's.
  const origin = x.far ? " AND json_extract(data, '$.far.machine') = ?" : " AND far_id IS NULL";
  const theirs = x.far ? [x.far.machine] : [];
  // One commit for the row it replaces, its number and the row itself (they were three); what is told of it goes out after.
  const made = store.db.transaction(() => {
  let asked: number | undefined;
  // And the cost it had when it began to wait: the queue's key is read once (src/core/wait-rank.ts).
  let first: unknown;
  if (key && decision) {
    // (The kind is written in the statement, so the card's index serves it.)
    const r = store.db.query<{ t: number; w: string | null }, string[]>(`SELECT ts AS t, json_extract(data, '$.wait') AS w FROM alerts WHERE kind = '${kind}' AND json_extract(data, ${KEY_PATH[key]}) = ?${key === "call_id" ? ` AND ${ASKED_IN} = ?` : ""}${origin} ORDER BY ts LIMIT 1`)
      .get(...[String(decision), ...(key === "call_id" ? [String((data as { open_session?: string }).open_session ?? x.from)] : []), ...theirs]);
    asked = r?.t ?? undefined;
    if (r?.w) try { first = JSON.parse(r.w); } catch {}
  }
  if (key && decision) {
    // An approval or a question is its own decision: the same one raised again
    // replaces its row; a different one (a sibling agent's) stands beside it.
    // (A call id is its session's: another session's question under the same id is another decision.)
    // An approval the owner has looked at and not answered is still listed while it waits: told of
    // again (its card changed while it waits), it is the same row, not a second one beside it.
    if (kind === "approval" && store.db.query(`SELECT 1 FROM alerts WHERE read = 1 AND kind = 'approval' AND json_extract(data, '$.approval_id') = ?${origin} LIMIT 1`).get(...[String(decision), ...theirs])) return undefined;
    store.db.query(`DELETE FROM alerts WHERE read = 0 AND kind = '${kind}' AND json_extract(data, ${KEY_PATH[key]}) = ?${key === "call_id" ? ` AND ${ASKED_IN} = ?` : ""}${origin}`)
      .run(...[String(decision), ...(key === "call_id" ? [String((data as { open_session?: string }).open_session ?? x.from)] : []), ...theirs]);
  } else if (sid && failureFp(data)) {
    // Agents' failures of one cause are one row a cause: a newer count replaces the unread row of its cause, never the session's own failure.
    store.db.query(`DELETE FROM alerts WHERE ${col} = ? AND kind = ? AND read = 0 AND json_extract(data, '$.failure_fp') = ?`).run(sid, kind, failureFp(data)!);
  } else if (sid) {
    // A newer notice of the same kind from the same source replaces the unread
    // one: one live row per session and kind (the activity list keeps each).
    store.db.query(`DELETE FROM alerts WHERE ${col} = ? AND kind = ? AND read = 0 AND COALESCE(json_extract(data, '$.child_session'), '') = ? AND json_extract(data, '$.failure_fp') IS NULL`)
      .run(sid, kind, x.source);
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
  const watched = !calls && watching(sid, x.from);
  const withheld = calls && !x.far?.read && f.deliver && !f.quiet && routed.length > 0 && attending(sid, x.from);
  // Read where it was raised (the owner was at that daemon's own page, or it was put away there): kept, and told nowhere.
  const farRead = !!x.far?.read;
  const sendTo = watched || withheld || farRead || x.silent || !f.deliver || f.quiet ? [] : routed;
  // Why nothing left the inbox when nothing did: no route chosen, or the
  // chosen ones are not set up (judged now, when it was raised).
  const inboxOnly = sendTo.length || watched || withheld || farRead || !f.deliver || f.quiet ? {}
    : x.silent ? { inbox_only: { many: true } }
    : { inbox_only: !chosen.length ? { no_route: true } : quietKind && chosen.some((c) => INTERRUPTS.has(c) && channels.get(c)?.available()) ? { routine: true } : { not_set_up: chosen } };
  const flags = { ...(f.deliver ? {} : { snoozed: true }), ...(f.quiet ? { held: true } : {}), ...(withheld ? { withheld: routed } : {}) };
  if (withheld) withheldMaybe = true;
  const extra = { ...x.child, ...flags, ...inboxOnly, ...(first ? { wait: first } : {}) };
  const stored = Object.keys(extra).length ? { ...(data as object), ...extra } : data;
  const delivery: Delivery | undefined = sendTo.length ? Object.fromEntries(sendTo.map((c) => [c, { state: "pending" as const }])) : undefined;
  // When it came here, whoever raised it: the inbox is in the order things reached the owner
  // (another daemon's clock may be minutes off; its own time is kept with the alert). A decision
  // raised again keeps the time it was first asked.
  lastTs = Math.max(Date.now(), lastTs + 1);
  const a: Alert = named({
    id: Bun.randomUUIDv7(), ts: asked ?? lastTs, kind, session_id: sid, read: watched || farRead || !f.deliver,
    title: clip(scrub(x.title), 200), body: clip(scrub(x.body), 500), data: stored, channels: sendTo, delivery, rev: nextRev(), kept: false,
  });
  store.db.query(`INSERT INTO alerts (id, ts, kind, ${col}, title, body, read, data, channels, delivery, rev, kept, far_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(a.id, a.ts, kind, sid, a.title, a.body, a.read ? 1 : 0, stored ? JSON.stringify(stored) : null, JSON.stringify(sendTo), delivery ? JSON.stringify(delivery) : null, a.rev, x.far ? farKey(x.far.machine, x.far.id) : null);
    return { a, sendTo, flags };
  })();
  if (!made) return undefined;
  const { a, sendTo, flags } = made;
  // An ask is open from the moment it is raised: its card waits.
  if (ASK_KINDS.includes(kind) && waits(a)) a.open = true;
  emit("alert", a);
  // (A limit's class and the time it lifts go with its row: the timeline says which limit.)
  const limit = kind === "limit" ? { cls: (data as { cls?: string } | undefined)?.cls, until: (data as { until?: number } | undefined)?.until } : {};
  activity.record("alert", kind, x.from, `${a.title}: ${a.body}`, { alert_id: a.id, ...flags, ...(key && decision ? { [key]: String(decision) } : {}), ...limit });
  deliverTo(a, sendTo);
  return a;
}

// --- another daemon's sessions ---------------------------------------------------
//
// A session on another machine is followed like one here: when it finishes,
// fails, needs the owner or tells them something, the daemon it runs on
// raises an alert of its own, and its live frames bring that alert to every
// daemon that shows the session. Each of those keeps it as its own alert, by
// its own rules (who is watching here, this daemon's routes and snoozes), so
// the row's mark, the inbox and the channels work as for a session here.
// Once: the other daemon's alert id is kept with the row, across reconnects
// and restarts of either daemon, and what came while the link was down is
// read when it is back (mirrorSince), with what was read on either side
// meanwhile.
//
// What another daemon sends is its word, not this daemon's: only the fields
// an alert is known to carry are kept, each within a bound; its ids stand
// under its machine and never touch an alert of this daemon's own; and no
// more than a minute's worth is listed or told in a minute.
const MIRRORED: ReadonlySet<string> = new Set<AlertKind>(["approval", "question", "finished", "failed", "limit", "agent", "loop_failed"]);
// The fields kept of its data, by what each holds. An id longer than any id is not an id: it is left out.
const FAR_DATA: Record<string, "id" | "text" | "number" | "flag"> = {
  event_id: "id", approval_id: "id", call_id: "id", plan_id: "id", loop_id: "id", open_session: "id", child_session: "id",
  child_title: "text", ran_ms: "number", expired: "flag",
};
const ID_MAX = 128;
const FAR_SESSION = /^[\w-]{1,128}$/;
function farData(d: unknown): Record<string, any> {
  const out: Record<string, any> = {};
  if (!d || typeof d !== "object") return out;
  for (const [k, kind] of Object.entries(FAR_DATA)) {
    const v = (d as Record<string, unknown>)[k];
    if (kind === "id" ? typeof v === "string" && v.length > 0 && v.length <= ID_MAX : kind === "text" ? typeof v === "string" : kind === "number" ? typeof v === "number" && Number.isFinite(v) : v === true) {
      out[k] = kind === "text" ? clip(v as string, 200) : v;
    }
  }
  return out;
}
// The row of another daemon's alert: its id under its machine (two machines may both hold an id).
const farKey = (machine: string, id: string) => `${machine}/${id}`;
const farCursor = (machine: string) => D().store.db.query<{ ts: number }, [string]>("SELECT ts FROM alert_far WHERE machine = ?").get(machine)?.ts;
const farSeen = (machine: string, ts: number) =>
  D().store.db.query("INSERT INTO alert_far (machine, ts) VALUES (?, ?) ON CONFLICT(machine) DO UPDATE SET ts = MAX(ts, excluded.ts)").run(machine, ts);
const sound = (far: Alert) =>
  !!far && typeof far.id === "string" && far.id.length > 0 && far.id.length <= ID_MAX && typeof far.session_id === "string" && FAR_SESSION.test(far.session_id)
  && MIRRORED.has(far.kind) && Number.isFinite(far.ts)
  // One it keeps for a third daemon is that daemon's to tell: never a relay of a relay.
  && !far.data?.far;

// At most this many of a machine's alerts are listed here in a minute, and
// this many told on the channels (the rest of the listed stay in the inbox).
// What was not listed is said in one alert when the minute is over.
export const FAR_KEPT_A_MINUTE = 60;
export const FAR_TOLD_A_MINUTE = 12;
type Minute = { from: number; kept: number; told: number; more: number; timer?: Timer };
const minutes = new Map<string, Minute>();
function minuteOf(machine: string, now = Date.now()): Minute {
  let m = minutes.get(machine);
  if (!m || now - m.from >= 60_000) {
    if (m) { clearTimeout(m.timer); sayMore(machine, m.more); }
    minutes.set(machine, (m = { from: now, kept: 0, told: 0, more: 0 }));
  }
  return m;
}
function sayMore(machine: string, n: number, why = "in one minute") {
  if (n <= 0) return;
  const name = farHook.name?.(machine) ?? machine;
  raise("machine", null, `${n} more from ${name}`, `${n} more alert${n === 1 ? "" : "s"} from ${name} ${why} ${n === 1 ? "is" : "are"} not listed here. Its own inbox has ${n === 1 ? "it" : "them"}.`, { machine_more: machine, count: n });
}
// For tests: the minute's counts are forgotten.
export const resetMinutes = () => { for (const m of minutes.values()) clearTimeout(m.timer); minutes.clear(); };

// `level`: this daemon has read that machine's list since its link opened, so
// an alert told now is the newest it knows of there. Before that the mark of
// what was read stays where it is: an alert told live must not hide the ones
// raised while the link was down, which the list is about to bring.
// `listed`: one of a list read at once (mirrorSince, which bounds the list itself): told on the channels, or kept in the inbox only.
export function mirror(machine: string, far: Alert, level = true, listed?: "told" | "inbox"): Alert | undefined {
  try {
    if (!sound(far)) return undefined;
    if (level) farSeen(machine, far.ts);
    if (D().store.db.query("SELECT 1 FROM alerts WHERE far_id = ?").get(farKey(machine, far.id))) return undefined;
    let silent = listed === "inbox";
    // One told as it is raised counts against the minute.
    if (!listed) {
      const m = minuteOf(machine);
      if (m.kept >= FAR_KEPT_A_MINUTE) {
        m.more++;
        m.timer ??= setTimeout(() => { const cur = minutes.get(machine); if (cur === m) { minutes.delete(machine); sayMore(machine, m.more); } }, Math.max(0, m.from + 60_000 - Date.now()));
        return undefined;
      }
      m.kept++;
      if (m.told >= FAR_TOLD_A_MINUTE) silent = true;
      else if (!far.read) m.told++;
    }
    const there = (id: string) => `${machine}--${id}`;
    // What that daemon did with it there (its snooze, its routes) is its own, and so is anything else it put in.
    const { child_session, child_title, open_session, ...rest } = farData(far.data);
    const child = child_session ? { child_session: there(child_session), child_title } : {};
    const data = { ...rest, ...(open_session ? { open_session: there(open_session) } : {}), far: { machine, alert: far.id, ts: far.ts } };
    const source = child_session ? there(child_session) : "";
    return file({ kind: far.kind, sid: there(far.session_id!), from: source || there(far.session_id!), source, title: String(far.title ?? ""), body: String(far.body ?? ""), data, child, far: { machine, id: far.id, read: !!far.read }, silent });
  } catch (e) {
    capture(e, { at: "mirror alert", machine });
    return undefined;
  }
}

// What needs the owner first, then what failed, then the rest, each newest first.
const WEIGHT: Partial<Record<AlertKind, number>> = { approval: 0, question: 0, failed: 1, limit: 1, loop_failed: 1 };
const weight = (a: Alert) => (a.read ? 3 : WEIGHT[a.kind] ?? 2);
export const FAR_KEPT_AT_ONCE = 100;

// That daemon's alerts, read when its link opens (the recent ones and every
// unread one). The ones raised since the last this daemon saw of it are kept:
// when there are more than a hundred, what needs the owner and what failed
// first, and one alert says how many were left out; a dozen are told on the
// channels and the rest stay in the inbox. What was read (or marked unread)
// on that side while the link was down is read here too. The first time a
// machine is read its history stays its own: only what comes after counts.
export function mirrorSince(machine: string, list: Alert[]): number {
  const all = list.filter(sound);
  const newest = Math.max(0, ...all.map((a) => a.ts));
  const from = farCursor(machine);
  if (from === undefined) {
    farSeen(machine, newest);
    return 0;
  }
  const db = D().store.db;
  const held = new Map(db.query<{ id: string; far_id: string; read: number; kept: number }, [string]>("SELECT id, far_id, read, kept FROM alerts WHERE far_id IS NOT NULL AND json_extract(data, '$.far.machine') = ?").all(machine).map((r) => [r.far_id, r]));
  const waiting = new Set(pendingReads(machine));
  const fresh = all.filter((a) => a.ts > from && !held.has(farKey(machine, a.id))).sort((x, y) => weight(x) - weight(y) || y.ts - x.ts);
  const take = fresh.slice(0, FAR_KEPT_AT_ONCE);
  const loud = new Set(take.filter((a) => !a.read).slice(0, FAR_TOLD_A_MINUTE).map((a) => a.id));
  let n = 0;
  // In the order they were raised, so the inbox lists them so.
  for (const a of [...take].sort((x, y) => x.ts - y.ts)) if (mirror(machine, a, false, loud.has(a.id) ? "told" : "inbox")) n++;
  farSeen(machine, Math.max(from, newest));
  sayMore(machine, fresh.length - take.length, "raised while it was out of reach");
  // Read state, both ways. A read made here that is still to be told there stands.
  const read: string[] = [];
  for (const a of all) {
    const h = held.get(farKey(machine, a.id));
    if (!h || waiting.has(a.id)) continue;
    if (a.read && !h.read && !h.kept) read.push(h.id);
    else if (!a.read && a.kept && h.read) farWasUnread(machine, a.id);
  }
  if (read.length) markRead({ ids: read }, false);
  return n;
}

// That daemon says alerts were read there (answered on its own page, or from another device): read here too.
export function farWasRead(machine: string, o: { ids?: unknown; session_id?: unknown; all?: unknown }) {
  try {
    const db = D().store.db;
    const keys = Array.isArray(o.ids) ? o.ids.map((id) => farKey(machine, String(id))).slice(0, 500) : [];
    const ids = keys.length
      ? db.query<{ id: string }, string[]>(`SELECT id FROM alerts WHERE read = 0 AND far_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(keys))
      : typeof o.session_id === "string"
      ? db.query<{ id: string }, [string]>("SELECT id FROM alerts WHERE read = 0 AND far_session = ? AND kept = 0").all(`${machine}--${o.session_id}`)
      : o.all
      ? db.query<{ id: string }, [string]>("SELECT id FROM alerts WHERE read = 0 AND kept = 0 AND far_id IS NOT NULL AND json_extract(data, '$.far.machine') = ?").all(machine)
      : [];
    if (ids.length) markRead({ ids: ids.map((r) => r.id) }, false);
  } catch (e) {
    capture(e, { at: "far alerts read", machine });
  }
}

// The owner marked it unread there, to come back to it: unread here too, and kept so.
export function farWasUnread(machine: string, alert: unknown) {
  try {
    const db = D().store.db;
    const r = db.query<{ id: string }, [string]>("SELECT id FROM alerts WHERE far_id = ? AND NOT (read = 0 AND kept = 1)").get(farKey(machine, String(alert)));
    if (!r) return;
    db.query("UPDATE alerts SET read = 0, kept = 1, rev = ? WHERE id = ?").run(nextRev(), r.id);
    emit("alerts_read", { unread: r.id, rev: currentRev() });
  } catch (e) {
    capture(e, { at: "far alert unread", machine });
  }
}

// Reads made here that the daemon they came from has not been told of (its link was down): told when it opens.
export const pendingReads = (machine: string) =>
  D().store.db.query<{ alert: string }, [string]>("SELECT alert FROM alert_far_reads WHERE machine = ? LIMIT 1000").all(machine).map((r) => r.alert);
function tellRead(machine: string, ids: string[]) {
  if (!ids.length) return;
  const db = D().store.db;
  const add = db.query("INSERT OR IGNORE INTO alert_far_reads (machine, alert) VALUES (?, ?)");
  db.transaction(() => { for (const id of ids) add.run(machine, id); })();
  const told = () => {
    const del = D().store.db.query("DELETE FROM alert_far_reads WHERE machine = ? AND alert = ?");
    D().store.db.transaction(() => { for (const id of ids) del.run(machine, id); })();
  };
  Promise.resolve().then(() => farHook.read?.(machine, ids)).then((ok) => { if (farHook.read && ok !== false) told(); }).catch(() => { /* its link is down: told when it opens */ });
}
export function tellPendingReads(machine: string) {
  try { tellRead(machine, pendingReads(machine)); } catch (e) { capture(e, { at: "far alerts read", machine }); }
}

// A session deleted on that daemon, or a machine taken out of the fleet: its alerts go with it, as a session's here do.
export function farGone(machine: string, sessionId?: string) {
  try {
    const db = D().store.db;
    const n = sessionId
      ? db.query("DELETE FROM alerts WHERE far_session = ?").run(`${machine}--${sessionId}`).changes
      : db.query("DELETE FROM alerts WHERE far_id IS NOT NULL AND json_extract(data, '$.far.machine') = ?").run(machine).changes;
    if (!sessionId) {
      db.query("DELETE FROM alert_far WHERE machine = ?").run(machine);
      db.query("DELETE FROM alert_far_reads WHERE machine = ?").run(machine);
      const m = minutes.get(machine);
      if (m) { clearTimeout(m.timer); minutes.delete(machine); }
    }
    if (n) { nextRev(); emit("alerts_read", { changed: n, rev: currentRev() }); }
  } catch (e) {
    capture(e, { at: "far alerts gone", machine });
  }
}
alertHook.raise = (kind, sessionId, title, body, data) => void raise(kind as AlertKind, sessionId, title, body, data);
inboxCounts.get = unreadCounts;

// The notifications held back while the owner attended a session: each goes to its channels once
// they no longer attend it, if it is still unread and (an ask) its card still waits. Nothing is
// read from the table while none is held (after a start that is not known, so the first look reads).
let withheldMaybe = true;
let withheldAt = 0;
// When the next look at the held-back notifications is due (the daemon's tick rests until then when it is idle): none when none is held.
export const withheldDue = (): number | undefined => (withheldMaybe ? withheldAt + 3000 : undefined);
export function tickWithheld(now = Date.now()) {
  if (!withheldMaybe || now - withheldAt < 3000) return;
  withheldAt = now;
  try {
    const db = D().store.db;
    // Told in the order of the next-look queue: the costliest wait first (src/core/wait-rank.ts).
    const held = rankWaiting(db.query<Row, []>("SELECT * FROM alerts WHERE read = 0 AND json_extract(data, '$.withheld') IS NOT NULL").all().map(toAlert), (a) => ({ id: a.id, ts: a.ts, wait: a.data?.wait }));
    if (!held.length) { withheldMaybe = false; return; }
    for (const a of held) {
      if (attending(a.session_id, a.data?.child_session, a.data?.open_session)) continue;
      const { withheld, ...rest } = a.data as { withheld: string[] } & Record<string, unknown>;
      const due = !ASK_KINDS.includes(a.kind) || waits(a);
      const sendTo = due ? withheld.filter((c) => channels.get(c)?.available()) : [];
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
// `tell`: the daemon an alert came from is told it was read here (false when it is that daemon saying so).
export function markRead(opts: { ids?: string[]; session_id?: string; all?: boolean; seen?: number; auto?: boolean; touch?: boolean }, tell = true): number {
  const db = D().store.db;
  const where = ["read = 0"];
  const args: (string | number)[] = [];
  if (opts.ids) {
    if (!opts.ids.length) return 0;
    where.push("id IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(opts.ids.map(String)));
  } else if (opts.session_id) { where.push("(session_id = ? OR far_session = ?)"); args.push(opts.session_id, opts.session_id); }
  else if (!opts.all) return 0;
  if (Number.isFinite(opts.seen)) { where.push("rev <= ?"); args.push(Number(opts.seen)); }
  if (opts.auto || opts.touch) where.push("kept = 0");
  if (opts.auto) where.push(`kind NOT IN (${CALLS.map((k) => `'${k}'`).join(", ")})`);
  const hit = db.query<{ id: string; session_id: string | null; far_id: string | null; machine: string | null }, any>(
    `SELECT id, COALESCE(session_id, far_session) AS session_id, json_extract(data, '$.far.alert') AS far_id, json_extract(data, '$.far.machine') AS machine FROM alerts WHERE ${where.join(" AND ")}`,
  ).all(...args);
  if (!hit.length) return 0;
  nextRev();
  const upd = db.query("UPDATE alerts SET read = 1, kept = 0 WHERE id = ?");
  db.transaction(() => { for (const h of hit) upd.run(h.id); })();
  if (tell) {
    const by = new Map<string, string[]>();
    for (const h of hit) if (h.far_id && h.machine) (by.get(h.machine) ?? by.set(h.machine, []).get(h.machine)!).push(h.far_id);
    for (const [machine, ids] of by) try { tellRead(machine, ids); } catch (e) { capture(e, { at: "far alerts read", machine }); }
  }
  // Each channel takes back what it shows for a session once nothing in it is unread, and
  // what it shows for each alert read while something else in its session still is.
  const left = unreadCounts().sessions;
  for (const sid of new Set(hit.map((h) => h.session_id).filter((x): x is string => !!x))) {
    if (left[sid]) continue;
    for (const c of channels.values()) {
      if (!c.withdraw) continue;
      Promise.resolve().then(() => c.withdraw!(sid)).catch((e) => capture(e, { at: "alert withdraw", channel: c.id }));
    }
  }
  const takers = [...channels.values()].filter((c) => c.take);
  if (takers.length) for (const h of hit) {
    if (!h.session_id || !left[h.session_id]) continue;
    const a = get(h.id);
    if (a) for (const c of takers) Promise.resolve().then(() => c.take!(a)).catch((e) => capture(e, { at: "alert take back", channel: c.id }));
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

// Whether the owner was told that this machine went out of reach at that time (once per absence, across restarts).
// A machine that was said offline is back: its alert says so in place of "is offline" (the same row, read,
// so the inbox holds the absence once with its end), and the pages are told. `back`: when it was heard again.
export function offlineOver(machine: string, since: number, back: number, name: string, when: (ms: number) => string): void {
  const db = D().store.db;
  const rows = db.query<Row, [string, number]>("SELECT * FROM alerts WHERE far_id IS NULL AND json_extract(data, '$.machine_offline') = ? AND json_extract(data, '$.since_ms') = ?").all(machine, since).map(toAlert);
  for (const a of rows) {
    if (typeof a.data?.back_ms === "number") continue;
    const data = { ...a.data, back_ms: back };
    const title = offlineTitle(name, data);
    const body = `${name} answered again at ${when(back)}, after ${outFor(back - since)} out of reach (from ${when(since)}).`;
    db.query("UPDATE alerts SET title = ?, body = ?, data = ?, read = 1, rev = ? WHERE id = ?").run(title, body, JSON.stringify(data), nextRev(), a.id);
    emit("alert", { ...a, title, body, data, read: true });
  }
}

export const raisedOffline = (machine: string, since: number) =>
  !!D().store.db.query("SELECT 1 FROM alerts WHERE json_extract(data, '$.machine_offline') = ? AND json_extract(data, '$.since_ms') = ? LIMIT 1").get(machine, since);

// What became of a question, kept with its alert when it closes, so the Inbox says it after a
// restart too: answered, declined, or not answered. Its notice of expiry is an alert of its own.
// `unsaid`: only the questions with no outcome yet (a call's turn stopped after a server's first
// question on it was answered leaves that one answered).
export function keepOutcome(key: "call_id" | "ask_id", value: string, askedIn: string, outcome: string, unsaid = false) {
  D().store.db.query(`UPDATE alerts SET data = json_set(COALESCE(data, '{}'), '$.outcome', ?) WHERE far_id IS NULL AND kind = 'question' AND json_extract(data, ?) = ? AND ${ASKED_IN} = ? AND json_extract(data, '$.expired') IS NULL${unsaid ? " AND json_extract(data, '$.outcome') IS NULL" : ""}`)
    .run(outcome, `$.${key}`, value, askedIn);
}

// Reads the unread alerts whose data names this value (an answered approval).
// `askedIn`: only the alerts of the session that asked (a question's call id is its session's).
// Of this daemon's own alerts: an id another daemon's alert names is that daemon's.
export function readWhere(key: string, value: string, askedIn?: string) {
  const sessions = D().store.db.query<{ session_id: string | null }, [string, string]>("SELECT DISTINCT session_id FROM alerts WHERE json_extract(data, ?) = ? AND far_id IS NULL").all(`$.${key}`, value);
  for (const r of sessions) if (r.session_id && key === "approval_id") snooze.resume(r.session_id);
  const ids = D().store.db.query<{ id: string }, string[]>(`SELECT id FROM alerts WHERE read = 0 AND far_id IS NULL AND json_extract(data, ?) = ?${askedIn ? ` AND ${ASKED_IN} = ?` : ""}`)
    .all(...[`$.${key}`, value, ...(askedIn ? [askedIn] : [])]).map((r) => r.id);
  if (ids.length) markRead({ ids });
  // An ask the owner had looked at and now answered is read already: the pages are told all the same, since it waits no more.
  else if (sessions.length) emit("alerts_read", { settled: value, rev: currentRev() });
}

// A question whose card went without an answer (its turn was stopped): nothing of it waits on
// the owner any more, so its alert is read, as an approval's is when its turn is stopped. The
// notice of a question that expired unanswered is an alert of its own and stays, and so does
// what the owner marked unread.
export function settleAsks(sessionId: string) {
  const rows = D().store.db.query<Row, [string]>(`SELECT * FROM alerts WHERE read = 0 AND kept = 0 AND kind = 'question' AND ${ASKED_IN} = ?`).all(sessionId);
  const ids = rows.map(toAlert).filter((a) => !a.data?.expired && !stillOpen(a)).map((a) => a.id);
  if (ids.length) markRead({ ids });
}

// The owner wants to come back to it: unread again, at a new revision, and kept
// until the owner reads it on purpose.
export function markUnread(id: string): boolean {
  const db = D().store.db;
  const r = db.query<{ alert: string | null; machine: string | null }, [string]>("SELECT json_extract(data, '$.far.alert') AS alert, json_extract(data, '$.far.machine') AS machine FROM alerts WHERE id = ?").get(id);
  if (!r) return false;
  db.query("UPDATE alerts SET read = 0, kept = 1, rev = ? WHERE id = ?").run(nextRev(), id);
  emit("alerts_read", { unread: id, rev: currentRev() });
  // Another daemon's: unread there too, and a read of it that was still to be told there is not told.
  if (r.alert && r.machine) {
    db.query("DELETE FROM alert_far_reads WHERE machine = ? AND alert = ?").run(r.machine, r.alert);
    Promise.resolve().then(() => farHook.unread?.(r.machine!, r.alert!)).catch(() => { /* its link is down: it stays as it is there */ });
  }
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
  async deliver(given) {
    // What the wait costs, under what it is: the order the Inbox lists it in, said (src/core/wait-rank.ts).
    const now = liveWait(given);
    const cost = costs(now) ? costLine(now, Date.now()) : "";
    const a = cost ? { ...given, body: `${given.body}\n${cost}` } : given;
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

// --- agents that failed ------------------------------------------------------------
//
// An agent's failure reaches the owner as its cause does in the session's own
// record (session_failures, src/automation/failure-groups.ts): one alert a
// cause a parent, "Coordinator: 6 agents failed: billing", its count raised as
// more agents fail of it. A newer count replaces the unread row and is told on
// no channel again (the owner was told of that cause once); one the owner has
// read is news again when another agent fails of it. An agent's finished work
// is not an alert: its report goes to its parent, and the parent's own Done
// says when the work is over (its alert waits while agents are out).
const failureFp = (data: unknown) => { const fp = (data as { failure_fp?: unknown } | null | undefined)?.failure_fp; return typeof fp === "string" ? fp : undefined; };
export function agentsFailed(a: { id: string; parent_id: string; session_id?: string }) {
  try {
    const { store } = D();
    const parent = store.session(a.parent_id);
    if (!parent || parent.archived) return;
    const g = groupsOf(store, a.parent_id).find((x) => x.kind === "agent" && x.refs.some((r) => r.id === a.id));
    if (!g) return;
    const named = g.refs.filter((r) => r.id !== SELF && r.id !== OTHERS);
    const n = named.length + (g.refs.find((r) => r.id === OTHERS)?.n ?? 0);
    const mine = named.find((r) => r.id === a.id);
    const why = failWord(g.cls) || exampleOf(g.sample);
    const told = store.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM alerts WHERE read = 0 AND kind = 'failed' AND session_id = ? AND json_extract(data, '$.failure_fp') = ?").get(parent.parent_id ?? parent.id, g.fp)!.n > 0;
    raise("failed", parent.id, `${parent.title || "Session"}: ${n} ${n === 1 ? "agent" : "agents"} failed: ${why}`, `${mine?.label ? `Agent "${mine.label}": ` : ""}${exampleOf(mine?.eg ?? g.sample)}`, { failure_fp: g.fp, agents_failed: n, agent_id: a.id, cls: g.cls, ...(a.session_id ? { agent_session: a.session_id } : {}) }, told);
    // The session the owner sees counts as failed until they look at it (ui/src/lib/home.ts).
    let root = parent;
    for (let i = 0; root.parent_id && i < 32; i++) root = store.session(root.parent_id) ?? root;
    D().bus.emit({ t: "session", session: store.mergeSettings(root.id, { agents_failed_ms: Date.now() })! });
  } catch (e) {
    capture(e, { at: "agents failed alert", session: a.parent_id });
  }
}

// --- turn outcomes -------------------------------------------------------------

const LIMIT = /rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded|throttl/i;

// Called after a turn has fully ended, when nothing else is lined up for the
// session (a subagent's turns are its parent's to report; a loop run reports
// only when it fails). Only this turn's events speak for it: a turn with no
// reply of its own never quotes an earlier one. The alert names the reply it
// quotes, so opening it shows that reply.
// Sessions whose module tells their turn's end with an alert of its own (a
// pull request review: ready, posted, failed): not filed as finished or failed too.
// Keyed by the module, so a hot reload replaces its entry.
export const ownSessionEnd = new Map<string, (sessionId: string) => boolean>();

export function onTurnEnd(sessionId: string, reason: string, opts: { subagent: boolean; loopRun: boolean; more: boolean }) {
  if (opts.subagent || opts.more) return;
  for (const own of ownSessionEnd.values()) if (own(sessionId)) return;
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
    const failed = [...evs].reverse().find((e) => e.kind === "error")?.data;
    const err = String(failed?.message ?? "The turn failed.");
    if (opts.loopRun) return; // the loop reports its own failure
    const cls = classOfText(err);
    if (!LIMIT.test(err)) { raise("failed", sessionId, `Failed: ${title}`, err.split("\n")[0]!, { cls }); return; }
    // A limit says which (a rate limit, an overloaded provider, a spent quota) and, when the provider named one, until when.
    const until = typeof failed?.retry_at === "number" ? failed.retry_at : undefined;
    raise("limit", sessionId, `${limitWord(cls)}: ${title}`, err.split("\n")[0]!, { cls, ...(until ? { until } : {}) });
    return;
  }
  if (reason === "max_tokens") { raise("failed", sessionId, `Cut off: ${title}`, "The reply reached the model's output limit."); return; }
  // The model declined the turn: it did not finish, and it is not filed as finished. What it said, when it said anything.
  if (reason === "refusal") {
    if (opts.loopRun) return;
    const said = evs.findLast((e) => e.kind === "assistant" && (e.data.blocks as any[]).some((b) => b.type === "text" && b.text.trim()));
    const text = said ? (said.data.blocks as any[]).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim() : "";
    raise("declined", sessionId, `${STATE_WORD.declined}: ${title}`, plainLine(text) || "The model declined the turn.", said ? { event_id: said.id } : undefined);
    return;
  }
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
  const end = all.findLast((e) => e.kind === "turn_end");
  const ran_ms = typeof end?.data.ms === "number" ? end.data.ms : start >= 0 ? Date.now() - all[start]!.ts : undefined;
  raise("finished", sessionId, title, plainLine(text) || "The turn finished.", event || ran_ms !== undefined ? { ...(event ? { event_id: event } : {}), ...(ran_ms !== undefined ? { ran_ms } : {}) } : undefined);
}
