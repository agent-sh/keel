// Agents, waits, loops and alerts on the client: loaded once, then kept live by
// the `automation` frames.
import { useSyncExternalStore } from "react";
import type { AgentRecord } from "../../../src/automation/agents.ts";
import type { Alert, AlertSettings } from "../../../src/automation/alerts.ts";
import type { LoopRecord, RunRecord } from "../../../src/automation/loops.ts";
import type { WaitRecord } from "../../../src/automation/waits.ts";
import { onFeature, reportError } from "./store.ts";
import { getUI, navigate } from "./ui.ts";

export type { AgentRecord, Alert, AlertSettings, LoopRecord, RunRecord, WaitRecord };
export type Channel = { id: string; label: string; available: boolean };

type State = {
  agents: Record<string, AgentRecord>;
  waits: Record<string, WaitRecord>;
  loops: Record<string, LoopRecord>;
  alerts: Alert[];
  unread: { total: number; sessions: Record<string, number> };
  settings: AlertSettings | null;
  channels: Channel[];
};

let state: State = { agents: {}, waits: {}, loops: {}, alerts: [], unread: { total: 0, sessions: {} }, settings: null, channels: [] };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};
export function useAuto<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}
export const autoState = () => state;

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as T;
}
const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

export const auto = {
  async load() {
    const r = await api<any>("/api/automation");
    set({ agents: byId(r.agents), waits: byId(r.waits), loops: byId(r.loops), alerts: r.alerts, unread: r.unread, settings: r.settings, channels: r.channels });
  },
  async loadAlerts() {
    const r = await api<{ alerts: Alert[]; unread: State["unread"] }>("/api/alerts?limit=100");
    set({ alerts: r.alerts, unread: r.unread });
  },
  stopAgent: (a: AgentRecord) => api(`/api/sessions/${a.parent_id}/agents/${a.id}/stop`, { method: "POST" }),
  cancelWait: (id: string) => api(`/api/waits/${id}`, { method: "DELETE" }),
  patchLoop: (id: string, body: Partial<LoopRecord>) => api(`/api/loops/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  runLoop: (id: string) => api(`/api/loops/${id}/run`, { method: "POST" }),
  deleteLoop: async (id: string) => {
    await api(`/api/loops/${id}`, { method: "DELETE" });
    const { [id]: _, ...rest } = state.loops;
    set({ loops: rest });
  },
  createLoop: (body: { name?: string; schedule: string; prompt: string; session_id?: string; max_runs?: number }) =>
    api<LoopRecord & { hook_key?: string }>("/api/loops", { method: "POST", body: JSON.stringify(body) }),
  runs: (id: string) => api<{ loop: LoopRecord; runs: RunRecord[] }>(`/api/loops/${id}/runs`),
  command: (sessionId: string, text: string) => api<{ handled: boolean; loop?: LoopRecord }>(`/api/sessions/${sessionId}/command`, { method: "POST", body: JSON.stringify({ text }) }),
  async read(opts: { session_id?: string; ids?: string[] } = {}) {
    const r = await api<{ unread: State["unread"] }>("/api/alerts/read", { method: "POST", body: JSON.stringify(opts) });
    const hit = (a: Alert) => (!opts.session_id && !opts.ids) || a.session_id === opts.session_id || opts.ids?.includes(a.id);
    set({ unread: r.unread, alerts: state.alerts.map((a) => (hit(a) ? { ...a, read: true } : a)) });
  },
  async unreadOne(id: string) {
    const r = await api<{ unread: State["unread"] }>(`/api/alerts/${id}/unread`, { method: "POST" });
    set({ unread: r.unread, alerts: state.alerts.map((a) => (a.id === id ? { ...a, read: false } : a)) });
  },
  async saveSettings(p: Partial<AlertSettings>) {
    const r = await api<{ settings: AlertSettings; channels: Channel[] }>("/api/alerts/settings", { method: "PUT", body: JSON.stringify(p) });
    set({ settings: r.settings, channels: r.channels });
  },
  test: () => api("/api/alerts/test", { method: "POST", body: JSON.stringify({ kind: "agent" }) }),
  presence: (session_id: string | null, focused: boolean) =>
    fetch("/api/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id, focused }) }).catch(() => {}),
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
      set({ alerts: [d, ...state.alerts.filter((a) => a.id !== d.id)].slice(0, 200) });
      refreshAlerts();
    } else if (kind === "alerts_read") refreshAlerts();
  },
  reconnect: () => void auto.load().catch(reportError),
});

// Presence: which session is on screen and whether the page has focus (an
// alert for a session the owner is watching stays in the page), sent when it
// changes and every 20 s; a watched session's alerts are read.
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
  if (sid && focused && (state.unread.sessions[sid] ?? 0) > 0 && !reading.has(sid)) {
    reading.add(sid);
    auto.read({ session_id: sid }).catch(reportError).finally(() => reading.delete(sid));
  }
}
const reading = new Set<string>();
setInterval(presence, 1000);
addEventListener("focus", presence);
addEventListener("blur", presence);
document.addEventListener("visibilitychange", presence);
auto.load().catch(reportError);


export const openSession = (id: string) => navigate({ name: "session", id });

export const isLive = (a: AgentRecord) => a.status === "running" || a.status === "waiting";

export function inMs(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `in ${Math.round(s / 86400)}d`;
}
