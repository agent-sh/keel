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
import { classOfText, errorClass } from "../admin/classes.ts";
import { shutWords } from "../providers/account.ts";
import { span } from "../core/watch.ts";
import type { Outage } from "../providers/outage.ts";
import { bodyOf, causeOfClass, IncidentBook, lineOf, owesAlert, titleOf, wentDownByItself, type Hit, type Incident } from "./incident-book.ts";
import { readStatus, statusFresh, statusKnown, statusOf, statusPageOf } from "../providers/status.ts";
import { absorbHook, raise, readWhere } from "./alerts.ts";
import { D, capture, emit } from "./core.ts";

const FRAME_MS = 500;
const TICK_MS = 15_000;
// Incidents a start takes up from the rows: those this young that had not cleared.
const RESTORE_MS = 24 * 3600_000;
// Cleared ones the list gives with the open ones.
const LISTED_MS = 24 * 3600_000;

// `told`: each incident's row as last written (unchanged: no write and no frame). `stored`: the
// cleared ones of the rows of the last day, read once at the start (listed() reads no table).
// `sent`: the cleared ones a frame carried already (a frame carries what cleared since the last).
// `news`: a row changed since the last frame (the alert's call writes its row before the frame).
type State = { book: IncidentBook; told: Map<string, string>; stored: Incident[]; sent: Set<string>; news?: boolean; frame?: ReturnType<typeof setTimeout>; tick?: ReturnType<typeof setInterval>; off?: () => void };
const G = globalThis as { __keelIncidents?: State };

const st = (): State => (G.__keelIncidents ??= { book: new IncidentBook(() => Bun.randomUUIDv7()), told: new Map(), stored: [], sent: new Set() });
export const book = () => st().book;

const who = (id: string) => {
  const s = D().store.session(id);
  return s ? { id: s.id, title: s.title || "Session", parent: s.parent_id ?? null } : undefined;
};
const providerOf = (model: string) => (model.includes(":") ? model.slice(0, model.indexOf(":")) : model);
const labelOf = (id: string) => D().providers.get(id)?.label ?? id;
const routeLabel = (pid: string, route: string) => (route === pid ? labelOf(pid) : `${labelOf(pid)} (${route.slice(route.indexOf(":") + 1)})`);

// Why new work is not started on a model's route now: its last answer said its account is out of
// credit, suspended or signed out, or that the account may not use the model, and the mark's time
// has not passed (the registry keeps it, src/providers/registry.ts shut). Nothing: it takes work.
// A successor, an agent, a reader and an overload fallback are not started on such a route
// (src/providers/account.ts firstOpen). The account incident is the owner's alert, not a gate: it
// would hold the route shut with no request to clear it.
export function routeShut(model: string): string | undefined {
  try {
    return shutWords(D().providers.shut(model));
  } catch (e) { capture(e, { at: "route shut", model }); return undefined; }
}

const UPSERT = `INSERT INTO activity (id, ts, kind, sub, session_id, text, data) VALUES (?, ?, 'daemon', 'incident', NULL, ?, ?)
  ON CONFLICT(id) DO UPDATE SET text = excluded.text, data = excluded.data`;
// The row's data: the incident whole, so the list and a restart read it back as it was. Written
// only when it changed. `now`: in this call, not with the side writes (the row that says its alert
// went: a kill right after the alert must not let the next start tell it again).
function persist(i: Incident, now = false): boolean {
  try {
    const s = st();
    const data = JSON.stringify(i);
    if (s.told.get(i.id) === data) return false;
    s.told.set(i.id, data);
    const { store } = D();
    const text = lineOf(i).slice(0, 500);
    const write = () => void store.db.query(UPSERT).run(i.id, i.since, text, data);
    if (now) write();
    else store.side.later("an incident row", write);
    s.news = true;
    emit("activity", { id: i.id, ts: i.since, kind: "daemon", sub: "incident", session_id: null, text, data: i });
    return true;
  } catch (e) { capture(e, { at: "incident row" }); return false; }
}

// The provider's status page the owner named, and the incident open there, on the incident as it stands. False
// while the page has not been read once: the read is on its way and takes the incident up again when it ends.
function named(i: Incident): boolean {
  if (i.cause !== "provider" || i.cleared || !i.key.startsWith("provider:")) return true;
  const pid = i.key.slice("provider:".length);
  const page = statusPageOf(pid);
  const now = statusOf(pid);
  if (JSON.stringify(now) !== JSON.stringify(i.status)) { if (now) i.status = now; else delete i.status; }
  if (!page || statusFresh(page)) return true;
  void readStatus(page).then(() => { if (!i.cleared && book().get(i.key) === i) changed(i); }, () => {});
  return statusKnown(page);
}

// The one alert, when it is owed, and the row that says so in the same call; read when the incident clears.
function tell(i: Incident) {
  if (!owesAlert(i)) return;
  i.notified = Date.now();
  raise("outage", null, titleOf(i), bodyOf(i), { incident: i.id, key: i.key });
  persist(i, true);
}

// Its row is written at once when it changed (a side write: a stop makes it before it ends), the
// alert's row in the same call as the alert; the pages hear it in the next frame.
function changed(i: Incident | undefined) {
  if (!i) return;
  const s = st();
  // A provider's alert waits for the first read of its status page (a few seconds at most), so it can name an open incident.
  const ready = named(i);
  if (owesAlert(i) && ready) tell(i);
  else persist(i);
  if (i.cleared) try { readWhere("incident", i.id); } catch (e) { capture(e, { at: "incident alert read" }); }
  if (!s.news) return;
  s.frame ??= setTimeout(frame, FRAME_MS);
  (s.frame as any)?.unref?.();
}

// One frame for what changed since the last: every open incident, and those that cleared since
// (the page keeps the cleared ones it has). Nothing changed: no frame.
export function frame() {
  const s = st();
  clearTimeout(s.frame);
  s.frame = undefined;
  if (!s.news) return;
  s.news = false;
  const recent = s.book.cleared();
  const cleared = recent.filter((i) => !s.sent.has(i.id));
  s.sent = new Set(recent.map((i) => i.id));
  try { D().bus.emit({ t: "feature", name: "incidents", data: { open: s.book.list().sort((a, b) => b.last - a.last), cleared } satisfies Listed }); } catch (e) { capture(e, { at: "incidents frame" }); }
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
    // An account is its route's (one provider can reach several: an ACP agent's upstreams).
    const route = D().providers.routeOf(s.model);
    if (reason === "error") {
      const row = store.db.query<{ data: string }, [string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'error' ORDER BY seq DESC LIMIT 1").get(sessionId);
      const data = row ? JSON.parse(row.data) : {};
      const message = String(data.message ?? "");
      // (The driver's own kind and status, where the event kept them, else the stored words.)
      const cls = typeof data.kind === "string" ? errorClass({ kind: data.kind, status: data.status, message }) ?? classOfText(message) : classOfText(message);
      const cause = causeOfClass(cls);
      if (!cause) return;
      const key = cause === "account" ? `account:${route}` : `provider:${pid}`;
      hit({ key, cause, label: cause === "account" ? routeLabel(pid, route) : labelOf(pid), cls, at, message, session: who(sessionId), failed: true });
      return;
    }
    if (reason !== "end_turn" && reason !== "max_tokens") return;
    changed(book().answered(`provider:${pid}`, "it answers again", at));
    // (A credential that went through works now: an account's incident ends at the first turn on its route.)
    changed(book().clear(`account:${route}`, "a turn on it went through", at));
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

// This start's record: the daemon before it went down by itself (killed, or a crash). A signal is
// a planned stop (systemd stops and restarts with SIGTERM), as a stop and a restart are.
function onStart() {
  const r = restarts()?.last();
  const how = r?.before?.how;
  if (!r || !wentDownByItself(how)) return;
  // Counted already (the same process built its routes again: a hot reload).
  if ((book().get("restarts")?.last ?? 0) >= r.up_ms) return;
  hit({ key: "restarts", cause: "restarts", cls: how, at: r.up_ms, message: `The daemon ${how === "killed" ? "went down without stopping" : "ended on a failure"}`, now: true });
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
// The open ones and those that cleared in the last day, the newest first: from memory (what this
// start saw clear, and what the rows held when it began), no read of a table.
export function listed(now = Date.now()): Listed {
  const s = st();
  const open = s.book.list().sort((a, b) => b.last - a.last);
  const seen = new Set(open.map((i) => i.id));
  const cleared: Incident[] = [];
  for (const i of [...s.book.cleared(), ...s.stored]) if (!seen.has(i.id) && i.cleared! >= now - LISTED_MS) { cleared.push(i); seen.add(i.id); }
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
  s.told.clear();
  s.stored = [];
  s.sent = new Set();
  s.news = false;
  const { store, bus, errors } = D();
  // The incident rows, by their own index: a start reads them once.
  store.migrate("CREATE INDEX IF NOT EXISTS activity_incident ON activity(ts) WHERE kind = 'daemon' AND sub = 'incident'");
  // What was open when the last daemon stopped: open again, its alert already told. A held wait
  // holds again only when the provider's wait takes it up; else it goes quiet like the rest.
  try {
    for (const r of store.db.query<{ data: string }, [number]>("SELECT data FROM activity INDEXED BY activity_incident WHERE kind = 'daemon' AND sub = 'incident' AND ts >= ? ORDER BY ts DESC LIMIT 200").all(Date.now() - RESTORE_MS)) {
      const i = JSON.parse(r.data) as Incident;
      s.told.set(i.id, r.data);
      if (i.cleared) s.stored.push(i);
      else s.book.restore({ ...i, held: false, touched: i.touched.map((t) => (t.state === "waiting" ? { ...t, state: "went_on" as const } : t)) });
    }
  } catch (e) { capture(e, { at: "incident restore" }); }
  // A session's failure alert while an incident it is part of is open: kept in the inbox, told on no channel.
  absorbHook.of = (sessionId, cls) => book().absorbs(sessionId, cls, Date.now())?.id;
  const offErrors = errors.onCapture((c) => {
    if ((c.context as { kind?: unknown } | undefined)?.kind !== "stall" || c.repeat) return;
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

// Leaves nothing running or hooked (a test's end; the next bind starts again).
export function unbind() {
  const s = G.__keelIncidents;
  if (!s) return;
  s.off?.();
  clearInterval(s.tick);
  clearTimeout(s.frame);
  absorbHook.of = undefined;
  delete G.__keelIncidents;
}
