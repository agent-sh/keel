// One client store: sessions, per-session events, live streaming drafts and
// errors, fed by REST on load and by the WebSocket after. Components read it
// with useStore(selector).
import { useSyncExternalStore } from "react";
import type { ErrorRecord, Frame, PromptBlock, QueueItem, Session, SocketFrame, StoredEvent, TurnStatus } from "../../../src/core/types.ts";
import type { ModelInfo, ProviderStatus } from "../../../src/providers/types.ts";
import { apiPath, localize, splitId } from "./fleet-ids.ts";
import { seedComposer } from "./ui.ts";
import { servedUi } from "./hotui.ts";

export type ProvidersReport = {
  providers: (ProviderStatus & { listing: { state: string; fetched_ms?: number; error?: string; models: number }; problem?: ProviderProblem })[];
  plugins: { id: string; state: string; name?: string; version?: string; reason?: string; stderr_tail?: string; violations: { count: number; last: string } }[];
  plugins_file?: string | null;
  choices: { default?: string; hidden: Record<string, string[]>; hidden_providers?: string[]; pinned?: string[] };
  windows?: LimitWindow[];
};

// A listed model as the picker gets it: `hidden` when the owner hid it or its provider.
export type ListedModel = ModelInfo & { hidden?: true; hidden_by?: "model" | "provider" | "both" };
export type LimitWindow = {
  provider: string; id: string; label: string; used_percent?: number; remaining?: number; limit?: number;
  unit?: "requests" | "tokens" | "usd"; resets_at_ms?: number; spent_usd?: number; overage_enabled?: boolean; note?: string; observed_ms: number;
};
export type ProviderProblem = { kind: "auth" | "billing"; message: string; at: number; source: string; link?: string };
export type Limits = { windows: LimitWindow[]; close: string[]; problems: Record<string, ProviderProblem>; close_percent: number };
export type ChoiceChange = { pin?: string[]; unpin?: string[]; provider?: string; hide?: string[]; show?: string[]; hide_provider?: string; show_provider?: string };

export type JobView = {
  id: string; num: number; command: string; description?: string; cwd: string; pty: boolean; log: string;
  started: number; ended?: number; exit_code?: number | null; signal?: string | null; background: boolean; bytes: number; running: boolean; last?: string; stop_reason?: string;
};

export type DraftBlock = { kind: "text" | "thinking" | "tool_input"; text: string; name?: string };

type State = {
  sessions: Record<string, Session>;
  // Deleted while this page was open: the parent's id for a subagent's session (its view links back), else true.
  gone: Record<string, string | true>;
  events: Record<string, StoredEvent[]>;
  drafts: Record<string, Record<number, DraftBlock>>;
  models: ListedModel[];
  defaultModel: string;
  pinned: string[];
  providerLabels: Record<string, string>;
  limits: Limits | null;
  errors: ErrorRecord[];
  connected: boolean;
  // The socket is open and the open sessions are restored on it (the replay
  // came and their snapshots landed): until then the page is catching up.
  synced: boolean;
  loaded: { sessions: boolean; models: boolean }; // the first listing of each arrived (first-run screens wait for it)
  providers: ProvidersReport | null;
  queues: Record<string, { queue: QueueItem[]; held: boolean }>;
  status: Record<string, TurnStatus>;
};

let state: State = { loaded: { sessions: false, models: false },
  sessions: {}, gone: {}, events: {}, drafts: {}, models: [], defaultModel: "", pinned: [], providerLabels: {}, limits: null, errors: [], connected: false, synced: false, providers: null, queues: {}, status: {},
};
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};

// One subscribe function for every reader: a new one per render would make
// React unsubscribe and subscribe again on each render.
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}
export const getState = () => state;

// A write a remote device makes with the owner's authority answers 428 with
// the action to sign: the page gets a passkey assertion (lib/presence.ts) and
// sends the same request once more. Cancelling sends nothing again.
export const presenceHook: { sign?: (action: string) => Promise<string | null> } = {};

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const send = (extra?: Record<string, string>) => fetch(apiPath(path), { ...init, headers: { "content-type": "application/json", ...init?.headers, ...extra } });
  // A body cut short (the daemon restarting mid-answer) is a dropped request,
  // as fetch reports one; an answer that is not JSON is a fault of its own.
  // Neither becomes an empty object a caller then reads fields of.
  const read = async (r: Response): Promise<any> => {
    const text = await r.text().catch(() => null);
    if (text === null) throw new TypeError(`Failed to fetch ${path}: the answer was cut short`);
    if (!text) return {};
    try { return JSON.parse(text); } catch {
      if (r.ok) throw Object.assign(new Error(`${path} answered with something other than JSON`), { status: r.status });
      return {};
    }
  };
  let r = await send();
  let body = await read(r);
  if (r.status === 428 && body.presence?.action && presenceHook.sign) {
    const receipt = await presenceHook.sign(body.presence.action);
    if (!receipt) throw Object.assign(new Error("Not done: the passkey check was cancelled."), { status: 428 });
    r = await send({ "x-keel-presence": receipt });
    body = await read(r);
  }
  if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status, body });
  return body as T;
}

export const actions = {
  async loadSessions() {
    const { sessions } = await api<{ sessions: Session[] }>("/api/sessions");
    // Sessions of other machines (the fleet module keeps them) stay.
    const remote = Object.entries(state.sessions).filter(([id]) => splitId(id));
    set({ sessions: Object.fromEntries([...remote, ...sessions.map((s) => [s.id, s] as const)]), loaded: { ...state.loaded, sessions: true } });
  },
  async loadModels(refresh = false) {
    const r = await api<{ models: ListedModel[]; default: string; pinned: string[]; providers: { id: string; label: string }[] }>(`/api/models${refresh ? "?refresh" : ""}`);
    set({ loaded: { ...state.loaded, models: true }, models: r.models, defaultModel: r.default, pinned: r.pinned ?? [], providerLabels: Object.fromEntries((r.providers ?? []).map((p) => [p.id, p.label])) });
  },
  async loadLimits(refresh = false) {
    set({ limits: await api<Limits>(`/api/limits${refresh ? "?refresh" : ""}`) });
  },
  // Favorites and hidden models: applied here at once, then saved.
  async choose(change: ChoiceChange) {
    const pinned = state.pinned.filter((id) => !change.unpin?.includes(id)).concat((change.pin ?? []).filter((id) => !state.pinned.includes(id)));
    // The two rules apart: showing a provider leaves a model hidden on its own hidden.
    const by = (m: ListedModel) => {
      let p = m.hidden_by === "provider" || m.hidden_by === "both";
      let own = m.hidden_by === "model" || m.hidden_by === "both";
      if (change.hide_provider === m.provider) p = true;
      if (change.show_provider === m.provider) p = false;
      if (change.provider === m.provider && change.hide?.includes(m.model)) own = true;
      if (change.provider === m.provider && change.show?.includes(m.model)) own = false;
      return p && own ? "both" : p ? "provider" : own ? "model" : undefined;
    };
    set({ pinned, models: state.models.map((m) => { const h = by(m); if (h === m.hidden_by) return m; const { hidden: _, hidden_by: __, ...rest } = m; return h ? { ...rest, hidden: true, hidden_by: h } : rest; }) });
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
    // The page's first session load started at boot (see preloadSession) is taken once.
    if (preload?.id === id) { const p = preload.p; preload = null; return p; }
    // Events that arrive while the snapshot is on its way are kept and merged:
    // the snapshot may be older or newer than any of them.
    if (!state.events[id]) loading.set(id, loading.get(id) ?? []);
    // What changes the draft while the snapshot is on its way, to replay over the snapshot's draft.
    const log = draftLog.get(id) ?? { n: 0, frames: [] };
    log.n++;
    draftLog.set(id, log);
    let r: { session: Session; events: StoredEvent[]; queue: QueueItem[]; held: boolean; status?: TurnStatus; draft?: Record<number, DraftBlock>; rev?: number };
    try {
      r = await api(`/api/sessions/${id}`);
    } catch (e) {
      loading.delete(id);
      throw e;
    } finally {
      if (--log.n === 0) draftLog.delete(id);
    }
    const early = loading.get(id) ?? [];
    loading.delete(id);
    const loc = localize(id, r.session, r.events);
    // Each mutable part is taken from the snapshot only when no newer live
    // frame set it while the request was out: a late snapshot never brings back
    // an old head, queue or retry countdown.
    let drafts = state.drafts;
    if (r.draft && r.rev !== undefined && newer(`${id}:draft`, r.rev, true)) {
      let d: Record<number, DraftBlock> = r.draft;
      for (const f of log.frames) if ((f.rev ?? 0) > r.rev) d = draftStep(d, f) ?? d;
      drafts = { ...drafts, [id]: d };
    }
    set({
      sessions: newer(`${id}:session`, r.rev, true) ? { ...state.sessions, [id]: loc.session } : state.sessions,
      events: { ...state.events, [id]: mergeEvents(mergeEvents(state.events[id] ?? [], loc.events!), early) },
      queues: newer(`${id}:queue`, r.rev, true) ? { ...state.queues, [id]: { queue: r.queue, held: r.held } } : state.queues,
      status: r.status && newer(`${id}:status`, r.rev, true) ? { ...state.status, [id]: r.status } : state.status,
      drafts,
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
  readError: (id: string, read: boolean) => api(`/api/errors/${id}`, { method: "PATCH", body: JSON.stringify({ read }) }),
  // As resolve-all: one that happened again since it was shown stays unread.
  readAllErrors: (seen: { id: string; count?: number }[]) =>
    api<{ read: number; changed: string[] }>("/api/errors/read-all", { method: "POST", body: JSON.stringify({ seen: seen.map((e) => ({ id: e.id, count: e.count ?? 1 })) }) }),
  // Only the kinds on screen, at the counts shown: one that happened again stays open.
  resolveAllErrors: (seen: { id: string; count?: number }[]) =>
    api<{ resolved: number; changed: string[] }>("/api/errors/resolve-all", { method: "POST", body: JSON.stringify({ seen: seen.map((e) => ({ id: e.id, count: e.count ?? 1 })) }) }),
  // `extra`: module fields of the new session (its project).
  async create(text: string, model?: string, workspace?: string, images?: PromptBlock[], extra?: Record<string, unknown>): Promise<Session> {
    const r = await api<{ session: Session }>("/api/sessions", { method: "POST", body: JSON.stringify({ ...extra, text, model, workspace, images }) });
    set({ sessions: { ...state.sessions, [r.session.id]: r.session } });
    return r.session;
  },
  send: (id: string, text: string, opts: { images?: PromptBlock[]; mode?: "send" | "queue" } = {}) =>
    api(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text, images: opts.images, mode: opts.mode }) }),
  edit: (id: string, eventId: string, text: string) =>
    api(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text, edit_of: eventId }) }),
  answer: (id: string, callId: string, answers: Record<string, { picked: string[]; other?: string }>) =>
    api(`/api/sessions/${id}/questions/${callId}`, { method: "POST", body: JSON.stringify({ answers }) }),
  jobs: (id: string) => api<{ jobs: JobView[] }>(`/api/sessions/${id}/jobs`),
  stopJob: (id: string, job: string) => api(`/api/sessions/${id}/jobs/${job}/stop`, { method: "POST" }),
  interrupt: (id: string) => api(`/api/sessions/${id}/interrupt`, { method: "POST", body: JSON.stringify({ by: "owner" }) }),
  patch: async (id: string, body: Partial<Omit<Session, "settings">> & { settings?: Record<string, unknown> }) => {
    const r = await api<{ session: Session }>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    // A reply that comes after a newer change (from another tab, or a later edit here) does not
    // undo it: the row's revision orders them (two saves in one millisecond too). The head
    // follows the events, which may have moved it since the reply was made.
    const cur = state.sessions[id];
    if (!cur || (r.session.rev ?? 0) > (cur.rev ?? 0)) set({ sessions: { ...state.sessions, [id]: cur ? { ...r.session, head: cur.head } : r.session } });
    return r.session;
  },
  // `leaf`: show the newest end of the branch below the event (a version
  // switch); without it the event itself becomes the head (undo a clear).
  setHead: (id: string, eventId: string, reveal = false, leaf = true) =>
    api(`/api/sessions/${id}/head`, { method: "POST", body: JSON.stringify({ head_event_id: eventId, reveal, leaf }) }),
  // `before`: the prompt is left out of the copy and goes back to the new box, words and attachments.
  async fork(id: string, eventId: string, opts: { before?: boolean; title?: string } = {}): Promise<Session> {
    const r = await api<{ session: Session; prompt_text?: string; prompt_images?: PromptBlock[] }>(`/api/sessions/${id}/fork`, {
      method: "POST", body: JSON.stringify({ event_id: eventId, before: !!opts.before, title: opts.title || undefined }),
    });
    set({ sessions: { ...state.sessions, [r.session.id]: r.session } });
    if (r.prompt_text !== undefined || r.prompt_images) seedComposer(r.prompt_text ?? "", r.session.id, { blocks: r.prompt_images });
    return r.session;
  },
  compact: (id: string, focus?: string) => api(`/api/sessions/${id}/compact`, { method: "POST", body: JSON.stringify({ focus }) }),
  clear: (id: string) => api<{ undo_head_event_id: string }>(`/api/sessions/${id}/clear`, { method: "POST" }),
  resume: (id: string) => api(`/api/sessions/${id}/resume`, { method: "POST" }),
  context: (id: string) => api<ContextInfo>(`/api/sessions/${id}/context`),
  queueResume: (id: string) => api(`/api/sessions/${id}/queue/resume`, { method: "POST" }),
  // `here`: a prompt queued on another branch goes on the one shown now.
  queueEdit: (id: string, qid: string, body: { text?: string; steer?: boolean; position?: number }) =>
    api(`/api/sessions/${id}/queue/${qid}`, { method: "PATCH", body: JSON.stringify(body) }),
  queueRemove: (id: string, qid: string) => api(`/api/sessions/${id}/queue/${qid}`, { method: "DELETE" }),
  queueSendNow: (id: string, qid: string, here = false) => api(`/api/sessions/${id}/queue/${qid}/send`, { method: "POST", body: JSON.stringify({ here }) }),
  remove: async (id: string) => {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    const { [id]: _, ...rest } = state.sessions;
    const { [id]: __, ...events } = state.events;
    set({ sessions: rest, events });
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


// The newest rev applied to each session's mutable part (`id:session`,
// `id:queue`, `id:status`, and `id:draft` for a whole draft: the replay's or a
// snapshot's, which then replays the deltas that came after it). A frame without a rev (a replay, an
// older daemon) always applies, as before. `tie`: a snapshot read at a frame's
// rev already reflects that frame.
const revs = new Map<string, number>();
export function newer(key: string, rev: number | undefined, tie = false): boolean {
  if (rev === undefined) return true;
  const cur = revs.get(key) ?? 0;
  if (tie ? rev < cur : rev <= cur) return false;
  revs.set(key, rev);
  return true;
}
const draftLog = new Map<string, { n: number; frames: Frame[] }>();

// How a frame changes a session's streamed draft (undefined: it does not).
function draftStep(cur: Record<number, DraftBlock>, f: Frame): Record<number, DraftBlock> | undefined {
  if (f.t === "delta") {
    const b = cur[f.index] ?? { kind: f.kind, text: "", name: f.name };
    return { ...cur, [f.index]: { ...b, text: b.text + f.text, name: b.name ?? f.name } };
  }
  // What streamed before a stored step is that step's; a retried attempt starts the reply again.
  if ((f.t === "event" && (f.event.kind === "assistant" || f.event.kind === "turn_end")) || (f.t === "status" && f.status.kind === "retry")) return {};
  return undefined;
}
const draftSession = (f: Frame) => (f.t === "event" ? f.event.session_id : f.t === "delta" || f.t === "status" ? f.session_id : undefined);

// A row that left a list without word of why (another daemon's fresh list no
// longer has it): out of the session list, neither archived nor gone. One
// that was opened asks its daemon instead, which says what became of it.
export function dropSession(id: string) {
  const s = state.sessions[id];
  if (!s) return;
  if (state.events[id]) {
    actions.loadSession(id).catch((e) => (e as { status?: number }).status === 404 ? apply({ t: "session", session: s, deleted: true } as Frame) : reportError(e, { at: "session left list", id }));
    return;
  }
  const { [id]: _s, ...sessions } = state.sessions;
  set({ sessions });
}

export function apply(f: Frame) {
  const ds = draftSession(f);
  if (ds) draftLog.get(ds)?.frames.push(f);
  if (f.t === "session") {
    const s = f.session;
    if (!newer(`${s.id}:session`, f.rev)) return;
    if (f.deleted) {
      // Its views unmount now instead of asking the daemon for a session it no longer has.
      const { [s.id]: _s, ...sessions } = state.sessions;
      const { [s.id]: _e, ...events } = state.events;
      set({ sessions, events, gone: { ...state.gone, [s.id]: s.parent_id ?? state.sessions[s.id]?.parent_id ?? true } });
      return;
    }
    if (!state.sessions[s.id] && s.archived) return;
    set({ sessions: { ...state.sessions, [s.id]: s } });
  } else if (f.t === "event") {
    const e = f.event;
    // A finished turn may have moved a window (its answers' headers, a plan's use).
    if (e.kind === "turn_end") limitsSoon();
    // The socket is in order: what streamed before a stored step is that step's,
    // also when the step is a replay of what a snapshot already brought.
    const cleared = !!draftStep({}, f) && !!state.drafts[e.session_id];
    if (cleared) state = { ...state, drafts: { ...state.drafts, [e.session_id]: {} } };
    const list = state.events[e.session_id];
    if (!list) { loading.get(e.session_id)?.push(e); if (cleared) set({}); return; } // not loaded; loading it later reads it from the store
    if (list.length && list[list.length - 1]!.seq >= e.seq) { if (cleared) set({}); return; } // a replay of what is here
    // The new event is the head of its session (the store appends at the head).
    const s = state.sessions[e.session_id];
    if (s && newer(`${s.id}:session`, f.rev)) state = { ...state, sessions: { ...state.sessions, [s.id]: { ...s, head: e.id } } };
    set({ events: { ...state.events, [e.session_id]: [...list, e] } });
  } else if (f.t === "delta") {
    set({ drafts: { ...state.drafts, [f.session_id]: draftStep(state.drafts[f.session_id] ?? {}, f)! } });
  } else if (f.t === "queue") {
    if (newer(`${f.session_id}:queue`, f.rev)) set({ queues: { ...state.queues, [f.session_id]: { queue: f.queue, held: f.held } } });
  } else if (f.t === "status") {
    if (!newer(`${f.session_id}:status`, f.rev)) return;
    const d = draftStep(state.drafts[f.session_id] ?? {}, f);
    set({ status: { ...state.status, [f.session_id]: f.status }, drafts: d ? { ...state.drafts, [f.session_id]: d } : state.drafts });
  } else if (f.t === "error") {
    // A repeat or a resolve updates the kind's row; the latest goes on top.
    set({ errors: [f.error, ...state.errors.filter((e) => e.id !== f.error.id)].slice(0, 200) });
  } else if (f.t === "feature") {
    for (const l of features) l.frame?.(f);
  }
}

let limitsTimer: ReturnType<typeof setTimeout> | undefined;
function limitsSoon() {
  clearTimeout(limitsTimer);
  limitsTimer = setTimeout(() => actions.loadLimits().catch((e) => reportError(e, { at: "limits" })), 1500);
}

// Snapshots on their way, with the events that came meanwhile.
const loading = new Map<string, StoredEvent[]>();

// Events in seq order, each once.
export function mergeEvents(a: StoredEvent[], b: StoredEvent[]): StoredEvent[] {
  if (!b.length) return a;
  const last = a.at(-1)?.seq ?? 0;
  if (b[0]!.seq > last) return [...a, ...b];
  const by = new Map(a.map((e) => [e.seq, e]));
  for (const e of b) by.set(e.seq, e);
  return [...by.values()].sort((x, y) => x.seq - y.seq);
}

// The live feed. On every (re)connect the page names the last seq it holds of
// each loaded session; the daemon replays what came after, and the reply a
// running turn has streamed so far, then sends live (see src/server/live.ts).
// A ping every 20 s proves the socket still delivers; no pong in 10 s and it
// is closed and opened again.
let retry = 500;
let socket: WebSocket | undefined;
// The session in the address is asked for at boot, with the page's first
// loads, not once its view mounts (after the lazy chunks and the first render).
let preload: { id: string; p: Promise<void> } | null = null;
export function preloadSession(id: string) {
  const p = actions.loadSession(id);
  p.catch(() => {}); // its view takes this promise and reports a failure
  preload = { id, p };
}
// The page's first socket open does not load the sessions, models and errors
// the page is loading at start; it does when those loads failed (the daemon
// was not up yet).
let opened = false;
let bootLoad: Promise<unknown> | null = null;
export const setBootLoad = (p: Promise<unknown>) => { bootLoad = p; };
let onReplayed: (() => void) | undefined;
export function connect() {
  const ws = (socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`));
  let pinger: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  ws.onopen = () => {
    retry = 500;
    const cursors = Object.fromEntries(Object.entries(state.events).filter(([id]) => !splitId(id)).map(([id, list]) => [id, list.at(-1)?.seq ?? 0]));
    // A draft from before the drop may be stale (a retry restarts it, the reply
    // may have finished meanwhile): the replay sends the current one of each
    // loaded session, and a session opened later reads it from its snapshot.
    set({ connected: true, synced: false, drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => splitId(id))) });
    ws.send(JSON.stringify({ op: "resume", cursors }));
    // What the page loads at start is loaded again: a first load the daemon
    // was not up for (a restart under the page) comes in now, quietly.
    const reload = () => {
      if (!state.loaded.models) actions.loadModels().catch((e) => reportError(e, { at: "reconnect" }));
      actions.loadErrors().catch((e) => reportError(e, { at: "reconnect" }));
      return actions.loadSessions().catch((e) => reportError(e, { at: "reconnect" }));
    };
    const first = !opened && bootLoad;
    opened = true;
    const loads: Promise<unknown>[] = [first ? first.then(() => {}, reload) : reload()];
    // Queue and status of the open sessions moved meanwhile (their events come by the
    // replay); one deleted meanwhile is dropped. On the page's first socket the
    // snapshots were just taken and the replay brings queue and status: no second load.
    for (const id of first ? [] : Object.keys(cursors)) {
      loads.push(actions.loadSession(id).catch((e) => {
        if ((e as { status?: number }).status !== 404) return reportError(e, { at: "reconnect" });
        const { [id]: _, ...events } = state.events;
        const { [id]: __, ...sessions } = state.sessions;
        set({ events, sessions, gone: { ...state.gone, [id]: state.sessions[id]?.parent_id ?? true } });
      }));
    }
    // Caught up when this socket's replay came and the reloads landed; a late
    // answer from a socket that dropped meanwhile declares nothing.
    const replayed = new Promise<void>((done) => (onReplayed = done));
    Promise.all([replayed, ...loads]).then(() => { if (socket === ws && state.connected) set({ synced: true }); });
    // Features load their own state here, the first open included.
    for (const l of features) l.reconnect?.();
    pinger = setInterval(() => {
      ws.send(JSON.stringify({ op: "ping", nonce: Date.now() }));
      deadline ??= setTimeout(() => ws.close(), 10_000);
    }, 20_000);
  };
  ws.onmessage = (m) => {
    const f = JSON.parse(m.data) as Frame | SocketFrame;
    if (f.t === "pong") { clearTimeout(deadline); deadline = undefined; }
    else if (f.t === "draft") { if (newer(`${f.session_id}:draft`, f.rev)) set({ drafts: { ...state.drafts, [f.session_id]: f.blocks } }); }
    else if (f.t === "replayed") { if (socket === ws) onReplayed?.(); }
    else if (f.t === "hello" || f.t === "ui") servedUi(f.t === "ui" ? f.version : f.ui);
    else apply(f);
  };
  ws.onclose = () => {
    clearInterval(pinger);
    clearTimeout(deadline);
    if (socket !== ws) return;
    drops++;
    set({ connected: false, synced: false });
    setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
  };
}

// Client-side error tracking: every uncaught error goes to the server's table.
let drops = 0; // socket drops so far: a network failure around one is the daemon going away
export function reportError(err: unknown, context?: unknown) {
  // The daemon recorded this one itself (its answer names the record): once is enough.
  if ((err as { body?: { error_id?: string } } | null)?.body?.error_id) return;
  // The daemon turned the request away because it is draining: the state the
  // page's band shows, not a fault. The band says that something was not
  // taken, since not every caller has a place to say so.
  if ((err as { body?: { draining?: boolean } } | null)?.body?.draining) return void dispatchEvent(new CustomEvent("keel:turned-away"));
  const e = err instanceof Error ? err : new Error(String(err));
  const url = location.pathname;
  const post = () =>
    fetch("/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: e.message, stack: e.stack, context: { url, ...(context as object) } }),
    }).catch(() => {});
  // A request cut because the daemon went away (a restart) is the connection
  // state the page already shows, and the reconnect reloads: only a network
  // failure while the socket was up and stays up is tracked. A request made
  // before the socket first opened (the page loading during a restart) is
  // loaded again when it opens. "network error" is Chrome's name for a response
  // cut while its body was being read (a stream open when the daemon went away).
  if (e instanceof TypeError && /failed to fetch|network ?error|load failed/i.test(e.message)) {
    if (!state.connected) return;
    const at = drops;
    setTimeout(() => { if (state.connected && drops === at) post(); }, 3000);
    return;
  }
  post();
}
// A failure the owner sees where it happened: tracked once, unless it is the
// daemon's answer to the request (a 4xx says what to change, not a fault) or
// the daemon recorded it itself. Returns the words to show.
export function failed(err: unknown, context?: unknown): string {
  const st = (err as { status?: number } | null)?.status;
  if (!(typeof st === "number" && st >= 400 && st < 500)) reportError(err, context);
  return err instanceof Error ? err.message : String(err);
}
// A per-session load that answers 404 found the session deleted meanwhile:
// its views unmount, so that is no failure. Anything else is tracked.
export function reportUnlessGone(err: unknown, context?: unknown) {
  if ((err as { status?: number }).status === 404) return;
  reportError(err, context);
}
window.addEventListener("error", (e) => reportError(e.error ?? e.message, { kind: "window.error" }));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason, { kind: "unhandledrejection" }));
