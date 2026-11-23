// The daemon's incidents (src/automation/incident-book.ts) fed from what it
// already records, kept and told. Each incident is one row of the activity
// list (kind daemon, sub incident), written when it opens and changed in
// place as it grows and when it clears: a restart keeps it, and its alert is
// never sent twice. It goes to every page as one frame (`incidents`), at most
// one a FRAME_MS, and to the owner as one alert (kind "outage", the kind the
// owner routes) when work stopped because of it, or when a held wait lasts.
// A failure alert of a session the incident touched is filed silently: the
// incident's alert stands for it.
//
// Fed by: a turn's end (failed with a provider's class, or answered), the
// provider's shared wait (src/providers/outage.ts, through outage.ts here),
// the judge's verdicts, stall rows of the errors table, the start record of
// a daemon that went down by itself, and the store's disk state.
import { restarts } from "../admin/life.ts";
import { classOfText } from "../admin/classes.ts";
import { span } from "../core/watch.ts";
import type { Outage } from "../providers/outage.ts";
import { causeOfClass, IncidentBook, lineOf, owesAlert, radiusOf, titleOf, doingOf, type Hit, type Incident } from "./incident-book.ts";
import { absorbHook, raise, readWhere } from "./alerts.ts";
import { D, capture, emit } from "./core.ts";

const FRAME_MS = 500;
const TICK_MS = 15_000;
// Incidents a start takes up from the rows: those this young that had not cleared.
const RESTORE_MS = 24 * 3600_000;
// Cleared ones the list gives with the open ones.
const LISTED_MS = 24 * 3600_000;

type State = { book: IncidentBook; dirty: Set<string>; frame?: ReturnType<typeof setTimeout>; tick?: ReturnType<typeof setInterval>; off?: () => void };
const G = globalThis as { __keelIncidents?: State };

const st = (): State => (G.__keelIncidents ??= { book: new IncidentBook(() => Bun.randomUUIDv7()), dirty: new Set() });
export const book = () => st().book;

const who = (id: string) => {
  const s = D().store.session(id);
  return s ? { id: s.id, title: s.title || "Session", parent: s.parent_id ?? null } : undefined;
};
const providerOf = (model: string) => (model.includes(":") ? model.slice(0, model.indexOf(":")) : model);
const labelOf = (id: string) => D().providers.get(id)?.label ?? id;

// The row's data: the incident whole, so the list and a restart read it back as it was.
function persist(i: Incident) {
  try {
    const { store } = D();
    const text = lineOf(i).slice(0, 500);
    const data = JSON.stringify(i);
    store.side.later("an incident row", () => void store.db.query(`INSERT INTO activity (id, ts, kind, sub, session_id, text, data) VALUES (?, ?, 'daemon', 'incident', NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET text = excluded.text, data = excluded.data`).run(i.id, i.since, text, data));
    emit("activity", { id: i.id, ts: i.since, kind: "daemon", sub: "incident", session_id: null, text, data: i });
  } catch (e) { capture(e, { at: "incident row" }); }
}

// The one alert, when it is owed; read when the incident clears.
function tell(i: Incident) {
  if (!owesAlert(i)) return;
  i.notified = Date.now();
  raise("outage", null, titleOf(i), `${radiusOf(i)}. ${doingOf(i)}`, { incident: i.id, key: i.key });
}

function changed(i: Incident | undefined) {
  if (!i) return;
  const s = st();
  s.dirty.add(i.id);
  tell(i);
  if (i.cleared) try { readWhere("incident", i.id); } catch (e) { capture(e, { at: "incident alert read" }); }
  s.frame ??= setTimeout(flush, FRAME_MS);
  (s.frame as any)?.unref?.();
}

function flush() {
  const s = st();
  s.frame = undefined;
  const all = [...s.book.list(), ...s.book.cleared()];
  for (const id of s.dirty) {
    const i = all.find((x) => x.id === id);
    if (i) persist(i);
  }
  s.dirty.clear();
  try { D().bus.emit({ t: "feature", name: "incidents", data: listed(Date.now(), false) }); } catch (e) { capture(e, { at: "incidents frame" }); }
}

const hit = (h: Hit) => changed(book().hit(h));

// --- what feeds it ---------------------------------------------------------

// A turn ended: failed on a provider's matter, or the provider answered it.
export function onTurnEnd(sessionId: string, reason: string) {
  try {
    const { store } = D();
    const s = store.session(sessionId);
    if (!s?.model) return;
    const pid = providerOf(s.model);
    const at = Date.now();
    if (reason === "error") {
      const row = store.db.query<{ data: string }, [string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'error' ORDER BY seq DESC LIMIT 1").get(sessionId);
      const message = row ? String(JSON.parse(row.data).message ?? "") : "";
      const cls = classOfText(message);
      const cause = causeOfClass(cls);
      if (!cause) return;
      hit({ key: `${cause}:${pid}`, cause, label: labelOf(pid), cls, at, message, session: who(sessionId), failed: true });
      return;
    }
    if (reason !== "end_turn" && reason !== "max_tokens") return;
    changed(book().clear(`provider:${pid}`, "it answers again", at));
    changed(book().clear(`account:${pid}`, "a turn on it went through", at));
  } catch (e) { capture(e, { at: "incident turn end", session: sessionId }); }
}

// The judge's verdict on a call: none it could give, or one it gave.
export function onJudged(j: { session_id: string; outcome: string; reason: string }) {
  try {
    if (j.outcome === "unavailable") hit({ key: "judge", cause: "judge", cls: "unavailable", at: Date.now(), message: j.reason, session: who(j.session_id) });
    else if (j.outcome === "judge" || j.outcome === "refused" || j.outcome === "retry") changed(book().clear("judge", "it gives verdicts again", Date.now()));
  } catch (e) { capture(e, { at: "incident judge" }); }
}

// The provider's shared wait, as it is now: every outage it confirmed holds its sessions.
export function syncHeld(long?: Outage) {
  try {
    const at = Date.now();
    for (const o of D().providers.outages.list()) {
      if (!o.confirmed) continue;
      const sessions = o.sessions.map(who).filter((x): x is NonNullable<typeof x> => !!x);
      changed(book().held({ key: `provider:${o.provider}`, label: labelOf(o.provider), since: o.since, message: o.message, sessions, long: long?.provider === o.provider }, at));
    }
  } catch (e) { capture(e, { at: "incident wait" }); }
}

// The wait is over: the provider answered, or nobody waits for it any more.
export function outageOver(o: Outage, ms: number, answered: boolean) {
  changed(book().unheld(`provider:${o.provider}`, answered ? `it answers again, after ${span(ms)}` : "nobody waits for it any more", Date.now()));
}

// The store's disk: full, or not answering, and back.
function onDisk(d: { full?: { since_ms: number; free_mb?: number }; silent_since_ms?: number } | null | undefined) {
  const at = Date.now();
  if (d?.full) hit({ key: "disk", cause: "disk", cls: "full", at, message: `${d.full.free_mb ?? "?"} MB free`, now: true });
  else if (d?.silent_since_ms !== undefined) hit({ key: "disk", cause: "disk", cls: "silent", at, message: "the store's disk does not answer", now: true });
  else changed(book().clear("disk", "the store saves again", at));
}

// This start's record: the daemon before it went down by itself (killed, a crash, a signal nobody in Keel sent).
function onStart() {
  const r = restarts()?.last();
  const how = r?.before?.how;
  if (!r || (how !== "killed" && how !== "crash" && how !== "signal")) return;
  // Counted already (the same process built its routes again: a hot reload).
  if ((book().get("restarts")?.last ?? 0) >= r.up_ms) return;
  hit({ key: "restarts", cause: "restarts", cls: how, at: r.up_ms, message: `The daemon ${how === "killed" ? "went down without stopping" : how === "crash" ? "ended on a failure" : "was stopped by a signal"}`, now: true });
}

// The cut turns of this start, as they are decided: the sessions a stop of the daemon touched.
function syncCut() {
  const i = book().get("restarts");
  const r = restarts()?.last();
  if (!i || !r) return;
  let moved = false;
  for (const t of r.turns) {
    if (i.touched.some((x) => x.id === t.session_id)) continue;
    i.touched.push({ id: t.session_id, title: t.title || "Session", parent: t.parent_id ?? null, state: "cut", n: 0, last: r.up_ms });
    moved = true;
  }
  if (moved) changed(i);
}

function tick() {
  try {
    syncCut();
    for (const i of book().quiet(Date.now())) changed(i);
  } catch (e) { capture(e, { at: "incident tick" }); }
}

// --- what reads it ---------------------------------------------------------

export type Listed = { open: Incident[]; cleared: Incident[] };
// The open ones and those that cleared in the last day, the newest first.
// `stored`: with those of the rows (a start's own memory holds only what cleared since it began).
export function listed(now = Date.now(), stored = true): Listed {
  const open = book().list().sort((a, b) => b.last - a.last);
  const seen = new Set(open.map((i) => i.id));
  const cleared: Incident[] = [];
  for (const i of book().cleared()) if (!seen.has(i.id) && i.cleared! >= now - LISTED_MS) { cleared.push(i); seen.add(i.id); }
  if (stored) try {
    for (const r of D().store.db.query<{ data: string }, [number]>("SELECT data FROM activity WHERE kind = 'daemon' AND sub = 'incident' AND ts >= ? ORDER BY ts DESC LIMIT 50").all(now - LISTED_MS)) {
      const i = JSON.parse(r.data) as Incident;
      if (i.cleared && !seen.has(i.id)) { cleared.push(i); seen.add(i.id); }
    }
  } catch (e) { capture(e, { at: "incident list" }); }
  return { open, cleared: cleared.sort((a, b) => b.cleared! - a.cleared!).slice(0, 20) };
}

// --- wiring ----------------------------------------------------------------

export function bind() {
  const s = st();
  s.off?.();
  clearInterval(s.tick);
  clearTimeout(s.frame);
  s.frame = undefined;
  s.book = new IncidentBook(() => Bun.randomUUIDv7());
  s.dirty.clear();
  const { store, bus, errors } = D();
  // What was open when the last daemon stopped: open again, its alert already told. A held wait
  // holds again only when the provider's wait takes it up; else it goes quiet like the rest.
  try {
    for (const r of store.db.query<{ data: string }, [number]>("SELECT data FROM activity WHERE kind = 'daemon' AND sub = 'incident' AND ts >= ? ORDER BY ts").all(Date.now() - RESTORE_MS)) {
      const i = JSON.parse(r.data) as Incident;
      if (!i.cleared) s.book.restore({ ...i, held: false, touched: i.touched.map((t) => (t.state === "waiting" ? { ...t, state: "went_on" as const } : t)) });
    }
  } catch (e) { capture(e, { at: "incident restore" }); }
  // A session's failure alert while an incident it is part of is open: kept in the inbox, told on no channel.
  absorbHook.of = (sessionId) => book().absorbs(sessionId, Date.now())?.id;
  const offErrors = errors.onCapture((c) => {
    if ((c.context as { kind?: unknown } | undefined)?.kind !== "stall") return;
    const e = store.error(c.id);
    hit({ key: "stall", cause: "stall", cls: "stall", at: Date.now(), message: e?.message ?? "the daemon did not answer" });
  });
  const offBus = bus.on((f) => {
    if (f.t !== "feature") return;
    if (f.name === "store") onDisk(f.data as any);
  });
  s.off = () => { offErrors(); offBus?.(); };
  onStart();
  s.tick = setInterval(tick, TICK_MS);
  (s.tick as any).unref?.();
}
