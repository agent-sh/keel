// One client store: sessions, per-session events, live streaming drafts and
// errors, fed by REST on load and by the WebSocket after. Components read it
// with useStore(selector).
import { useSyncExternalStore } from "react";
import type { ErrorRecord, Frame, ImageBlock, Session, StoredEvent } from "../../../src/core/types.ts";
import type { ModelInfo } from "../../../src/providers/types.ts";

export type JobView = {
  id: string; num: number; command: string; description?: string; cwd: string; pty: boolean; log: string;
  started: number; ended?: number; exit_code?: number | null; signal?: string | null; background: boolean; bytes: number; running: boolean;
};

export type DraftBlock = { kind: "text" | "thinking" | "tool_input"; text: string; name?: string };

type State = {
  sessions: Record<string, Session>;
  events: Record<string, StoredEvent[]>;
  drafts: Record<string, Record<number, DraftBlock>>;
  models: ModelInfo[];
  defaultModel: string;
  errors: ErrorRecord[];
  connected: boolean;
};

let state: State = { sessions: {}, events: {}, drafts: {}, models: [], defaultModel: "", errors: [], connected: false };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}
export const getState = () => state;

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as T;
}

export const actions = {
  async loadSessions() {
    const { sessions } = await api<{ sessions: Session[] }>("/api/sessions");
    set({ sessions: Object.fromEntries(sessions.map((s) => [s.id, s])) });
  },
  async loadModels(refresh = false) {
    const r = await api<{ models: ModelInfo[]; default: string }>(`/api/models${refresh ? "?refresh" : ""}`);
    set({ models: r.models, defaultModel: r.default });
  },
  async loadSession(id: string) {
    const r = await api<{ session: Session; events: StoredEvent[] }>(`/api/sessions/${id}`);
    set({ sessions: { ...state.sessions, [id]: r.session }, events: { ...state.events, [id]: r.events } });
  },
  async loadErrors() {
    const r = await api<{ errors: ErrorRecord[] }>("/api/errors");
    set({ errors: r.errors });
  },
  async create(text: string, model?: string, workspace?: string, images?: ImageBlock[]): Promise<Session> {
    const r = await api<{ session: Session }>("/api/sessions", { method: "POST", body: JSON.stringify({ text, model, workspace, images }) });
    set({ sessions: { ...state.sessions, [r.session.id]: r.session } });
    return r.session;
  },
  send: (id: string, text: string, images?: ImageBlock[]) => api(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text, images }) }),
  answer: (id: string, callId: string, answers: Record<string, { picked: string[]; other?: string }>) =>
    api(`/api/sessions/${id}/questions/${callId}`, { method: "POST", body: JSON.stringify({ answers }) }),
  jobs: (id: string) => api<{ jobs: JobView[] }>(`/api/sessions/${id}/jobs`),
  stopJob: (id: string, job: string) => api(`/api/sessions/${id}/jobs/${job}/stop`, { method: "POST" }),
  interrupt: (id: string) => api(`/api/sessions/${id}/interrupt`, { method: "POST" }),
  patch: (id: string, body: Partial<Session>) => api(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  remove: async (id: string) => {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    const { [id]: _, ...rest } = state.sessions;
    set({ sessions: rest });
  },
};

// Feature modules (approvals, checkpoints, worktrees) keep their own client
// state: they get their frames, and a call after each reconnect to catch up.
type FeatureFrame = Extract<Frame, { t: "feature" }>;
type FeatureListener = { frame?: (f: FeatureFrame) => void; reconnect?: () => void };
const features = new Set<FeatureListener>();
export function onFeature(l: FeatureListener) {
  features.add(l);
  return () => void features.delete(l);
}

function apply(f: Frame) {
  if (f.t === "session") {
    const s = f.session;
    if (!state.sessions[s.id] && s.archived) return;
    set({ sessions: { ...state.sessions, [s.id]: s } });
  } else if (f.t === "event") {
    const e = f.event;
    const list = state.events[e.session_id];
    if (!list) return; // not loaded; loading it later reads it from the store
    if (list.length && list[list.length - 1]!.seq >= e.seq) return;
    const drafts = e.kind === "assistant" || e.kind === "turn_end" ? { ...state.drafts, [e.session_id]: {} } : state.drafts;
    set({ events: { ...state.events, [e.session_id]: [...list, e] }, drafts });
  } else if (f.t === "delta") {
    const cur = state.drafts[f.session_id] ?? {};
    const b = cur[f.index] ?? { kind: f.kind, text: "", name: f.name };
    set({ drafts: { ...state.drafts, [f.session_id]: { ...cur, [f.index]: { ...b, text: b.text + f.text, name: b.name ?? f.name } } } });
  } else if (f.t === "error") {
    set({ errors: [f.error, ...state.errors].slice(0, 200) });
  } else if (f.t === "feature") {
    for (const l of features) l.frame?.(f);
  }
}

let retry = 500;
export function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 500;
    set({ connected: true });
    // Catch up on whatever happened while disconnected.
    actions.loadSessions();
    for (const id of Object.keys(state.events)) actions.loadSession(id);
    for (const l of features) l.reconnect?.();
  };
  ws.onmessage = (m) => apply(JSON.parse(m.data));
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
  };
}

// Client-side error tracking: every uncaught error goes to the server's table.
export function reportError(err: unknown, context?: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  fetch("/api/errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: e.message, stack: e.stack, context: { url: location.pathname, ...(context as object) } }),
  }).catch(() => {});
}
window.addEventListener("error", (e) => reportError(e.error ?? e.message, { kind: "window.error" }));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason, { kind: "unhandledrejection" }));
