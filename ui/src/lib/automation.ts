// Agents, waits, loops and alerts on the client: loaded once, then kept live by
// the `automation` frames.
import { useSyncExternalStore } from "react";
import type { AgentRecord } from "../../../src/automation/agents.ts";
import type { Alert, AlertSettings } from "../../../src/automation/alerts.ts";
import type { LoopRecord, RunRecord } from "../../../src/automation/loops.ts";
import type { WaitRecord } from "../../../src/automation/waits.ts";
import type { Activity } from "../../../src/automation/activity.ts";
import type { Snooze } from "../../../src/automation/snooze.ts";
import type { Goal, Task } from "../../../src/automation/goals.ts";
import { actions, api, newer, onFeature, readAtOpen, reportError } from "./store.ts";
import { getUI, navigate } from "./ui.ts";
import { remoteId, splitId } from "./fleet-ids.ts";
import { clock } from "./utils.ts";

export type { Goal, Task };
export type { Activity, AgentRecord, Alert, AlertSettings, LoopRecord, RunRecord, Snooze, WaitRecord };
export type Channel = { id: string; label: string; available: boolean };

type State = {
  agents: Record<string, AgentRecord>;
  waits: Record<string, WaitRecord>;
  loops: Record<string, LoopRecord>;
  alerts: Alert[];
  // Unread counts; `children` per agent session, `fresh` per session without
  // what the owner kept unread on purpose; `rev` the inbox revision they are at.
  unread: Unread;
  rev: number; // the highest inbox revision this page has seen
  settings: AlertSettings | null;
  channels: Channel[];
  snoozes: Record<string, Snooze>; // "*" is the global snooze
  activityTick: number; // bumped by each new activity row
  lastActivity: Activity | null; // the row that bumped it
  goals: Record<string, Goal | null>; // by session, once loaded
  tasks: Record<string, Task[]>;
  goneDests: Record<string, true>; // task destinations their daemon said it no longer has
};

type Unread = { total: number; sessions: Record<string, number>; children: Record<string, number>; fresh: Record<string, number>; rev: number };
const NO_UNREAD: Unread = { total: 0, sessions: {}, children: {}, fresh: {}, rev: 0 };
let state: State = { agents: {}, waits: {}, loops: {}, alerts: [], unread: NO_UNREAD, rev: 0, settings: null, channels: [], snoozes: {}, activityTick: 0, lastActivity: null, goals: {}, tasks: {}, goneDests: {} };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};
export function useAuto<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}
export const autoState = () => state;

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

// A snapshot of the inbox applies only when it is not older than what the page
// already shows: replies that land out of order never put back an old count.
function applyInbox(unread: Unread, alerts?: Alert[]): boolean {
  if (unread.rev < state.unread.rev) return false;
  set({ unread, rev: Math.max(state.rev, unread.rev), ...(alerts ? { alerts } : {}) });
  return true;
}

// Each page reports its own presence: the daemon judges "watching" per page.
const PAGE = Math.random().toString(36).slice(2, 12);

// A snapshot's records merged with what the page has: per record, the newer of
// the two by the bus rev (a record a frame changed after the snapshot was read
// keeps the frame's state, a record the snapshot no longer has and no newer
// frame kept goes). `rev` undefined (an older daemon): the snapshot wins, as before.
function merge<T>(kind: string, cur: Record<string, T>, snap: Record<string, T>, rev: number | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const id of new Set([...Object.keys(cur), ...Object.keys(snap)])) {
    const take = newer(`${kind}:${id}`, rev, true);
    const v = take ? snap[id] : cur[id];
    if (v !== undefined) out[id] = v;
  }
  return out;
}

export const auto = {
  async load() {
    const r = await api<any>("/api/automation");
    set({
      agents: merge("agent", state.agents, byId(r.agents), r.rev), waits: merge("wait", state.waits, byId(r.waits), r.rev), loops: merge("loop", state.loops, byId(r.loops), r.rev),
      settings: r.settings, channels: r.channels,
      snoozes: Object.fromEntries((r.snoozes as Snooze[]).map((x) => [x.session_id, x])),
    });
    applyInbox(r.unread, r.alerts);
  },
  // The recent history and every unread alert, however old.
  async loadAlerts() {
    const r = await api<{ alerts: Alert[]; unread: Unread }>("/api/alerts?limit=100&with_unread");
    applyInbox(r.unread, r.alerts);
  },
  reviewAgent: (a: AgentRecord) => api(`/api/sessions/${a.parent_id}/reviews`, { method: "POST", body: JSON.stringify({ agent_id: a.id }) }),
  stopAgent: (a: AgentRecord) => api(`/api/sessions/${a.parent_id}/agents/${a.id}/stop`, { method: "POST" }),
  // From the agent's own session: the whole agent, as its parent's card stops it.
  stopAgentSession: (sessionId: string) => api(`/api/sessions/${sessionId}/as-agent/stop`, { method: "POST" }),
  cancelWait: (id: string) => api(`/api/waits/${id}`, { method: "DELETE" }),
  patchLoop: (id: string, body: Partial<LoopRecord>) => api(`/api/loops/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  runLoop: (id: string) => api(`/api/loops/${id}/run`, { method: "POST" }),
  deleteLoop: async (id: string) => {
    await api(`/api/loops/${id}`, { method: "DELETE" });
    const { [id]: _, ...rest } = state.loops;
    set({ loops: rest });
  },
  createLoop: (body: { name?: string; schedule: string; prompt: string; session_id?: string; max_runs?: number; signed?: boolean }) =>
    api<LoopRecord & { hook_key?: string; hook_secret?: string }>("/api/loops", { method: "POST", body: JSON.stringify(body) }),
  rotateKey: (id: string) => api<{ hook_key: string; hook_secret?: string }>(`/api/loops/${id}/hook-key`, { method: "POST" }),
  runs: (id: string) => api<{ loop: LoopRecord; runs: RunRecord[] }>(`/api/loops/${id}/runs`),
  command: (sessionId: string, text: string) => api<{ handled: boolean; loop?: LoopRecord }>(`/api/sessions/${sessionId}/command`, { method: "POST", body: JSON.stringify({ text }) }),
  // Reads what the page has seen: the request names the inbox revision shown,
  // so the daemon leaves alone anything that arrived or was marked unread since.
  // `auto` is the page reading the session on screen (what the owner kept
  // unread stays unread).
  async read(opts: { session_id?: string; ids?: string[]; auto?: boolean } = {}) {
    const seen = state.rev;
    const r = await api<{ unread: Unread }>("/api/alerts/read", { method: "POST", body: JSON.stringify({ ...opts, seen }) });
    const hit = (a: Alert) =>
      !a.read && a.rev <= seen && !(opts.auto && a.kept) &&
      ((!opts.session_id && !opts.ids) || a.session_id === opts.session_id || !!opts.ids?.includes(a.id));
    set({ alerts: state.alerts.map((a) => (hit(a) ? { ...a, read: true, kept: false } : a)) });
    applyInbox(r.unread);
  },
  async unreadOne(id: string) {
    const r = await api<{ unread: Unread }>(`/api/alerts/${id}/unread`, { method: "POST" });
    set({ alerts: state.alerts.map((a) => (a.id === id ? { ...a, read: false, kept: true, rev: r.unread.rev } : a)) });
    applyInbox(r.unread);
  },
  retry: (id: string) => api<{ alert: Alert }>(`/api/alerts/${id}/retry`, { method: "POST" }),
  async saveSettings(p: Partial<AlertSettings>) {
    const r = await api<{ settings: AlertSettings; channels: Channel[] }>("/api/alerts/settings", { method: "PUT", body: JSON.stringify(p) });
    set({ settings: r.settings, channels: r.channels });
  },
  // One channel on or off for one kind: shown at once, saved as that one change.
  async setRoute(kind: keyof AlertSettings["routes"], channel: string, on: boolean) {
    if (state.settings) {
      const cur = (state.settings.routes[kind] ?? []).filter((c) => c !== channel);
      set({ settings: { ...state.settings, routes: { ...state.settings.routes, [kind]: on ? [...cur, channel] : cur } } });
    }
    const r = await api<{ settings: AlertSettings; channels: Channel[] }>("/api/alerts/settings", { method: "PUT", body: JSON.stringify({ route: { kind, channel, on } }) });
    set({ settings: r.settings, channels: r.channels });
  },
  snooze: (sessionId: string, body: { until_ms?: number; until_needed?: boolean }) =>
    api(`/api/sessions/${sessionId}/snooze`, { method: "PUT", body: JSON.stringify(body) }),
  unsnooze: (sessionId: string) => api(`/api/sessions/${sessionId}/snooze`, { method: "DELETE" }),
  snoozeAll: (until_ms: number) => api("/api/snooze", { method: "PUT", body: JSON.stringify({ until_ms }) }),
  unsnoozeAll: () => api("/api/snooze", { method: "DELETE" }),
  activity: (q: { before?: string; kind?: string[]; session_id?: string; q?: string }, init?: RequestInit) => {
    const p = new URLSearchParams({ limit: "50" });
    if (q.before) p.set("before", q.before);
    if (q.kind?.length) p.set("kind", q.kind.join(","));
    if (q.session_id) p.set("session_id", q.session_id);
    if (q.q) p.set("q", q.q);
    return api<{ items: Activity[]; has_more: boolean; kinds: string[] }>(`/api/activity?${p}`, init);
  },
  activitySessions: () => api<{ sessions: { session_id: string; last: number }[] }>("/api/activity/sessions"),
  async loadSessionPlan(sid: string) {
    const [g, t] = await Promise.all([api<{ goal: Goal | null; rev?: number }>(`/api/sessions/${sid}/goal`), api<{ tasks: Task[]; gone?: string[]; rev?: number }>(`/api/sessions/${sid}/tasks`)]);
    set({
      goneDests: t.gone?.length ? { ...state.goneDests, ...Object.fromEntries(t.gone.map((id) => [id, true as const])) } : state.goneDests,
      goals: newer(`goal:${sid}`, g.rev, true) ? { ...state.goals, [sid]: g.goal } : state.goals,
      tasks: newer(`tasks:${sid}`, t.rev, true) ? { ...state.tasks, [sid]: t.tasks } : state.tasks,
    });
  },
  setGoal: (sid: string, body: { objective: string; max_turns?: number | null; token_budget?: number | null; replace?: boolean }) =>
    api<{ goal: Goal }>(`/api/sessions/${sid}/goal`, { method: "PUT", body: JSON.stringify(body) }),
  patchGoal: (sid: string, body: Record<string, unknown>) => api<{ goal: Goal }>(`/api/sessions/${sid}/goal`, { method: "PATCH", body: JSON.stringify(body) }),
  clearGoal: (sid: string) => api(`/api/sessions/${sid}/goal`, { method: "DELETE" }),
  addTask: (sid: string, text: string) => api(`/api/sessions/${sid}/tasks`, { method: "POST", body: JSON.stringify({ text }) }),
  editTask: (sid: string, id: string, body: Partial<Pick<Task, "text" | "status">> & { was?: string }) => api(`/api/sessions/${sid}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeTask: (sid: string, id: string) => api(`/api/sessions/${sid}/tasks/${id}`, { method: "DELETE" }),
  // The new session is on the daemon that owns the source session.
  startTask: (sid: string, id: string) =>
    api<{ session_id: string }>(`/api/sessions/${sid}/tasks/${id}/start`, { method: "POST" }).then((r) => {
      const from = splitId(sid);
      return from ? { ...r, session_id: remoteId(from.machine, r.session_id) } : r;
    }),
  advisor: () => api<{ model: string | null }>("/api/advisor"),
  setAdvisor: (model: string | null) => api<{ model: string | null }>("/api/advisor", { method: "PUT", body: JSON.stringify({ model }) }),
  sessionAdvisor: (sid: string) => api<{ model: string | null; own: string | null; default: string | null }>(`/api/sessions/${sid}/advisor`),
  setSessionAdvisor: (sid: string, model: string | null) =>
    api<{ model: string | null; own: string | null; default: string | null }>(`/api/sessions/${sid}/advisor`, { method: "PUT", body: JSON.stringify({ model }) }),
  test: () => api<{ alert?: Alert; channels: Channel[] }>("/api/alerts/test", { method: "POST", body: JSON.stringify({ kind: "agent" }) }),
  // `idle_ms`: how long ago the owner last did something in this page (absent: not yet).
  presence: (session_id: string | null, focused: boolean, idle_ms?: number) =>
    fetch("/api/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id, focused, page: PAGE, ...(idle_ms === undefined ? {} : { idle_ms }) }), keepalive: true }).catch(() => {}),
};

let alertsTimer: ReturnType<typeof setTimeout> | undefined;
const refreshAlerts = () => {
  clearTimeout(alertsTimer);
  alertsTimer = setTimeout(() => auto.loadAlerts().catch(reportError), 150);
};

onFeature({
  frame: (f) => {
    if (f.name !== "automation") return;
    const { kind, data: d } = f.data as { kind: string; data: any };
    // Records are ordered by the bus rev: a frame older than what a snapshot already showed is dropped.
    if (kind === "agent") { if (newer(`agent:${d.id}`, f.rev)) set({ agents: { ...state.agents, [d.id]: d } }); }
    else if (kind === "wait") { if (newer(`wait:${d.id}`, f.rev)) set({ waits: { ...state.waits, [d.id]: d } }); }
    else if (kind === "loop") {
      if (!newer(`loop:${d.id}`, f.rev)) return;
      if (d.deleted) {
        const { [d.id]: _, ...rest } = state.loops;
        set({ loops: rest });
      } else set({ loops: { ...state.loops, [d.id]: d } });
    } else if (kind === "alert") {
      // A new alert goes on top; an update (a channel's handoff) keeps its place.
      const at = state.alerts.findIndex((a) => a.id === d.id);
      const alerts = at >= 0 ? state.alerts.map((a, i) => (i === at ? { ...a, delivery: d.delivery } : a)) : [d, ...state.alerts];
      set({ alerts, rev: Math.max(state.rev, d.rev ?? 0) });
      refreshAlerts();
    } else if (kind === "alerts_read") refreshAlerts();
    else if (kind === "snooze") {
      const { [d.session_id]: _, ...rest } = state.snoozes;
      set({ snoozes: d.snooze ? { ...rest, [d.session_id]: d.snooze } : rest });
    } else if (kind === "goal") { if (newer(`goal:${d.session_id}`, f.rev)) set({ goals: { ...state.goals, [d.session_id]: d.cleared ? null : d } }); }
    else if (kind === "tasks") { if (newer(`tasks:${d.session_id}`, f.rev)) set({ tasks: { ...state.tasks, [d.session_id]: d.tasks } }); }
    else if (kind === "activity") set({ activityTick: state.activityTick + 1, lastActivity: d });
  },
  reconnect: () => reread(),
});

// Presence: which session is on screen and whether the page has focus (an
// alert for a session the owner is watching stays in the page), sent when it
// changes and every 20 s; a watched session's alerts are read, except those the
// owner marked unread to come back to.
// With it goes how long ago the owner last did something here (a key, the
// pointer, the wheel, a touch): the daemon reads the owner's absences off
// that, not off focus, which a page keeps while nobody is there.
let sent = { key: "", at: 0 };
let lastInput = 0;
function presence(now = false) {
  const r = getUI().route;
  const sid = r.name === "session" ? r.id : null;
  const focused = document.hasFocus() && document.visibilityState === "visible";
  const key = `${sid}:${focused}`;
  if (now === true || key !== sent.key || Date.now() - sent.at > 20_000) {
    sent = { key, at: Date.now() };
    auto.presence(sid, focused, lastInput ? Date.now() - lastInput : undefined);
  }
  if (sid && focused && (state.unread.fresh?.[sid] ?? 0) > 0 && !reading.has(sid)) {
    reading.add(sid);
    auto.read({ session_id: sid, auto: true }).catch(reportError).finally(() => reading.delete(sid));
  }
}
const reading = new Set<string>();
setInterval(() => presence(), 1000);
addEventListener("focus", () => presence());
addEventListener("blur", () => presence());
document.addEventListener("visibilitychange", () => presence());
// A page that goes away says when its owner was last there, so what they did since the last report is not lost.
addEventListener("pagehide", () => presence(true));
// The first input after a while is the owner coming back: said at once. Any other is said within
// five seconds, not at the next report, so the daemon knows to within that when they were last there.
function input() {
  const now = Date.now();
  const back = now - lastInput > 60_000;
  lastInput = now;
  if (back || now - sent.at > 5_000) presence(true);
}
for (const type of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"]) addEventListener(type, input, { capture: true, passive: true });
const reread = readAtOpen(() => auto.load());


export const openSession = (id: string) => navigate({ name: "session", id });

// Stop on a session's page: an agent's session stops the whole agent (by the
// owner, its waits cancelled), any other session its turn.
export const stopHere = (s: { id: string; parent_id?: string | null }) =>
  (s.parent_id ? auto.stopAgentSession(s.id).catch((e) => ((e as { status?: number }).status === 400 ? actions.interrupt(s.id) : Promise.reject(e))) : actions.interrupt(s.id)).catch(reportError);

// Where a row leads, asked of the daemon when the owner opens it (the client's
// session list can be stale): the agent session, or its parent when the agent
// was deleted, and whether an approval still waits.
export type Target = { parent: string | null; child: string | null; child_deleted: boolean; open: string | null; approval?: string };
export const alertTarget = (id: string) => api<Target>(`/api/alerts/${id}/target`);
export const activityTarget = (id: string) => api<Target>(`/api/activity/${id}/target`);

// Where the keyboard is to land on an approval card the owner is on the way to:
// - "allow": on that card, and on its Allow once after the settle time, so
//   Enter then answers that card and no other (a link that names one
//   request). Code never puts the keyboard straight on an answer (lib/asks.ts),
//   and a card whose text is not all shown never has it on one: there it
//   stays on the list of requests.
// - "card": on the list of requests, not on an answer. For an arrival from a
//   row that showed the request in short (the home screen, the Inbox): it is
//   read here first, and a key pressed on the way in answers nothing.
// - "deny": the card opens its denial, the keyboard in the reason field. Never on Allow.
// The card itself reads this when it is drawn (`arrivalOf`), however late that
// is: an arrival is never forgotten in a way that lets the card take the
// keyboard on an answer. What is typed between a press of Deny and the reason
// field taking the keyboard is kept for that field (`typed`).
export type Arrival = { to: "allow" | "card" | "deny"; typed: string };
const arrivals = new Map<string, Arrival & { stop: () => void }>();
// The arrival a card is to honour, taken once (a later look gets nothing).
export function arrivalOf(id: string): Arrival | undefined {
  const a = arrivals.get(id);
  if (!a) return undefined;
  arrivals.delete(id);
  a.stop();
  return { to: a.to, typed: a.typed };
}
// One still waiting for its card (the card asks before it takes the keyboard by itself).
export const arriving = (id: string): Arrival["to"] | undefined => arrivals.get(id)?.to;

// Brings an approval card into view once the page shows it and gives it the keyboard as `to` says.
export function focusApproval(id: string, to: Arrival["to"] = "allow") {
  arrivals.get(id)?.stop();
  // Letters typed on the way to a denial are the reason's: they are kept, not handed to whatever has the keyboard meanwhile.
  const keep = (e: KeyboardEvent) => {
    const a = arrivals.get(id);
    if (!a || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.key.length === 1) a.typed += e.key;
    else if (e.key === "Backspace") a.typed = a.typed.slice(0, -1);
    else if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
  };
  // (Kept for a few seconds at most: a card that does not come by then is not coming for these keys.)
  const stopKeys = () => removeEventListener("keydown", keep, true);
  if (to === "deny") { addEventListener("keydown", keep, true); setTimeout(stopKeys, 4000); }
  // An arrival waits for its card however late it is drawn: a card that comes late never takes the
  // keyboard on an answer the arrival did not ask for. One nobody took (the request was answered
  // elsewhere, the session is gone) is dropped after ten minutes.
  const forget = setTimeout(() => arrivalOf(id), 600_000);
  const mo = new MutationObserver(() => { if (find()) { mo.disconnect(); go(); } });
  arrivals.set(id, { to, typed: "", stop: () => { stopKeys(); clearTimeout(forget); mo.disconnect(); } });
  const find = () => document.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(id)}"]`);
  // A card already on the page is told now; one drawn later reads the arrival itself.
  const go = () => {
    const el = find();
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.dispatchEvent(new CustomEvent("keel:arrive", { bubbles: false }));
  };
  if (find()) go();
  else mo.observe(document.body, { childList: true, subtree: true });
}

// The name of a row's destination: the session, and the agent inside it when
// the row came from one ("Build › Docs"), so rows from two agents never read alike.
export function placeName(sessions: Record<string, { title?: string } | undefined>, sessionId: string | null, child?: string, fallback?: { title?: string; child_title?: string }) {
  const parent = sessionId ? sessions[sessionId]?.title || (child ? "" : fallback?.title) || "" : "";
  if (!child) return parent || fallback?.title || "Keel";
  const kid = sessions[child]?.title || fallback?.child_title || `agent ${child.slice(-6)}`;
  return parent ? `${parent} › ${kid}` : kid;
}

// The session a bare /advisor came from: Settings > Agents then sets its advisor first.
let advisorFrom: { id: string; title: string } | null = null;
export const advisorSession = () => advisorFrom;
export const setAdvisorSession = (s: { id: string; title: string } | null) => void (advisorFrom = s);

export const isLive = (a: AgentRecord) => a.status === "running" || a.status === "waiting";

export function inMs(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `in ${Math.round(s / 86400)}d`;
}

export function snoozeText(s: Snooze): string {
  const t = s.until_ms ? clock(s.until_ms, { weekday: true }) : "";
  if (s.suspended) return "Snooze paused: it needs you";
  return [t ? `until ${t}` : "", s.until_needed ? "until it needs you" : ""].filter(Boolean).join(" or ");
}
