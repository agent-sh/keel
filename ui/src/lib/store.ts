// One client store: sessions, per-session events, live streaming drafts and
// errors, fed by REST on load and by the WebSocket after. Components read it
// with useStore(selector).
import { useContext, useEffect, useSyncExternalStore } from "react";
import { lineage, type Page } from "../../../src/core/tree.ts";
import type { Asked, ErrorRecord, Frame, PromptBlock, QueueItem, Session, SocketFrame, StoredEvent, TurnStatus } from "../../../src/core/types.ts";
import type { ModelInfo, ProviderStatus } from "../../../src/providers/types.ts";
import { apiPath, localize, splitId } from "./fleet-ids.ts";
import { seedComposer } from "./ui.ts";
import { servedUi } from "./hotui.ts";
import { dropOrphans, dropSendDrafts } from "./send-drafts.ts";
import { setRatio } from "../../../src/engine/compact.ts";
import { answerMakesTry, askGap, askLife, ASKS, BEAT_MS, GRACE_MS, HIDDEN_RESYNC_MS, look, PING, rttOf, SLEPT_MS, SLOW_BEAT_MS, socketBound, step, tripped, type Beat, type Trips } from "./heartbeat.ts";
import { Scope } from "./scope.ts";
import { dropPlace } from "./place.ts";
import { every as onBeat } from "./clock.ts";
import { CoverCtx, makeGate, type Gate } from "./cover.ts";

export type ProvidersReport = {
  keys_read?: boolean; // false: a key is still being looked for, and an "available" may be unconfirmed
  providers: (ProviderStatus & { listing: { state: string; fetched_ms?: number; error?: string; models: number }; problem?: ProviderProblem; routes?: RouteProblem[] })[];
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
export type ProviderProblem = { kind: "auth" | "billing" | "access"; message: string; at: number; source: string; link?: string; until?: number; strikes?: number };
// One route of a provider (an ACP agent's upstream, a stand-in) or one model (`model:<provider>:<model>`)
// with an account problem. `open`: its time passed; new work goes to it again and its next request decides.
export type RouteProblem = ProviderProblem & { route: string; open: boolean };
export type Limits = { windows: LimitWindow[]; close: string[]; problems: Record<string, ProviderProblem>; close_percent: number };
export type ChoiceChange = { pin?: string[]; unpin?: string[]; provider?: string; hide?: string[]; show?: string[]; hide_provider?: string; show_provider?: string };

export type JobView = {
  id: string; num: number; command: string; description?: string; cwd: string; pty: boolean; log: string;
  started: number; ended?: number; exit_code?: number | null; signal?: string | null; background: boolean; bytes: number; running: boolean; last?: string; stop_reason?: string;
  call_id?: string; // the tool call that started it
  // Work an ACP agent runs apart from its foreground work (ACP v2): what it is ("agent terminal"), and whether the agent
  // offered to stop it alone. It is not a process of Keel's: it has no log.
  external?: string; can_stop?: boolean;
};

export type DraftBlock = { kind: "text" | "thinking" | "tool_input"; text: string; name?: string };

type State = {
  sessions: Record<string, Session>;
  // The list leaves out the sessions of agents at rest and counts them
  // (src/server/session-list.ts): how many are left out under each session
  // the list carries. Taken off once they were read (loadAgentsOf).
  agentsLeft: Record<string, number>;
  // Ready to answer, not historical question tool calls. A child's call
  // belongs to it; its parent needs the owner too.
  questionCalls: Record<string, string[]>;
  questionChildren: Record<string, string[]>;
  // What a waiting call was asked that its own input does not hold (an MCP server's question), by session and call.
  questionAsks: Record<string, Record<string, Asked>>;
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
  // came and their snapshots landed): until then the page is catching up, and
  // what it shows is as of when it lost the daemon (downSince).
  synced: boolean;
  // The daemon has not answered two asks in a row: slow to answer, not yet lost.
  slow: boolean;
  // The first listing of each arrived (first-run screens wait for it). `models`:
  // the few a page shows before a list is opened (see loadModelsBrief), or
  // all of them; `allModels`: the whole listing is in `models`.
  loaded: { sessions: boolean; models: boolean; allModels: boolean };
  // How many models the daemon lists, known from the first read on.
  modelCount: number;
  providers: ProvidersReport | null;
  queues: Record<string, { queue: QueueItem[]; held: boolean; rev?: number }>;
  // The local rail's counts, not the bodies read by the composer and timeline.
  queueSnapshot?: { counts?: Record<string, number>; rev?: number };
  status: Record<string, TurnStatus>;
};

let state: State = { loaded: { sessions: false, models: false, allModels: false }, modelCount: 0,
  sessions: {}, agentsLeft: {}, questionCalls: {}, questionChildren: {}, questionAsks: {}, gone: {}, events: {}, drafts: {}, models: [], defaultModel: "", pinned: [], providerLabels: {}, limits: null, errors: [], connected: false, synced: false, slow: false, providers: null, queues: {}, status: {},
};
const subs = new Set<() => void>();
// What the socket brings is put into the state at once, in its order, and
// the readers are told once a frame of the page: a dozen sessions streaming
// send hundreds of frames a second, and telling the readers of each one
// rendered every pane for it. The page also measures what a frame that told
// them costs it (the render, layout and paint) and spaces the next one so
// that live updates take about a third of its time at most: one pane streams
// at the screen's rate, six panes a little slower each, and the page stays
// free for the owner's keys and scrolling. A change the page itself makes (a
// click, an answer to its own request) tells the readers there and then.
const SHARE = 0.3; // of the main thread, for what the socket brings
let live = false; // inside the socket's delivery of a frame
let due: { raf?: number; timer: ReturnType<typeof setTimeout> } | null = null;
let cost = 0; // what the frames that told the readers cost lately (ms, smoothed)
let told = 0; // when they were last told
const paints = () => typeof requestAnimationFrame === "function" && !(typeof document !== "undefined" && document.hidden);
function tell() {
  if (due) { if (due.raf !== undefined) cancelAnimationFrame(due.raf); clearTimeout(due.timer); due = null; }
  const at = (told = paints() ? performance.now() : 0);
  subs.forEach((f) => f());
  // A task queued here runs when this frame's work is through: the time until then is what it cost.
  if (at) setTimeout(() => { cost = 0.7 * cost + 0.3 * (performance.now() - at); }, 0);
}
const onFrame = () => { due = { raf: requestAnimationFrame(tell), timer: setTimeout(tell, 250) }; };
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  // No frames to wait for (a hidden page draws none, a test has none): told at once.
  if (!live || !paints()) return tell();
  if (due) return;
  const rest = Math.min(250, cost / SHARE) - (performance.now() - told);
  if (rest > 4) due = { timer: setTimeout(onFrame, rest) };
  else onFrame();
};
// The socket's delivery of one frame: the readers are told of it with the frame of the page.
function delivered(f: () => void) {
  live = true;
  try { f(); } finally { live = false; }
}

// One subscribe function for every reader: a new one per render would make
// React unsubscribe and subscribe again on each render.
export const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
// A reader in a view that is covered reads the store as it was when the view
// was covered, and is told of nothing until it shows again (lib/cover.ts).
export function useStore<T>(sel: (s: State) => T): T {
  const gate = useContext(CoverCtx) as Gate<State> | null;
  return useSyncExternalStore(gate ? gate.subscribe : subscribe, () => sel(gate?.held ?? state));
}
export const storeGate = (): Gate => makeGate(subscribe, () => state);
export const getState = () => state;
// The whole model listing is in the store: asked for once, by the first thing that lists models.
let allModelsOut: Promise<void> | null = null;
export function ensureModels(): Promise<void> {
  if (state.loaded.allModels) return Promise.resolve();
  return (allModelsOut ??= actions.loadModels().finally(() => { allModelsOut = null; }));
}
// Every model the daemon lists, for a view that lists them or looks one up
// that the page may not hold yet. The view's first use reads the listing.
export function useModels(): ListedModel[] {
  useEffect(() => { ensureModels().catch((e) => reportError(e, { at: "models" })); }, []);
  return useStore((s) => s.models);
}

// A write a remote device makes with the owner's authority answers 428 with
// the action to sign: the page gets a passkey assertion (lib/presence.ts) and
// sends the same request once more. Cancelling sends nothing again.
export const presenceHook: { sign?: (action: string) => Promise<string | null> } = {};

// The reads on their way. When the page loses the daemon, and again when it is back, they are
// given up: what they would bring is read again by the catch-up, and a read sent into a link
// that says nothing would otherwise hold one of the browser's few connections to the daemon
// for as long as the link says nothing, in the way of the reads that catch up. A change (a
// message, an answer) is never given up here: it may have arrived.
let reads = new AbortController();
function cutReads() {
  reads.abort();
  reads = new AbortController();
}

// What the page says of itself by itself (where its owner is, that a box holds a draft): words
// the daemon lets run out when they are not repeated. They are not said into a link that says
// nothing, and those on their way are given up with it, as the reads are: there they would
// only hold the connections the catch-up needs.
export function says(path: string, body?: unknown): void {
  if (opened && !state.connected) return;
  fetch(path, { method: "POST", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: true, signal: reads.signal }).catch(() => {});
}

// The signal of a request that is only worth sending while the daemon is heard and is sent again
// later when it did not go (the owner's presses): given up with the link like a read, so a batch
// sent into a silent link never holds a connection the catch-up needs, nor the sender's one batch
// at a time. Null while the page knows the daemon is not heard.
export function whileLinked(): AbortSignal | null {
  return opened && !state.connected ? null : reads.signal;
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const asks = !init?.method || init.method === "GET";
  const cut = reads.signal;
  const signal = asks ? (init?.signal ? AbortSignal.any([init.signal, cut]) : cut) : init?.signal;
  const send = (extra?: Record<string, string>) => fetch(apiPath(path), { ...init, signal, headers: { "content-type": "application/json", ...init?.headers, ...extra } })
    // Given up with the link: a dropped request, as the network would have made it.
    // (`cut`: given up because the link dropped: the reconnect reads it again, so it is no failure to track.)
    .catch((e) => { throw asks && cut.aborted && !init?.signal?.aborted ? Object.assign(new TypeError(`Failed to fetch ${path}: Keel stopped answering`), { cut: true }) : e; });
  // A body cut short (the daemon restarting mid-answer) is a dropped request,
  // as fetch reports one; an answer that is not JSON is a fault of its own.
  // Neither becomes an empty object a caller then reads fields of.
  const read = async (r: Response): Promise<any> => {
    const text = await r.text().catch(() => null);
    if (text === null) throw Object.assign(new TypeError(`Failed to fetch ${path}: the answer was cut short`), asks && cut.aborted && !init?.signal?.aborted ? { cut: true } : {});
    if (!text) return {};
    try { return JSON.parse(text); } catch {
      if (r.ok) throw Object.assign(new Error(`${path} answered with something other than JSON`), { status: r.status });
      return {};
    }
  };
  let r = await send();
  lastAnswer = Date.now();
  let body = await read(r);
  if (r.status === 428 && body.presence?.action && presenceHook.sign) {
    const receipt = await presenceHook.sign(body.presence.action);
    if (!receipt) throw Object.assign(new Error("Not done: the passkey check was cancelled."), { status: 428 });
    r = await send({ "x-keel-presence": receipt });
    body = await read(r);
  }
  if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status, body, path });
  return body as T;
}

// The reads of a session's agents that are on their way (loadAgentsOf).
const agentsAsked = new Map<string, Promise<void>>();

export const actions = {
  async loadSessions() {
    const { sessions, level, rev, agents_left } = await api<{ sessions: Session[]; level?: number; rev?: number; agents_left?: Record<string, number> }>("/api/sessions");
    listLevel = level;
    // The list is as it was at `rev`. It can land after frames the socket
    // already brought (it was read before them): a row a newer frame told of
    // stands as that frame left it. Taken whole, such an answer put an old
    // title back, brought back a deleted or archived row and dropped a new one.
    // Sessions of other machines (the fleet module keeps them) stay.
    const listed = new Set(sessions.map((s) => s.id));
    const next: Record<string, Session> = {};
    for (const [id, s] of Object.entries(state.sessions)) if (splitId(id) || (!listed.has(id) && !newer(`${id}:session`, rev, true))) next[id] = s;
    for (const s of sessions) {
      if (newer(`${s.id}:session`, rev, true)) next[s.id] = s;
      else if (state.sessions[s.id]) next[s.id] = state.sessions[s.id]!;
    }
    // An agent's session the list left out (it is at rest) and this page holds, because it was
    // listed while it worked, opened, or read with its parent's agents, stays for as long as the
    // session above it does: the list no longer says it is gone by not carrying it.
    const agentsLeft = { ...(agents_left ?? {}) };
    if (agents_left) {
      const held = Object.values(state.sessions).filter((s) => s.parent_id && !next[s.id] && !splitId(s.id) && !state.gone[s.id]);
      for (let more = true; more; ) {
        more = false;
        for (const s of held) if (!next[s.id] && next[s.parent_id!]) { next[s.id] = s; more = true; }
      }
      // Each one held is one less to read: counted off the session of the list it is under.
      for (const s of held) {
        if (!next[s.id]) continue;
        let a: Session | undefined = next[s.parent_id!];
        for (let n = 0; a && !listed.has(a.id) && n < 64; n++) a = a.parent_id ? next[a.parent_id] : undefined;
        if (a && agentsLeft[a.id]) { if (--agentsLeft[a.id]! <= 0) delete agentsLeft[a.id]; }
      }
    }
    set({ sessions: next, agentsLeft, loaded: { ...state.loaded, sessions: true } });
  },
  // The sessions of the agents under `id` that the list left out: read when
  // their rows are wanted (the session's agents are opened, it is about to be
  // deleted with them). A list read later keeps them, and counts only what is not held.
  async loadAgentsOf(id: string) {
    if (!state.agentsLeft[id] || agentsAsked.has(id)) return agentsAsked.get(id);
    const ask = (async () => {
      const { sessions, rev } = await api<{ sessions: Session[]; rev?: number }>(`/api/sessions?agents_of=${encodeURIComponent(id)}`);
      const next = { ...state.sessions };
      for (const s of sessions) if (!state.gone[s.id] && (newer(`${s.id}:session`, rev, true) || !next[s.id])) next[s.id] = s;
      const { [id]: _, ...agentsLeft } = state.agentsLeft;
      set({ sessions: next, agentsLeft });
    })().finally(() => agentsAsked.delete(id));
    agentsAsked.set(id, ask);
    return ask;
  },
  // The whole model listing. It can hold hundreds of entries, so a page
  // reads it when something lists models (the picker, the palette, a
  // settings page, a command that takes a model's name): see useModels and
  // ensureModels. Before that it holds the few of loadModelsBrief.
  async loadModels(refresh = false) {
    const r = await api<{ models: ListedModel[]; default: string; pinned: string[]; providers: { id: string; label: string }[] }>(`/api/models${refresh ? "?refresh" : ""}`);
    set({ loaded: { ...state.loaded, models: true, allModels: true }, models: r.models, modelCount: r.models.length, defaultModel: r.default, pinned: r.pinned ?? [], providerLabels: Object.fromEntries((r.providers ?? []).map((p) => [p.id, p.label])) });
  },
  // What a page shows before anybody opens a list: the default model and the
  // models its sessions run on (a message box names its model, knows whether
  // it reads images, its window and its efforts), and how many there are.
  // `also`: models the page shows that are no session's (the one picked for a new session).
  async loadModelsBrief(also: string[] = []) {
    if (state.loaded.allModels) return actions.loadModels(); // a page that listed them once keeps the whole listing current
    const r = await api<{ models: ListedModel[]; default: string; total?: number; providers?: { id: string; label: string }[] }>(`/api/models?brief${also.filter(Boolean).map((id) => `&id=${encodeURIComponent(id)}`).join("")}`);
    if (state.loaded.allModels) return; // the whole listing came in meanwhile
    // (A daemon that answers with its whole listing, an older one, gives no count: the list is the count.)
    set({ loaded: { ...state.loaded, models: true, allModels: r.total === undefined }, models: r.models, modelCount: r.total ?? r.models.length, defaultModel: r.default, ...(r.providers ? { providerLabels: Object.fromEntries(r.providers.map((p) => [p.id, p.label])) } : {}) });
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
  // A session is read in pages: its snapshot brings the newest PAGE events of
  // its branch, and the older ones (or another branch's) come when asked for
  // (actions.page), so a long session costs what its end costs.
  // `transcript: false` asks for the session as it is now without its events:
  // the page holds them and the socket's replay brings the ones after its
  // cursor (a reconnect of a session of this daemon).
  async loadSession(id: string, transcript = true) {
    // The page's first session load started at boot (see preloadSession) is taken once.
    if (transcript && preload?.id === id) { const p = preload.p; preload = null; return p; }
    // Events that arrive while the snapshot is on its way are kept and merged:
    // the snapshot may be older or newer than any of them.
    if (!state.events[id]) loading.set(id, loading.get(id) ?? []);
    // What changes the draft while the snapshot is on its way, to replay over the snapshot's draft.
    const log = draftLog.get(id) ?? { n: 0, frames: [] };
    log.n++;
    draftLog.set(id, log);
    let r: { session: Session; events?: StoredEvent[]; seq?: number; paged?: boolean; queue: QueueItem[]; held: boolean; status?: TurnStatus; draft?: Record<number, DraftBlock>; rev?: number; bytes_per_token?: number };
    try {
      r = await api(`/api/sessions/${id}${transcript ? `?page=${PAGE}` : "?events=0"}`);
      // The daemon's learned bytes a token for the session's model: the page's count of its context then agrees with the daemon's.
      if (r.bytes_per_token) setRatio(r.session.model, r.bytes_per_token);
    } catch (e) {
      loading.delete(id);
      throw e;
    } finally {
      if (--log.n === 0) draftLog.delete(id);
    }
    const early = loading.get(id) ?? [];
    loading.delete(id);
    const loc = localize(id, r.session, r.events);
    if (loc.events) {
      // A transcript answer accounts for every event up to the session's
      // newest seq: the ones of the branch shown are in it, the rest the page
      // does not hold by choice. (An answer without a transcript accounts for
      // nothing: events below its seq may still be on their way by the socket.)
      seen.set(id, Math.max(seen.get(id) ?? 0, r.seq ?? loc.events.at(-1)?.seq ?? 0, early.at(-1)?.seq ?? 0));
      // A daemon without the page routes (a peer on an older build) answers
      // with the whole session: it is kept whole and no part is asked for.
      if (r.paged) paged.add(id);
      else paged.delete(id);
    }
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
      // An answer without a transcript adds nothing to one the page no longer holds (deleted meanwhile).
      events: loc.events || state.events[id] ? { ...state.events, [id]: mergeEvents(mergeEvents(state.events[id] ?? [], loc.events ?? []), early) } : state.events,
      queues: newer(`${id}:queue`, r.rev, true) ? { ...state.queues, [id]: { queue: r.queue, held: r.held, rev: r.rev } } : state.queues,
      status: r.status && newer(`${id}:status`, r.rev, true) ? { ...state.status, [id]: r.status } : state.status,
      drafts,
    });
    void loadLegacyQuestions(id);
    pollQuestions();
    // The branch may have changed while the page was away from it (no transcript asked for), or
    // the session's row came before this snapshot with a head the snapshot does not hold yet:
    // what the stream does not bring of it soon is read.
    headSoon(id);
  },
  // A part of a branch the page does not hold yet (pageOf in src/core/tree.ts):
  // older or newer than a seq, around an event, or the end of the branch `head`
  // ends. Its events join the session's. `first` runs before they do.
  // A view that shows a session opens it: the read another view of it has on its way is the one it takes.
  // (A pane that stood for the session until the list was in and the pane that replaces it both open it:
  // two reads of the same snapshot, a moment apart, on a page that is slow to start.)
  openSession(id: string): Promise<void> {
    // Opened again while the page still holds it and its socket still sends it (inside the linger): what the page
    // holds is the session as it is, every frame since its snapshot came by the stream. No snapshot is read again;
    // a head the page does not hold is read as at any change of it. A socket lost or still catching up, a session
    // of another daemon, or one whose snapshot is on its way is read as before.
    if (state.events[id] && state.connected && state.synced && !splitId(id) && !loading.has(id) && scope.hearing(id)) {
      headSoon(id);
      return Promise.resolve();
    }
    const reading = opening.get(id);
    if (reading) {
      if (preload?.id === id && preload.p === reading) preload = null; // taken, as loadSession takes it
      return reading;
    }
    const p = actions.loadSession(id);
    opening.set(id, p);
    const done = () => { if (opening.get(id) === p) opening.delete(id); };
    p.then(done, done);
    return p;
  },
  async page(id: string, ask: { head?: string; before?: number; after?: number; around?: string }, first?: (p: Page) => void): Promise<Page> {
    const q = new URLSearchParams({ limit: String(PAGE) });
    for (const [k, v] of Object.entries(ask)) if (v !== undefined) q.set(k, String(v));
    const r = await api<Page>(`/api/sessions/${id}/page?${q}`);
    const events = splitId(id) ? r.events.map((e) => ({ ...e, session_id: id })) : r.events;
    first?.(r);
    if (state.events[id]) set({ events: { ...state.events, [id]: mergeEvents(state.events[id]!, events) } });
    return { ...r, events };
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
  // `client_id` names the send: the daemon stores it once however often it is sent.
  // A prompt this page sent (not one queued for later) is told to the session's
  // views: a transcript reading an earlier part goes to the end for it.
  send: (id: string, text: string, opts: { images?: PromptBlock[]; mode?: "send" | "queue"; client_id?: string } = {}) =>
    api(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text, images: opts.images, mode: opts.mode, client_id: opts.client_id }) })
      .then((r) => { if (opts.mode !== "queue") dispatchEvent(new CustomEvent("keel:sent", { detail: id })); return r; }),
  // `files`: the files go back to before the prompt too, as the new version starts.
  edit: (id: string, eventId: string, text: string, files = false) =>
    api(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text, edit_of: eventId, ...(files ? { restore_files: true } : {}) }) }),
  // `sendAnyway`: the owner's word for a server's form that asks for what looks like a secret.
  // `question`: the id of a server's question, so the answer lands on that one and no other.
  answer: (id: string, callId: string, answers: Record<string, { picked: string[]; other?: string; skipped?: true }>, sendAnyway = false, question?: string) =>
    api(`/api/sessions/${id}/questions/${callId}`, { method: "POST", body: JSON.stringify({ answers, ...(sendAnyway ? { send_anyway: true } : {}), ...(question ? { question } : {}) }) }),
  // The whole reply of a turn the page holds only the end of (see the route).
  reply: (id: string, ask: { before?: number; head?: string; last?: boolean }) => {
    const q = new URLSearchParams();
    if (ask.before !== undefined) q.set("before", String(ask.before));
    if (ask.head) q.set("head", ask.head);
    if (ask.last) q.set("last", "1");
    return api<{ texts: string[] }>(`/api/sessions/${id}/reply?${q}`).then((r) => r.texts.join("\n\n"));
  },
  // Says no to a question a server asked on the call's card.
  declineQuestion: (id: string, callId: string, question?: string) =>
    api(`/api/sessions/${id}/questions/${callId}`, { method: "POST", body: JSON.stringify({ decline: true, ...(question ? { question } : {}) }) }),
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
  // The end of the branch it moved to is read at once when the page does not hold it.
  setHead: async (id: string, eventId: string, reveal = false, leaf = true) => {
    const r = await api<{ ok: boolean; head: string }>(`/api/sessions/${id}/head`, { method: "POST", body: JSON.stringify({ head_event_id: eventId, reveal, leaf }) });
    if (r.head && state.events[id] && !holds(id, r.head)) await actions.page(id, { head: r.head });
    return r;
  },
  // `before`: the prompt is left out of the copy and goes back to the new box, words and attachments.
  // `worktree`: the fork works in a worktree of its own, so it never writes the folder its source does.
  async fork(id: string, eventId: string, opts: { before?: boolean; title?: string; worktree?: boolean } = {}): Promise<Session> {
    const r = await api<{ session: Session; prompt_text?: string; prompt_images?: PromptBlock[] }>(`/api/sessions/${id}/fork`, {
      method: "POST", body: JSON.stringify({ event_id: eventId, before: !!opts.before, title: opts.title || undefined, worktree: opts.worktree ? {} : undefined }),
    });
    set({ sessions: { ...state.sessions, [r.session.id]: r.session } });
    if (r.prompt_text !== undefined || r.prompt_images) seedComposer(r.prompt_text ?? "", r.session.id, { blocks: r.prompt_images });
    return r.session;
  },
  compact: (id: string, focus?: string) => api(`/api/sessions/${id}/compact`, { method: "POST", body: JSON.stringify({ focus }) }),
  clear: (id: string) => api<{ undo_head_event_id: string }>(`/api/sessions/${id}/clear`, { method: "POST" }),
  resume: (id: string) => api(`/api/sessions/${id}/resume`, { method: "POST" }),
  // After a declined turn: the session starts again from a capsule of its records, without the declined reply.
  freshStart: (id: string) => api(`/api/sessions/${id}/fresh-start`, { method: "POST" }),
  // Calls off a failed turn that would continue by itself when the provider's wait is over.
  cancelContinue: (id: string) => api(`/api/sessions/${id}/resume`, { method: "DELETE" }),
  context: (id: string) => api<ContextInfo>(`/api/sessions/${id}/context`),
  // Which build the session's tools and system prompt are from, and taking the running build's now.
  buildState: (id: string) => api<BuildState>(`/api/sessions/${id}/build`),
  adoptBuild: (id: string) => api<BuildState>(`/api/sessions/${id}/build/adopt`, { method: "POST" }),
  // The open sessions on an earlier build's, with the tokens taking this build's in all of them writes again.
  buildPins: () => api<BuildPins>("/api/build/pins"),
  adoptAllBuilds: () => api<{ asked: number }>("/api/build/adopt", { method: "POST" }),
  queueResume: (id: string) => api(`/api/sessions/${id}/queue/resume`, { method: "POST" }),
  // `here`: a prompt queued on another branch goes on the one shown now.
  queueEdit: (id: string, qid: string, body: { text?: string; steer?: boolean; position?: number }) =>
    api(`/api/sessions/${id}/queue/${qid}`, { method: "PATCH", body: JSON.stringify(body) }),
  // Next: first among the queued prompts, the running turn left alone.
  queueNext: (id: string, qid: string) => api(`/api/sessions/${id}/queue/${qid}/next`, { method: "POST" }),
  queueRemove: (id: string, qid: string) => api(`/api/sessions/${id}/queue/${qid}`, { method: "DELETE" }),
  queueSendNow: (id: string, qid: string, here = false) => api(`/api/sessions/${id}/queue/${qid}/send`, { method: "POST", body: JSON.stringify({ here }) }),
  remove: async (id: string) => {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    const { [id]: _, ...rest } = state.sessions;
    const { [id]: __, ...events } = state.events;
    forgot(id);
    set({ sessions: rest, events });
  },
};

// Events of a branch asked for at a time, and how many a session may hold
// before its oldest are let go (see trimmed).
export const PAGE = 200;
// Two parts, cut back to one: what a pane costs the page while it follows a
// stream grows with the rows it has mounted (measured: the main thread's
// share for one streaming pane rose from 16% to 50% between 8,000 and 50,000
// nodes), and so does the memory of a page of six of them.
const HELD = 2 * PAGE;
const holds = (id: string, eventId: string) => !!state.events[id]?.findLast((e) => e.id === eventId);

// The newest seq the page has seen of each session it holds: from a
// snapshot (the session's newest, on any branch) and from every event frame.
// It is the cursor a reconnect resumes from and what tells a replayed event
// from a new one. The last event the page holds is not that: the page holds
// the branch shown, which may end far below the session's newest event (an
// older version of a prompt is shown, a rewind, an undone clear).
const seen = new Map<string, number>();
// Sessions the daemon answers in parts (see loadSession).
const paged = new Set<string>();
const forgot = (id: string) => { seen.delete(id); paged.delete(id); };
// Whether the list (in seq order) holds an event with that seq.
function holdsSeq(list: StoredEvent[], seq: number): boolean {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid]!.seq >= seq) hi = mid; else lo = mid + 1; }
  return list[lo]?.seq === seq;
}

// A session's head that the page does not hold (another branch was shown from
// another tab, a rewind, an undo): the end of that branch is read. Soon, not
// at once: the frame of a new event's session comes just before the event.
const headChecks = new Map<string, ReturnType<typeof setTimeout>>();
function headSoon(id: string) {
  const missing = () => { const head = state.sessions[id]?.head; return head && state.events[id] && !holds(id, head) ? head : null; };
  if (headChecks.has(id) || !missing()) return;
  headChecks.set(id, setTimeout(() => {
    headChecks.delete(id);
    const head = missing();
    if (head) actions.page(id, { head }).catch(reportUnlessGone);
  }, 400));
}

// What this page's socket is asked for (lib/scope.ts): the whole stream of the
// sessions a view shows, and of no other. A session no view shows any more is
// let go of: its events, its draft and what its turn was doing. Its row, its
// queue and its state stay, as for a session this page never opened.
function unhold(id: string) {
  if (!state.events[id] && !state.drafts[id] && !state.status[id]) return;
  const { [id]: _e, ...events } = state.events;
  const { [id]: _d, ...drafts } = state.drafts;
  const { [id]: _s, ...status } = state.status;
  forgot(id);
  set({ events, drafts, status });
}
export const scope = new Scope({
  cursor: (id) => (state.events[id] ? seen.get(id) ?? state.events[id]!.at(-1)?.seq ?? 0 : undefined),
  drop: unhold,
  far: (id) => !!splitId(id),
});

// Views that read a session's history away from its end (scrolled up, another
// branch, an earlier part) keep it whole meanwhile.
const keepers = new Map<string, number>();
export function keepEvents(id: string) {
  keepers.set(id, (keepers.get(id) ?? 0) + 1);
  return () => void keepers.set(id, (keepers.get(id) ?? 1) - 1);
}

// Events a view read and no longer shows (an earlier part of the branch, left).
export function forgetEvents(id: string, ids: string[]) {
  const list = state.events[id];
  if (!list || !ids.length) return;
  const drop = new Set(ids);
  set({ events: { ...state.events, [id]: list.filter((e) => !drop.has(e.id)) } });
}

// A session that grew past HELD events while nobody reads its history keeps
// what a fresh snapshot would bring: the newest events of its branch from a
// turn's start, the other versions of their prompts, and the start of the
// running turn (its clock).
export function trimmed(list: StoredEvent[], head: string | null): StoredEvent[] {
  const line = lineage(list, head);
  // A head the page does not hold yet (its part is on its way): nothing is let go.
  if (!line.length) return list;
  let k = Math.max(0, line.length - PAGE);
  // From a turn's start: after a turn's end and what failed in it (stored right after, shown with it).
  for (let i = k; i > Math.max(0, k - PAGE); i--) if (line[i - 1]!.kind === "turn_end" && line[i]?.kind !== "error") { k = i; break; }
  if (k === 0 && line.length === list.length) return list;
  const keep = new Set(line.slice(k).map((e) => e.id));
  const parents = new Set(line.slice(k).filter((e) => e.kind === "user" && !e.data.origin).map((e) => e.parent));
  const start = line.findLast((e) => e.kind === "turn_start");
  if (start) keep.add(start.id);
  return list.filter((e) => keep.has(e.id) || (e.kind === "user" && !e.data.origin && parents.has(e.parent)));
}

// Feature modules (approvals, checkpoints, worktrees) keep their own client
// state: they get their frames, and a call after each reconnect to catch up.
type FeatureFrame = Extract<Frame, { t: "feature" }>;
type FeatureListener = { frame?: (f: FeatureFrame) => void; reconnect?: () => void };
const features = new Set<FeatureListener>();
export function onFeature(l: FeatureListener) {
  features.add(l);
  return () => void features.delete(l);
}
// The page's socket has opened at least once.
let opened = false;
// A feature reads its own state when the page's socket opens, the first
// time and every time after: from the open on, frames tell what changes, so
// nothing falls between the read and the frames. (Read as the page loaded,
// a change before the socket opened was told by no frame and stayed unseen:
// an approval asked for in that moment showed only at the next reconnect.)
// A feature that arrives after the socket opened reads at once. Returns the
// feature's `reconnect` listener: one read per open, none before.
//
// A socket that is slow to open, or refused, is not waited for without end:
// a second after the page asked for it the features read once without it, so
// what waits on the owner (an approval, a question, a secret) shows while the
// page still reconnects. The open reads again, as every open does. (The
// second is the socket's own, counted from the ask: a page that was slow to
// start, on a busy machine, has not waited on its socket yet, and reading
// twice for it would only cost what it has not got.)
const LATE_MS = 1000;
let late = false;
let lateTimer: ReturnType<typeof setTimeout> | undefined;
const unread = new Set<() => void>();
// (A daemon that is answering the page's requests is not gone: its socket is on its way behind them. The look is
// taken again a second later, up to four times, while it answers.)
let lastAnswer = 0;
function startLate(rearmed = 0) {
  if (lateTimer && !rearmed || late) return;
  lateTimer = setTimeout(() => {
    if (!opened && rearmed < 4 && Date.now() - lastAnswer < LATE_MS) return startLate(rearmed + 1);
    late = true;
    if (!opened) for (const read of unread) read();
    unread.clear();
  }, LATE_MS);
}
export function readAtOpen(load: () => Promise<unknown>, at?: string): () => void {
  const read = () => void load().catch((e) => reportError(e, at ? { at } : undefined));
  if (opened || late) read();
  else unread.add(read);
  return read;
}
// The folders a new session can start in: read once for the views that ask for it together.
type Workspaces = { default: string; home: string; recent: { path: string; name?: string; last?: number }[] };
let workspacesOut: Promise<any> | null = null;
export const workspaces = <T = Workspaces>(): Promise<T> => (workspacesOut ??= api("/api/workspaces").finally(() => { workspacesOut = null; }));
// src/engine/build-pin.ts: `waiting` is what the running build changed that the session does not carry yet.
export type BuildState = {
  build: string;
  pinned: { build: string | null; since: number } | null;
  // `told`: blocks of the owner's side, told to the model at the tail until the prompt takes them.
  waiting: { blocks: string[]; tools: string[]; told?: string[] };
  known: boolean;
  behind_since: number | null;
  takes_at: number | null;
  asked: boolean;
  adoptions: { ts: number; reason: string; from_build: string | null; to_build: string; blocks: string[]; tools: string[] }[];
};
export type BuildPins = { build: string; sessions: { id: string; title: string; tokens: number; warm: boolean }[]; tokens: number; unknown: number; asked: number };
export type ContextParts = {
  measured: boolean;
  total_tokens: number;
  native_tools: boolean;
  system: { tokens: number; blocks: { key: string; label: string; tokens: number }[] };
  tools: { tokens: number; groups: { key: string; label: string; kind: "builtin" | "mcp" | "catalog"; tools: number; carried: number; tokens: number; save: string }[] };
  messages: { tokens: number; rows: { key: string; label: string; tokens: number }[] };
};
export type ContextInfo = {
  context_window: number;
  bytes_per_token?: number;
  context_used_tokens: number;
  compacts_at_tokens: number;
  zones: { key: string; bytes: number; estimated_tokens: number; tokens?: number }[];
  // What the next request carries, part by part, in tokens scaled to the provider's count when it measured one.
  parts?: ContextParts;
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
export function tellQueueCounts(counts: Record<string, number> | undefined, rev: number | undefined) {
  if (!newer("local:queue-counts", rev, true)) return;
  set({ queueSnapshot: { counts, rev } });
}

export function queueCount(s: State, id: string): number | undefined {
  const live = s.queues[id];
  const snap = s.queueSnapshot;
  // A snapshot includes the effects at its rev. Peers have their own revs.
  if (snap?.counts && !splitId(id) && (live?.rev ?? 0) <= (snap.rev ?? 0)) return snap.counts[id] ?? 0;
  return live?.queue.length;
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

const questionSnapshots = new Map<string, Extract<Frame, { t: "questions" }>["pending"]>();
const legacyQuestions = new Map<string, Extract<Frame, { t: "questions" }>["pending"]>();
const loadingQuestions = new Set<string>();

function publishQuestions() {
  const questionCalls: State["questionCalls"] = {};
  const questionChildren: State["questionChildren"] = {};
  const questionAsks: State["questionAsks"] = {};
  for (const pending of [...questionSnapshots.values(), ...legacyQuestions.values()]) for (const q of pending) {
    (questionCalls[q.session_id] ??= []).push(q.call_id);
    if (q.asked) (questionAsks[q.session_id] ??= {})[q.call_id] = q.asked;
    if (q.parent_id) {
      const children = (questionChildren[q.parent_id] ??= []);
      if (!children.includes(q.session_id)) children.push(q.session_id);
    }
  }
  set({ questionCalls, questionChildren, questionAsks });
}

function forgetLegacyQuestions(id: string) {
  if (legacyQuestions.delete(id)) publishQuestions();
}

// Peers predating the global snapshot still expose their authoritative
// pending IDs on the per-session route. Never infer them from a transcript.
async function loadLegacyQuestions(id: string) {
  const peer = splitId(id);
  if (!peer || questionSnapshots.has(peer.machine) || loadingQuestions.has(id)) return;
  loadingQuestions.add(id);
  try {
    // apiPath forwards this as /api/fleet/machines/<peer>/api/sessions/<id>/questions.
    const { pending } = await api<{ pending: string[] }>(`/api/sessions/${id}/questions`, { signal: AbortSignal.timeout(5_000) });
    const session = state.sessions[id];
    if (questionSnapshots.has(peer.machine) || !session) return;
    if (pending.length) legacyQuestions.set(id, pending.map((call_id) => ({ session_id: id, call_id, parent_id: session.parent_id ?? undefined })));
    else if (!legacyQuestions.delete(id)) return;
    publishQuestions();
  } catch (e) {
    if ((e as { status?: number }).status === 404) forgetLegacyQuestions(id);
    // A busy or disconnected peer can be asked again on the next poll.
  } finally {
    loadingQuestions.delete(id);
  }
}

let questionPoll: ReturnType<typeof setInterval> | undefined;
// A daemon that tells no questions by itself is asked every second for the
// sessions of it this page holds, on the page's clock (still while the page
// is hidden). No such session, no beat: a page at rest runs no timer for this.
let questionBeat: (() => void) | undefined;
function pollQuestions() {
  const asked = () => Object.keys(state.events).filter((id) => { const peer = splitId(id); return !!peer && !questionSnapshots.has(peer.machine); });
  if (questionBeat || !asked().length) return;
  questionBeat = onBeat(1_000, () => {
    const ids = asked();
    if (!ids.length || !state.connected) { questionBeat?.(); questionBeat = undefined; return; }
    for (const id of ids) if (state.sessions[id]?.phase === "working" || legacyQuestions.has(id)) void loadLegacyQuestions(id);
  });
}

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
      forgot(s.id);
      set({ sessions, events, gone: { ...state.gone, [s.id]: s.parent_id ?? state.sessions[s.id]?.parent_id ?? true } });
      forgetLegacyQuestions(s.id);
      dropSendDrafts(s.id);
      dropPlace(s.id);
      return;
    }
    if (!state.sessions[s.id] && s.archived) return;
    // A turn ended in a session whose events this page is not sent: it may have moved a window too.
    if (state.sessions[s.id]?.phase === "working" && s.phase !== "working") limitsSoon();
    set({ sessions: { ...state.sessions, [s.id]: s } });
    headSoon(s.id);
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
    // Seen before: at or below the cursor (the page holds it, or chose not to).
    const known = e.seq <= (seen.get(e.session_id) ?? 0);
    if (!known) seen.set(e.session_id, e.seq);
    // A live event is the head of its session (the store appends at the head).
    // A replayed one (no rev) may be of any branch and moves no head: the
    // session's row, sent after the replay, says where the head is.
    const s = state.sessions[e.session_id];
    const was = s?.head;
    const moved = !known && !!s && f.rev !== undefined && newer(`${s.id}:session`, f.rev);
    if (moved) state = { ...state, sessions: { ...state.sessions, [s!.id]: { ...s!, head: e.id } } };
    // Held already: a replay of what is here, or an event a part read brought before its frame.
    if (known || holdsSeq(list, e.seq)) { if (cleared || moved) set({}); return; }
    const next = [...list, e];
    const head = state.sessions[e.session_id]?.head ?? null;
    set({ events: { ...state.events, [e.session_id]: next.length > HELD && paged.has(e.session_id) && !keepers.get(e.session_id) ? trimmed(next, head) : next } });
    // A prompt that did not go on from the head (another version of an earlier
    // prompt, made in another tab or from the command line): the part around it
    // is read, which brings the versions it stands beside. A prompt at the end
    // goes on from the head the page knew, or (when the session's row with the
    // new head came before the event) from the newest event it holds: nothing
    // is read for it, and no row above it is made again.
    if (f.rev !== undefined && e.kind === "user" && !e.data.origin && e.parent !== was && e.parent !== list.at(-1)?.id && paged.has(e.session_id)) actions.page(e.session_id, { around: e.id }).catch(reportUnlessGone);
  } else if (f.t === "delta") {
    // A reply streaming in a session this page has not opened is not kept: no
    // view reads it. A session opened later reads the reply so far from its snapshot.
    if (!state.events[f.session_id] && !loading.has(f.session_id)) return;
    // A whole draft taken at this rev or a later one (a snapshot that overtook this frame) holds it already.
    if (f.rev !== undefined && f.rev <= (revs.get(`${f.session_id}:draft`) ?? 0)) return;
    set({ drafts: { ...state.drafts, [f.session_id]: draftStep(state.drafts[f.session_id] ?? {}, f)! } });
  } else if (f.t === "queue") {
    if (newer(`${f.session_id}:queue`, f.rev)) set({ queues: { ...state.queues, [f.session_id]: { queue: f.queue, held: f.held, rev: f.rev } } });
  } else if (f.t === "status") {
    if (!newer(`${f.session_id}:status`, f.rev)) return;
    const d = draftStep(state.drafts[f.session_id] ?? {}, f);
    set({ status: { ...state.status, [f.session_id]: f.status }, drafts: d ? { ...state.drafts, [f.session_id]: d } : state.drafts });
  } else if (f.t === "questions") {
    const machine = f.machine ?? "local";
    if (!newer(`${machine}:questions`, f.rev)) return;
    questionSnapshots.set(machine, f.pending);
    for (const id of legacyQuestions.keys()) if (splitId(id)?.machine === machine) legacyQuestions.delete(id);
    publishQuestions();
  } else if (f.t === "error") {
    // A repeat or a resolve updates the kind's row; the latest goes on top.
    set({ errors: [f.error, ...state.errors.filter((e) => e.id !== f.error.id)].slice(0, 200) });
  } else if (f.t === "feature") {
    for (const l of features) l.frame?.(f);
  }
}

// Read a moment after the turn, and once for all the turns that end within LIMITS_EVERY_MS:
// a page that hears one session's turns end every few seconds read the limits after each.
const LIMITS_EVERY_MS = 20_000;
let limitsTimer: ReturnType<typeof setTimeout> | undefined;
let limitsRead = 0;
function limitsSoon() {
  if (limitsTimer) return;
  limitsTimer = setTimeout(() => {
    limitsTimer = undefined;
    limitsRead = Date.now();
    actions.loadLimits().catch((e) => reportError(e, { at: "limits" }));
  }, Math.max(1500, limitsRead + LIMITS_EVERY_MS - Date.now()));
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

// The live feed. On every (re)connect the page names the newest seq it has seen of
// each loaded session; the daemon replays what came after, and the reply a
// running turn has streamed so far, then sends live (see src/server/live.ts).
//
// The page never takes the feed for live on trust (heartbeat.ts). While it is
// on screen and the socket is quiet it asks every two seconds (less often on
// a link whose answers take longer). Two asks with no word back and the
// daemon is slow to answer; three, and it is not heard: the page says so,
// with the time of the last frame, and its clocks stop there. Then it tries
// a new socket beside the old one (which a stalled tunnel gives back whole),
// with small requests that ask whether the daemon answers at all, and the
// first frame from either socket is the way back: the page reads again all
// it holds, as at any open, and until those reads are in it goes on saying
// that what it shows is from before.
// A hidden page asks nothing; it asks the moment it is seen again.
let socket: WebSocket | undefined;
// Frames a module says on each socket as it opens, after its resume (lib/look.ts), and one it says now.
const onOpen = new Set<() => object | undefined>();
export const sayOnOpen = (f: () => object | undefined) => void onOpen.add(f);
export function sayOnSocket(m: object): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try { socket.send(JSON.stringify(m)); return true; } catch { return false; }
}
// When the live feed was last known good before a drop (null while what the
// page shows is current, and before the page's first socket): from the drop
// until the page has caught up again, not only until a socket speaks. A clock
// of running work reads `liveNow`: it stops there, since the page does not
// know that the work goes on.
let downAt: number | null = null;
export const liveNow = () => downAt ?? Date.now();
export const downSince = () => downAt;
// When the daemon was last lost: the latest loss, where `downSince` is the first of an absence (it
// may be lost again while the page catches up). Kept while connected.
let lostAt = 0;
export const lastLoss = () => lostAt;
// Since when what the page shows is not current (null: it is): from the loss until it has caught up.
export const staleSince = (s: Pick<State, "synced">) => (s.synced ? null : downAt);
export const useStaleSince = () => useStore(staleSince);
// The session in the address is asked for at boot, with the page's first
// loads, not once its view mounts (after the lazy chunks and the first render).
let preload: { id: string; p: Promise<void> } | null = null;
const opening = new Map<string, Promise<void>>();
export function preloadSession(id: string) {
  // The session view can mount before the app's boot effect. Its read is
  // already on the way, so there is nothing left to preload.
  if (opening.has(id)) return;
  const p = actions.loadSession(id);
  p.catch(() => {}); // its view takes this promise and reports a failure
  preload = { id, p };
  // A view that opens the session while this read is on its way joins it.
  opening.set(id, p);
  const done = () => { if (opening.get(id) === p) opening.delete(id); };
  p.then(done, done);
}
// The page's first socket open does not load the sessions, models and errors
// the page is loading at start; it does when those loads failed (the daemon
// was not up yet).
let bootLoad: Promise<unknown> | null = null;
export const setBootLoad = (p: Promise<unknown>) => { bootLoad = p; };
let onReplayed: ((ends: Record<string, number>) => void) | undefined;
// How far the daemon's session list had moved: when the page last read it, and (told once per socket) when the socket was subscribed.
let listLevel: number | undefined;
let onHello: ((level: number | undefined) => void) | undefined;
// The last socket opened and closed before its replay was through (a replay
// too large for it): the next one reads the open transcripts by HTTP too.
let cutShort = false;
let swept = false;
// The socket's replay is through (set again by each resume).
let caught = false;
// A resume is out on a socket that was already subscribed: until its replay
// is through, a live event of a session it names is left to the replay, which
// brings it in order. (Applied now, it would move the cursor past events the
// page never got.)
let replaying: Set<string> | null = null;
// The looks at the socket (heartbeat.ts), the tries while it is not heard, and when the absence began.
let beat: Beat = { heard: 0, pings: 0, due: 0 };
let beatTimer: ReturnType<typeof setTimeout> | undefined;
let downTimer: ReturnType<typeof setTimeout> | undefined;
let downFrom = 0;
// The round trips of the last asks, and when each ask still unanswered on the
// page's socket left. The daemon answers asks in order, so the oldest is the
// one an answer is for. Asks that waited out an absence are forgotten when it
// ends: their answers measure the absence, not the link.
let trips: Trips = [];
let asked: number[] = [];
// The way back in this absence (heartbeat.ts): the one socket being tried, the requests that ask
// beside it, and whether the daemon's machine answers without it (then requests ask alone).
// `round`: the tries that were given their whole time since something last answered.
// `sure`: the try was made on an answer.
// `asks`: the requests still out, each with the way to give it up.
type Try = { born: number | null; open: boolean; life: number };
const noTries = () => ({ socket: { born: null, open: false, life: 0, round: 0 } as Try & { ws?: WebSocket; round: number; sure?: boolean }, ask: { born: null, open: false, life: 0 } as Try, asks: new Set<() => void>(), refused: false, other: false });
let trying = noTries();
const dropAsks = () => { for (const stop of trying.asks) stop(); trying.asks.clear(); trying.ask = { ...trying.ask, open: false }; };
let probed = 0;
let hiddenAt: number | null = null;
// The absence being lived through: why it began, and the daemon's start as its last socket told it.
let absence: { why: "silent" | "closed" } | null = null;
let daemonStarted = 0;
let syncs = 0;
const every = () => ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData ? SLOW_BEAT_MS : BEAT_MS);
const hidden = () => typeof document !== "undefined" && !!document.hidden;
const isOpen = (ws: WebSocket | undefined): ws is WebSocket => !!ws && ws.readyState === WebSocket.OPEN;
// The link's round trip, for tests and the daemon's panel.
export const linkRtt = () => rttOf(trips);

function ask(ws: WebSocket) {
  try { ws.send(PING); asked.push(Date.now()); } catch { /* closing */ }
}

// The next look at the socket, when it is due.
function watch() {
  clearTimeout(beatTimer);
  if (!socket || !state.connected || hidden()) return;
  beatTimer = setTimeout(onLook, Math.max(0, beat.due - Date.now()));
}
function onLook() {
  const ws = socket;
  if (!ws || !state.connected || hidden()) return;
  const l = look(beat, Date.now(), every(), GRACE_MS, rttOf(trips));
  beat = { heard: beat.heard, pings: l.pings, due: l.due };
  if (l.lost) return lose("silent");
  if (l.slow !== state.slow) set({ slow: l.slow });
  if (l.ping && isOpen(ws)) ask(ws);
  watch();
}
// Asks now: the page is seen again, or the browser says the network changed.
// `once`: what the page shows may be old (it was out of sight a while): this one ask decides.
function probe(once = false) {
  if (!state.connected || !isOpen(socket)) return;
  ask(socket);
  const rtt = rttOf(trips);
  beat = once ? { heard: beat.heard, pings: ASKS, due: Date.now() + Math.max(GRACE_MS, 2 * rtt) } : { heard: beat.heard, pings: 1, due: Date.now() + Math.max(every(), 2 * rtt) };
  watch();
}

// The daemon is not heard: the socket closed, or went silent.
function lose(why: "silent" | "closed") {
  clearTimeout(beatTimer);
  clearInterval(questionPoll);
  drops++;
  // Silent: what the page shows is as of the last frame, not of the moment it gave up.
  // Lost again while it was catching up: still as of the first loss.
  if (opened) downAt ??= why === "silent" && beat.heard ? beat.heard : Date.now();
  lostAt = why === "silent" && beat.heard ? beat.heard : Date.now();
  cutReads();
  downFrom = Date.now();
  absence ??= { why };
  dropTries();
  set({ connected: false, synced: false, slow: false });
  downTick();
}

// Everything on its way is given up (the old socket is not: it may speak again).
function dropTries() {
  if (trying.socket.ws) abandon(trying.socket.ws);
  dropAsks();
  trying = noTries();
}
// One look at the way back while the daemon is not heard (heartbeat.ts).
function downTick() {
  clearTimeout(downTimer);
  if (state.connected) return;
  const now = Date.now(), away = hidden(), downFor = now - downFrom;
  // The socket that went silent may speak again (a tunnel that stalled gives it back whole).
  if (isOpen(socket) && now - probed >= askGap(downFor, away)) { probed = now; ask(socket); }
  const next = step(trying, now, downFor, away);
  // The request that asked alone got no answer at all: the network says nothing now.
  if (next.quiet) trying.refused = false;
  if (next.socket) {
    // The try that was given its time and said nothing: the next is given more.
    const round = trying.socket.born !== null && trying.socket.open ? trying.socket.round + 1 : trying.socket.round;
    attempt(round, socketBound(round));
  }
  if (next.ask) askByRequest(askLife(trying, downFor, away));
  downTimer = setTimeout(downTick, step(trying, Date.now(), Date.now() - downFrom, away).wait);
}
const lookSoon = () => { clearTimeout(downTimer); downTimer = setTimeout(downTick, 50); };
// A new socket is tried, in place of the one that was. `sure`: on the word of a request the daemon just answered.
// (The requests that are out go on: they ask by the absence's age, not the try's.)
function attempt(round: number, life: number, sure = false) {
  if (trying.socket.ws) abandon(trying.socket.ws);
  trying.refused = false;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  const born = Date.now();
  trying.socket = { ws, born, open: true, life, round, sure };
  // Open is not heard: the daemon greets a socket the moment it opens, and that
  // first frame is what makes this the page's connection. One that opens and
  // says nothing (something on the way took the handshake) waits out its time
  // like one that never opened.
  ws.onmessage = (m) => { adopt(ws, Date.now() - born); onMessage(ws, m); };
  // Ended without a word (refused, or cut before it spoke): something there answers and the
  // daemon does not. Requests ask alone from here, and the next try is made when it answers one.
  ws.onclose = () => { if (trying.socket.ws === ws && !state.connected) alone(); };
}
// The daemon's machine answers and the daemon does not: no try is left out (it would hear the
// same, or was made into a network that is gone, and a browser makes one handshake at a time),
// and the requests that asked beside it are given up, so the next one asks alone after the gap
// and not after the time the last of them was given.
function alone(other = false) {
  if (trying.socket.ws) abandon(trying.socket.ws);
  trying.socket = { ...trying.socket, ws: undefined, open: false };
  dropAsks();
  trying.refused = true;
  trying.other = other;
  lookSoon();
}
// What the daemon answers a request that asks whether it is there (src/server/app.ts, /api/health?link).
const daemonSays = (j: unknown) => !!j && typeof j === "object" && (j as { ok?: unknown }).ok === true && typeof (j as { pid?: unknown }).pid === "number";
// A small request that asks whether the daemon answers at all, given `life`.
function askByRequest(life: number) {
  const cut = new AbortController();
  const sent = Date.now();
  const mine: Try = { born: sent, open: true, life };
  trying.ask = mine;
  const timer = setTimeout(() => stop(), life);
  const stop = () => { clearTimeout(timer); cut.abort(); trying.asks.delete(stop); };
  trying.asks.add(stop);
  // Still one of this absence's, and not given up.
  const live = () => !cut.signal.aborted && trying.asks.has(stop) && !state.connected;
  // Without credentials (the route needs none): the browser keeps such requests apart from the
  // page's own, and the daemon closes each one's connection, so every one is a new connection.
  // One that went into a connection kept from before the loss would wait there for nothing.
  fetch("/api/health?link", { cache: "no-store", credentials: "omit", signal: cut.signal })
    // The daemon's own answer, or something else's (a front that stands before it, another program on its port).
    .then((r) => (r.ok ? r.json().then(daemonSays, () => false) : false))
    .then((daemon) => {
      if (!live()) return;
      mine.open = false;
      stop();
      if (daemon) return answered(Date.now() - sent);
      // Not the daemon: no socket is made on that word (it would fail, and a browser counts those).
      alone(true);
    }, () => {
      if (!live()) return;
      mine.open = false;
      stop();
      // Refused: the daemon's machine answers and the daemon does not.
      alone();
    });
}
// The daemon answered a request: the network is back, this slow. The try that is out may be dead
// for good (it was made into the silence): a new one is made on this answer, with its bound from
// what was measured. Not in place of a try that may be about to be greeted, and not, for six
// seconds, of one that was itself made on an answer (heartbeat.ts).
function answered(took: number) {
  if (state.connected) return;
  trying.other = false;
  if (!answerMakesTry(trying, Date.now(), took)) return;
  attempt(0, socketBound(0, took), true);
  lookSoon();
}
function abandon(ws: WebSocket) {
  ws.onopen = ws.onclose = ws.onmessage = null;
  try { ws.close(); } catch { /* never opened */ }
}
// A new socket spoke: it is the page's connection from here. `took`: from its start to its first frame.
function adopt(ws: WebSocket, took: number) {
  trying.socket.ws = undefined;
  dropTries();
  const old = socket;
  if (old && old !== ws) {
    if (!caught) cutShort = true;
    abandon(old);
  }
  socket = ws;
  // Nothing is asked on it yet. Its handshake is the first measure of the link: at least one round trip.
  asked = [];
  trips = tripped([], took);
  ws.onmessage = (m) => onMessage(ws, m);
  ws.onclose = () => onClose(ws);
  sync(ws);
}
function onClose(ws: WebSocket) {
  if (socket !== ws) return;
  socket = undefined;
  asked = [];
  onHello?.(undefined); // a socket that closed before it said hello leaves nothing waiting on it
  if (!caught) cutShort = true;
  // Already not heard (it had gone silent): the tries go on.
  if (state.connected || !downTimer) lose("closed");
}
export function connect() {
  startLate();
  downFrom = Date.now();
  downTick();
}
// Tries the daemon now instead of when the try on its way has had its time: for a host that
// knows it is back, a page seen again, and a network the browser says changed.
export function reconnectNow() {
  if (state.connected) return;
  dropTries();
  probed = 0;
  downTick();
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (hidden()) { hiddenAt = Date.now(); clearTimeout(beatTimer); return; }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (!state.connected) { if (downTimer) reconnectNow(); return; }
    probe(away >= SLEPT_MS);
    // Away long enough for the browser to have put the page to sleep: what it holds is read again, quietly.
    if (away >= HIDDEN_RESYNC_MS && isOpen(socket)) sync(socket, true);
  });
  // The browser saw the network change: asked now, in either state.
  addEventListener("online", () => { if (state.connected) probe(); else if (downTimer) reconnectNow(); });
}

// A request that is waited for only while the daemon is heard: when the page loses it, the wait
// ends as a request the network dropped does (a TypeError), whatever becomes of the request.
// For what is safe to ask again (a send under its own id).
export function whileHeard<T>(p: Promise<T>): Promise<T> {
  if (!state.connected) return p;
  return new Promise<T>((done, fail) => {
    const off = subscribe(() => { if (!state.connected) { off(); fail(new TypeError("Failed to fetch: Keel stopped answering")); } });
    p.then((v) => { off(); done(v); }, (e) => { off(); fail(e); });
  });
}

// Everything the page holds is read again against this socket: the daemon
// replays what came after the page's cursors, and the lists and the features
// load as at the page's start. `quiet`: the socket was never lost (the page
// was hidden a while), so nothing says "Catching up".
// `again`: how often this catch-up was started over.
let syncTimer: ReturnType<typeof setTimeout> | undefined;
function sync(ws: WebSocket, quiet = false, again = 0) {
  const mine = ++syncs;
  // Back from an absence: what was asked into it is asked again below, on connections made now.
  if (opened && (!state.connected || again)) cutReads();
  // A catch-up that does not end (a read went into a connection that died without a word) is
  // started over, its reads given up for new ones: after twenty seconds, or twelve of the
  // link's round trips when that is longer, and twice as long each time after.
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (mine === syncs && socket === ws && state.connected && !state.synced) sync(ws, quiet, again + 1);
  }, Math.max(20_000, 12 * rttOf(trips)) * 2 ** Math.min(again, 4));
  clearTimeout(downTimer);
  downTimer = undefined;
  // The lost time stands until the reads below are in: what the page shows is from then.
  const since = downAt;
  const was = absence;
  caught = false;
  beat = { heard: Date.now(), pings: 0, due: Date.now() + every() };
  const loaded = Object.entries(state.events);
  const cursors = Object.fromEntries(loaded.filter(([id]) => !splitId(id)).map(([id, list]) => [id, seen.get(id) ?? list.at(-1)?.seq ?? 0]));
  // A draft from before the drop may be stale (a retry restarts it, the reply
  // may have finished meanwhile): the replay sends the current one of each
  // loaded session, and a session opened later reads it from its snapshot.
  if (!quiet) set({ connected: true, synced: false, drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => splitId(id))) });
  watch();
  replaying = new Set(Object.keys(cursors));
  ws.send(JSON.stringify(scope.resume(cursors, (m) => ws.readyState === WebSocket.OPEN && (ws.send(JSON.stringify(m)), true))));
  for (const f of onOpen) { try { const m = f(); if (m) ws.send(JSON.stringify(m)); } catch (e) { reportError(e, { at: "socket open" }); } }
  // What the page loads at start is loaded again: a first load the daemon
  // was not up for (a restart under the page) comes in now, quietly.
  const reload = () => {
    if (!state.loaded.models) actions.loadModelsBrief().catch((e) => reportError(e, { at: "reconnect" }));
    actions.loadErrors().catch((e) => reportError(e, { at: "reconnect" }));
    return actions.loadSessions().catch((e) => reportError(e, { at: "reconnect" }));
  };
  const first = !opened && bootLoad;
  opened = true;
  // The list the page read as it loaded stands for this first open when
  // nothing moved between the two: the daemon says how far its session
  // list had moved at each. A session made, renamed or deleted after the
  // read and before the socket was subscribed was told by no frame: the
  // list is then read again.
  const hello = new Promise<number | undefined>((said) => (onHello = said));
  const level = () => hello.then((at) => (at !== undefined && listLevel !== undefined && at > listLevel ? actions.loadSessions().catch((e) => reportError(e, { at: "reconnect" })) : undefined));
  const listed = first ? first.then(level, reload) : reload();
  // Once a page: what this browser kept for sessions that were deleted while no page was open goes.
  void listed.then(() => {
    if (swept || !state.loaded.sessions) return; // a list that did not come is asked for again at the next socket
    swept = true;
    return dropOrphans(
      (id) => !!state.sessions[id],
      // Only the daemon's own "no such session" says it is gone: any other answer (another
      // daemon's or a proxy's 404 included) keeps what was stored.
      (id) => fetch(apiPath(`/api/sessions/${id}/draft`)).then(async (r) => r.status !== 404 || (await r.json().catch(() => null))?.error !== "no such session", () => true),
    );
  }).catch((e) => reportError(e, { at: "kept sends of deleted sessions" }));
  const loads: Promise<unknown>[] = [listed];
  // Where the daemon's replay of each session ended, once it is through.
  const replayed = new Promise<Record<string, number>>((done) => (onReplayed = done));
  const whole = cutShort;
  cutShort = false;
  // One deleted meanwhile is dropped.
  const gone = (id: string) => (e: unknown) => {
    if ((e as { status?: number }).status !== 404) return reportError(e, { at: "reconnect" });
    const { [id]: _, ...events } = state.events;
    const { [id]: __, ...sessions } = state.sessions;
    forgot(id);
    set({ events, sessions, gone: { ...state.gone, [id]: state.sessions[id]?.parent_id ?? true } });
    forgetLegacyQuestions(id);
    dropSendDrafts(id);
  };
  // The open sessions moved meanwhile. On the page's first socket the
  // snapshots were just taken and the replay brings queue and status: no load.
  for (const [id] of first ? [] : loaded) {
    // The local resume cannot replay events from a peer, even when the
    // daemon-to-peer relay stayed up: its transcript is read again by HTTP.
    // So is every transcript after a socket that closed inside its replay.
    if (splitId(id) || whole) { loads.push(actions.loadSession(id).catch(gone(id))); continue; }
    // A session of this daemon: the replay brings every event after the
    // page's cursor, so it is asked for without its transcript, and only
    // once the replay and the list are in. Its answer (row, head, queue,
    // status, draft) is then newer than every replayed frame and lands
    // after them, and after the list, which holds no archived row.
    loads.push(Promise.all([replayed, listed]).then(([ends]) => {
      if (socket !== ws || mine !== syncs) return;
      // The daemon holds less of it than the page (its replay ended below the
      // page's cursor: a restored backup): what the page holds is dropped
      // and the session is read whole, or its new events would be taken for old ones.
      const behind = (ends[id] ?? cursors[id]!) < cursors[id]!;
      if (behind) { const { [id]: _, ...events } = state.events; forgot(id); set({ events }); }
      return actions.loadSession(id, behind).catch(gone(id));
    }));
  }
  // Caught up when this socket's replay came and the reloads landed; a late
  // answer from a socket that dropped meanwhile declares nothing.
  Promise.all(loads).then(() => {
    if (socket !== ws || mine !== syncs || !state.connected) return;
    downAt = null;
    absence = null;
    set({ synced: true });
    // The absence is told to the daemon, which keeps it where the owner can read it
    // afterwards. Not a daemon that restarted meanwhile: its restart is kept already.
    if (since !== null && was && Date.now() - since >= 1000 && daemonStarted <= since) {
      fetch("/api/connection", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: since, to: Date.now(), why: was.why }) }).catch(() => {});
    }
  });
  // Features load their own state here, the first open included.
  for (const l of features) l.reconnect?.();
  pollQuestions();
}

function onMessage(ws: WebSocket, m: MessageEvent) {
  if (socket !== ws) return;
  beat.heard = Date.now();
  beat.pings = 0;
  if (state.slow) set({ slow: false });
  // The socket that went silent speaks again: it is the connection again, and
  // what the page holds is read against it before this frame is. The asks
  // that waited out the absence measure nothing of the link.
  if (!state.connected) {
    dropTries();
    asked = [];
    sync(ws);
  }
  const f = JSON.parse(m.data) as Frame | SocketFrame;
  if (f.t === "pong") {
    const at = asked.shift();
    if (at) trips = tripped(trips, Date.now() - at);
    return;
  }
  // The replay's whole draft, also at the rev of a snapshot that came before this socket
  // opened (nothing was emitted between them): the open dropped the snapshot's copy.
  if (f.t === "draft") delivered(() => { if (newer(`${f.session_id}:draft`, f.rev, true)) set({ drafts: { ...state.drafts, [f.session_id]: f.blocks } }); });
  else if (f.t === "replayed") { caught = true; replaying = null; onReplayed?.(f.cursors ?? {}); }
  else if (f.t === "hello" || f.t === "ui") {
    if (f.t === "hello") { daemonStarted = f.started_ms ?? 0; onHello?.(f.sessions_level); }
    servedUi(f.t === "ui" ? f.version : f.ui);
  }
  else if (f.t === "event" && f.rev !== undefined && replaying?.has(f.event.session_id)) return;
  else delivered(() => apply(f));
}

// The affected composer claims the notice if it is still on screen.
export function showArchivedRefusal(err: unknown): boolean {
  const apiError = err as { status?: number; body?: { error?: string }; path?: string } | null;
  if (apiError?.status === 409 && apiError.body?.error === "the session is archived" && typeof apiError.path === "string") {
    const session = apiError.path.match(/^\/api\/sessions\/([^/?]+)(?:\/|$)/)?.[1];
    if (session) {
      dispatchEvent(new CustomEvent("keel:archived-refusal", { cancelable: true, detail: session }));
      return true;
    }
  }
  return false;
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
  if (showArchivedRefusal(err)) return;
  // A read the page gave up when its link dropped: the reconnect reads it again (a deleted session's then answers 404).
  if ((err as { cut?: boolean } | null)?.cut) return;
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
