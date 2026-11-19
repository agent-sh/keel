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
import { api, onFeature, reportError } from "./store.ts";
import { getUI, navigate } from "./ui.ts";

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
};

type Unread = { total: number; sessions: Record<string, number>; children: Record<string, number>; fresh: Record<string, number>; rev: number };
const NO_UNREAD: Unread = { total: 0, sessions: {}, children: {}, fresh: {}, rev: 0 };
let state: State = { agents: {}, waits: {}, loops: {}, alerts: [], unread: NO_UNREAD, rev: 0, settings: null, channels: [], snoozes: {}, activityTick: 0, lastActivity: null, goals: {}, tasks: {} };
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

export const auto = {
  async load() {
    const r = await api<any>("/api/automation");
    set({
      agents: byId(r.agents), waits: byId(r.waits), loops: byId(r.loops), settings: r.settings, channels: r.channels,
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
    const [g, t] = await Promise.all([api<{ goal: Goal | null }>(`/api/sessions/${sid}/goal`), api<{ tasks: Task[] }>(`/api/sessions/${sid}/tasks`)]);
    set({ goals: { ...state.goals, [sid]: g.goal }, tasks: { ...state.tasks, [sid]: t.tasks } });
  },
  setGoal: (sid: string, body: { objective: string; max_turns?: number | null; token_budget?: number | null; replace?: boolean }) =>
    api<{ goal: Goal }>(`/api/sessions/${sid}/goal`, { method: "PUT", body: JSON.stringify(body) }),
  patchGoal: (sid: string, body: Record<string, unknown>) => api<{ goal: Goal }>(`/api/sessions/${sid}/goal`, { method: "PATCH", body: JSON.stringify(body) }),
  clearGoal: (sid: string) => api(`/api/sessions/${sid}/goal`, { method: "DELETE" }),
  addTask: (sid: string, text: string) => api(`/api/sessions/${sid}/tasks`, { method: "POST", body: JSON.stringify({ text }) }),
  editTask: (sid: string, id: string, body: Partial<Pick<Task, "text" | "status">>) => api(`/api/sessions/${sid}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeTask: (sid: string, id: string) => api(`/api/sessions/${sid}/tasks/${id}`, { method: "DELETE" }),
  startTask: (sid: string, id: string) => api<{ session_id: string }>(`/api/sessions/${sid}/tasks/${id}/start`, { method: "POST" }),
  advisor: () => api<{ model: string | null }>("/api/advisor"),
  setAdvisor: (model: string | null) => api<{ model: string | null }>("/api/advisor", { method: "PUT", body: JSON.stringify({ model }) }),
  sessionAdvisor: (sid: string) => api<{ model: string | null; own: string | null; default: string | null }>(`/api/sessions/${sid}/advisor`),
  setSessionAdvisor: (sid: string, model: string | null) =>
    api<{ model: string | null; own: string | null; default: string | null }>(`/api/sessions/${sid}/advisor`, { method: "PUT", body: JSON.stringify({ model }) }),
  test: () => api<{ alert?: Alert; channels: Channel[] }>("/api/alerts/test", { method: "POST", body: JSON.stringify({ kind: "agent" }) }),
  presence: (session_id: string | null, focused: boolean) =>
    fetch("/api/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id, focused, page: PAGE }) }).catch(() => {}),
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
    if (kind === "agent") set({ agents: { ...state.agents, [d.id]: d } });
    else if (kind === "wait") set({ waits: { ...state.waits, [d.id]: d } });
    else if (kind === "loop") {
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
    } else if (kind === "goal") set({ goals: { ...state.goals, [d.session_id]: d.cleared ? null : d } });
    else if (kind === "tasks") set({ tasks: { ...state.tasks, [d.session_id]: d.tasks } });
    else if (kind === "activity") set({ activityTick: state.activityTick + 1, lastActivity: d });
  },
  reconnect: () => void auto.load().catch(reportError),
});

// Presence: which session is on screen and whether the page has focus (an
// alert for a session the owner is watching stays in the page), sent when it
// changes and every 20 s; a watched session's alerts are read, except those the
// owner marked unread to come back to.
let sent = { key: "", at: 0 };
function presence() {
  const r = getUI().route;
  const sid = r.name === "session" ? r.id : null;
  const focused = document.hasFocus() && document.visibilityState === "visible";
  const key = `${sid}:${focused}`;
  if (key !== sent.key || Date.now() - sent.at > 20_000) {
    sent = { key, at: Date.now() };
    auto.presence(sid, focused);
  }
  if (sid && focused && (state.unread.fresh?.[sid] ?? 0) > 0 && !reading.has(sid)) {
    reading.add(sid);
    auto.read({ session_id: sid, auto: true }).catch(reportError).finally(() => reading.delete(sid));
  }
}
const reading = new Set<string>();
setInterval(presence, 1000);
addEventListener("focus", presence);
addEventListener("blur", presence);
document.addEventListener("visibilitychange", presence);
auto.load().catch(reportError);


export const openSession = (id: string) => navigate({ name: "session", id });

// Where a row leads, asked of the daemon when the owner opens it (the client's
// session list can be stale): the agent session, or its parent when the agent
// was deleted, and whether an approval still waits.
export type Target = { parent: string | null; child: string | null; child_deleted: boolean; open: string | null; approval?: string };
export const alertTarget = (id: string) => api<Target>(`/api/alerts/${id}/target`);
export const activityTarget = (id: string) => api<Target>(`/api/activity/${id}/target`);

// Moves keyboard focus to an approval card once the page shows it (a few
// seconds at most), so Enter answers that card and no other.
export function focusApproval(id: string) {
  const find = () => document.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(id)}"]`);
  const go = (el: HTMLElement) => {
    el.scrollIntoView({ block: "center" });
    (el.querySelector<HTMLElement>("button:not([disabled])") ?? el).focus({ preventScroll: true });
  };
  const now = find();
  if (now) return go(now);
  const mo = new MutationObserver(() => {
    const el = find();
    if (el) { mo.disconnect(); clearTimeout(t); go(el); }
  });
  const t = setTimeout(() => mo.disconnect(), 5000);
  mo.observe(document.body, { childList: true, subtree: true });
}

// The name of a row's destination: the session, and the agent inside it when
// the row came from one ("Build › Docs"), so rows from two agents never read alike.
export function placeName(sessions: Record<string, { title?: string } | undefined>, sessionId: string | null, child?: string, fallback?: { title?: string; child_title?: string }) {
  const parent = sessionId ? sessions[sessionId]?.title || (child ? "" : fallback?.title) || "" : "";
  if (!child) return parent || fallback?.title || "Keel";
  const kid = sessions[child]?.title || fallback?.child_title || `agent ${child.slice(-6)}`;
  return parent ? `${parent} › ${kid}` : kid;
}

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
  const t = s.until_ms ? new Date(s.until_ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
  if (s.suspended) return "Snooze paused: it needs you";
  return [t ? `until ${t}` : "", s.until_needed ? "until it needs you" : ""].filter(Boolean).join(" or ");
}
