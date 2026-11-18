import { D, alertHook, capture, emit } from "./core.ts";

// What needs the owner becomes one alert: kept in the inbox with unread state,
// sent as a frame, and delivered to the channels the settings name for its
// kind. A channel is anything with deliver(); phone push registers one later.

export const KINDS = ["approval", "question", "finished", "failed", "limit", "loop_failed", "agent"] as const;
export type AlertKind = (typeof KINDS)[number];
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

export function migrate() {
  D().store.migrate(`
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
CREATE TABLE IF NOT EXISTS alert_settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);`);
  // Rows are kept 30 days.
  D().store.db.query("DELETE FROM alerts WHERE ts < ?").run(Date.now() - 30 * 86400_000);
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

export function saveSettings(p: Partial<AlertSettings>): AlertSettings {
  const cur = settings();
  if (p.completion && !["never", "background", "always"].includes(p.completion)) throw new Error("completion is never, background or always");
  const routes = { ...cur.routes };
  for (const [k, v] of Object.entries(p.routes ?? {})) {
    if (!KINDS.includes(k as AlertKind)) throw new Error(`unknown alert kind ${k}`);
    if (!Array.isArray(v)) throw new Error(`routes.${k} is a list of channels`);
    routes[k as AlertKind] = v.map(String);
  }
  const next = { routes, completion: p.completion ?? cur.completion };
  D().store.db.query("INSERT INTO alert_settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  return next;
}

type Row = Omit<Alert, "read" | "data" | "channels"> & { read: number; data: string | null; channels: string | null };
const toAlert = (r: Row): Alert => ({ ...r, read: !!r.read, data: r.data ? JSON.parse(r.data) : undefined, channels: r.channels ? JSON.parse(r.channels) : [] });

export function list(opts: { before?: number; limit?: number; unread?: boolean } = {}): Alert[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return D().store.db
    .query<Row, [number, number]>(`SELECT * FROM alerts WHERE ts < ? ${opts.unread ? "AND read = 0" : ""} ORDER BY ts DESC LIMIT ?`)
    .all(opts.before ?? Number.MAX_SAFE_INTEGER, limit)
    .map(toAlert);
}

export function unreadCounts(): { total: number; sessions: Record<string, number> } {
  const rows = D().store.db.query<{ session_id: string | null; n: number }, []>("SELECT session_id, COUNT(*) AS n FROM alerts WHERE read = 0 GROUP BY session_id").all();
  const sessions: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { total += r.n; if (r.session_id) sessions[r.session_id] = r.n; }
  return { total, sessions };
}

// The page reports where the owner is: which session is on screen and whether
// the page has focus. Fresh for 45 s.
let presence: { at: number; session_id: string | null; focused: boolean } = { at: 0, session_id: null, focused: false };
export const setPresence = (session_id: string | null, focused: boolean) => void (presence = { at: Date.now(), session_id, focused });
const atDesk = () => Date.now() - presence.at < 45_000 && presence.focused;
const watching = (sessionId: string | null) => atDesk() && !!sessionId && presence.session_id === sessionId;

const SECRETS = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const scrub = (t: string) => t.replace(SECRETS, "[secret]");

export function raise(kind: AlertKind, sessionId: string | null, title: string, body: string, data?: unknown): Alert | undefined {
  try {
    const { store } = D();
    const s = sessionId ? store.session(sessionId) : undefined;
    if (sessionId && !s) return undefined;
    // A subagent's alerts belong to its parent's session in the inbox.
    const sid = s?.parent_id ?? sessionId;
    const st = settings();
    if (kind === "finished") {
      if (st.completion === "never") return undefined;
      if (st.completion === "background" && watching(sid)) return undefined;
    }
    // One alert per decision: a newer one for the same session and kind replaces the unread one.
    if (sid && kind !== "approval") store.db.query("UPDATE alerts SET read = 1 WHERE session_id = ? AND kind = ? AND read = 0").run(sid, kind);
    const routed = (st.routes[kind] ?? []).filter((c) => channels.get(c)?.available());
    // Watching the session: the page shows it, nothing leaves the machine for it.
    const sendTo = watching(sid) ? [] : routed;
    const a: Alert = {
      id: Bun.randomUUIDv7(), ts: Date.now(), kind, session_id: sid, read: watching(sid),
      title: scrub(title).slice(0, 200), body: scrub(body).slice(0, 500), data, channels: sendTo,
    };
    store.db.query("INSERT INTO alerts (id, ts, kind, session_id, title, body, read, data, channels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.ts, kind, sid, a.title, a.body, a.read ? 1 : 0, data ? JSON.stringify(data) : null, JSON.stringify(sendTo));
    emit("alert", a);
    for (const c of sendTo) {
      Promise.resolve(channels.get(c)!.deliver(a)).catch((e) => capture(e, { at: "alert channel", channel: c }));
    }
    return a;
  } catch (e) {
    capture(e, { at: "raise alert", kind });
    return undefined;
  }
}
alertHook.raise = (kind, sessionId, title, body, data) => void raise(kind as AlertKind, sessionId, title, body, data);

export function markRead(opts: { ids?: string[]; session_id?: string; all?: boolean }): number {
  const db = D().store.db;
  let n = 0;
  if (opts.all) n = db.query("UPDATE alerts SET read = 1 WHERE read = 0").run().changes;
  else if (opts.session_id) n = db.query("UPDATE alerts SET read = 1 WHERE read = 0 AND session_id = ?").run(opts.session_id).changes;
  else for (const id of opts.ids ?? []) n += db.query("UPDATE alerts SET read = 1 WHERE id = ? AND read = 0").run(id).changes;
  if (opts.session_id) for (const c of channels.values()) Promise.resolve(c.withdraw?.(opts.session_id)).catch(() => {});
  if (opts.all) for (const c of channels.values()) for (const sid of Object.keys(shown)) Promise.resolve(c.withdraw?.(sid)).catch(() => {});
  emit("alerts_read", { ...opts, changed: n });
  return n;
}

// Reads the unread alerts whose data names this value (an answered approval).
export function readWhere(key: string, value: string) {
  const n = D().store.db.query("UPDATE alerts SET read = 1 WHERE read = 0 AND json_extract(data, ?) = ?").run(`$.${key}`, value).changes;
  if (n) emit("alerts_read", { [key]: value, changed: n });
}

export function markUnread(id: string) {
  D().store.db.query("UPDATE alerts SET read = 0 WHERE id = ?").run(id);
  emit("alerts_read", { unread: id });
}

// --- channels ------------------------------------------------------------------

// Desktop: the notification service over the session bus, through gdbus. One
// notification per session, replaced by the next and closed when the session is
// read. Always silent (the hint suppress-sound).
const shown: Record<string, number> = {};
const gdbusArgs = ["call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications"];

function gvariantString(s: string) {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ")}'`;
}

registerChannel({
  id: "desktop",
  label: "Desktop notification",
  available: () => process.env.KEEL_DESKTOP_NOTIFY !== "off" && !!(process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR) && !!Bun.which("gdbus"),
  async deliver(a) {
    const key = a.session_id ?? "_";
    const urgency = a.kind === "approval" || a.kind === "question" || a.kind === "failed" || a.kind === "loop_failed" ? 2 : 1;
    const p = Bun.spawn([
      "gdbus", ...gdbusArgs, "--method", "org.freedesktop.Notifications.Notify",
      "Keel", String(shown[key] ?? 0), "", a.title, a.body, "[]",
      `{'suppress-sound': <true>, 'urgency': <byte ${urgency}>, 'desktop-entry': <'keel'>, 'category': <${gvariantString(`keel.${a.kind}`)}>}`,
      "int32 -1",
    ], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`gdbus Notify failed: ${err.trim()}`);
    const m = out.match(/uint32 (\d+)/);
    if (m) shown[key] = Number(m[1]);
  },
  async withdraw(sessionId) {
    const id = shown[sessionId];
    if (!id) return;
    delete shown[sessionId];
    await Bun.spawn(["gdbus", ...gdbusArgs, "--method", "org.freedesktop.Notifications.CloseNotification", String(id)], { stdout: "ignore", stderr: "ignore" }).exited;
  },
});

// Command: KEEL_NOTIFY_COMMAND (split on spaces) gets the alert as JSON in one
// more argument and is not waited for.
registerChannel({
  id: "command",
  label: "KEEL_NOTIFY_COMMAND",
  available: () => !!process.env.KEEL_NOTIFY_COMMAND?.trim(),
  deliver(a) {
    const argv = process.env.KEEL_NOTIFY_COMMAND!.trim().split(/\s+/);
    const p = Bun.spawn([...argv, JSON.stringify(a)], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    p.exited.then(async (code) => {
      if (code !== 0) capture(new Error(`KEEL_NOTIFY_COMMAND exited ${code}: ${(await new Response(p.stderr).text()).slice(0, 500)}`), { alert: a.id });
    });
  },
});

// --- turn outcomes -------------------------------------------------------------

const LIMIT = /rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded|throttl/i;

// Called after a turn has fully ended, when nothing else is lined up for the
// session (a subagent's turns are its parent's to report; a loop run reports
// only when it fails).
export function onTurnEnd(sessionId: string, reason: string, opts: { subagent: boolean; loopRun: boolean; more: boolean }) {
  if (opts.subagent || opts.more) return;
  const { store } = D();
  const s = store.session(sessionId);
  if (!s || s.archived) return;
  const title = s.title || "Session";
  const evs = store.events(sessionId, Math.max(0, (store.events(sessionId).at(-1)?.seq ?? 0) - 60));
  if (reason === "error") {
    const err = [...evs].reverse().find((e) => e.kind === "error")?.data.message ?? "The turn failed.";
    if (opts.loopRun) return; // the loop reports its own failure
    raise(LIMIT.test(err) ? "limit" : "failed", sessionId, LIMIT.test(err) ? `Usage limit: ${title}` : `Failed: ${title}`, err.split("\n")[0]!);
    return;
  }
  if (reason === "max_tokens") { raise("failed", sessionId, `Cut off: ${title}`, "The reply reached the model's output limit."); return; }
  if (reason === "interrupted" || opts.loopRun) return;
  let text = "";
  for (let i = evs.length - 1; i >= 0 && !text; i--) {
    const e = evs[i]!;
    if (e.kind === "assistant") text = (e.data.blocks as any[]).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  }
  raise("finished", sessionId, title, text.split("\n")[0]!.slice(0, 300) || "The turn finished.");
}
