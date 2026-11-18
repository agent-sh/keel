// One client store: sessions, per-session events, live streaming drafts and
// errors, fed by REST on load and by the WebSocket after. Components read it
// with useStore(selector).
import { useSyncExternalStore } from "react";
import type { ErrorRecord, Frame, ImageBlock, QueueItem, Session, StoredEvent, TurnStatus } from "../../../src/core/types.ts";
import type { ModelInfo, ProviderStatus } from "../../../src/providers/types.ts";
import { apiPath, localize, splitId } from "./fleet-ids.ts";

export type ProvidersReport = {
  providers: (ProviderStatus & { listing: { state: string; fetched_ms?: number; error?: string; models: number } })[];
  plugins: { id: string; state: string; name?: string; version?: string; reason?: string; stderr_tail?: string; violations: { count: number; last: string } }[];
  plugins_file?: string | null;
  choices: { default?: string; hidden: Record<string, string[]>; hidden_providers?: string[]; pinned?: string[] };
};

// A listed model as the picker gets it: `hidden` when the owner hid it or its provider.
export type ListedModel = ModelInfo & { hidden?: true };
export type ChoiceChange = { pin?: string[]; unpin?: string[]; provider?: string; hide?: string[]; show?: string[]; hide_provider?: string; show_provider?: string };

export type JobView = {
  id: string; num: number; command: string; description?: string; cwd: string; pty: boolean; log: string;
  started: number; ended?: number; exit_code?: number | null; signal?: string | null; background: boolean; bytes: number; running: boolean; last?: string;
};

export type DraftBlock = { kind: "text" | "thinking" | "tool_input"; text: string; name?: string };

type State = {
  sessions: Record<string, Session>;
  events: Record<string, StoredEvent[]>;
  drafts: Record<string, Record<number, DraftBlock>>;
  models: ListedModel[];
  defaultModel: string;
  pinned: string[];
  providerLabels: Record<string, string>;
  errors: ErrorRecord[];
  connected: boolean;
  providers: ProvidersReport | null;
  queues: Record<string, { queue: QueueItem[]; held: boolean }>;
  status: Record<string, TurnStatus>;
  // Text handed to a session's composer (a forked-off prompt to edit).
  composer: Record<string, string>;
};

let state: State = {
  sessions: {}, events: {}, drafts: {}, models: [], defaultModel: "", pinned: [], providerLabels: {}, errors: [], connected: false, providers: null, queues: {}, status: {}, composer: {},
};
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
  const r = await fetch(apiPath(path), { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as T;
}

export const actions = {
  async loadSessions() {
    const { sessions } = await api<{ sessions: Session[] }>("/api/sessions");
    // Sessions of other machines (the fleet module keeps them) stay.
    const remote = Object.entries(state.sessions).filter(([id]) => splitId(id));
    set({ sessions: Object.fromEntries([...remote, ...sessions.map((s) => [s.id, s] as const)]) });
  },
  async loadModels(refresh = false) {
    const r = await api<{ models: ListedModel[]; default: string; pinned: string[]; providers: { id: string; label: string }[] }>(`/api/models${refresh ? "?refresh" : ""}`);
    set({ models: r.models, defaultModel: r.default, pinned: r.pinned ?? [], providerLabels: Object.fromEntries((r.providers ?? []).map((p) => [p.id, p.label])) });
  },
  // Favorites and hidden models: applied here at once, then saved.
  async choose(change: ChoiceChange) {
    const pinned = state.pinned.filter((id) => !change.unpin?.includes(id)).concat((change.pin ?? []).filter((id) => !state.pinned.includes(id)));
    const off = (m: ListedModel) =>
      change.hide_provider === m.provider || (change.provider === m.provider && change.hide?.includes(m.model))
        ? true
        : change.show_provider === m.provider || (change.provider === m.provider && change.show?.includes(m.model))
          ? false
          : !!m.hidden;
    set({ pinned, models: state.models.map((m) => { const h = off(m); return h === !!m.hidden ? m : h ? { ...m, hidden: true } : (({ hidden: _, ...rest }) => rest)(m); }) });
    try {
      const r = await api<ProvidersReport>("/api/providers/choices", { method: "POST", body: JSON.stringify(change) });
      set({ providers: r });
    } finally {
      await actions.loadModels();
    }
  },
  async loadProviders(refresh = false) {
    const r = await api<ProvidersReport>(refresh ? "/api/providers/refresh" : "/api/providers", refresh ? { method: "POST", body: "{}" } : undefined);
    set({ providers: r });
    if (refresh) await actions.loadModels();
  },
  async setDefaultModel(id: string) {
    const r = await api<ProvidersReport>("/api/providers/choices", { method: "POST", body: JSON.stringify({ default: id }) });
    set({ providers: r, defaultModel: id });
  },
  grokSignIn: () => api<any>("/api/providers/grok/sign-in", { method: "POST" }),
  grokSignInState: () => api<any>("/api/providers/grok/sign-in"),
  async loadSession(id: string) {
    const r = await api<{ session: Session; events: StoredEvent[]; queue: QueueItem[]; held: boolean }>(`/api/sessions/${id}`);
    const loc = localize(id, r.session, r.events);
    set({
      sessions: { ...state.sessions, [id]: loc.session },
      events: { ...state.events, [id]: loc.events! },
      queues: { ...state.queues, [id]: { queue: r.queue, held: r.held } },
    });
  },
  async loadArchived() {
    const { sessions } = await api<{ sessions: Session[] }>("/api/sessions?archived=1");
    set({ sessions: { ...state.sessions, ...Object.fromEntries(sessions.map((s) => [s.id, s])) } });
  },
  async loadErrors() {
    const r = await api<{ errors: ErrorRecord[] }>("/api/errors");
    set({ errors: r.errors });
  },
  resolveError: (id: string, resolved: boolean) => api(`/api/errors/${id}`, { method: "PATCH", body: JSON.stringify({ resolved }) }),
  resolveAllErrors: () => api("/api/errors/resolve-all", { method: "POST" }),
  async create(text: string, model?: string, workspace?: string, images?: ImageBlock[]): Promise<Session> {
    const r = await api<{ session: Session }>("/api/sessions", { method: "POST", body: JSON.stringify({ text, model, workspace, images }) });
    set({ sessions: { ...state.sessions, [r.session.id]: r.session } });
    return r.session;
  },
  send: (id: string, text: string, opts: { images?: ImageBlock[]; mode?: "send" | "queue" } = {}) =>
    api(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text, images: opts.images, mode: opts.mode }) }),
  edit: (id: string, eventId: string, text: string) =>
    api(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text, edit_of: eventId }) }),
  answer: (id: string, callId: string, answers: Record<string, { picked: string[]; other?: string }>) =>
    api(`/api/sessions/${id}/questions/${callId}`, { method: "POST", body: JSON.stringify({ answers }) }),
  jobs: (id: string) => api<{ jobs: JobView[] }>(`/api/sessions/${id}/jobs`),
  stopJob: (id: string, job: string) => api(`/api/sessions/${id}/jobs/${job}/stop`, { method: "POST" }),
  interrupt: (id: string) => api(`/api/sessions/${id}/interrupt`, { method: "POST" }),
  patch: async (id: string, body: Partial<Omit<Session, "settings">> & { settings?: Record<string, unknown> }) => {
    const r = await api<{ session: Session }>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    set({ sessions: { ...state.sessions, [id]: r.session } });
    return r.session;
  },
  // `leaf`: show the newest end of the branch below the event (a version
  // switch); without it the event itself becomes the head (undo a clear).
  setHead: (id: string, eventId: string, reveal = false, leaf = true) =>
    api(`/api/sessions/${id}/head`, { method: "POST", body: JSON.stringify({ head_event_id: eventId, reveal, leaf }) }),
  async fork(id: string, eventId: string, before = false): Promise<Session> {
    const r = await api<{ session: Session; prompt_text?: string }>(`/api/sessions/${id}/fork`, {
      method: "POST", body: JSON.stringify({ event_id: eventId, before }),
    });
    set({ sessions: { ...state.sessions, [r.session.id]: r.session }, composer: r.prompt_text ? { ...state.composer, [r.session.id]: r.prompt_text } : state.composer });
    return r.session;
  },
  compact: (id: string, focus?: string) => api(`/api/sessions/${id}/compact`, { method: "POST", body: JSON.stringify({ focus }) }),
  clear: (id: string) => api<{ undo_head_event_id: string }>(`/api/sessions/${id}/clear`, { method: "POST" }),
  resume: (id: string) => api(`/api/sessions/${id}/resume`, { method: "POST" }),
  context: (id: string) => api<ContextInfo>(`/api/sessions/${id}/context`),
  queueResume: (id: string) => api(`/api/sessions/${id}/queue/resume`, { method: "POST" }),
  queueEdit: (id: string, qid: string, body: { text?: string; steer?: boolean; position?: number }) =>
    api(`/api/sessions/${id}/queue/${qid}`, { method: "PATCH", body: JSON.stringify(body) }),
  queueRemove: (id: string, qid: string) => api(`/api/sessions/${id}/queue/${qid}`, { method: "DELETE" }),
  queueSendNow: (id: string, qid: string) => api(`/api/sessions/${id}/queue/${qid}/send`, { method: "POST" }),
  takeComposer(id: string): string | undefined {
    const t = state.composer[id];
    if (t !== undefined) {
      const { [id]: _, ...rest } = state.composer;
      set({ composer: rest });
    }
    return t;
  },
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
export type ContextInfo = {
  context_window: number;
  context_used_tokens: number;
  compacts_at_tokens: number;
  zones: { key: string; bytes: number; estimated_tokens: number }[];
  last_usage: { input: number; output: number; cache_read: number; cache_write: number; cost?: number } | null;
};


export function apply(f: Frame) {
  if (f.t === "session") {
    const s = f.session;
    if (!state.sessions[s.id] && s.archived) return;
    set({ sessions: { ...state.sessions, [s.id]: s } });
  } else if (f.t === "event") {
    const e = f.event;
    const list = state.events[e.session_id];
    if (!list) return; // not loaded; loading it later reads it from the store
    if (list.length && list[list.length - 1]!.seq >= e.seq) return;
    // The new event is the head of its session (the store appends at the head).
    const s = state.sessions[e.session_id];
    if (s) state = { ...state, sessions: { ...state.sessions, [s.id]: { ...s, head: e.id } } };
    const drafts = e.kind === "assistant" || e.kind === "turn_end" ? { ...state.drafts, [e.session_id]: {} } : state.drafts;
    set({ events: { ...state.events, [e.session_id]: [...list, e] }, drafts });
  } else if (f.t === "delta") {
    const cur = state.drafts[f.session_id] ?? {};
    const b = cur[f.index] ?? { kind: f.kind, text: "", name: f.name };
    set({ drafts: { ...state.drafts, [f.session_id]: { ...cur, [f.index]: { ...b, text: b.text + f.text, name: b.name ?? f.name } } } });
  } else if (f.t === "queue") {
    set({ queues: { ...state.queues, [f.session_id]: { queue: f.queue, held: f.held } } });
  } else if (f.t === "status") {
    // A retried attempt starts the reply again: drop what it streamed.
    const drafts = f.status.kind === "retry" ? { ...state.drafts, [f.session_id]: {} } : state.drafts;
    set({ status: { ...state.status, [f.session_id]: f.status }, drafts });
  } else if (f.t === "error") {
    // A repeat or a resolve updates the kind's row; the latest goes on top.
    set({ errors: [f.error, ...state.errors.filter((e) => e.id !== f.error.id)].slice(0, 200) });
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
