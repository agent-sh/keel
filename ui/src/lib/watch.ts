// What each session needs from the owner: the one word every shell shows
// first (needs you, working, failed, done), why, and since when. The daemon
// works the state out (src/core/watch.ts, src/automation/state.ts) and sends
// it; this file keeps what it sent and adds the one thing only this browser
// knows, a message it could not send. Also the line of what a session is
// doing now, and its turns over time for the wake chart.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ownerPrompt } from "../../../src/core/owner.ts";
import type { Session, StoredEvent } from "../../../src/core/types.ts";
import { agentLive, AT_REST, liveAgentCounts, stateOf, type SessionState, type Watch } from "../../../src/core/watch.ts";
import { stateAlone, stateLabel, waitsOnOwner } from "../../../src/core/state-words.ts";
import { useAuto } from "./automation.ts";
import { remoteId, splitId } from "./fleet-ids.ts";
import { useSafety } from "./safety.ts";
import { sendDrafts, unsentOf, useShelfVersion } from "./send-drafts.ts";
import { actions, api, downSince, getState, lastLoss, newer, onFeature, readAtOpen, reportError, useStaleSince, useStore } from "./store.ts";
import { useReach } from "./reach.ts";
import { stripAnsi, toolKind, toolLine, type ToolKind } from "./tools.ts";

export { toolLine };

export { AT_REST, LIST_TIER, WATCH_LABEL, WATCH_RANK, type SessionState, type Watch } from "../../../src/core/watch.ts";

// Agents still at work, per parent session (the automation store keeps every live one).
export function useAgentCounts(): Record<string, number> {
  const agents = useAuto((x) => x.agents);
  return useMemo(() => liveAgentCounts(Object.values(agents)), [agents]);
}
export const useAgentCount = (id: string | undefined) =>
  useAuto((x) => { let n = 0; if (id) for (const a of Object.values(x.agents)) if (a.parent_id === id && agentLive(a)) n++; return n; });

// The branch the session shows, from the events the page holds of it. The
// held list also has the other versions of the branch's prompts (and, for a
// session read whole, every other branch), so its last event is not always
// the branch's: what the page reads from its own events (a session's last
// line, the transcript's rows) is read from the branch. A session's word and
// reason are not: the daemon tells them (below), since the page may hold only
// the newest part of a session.
// Walked back from the head once per state of the list.
const branches = new WeakMap<StoredEvent[], { head: string | null; line: StoredEvent[] }>();
export function branchOf(events: StoredEvent[] | undefined, head: string | null | undefined): StoredEvent[] | undefined {
  if (!events) return undefined;
  const had = branches.get(events);
  if (had && had.head === (head ?? null)) return had.line;
  const out: StoredEvent[] = [];
  let want = head ?? null;
  for (let i = events.length - 1; i >= 0 && want; i--) {
    const e = events[i]!;
    if (e.id !== want) continue;
    out.push(e);
    want = e.parent;
  }
  // A head the page does not hold yet (its part is on its way): the list as it is.
  const line = !out.length || out.length === events.length ? events : out.reverse();
  branches.set(events, { head: head ?? null, line });
  return line;
}

// The states the daemon told, by session: a snapshot when the page loads or
// reconnects, a frame for every change after it. The newer of the two wins.
let told: Record<string, SessionState> = {};
const subs = new Set<() => void>();
const setTold = (next: Record<string, SessionState>) => { told = next; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
function useTold<T>(sel: (x: Record<string, SessionState>) => T): T {
  return useSyncExternalStore(subscribe, () => sel(told));
}
// What the daemon told, as it is: for a part that marks a session by its state without its row (an agent in the tree).
export const useToldStates = () => useTold((x) => x);
export const useToldState = (id: string | undefined) => useTold((x) => (id ? x[id] : undefined));
// Which states are current while the page catches up. From the moment it stops hearing the
// daemon until it has read everything again, what it shows is as of the loss. A state told
// since (a frame of the new socket, the snapshot read on it) is not: it is the daemon's word of
// now, and says so the moment it is in, before the rest of the catch-up is. Lost again before
// the catch-up ended, such a state is as of that loss, not the first.
// When each session's state was last told, and this daemon's snapshot of all of its own.
const toldAt = new Map<string, number>();
let snapAt = 0;
let freshRev = 0;
function toldNow(ids: string[] | "all") {
  const now = Date.now();
  if (ids === "all") snapAt = now;
  else for (const id of ids) toldAt.set(id, now);
  // Readers are told only while something is not current: at other times nothing reads this.
  if (downSince() !== null) freshRev++;
}
// (Another machine's sessions are not in this daemon's snapshot: its relay tells them.)
const toldOf = (id: string) => Math.max(toldAt.get(id) ?? 0, splitId(id) ? 0 : snapAt);
// Since when a session's state is not current (null: it is). `since`: since when the page's are.
export function staleOf(id: string, since: number | null, connected: boolean, told = toldOf(id), lost = lastLoss()): number | null {
  if (since === null) return null;
  if (told <= since) return since; // from before the absence began
  if (told > lost) return connected ? null : told; // told on the connection the page has now
  return lost; // told between two losses of one absence
}
const useFresh = () => useSyncExternalStore(subscribe, () => freshRev);
// Since when the states the page shows are not current (null: they are): from the loss until
// the daemon's snapshot of them is in, which is sooner than the whole catch-up.
export function useStatesSince(): number | null {
  const page = useStaleSince();
  const connected = useStore((x) => x.connected);
  useFresh();
  return page !== null && connected && snapAt > lastLoss() ? null : page;
}
// The sessions told since the loss, while the snapshot is not in yet: the few a frame was quicker for.
export function useToldSince(): string[] {
  const page = useStaleSince();
  const connected = useStore((x) => x.connected);
  const rev = useFresh();
  return useMemo(() => {
    const lost = lastLoss();
    if (page === null || !connected || snapAt > lost) return [];
    const out: string[] = [];
    for (const [id, at] of toldAt) if (at > lost && out.length < 40) out.push(id);
    return out;
  }, [page, connected, rev]);
}

export async function loadStates() {
  const r = await api<{ states: Record<string, SessionState>; rev?: number }>("/api/state");
  toldNow("all");
  // The snapshot is every session this daemon tells of: one it leaves out (archived or
  // deleted while the page was away) is told no more, unless a newer frame says otherwise.
  // Another machine's sessions are told by its relay (tellRemote).
  const next: Record<string, SessionState> = {};
  for (const [id, st] of Object.entries(told)) if (splitId(id) || (!(id in r.states) && !newer(`${id}:state`, r.rev, true))) next[id] = st;
  for (const [id, st] of Object.entries(r.states)) next[id] = newer(`${id}:state`, r.rev, true) || !told[id] ? st : told[id]!;
  setTold(next);
}
// The states of another machine's sessions, as its daemon told them: with the relay's snapshot,
// and with every list of that machine's sessions this daemon serves. `rev`: that daemon's bus rev
// the states reflect. A list can come back after a newer frame of one of its sessions (the list
// was read first): per session the newer of the two is kept, and a session the list leaves out is
// dropped only when the list is the newer word on it.
export function tellRemote(machine: string, states: Record<string, SessionState>, rev?: number) {
  const next: Record<string, SessionState> = {};
  const theirs = new Set(Object.keys(states).map((id) => remoteId(machine, id)));
  for (const [id, st] of Object.entries(told)) {
    if (splitId(id)?.machine !== machine || (!theirs.has(id) && !newer(`${id}:state`, rev, true))) next[id] = st;
  }
  for (const [id, st] of Object.entries(states)) {
    const rid = remoteId(machine, id);
    next[rid] = newer(`${rid}:state`, rev, true) || !told[rid] ? (st.child ? { ...st, child: remoteId(machine, st.child) } : st) : told[rid]!;
  }
  toldNow(Object.keys(states).map((id) => remoteId(machine, id)));
  setTold(next);
}
onFeature({
  frame(f) {
    if (f.name !== "state" || !f.session_id || !newer(`${f.session_id}:state`, f.rev)) return;
    toldNow([f.session_id]);
    if (f.data) return setTold({ ...told, [f.session_id]: f.data as SessionState });
    const { [f.session_id]: _gone, ...rest } = told;
    setTold(rest);
  },
  reconnect: readAtOpen(loadStates),
});

// A message this browser keeps because it was not sent, or nobody confirmed
// it, waits for the owner like a question does: the session needs them. One
// that waits for the daemon to be back goes out by itself: nothing for the
// owner to do, so a session at rest reads Waiting with that as its reason,
// and a state that already says more (needs you, working, failed) keeps its own.
const UNSENT_LINE = { refused: "A message was not sent", unconfirmed: "A message's delivery is unconfirmed" } as const;
const SEND_WAITS = "A message waits for Keel to be back";
type Kept = "refused" | "unconfirmed" | "waiting" | null;
// What the shelf holds for a session: a send the owner must look at first, else one that waits for the daemon.
const keptOf = (sid: string): Kept => unsentOf(sid) ?? (sendDrafts(sid).some((d) => d.state === "waiting") ? "waiting" : null);
function withUnsent(st: SessionState, kept: Kept): SessionState {
  if (!kept) return st;
  if (kept === "waiting") return AT_REST.includes(st.watch) ? { watch: "wait", agents: st.agents, why: "send", text: SEND_WAITS } : st;
  if (st.watch === "need") return { ...st, asks: (st.asks ?? 1) + 1 };
  return { watch: "need", agents: st.agents, why: "unsent", text: UNSENT_LINE[kept], asks: 1 };
}

// A session the daemon has not told of yet (another machine's before its first
// frame, a page that just opened): read from the marks the daemon keeps on its
// row (its phase, how its last turn ended) and the cards the page holds. Never
// from the events the page holds: they may be only the newest part of it.
type Held = { approvals?: number; asking?: boolean; agents?: number };
const fromHeld = (s: Session, h: Held): SessionState => stateOf(s, undefined, { approvals: h.approvals, asking: h.asking, agents: h.agents });

// A state the page cannot vouch for says so: `as_of` is when it was last known.
// The page does not hear the daemon (every state, as of the last frame), or
// the machine the session is on is out of reach (`offline`, as of when it was
// last heard). A reader shows the word with "as of HH:MM"; the clocks stop there.
// A session of this daemon whose tools run on a machine that is out of reach is
// `offline` too, but its state is this daemon's own and current: no "as of".
// `machine`: since when its machine is not heard (undefined: it is, or the session is here).
const notCurrent = (st: SessionState, page: number | null, machine: number | undefined, theirs: boolean): SessionState => {
  const since = theirs && machine ? Math.min(machine, page ?? machine) : page;
  return machine !== undefined ? { ...st, offline: true, ...(since ? { as_of: since } : {}) } : page !== null ? { ...st, as_of: page } : st;
};
// Since when the page's states are not current (null: they are): from when it stopped hearing the daemon until it has caught up.
// One the daemon told since is current before that (`staleOf`).
const usePageSince = useStaleSince;
// The machine a session depends on: the one it lives on (another daemon's session), or the one its tools run on.
const machineOf = (s: Session | undefined) => (s ? splitId(s.id)?.machine ?? s.machine ?? undefined : undefined);
const theirs = (s: Session) => !!splitId(s.id);

export function useSessionState(s: Session | undefined): SessionState {
  const state = useTold((x) => (s ? x[s.id] : undefined));
  const since = usePageSince();
  const rev = useFresh();
  const connected = useStore((x) => x.connected);
  const page = s ? staleOf(s.id, since, connected) : since;
  const far = machineOf(s);
  const machine = useReach((x) => (far ? x.unheard[far]?.since : undefined));
  const n = useSafety((x) => (s ? x.approvals[s.id]?.length ?? 0 : 0));
  const asking = useStore((x) => !!s && !!(x.questionCalls[s.id]?.length || x.questionChildren[s.id]?.length));
  useShelfVersion();
  const kept = s ? keptOf(s.id) : null;
  const agents = useAgentCount(s?.id);
  return useMemo(
    () => (s ? notCurrent(withUnsent(state ?? fromHeld(s, { approvals: n, asking, agents }), kept), page, machine, theirs(s)) : { watch: "idle", agents: 0 }),
    [s, state, n, asking, agents, kept, page, machine, rev, connected],
  );
}
export const useWatch = (s: Session | undefined): Watch => useSessionState(s).watch;

// The word as shown, with the agents that keep it working.
export function useWatchLabel(s: Session | undefined): string {
  const st = useSessionState(s);
  return stateLabel(st);
}

// The word of a session's state for a place that shows it with no reason beside it (a mark's
// tooltip, a recent row, a dock): the label of the state the daemon told ("Working · 2 agents",
// "Command in background"), else the word of the mark alone.
export function useStateLabel(): (id: string, w: Watch) => string {
  const states = useTold((x) => x);
  return useCallback((id, w) => stateAlone(states[id]?.watch === w ? states[id]! : { watch: w }), [states]);
}

// How many things wait on the owner, in every session of theirs: the one count (src/core/state-words.ts)
// behind the tab's title, the home headline, the list's line and the phone's dock.
export function useNeedCount(): number {
  const sessions = useStore((x) => x.sessions);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived && !s.parent_id), [sessions]);
  const states = useSessionStates(list);
  return useMemo(() => waitsOnOwner(list.map((s) => states[s.id])), [list, states]);
}

// All sessions' states in one pass (for boards and lists).
export function useSessionStates(list: Session[]): Record<string, SessionState> {
  const states = useTold((x) => x);
  const calls = useStore((x) => x.questionCalls);
  const children = useStore((x) => x.questionChildren);
  const approvals = useSafety((x) => x.approvals);
  const agents = useAgentCounts();
  const shelf = useShelfVersion();
  const page = usePageSince();
  const connected = useStore((x) => x.connected);
  const unheard = useReach((x) => x.unheard);
  return useMemo(() => {
    const out: Record<string, SessionState> = {};
    for (const s of list) {
      const st = states[s.id] ?? fromHeld(s, { approvals: approvals[s.id]?.length, asking: !!(calls[s.id]?.length || children[s.id]?.length), agents: agents[s.id] });
      const far = machineOf(s);
      out[s.id] = notCurrent(withUnsent(st, keptOf(s.id)), staleOf(s.id, page, connected), far ? unheard[far]?.since : undefined, theirs(s));
    }
    return out;
  }, [list, states, calls, children, approvals, agents, shelf, page, unheard]);
}
export function useWatches(list: Session[]): Record<string, Watch> {
  const states = useSessionStates(list);
  return useMemo(() => Object.fromEntries(Object.entries(states).map(([id, st]) => [id, st.watch])), [states]);
}

// Loads the events of sessions an overview shows, once each.
const asked = new Set<string>();
export function useLoadEvents(ids: string[]) {
  const key = ids.join(",");
  useEffect(() => {
    for (const id of ids) {
      if (asked.has(id) || getState().events[id]) continue;
      asked.add(id);
      // A session deleted meanwhile is simply not shown.
      // A failed load is asked again next time (the marks stand meanwhile).
      actions.loadSession(id).catch((e) => { if ((e as { status?: number }).status !== 404) { asked.delete(id); reportError(e, { at: "overview events" }); } });
    }
  }, [key]);
}

// The newest thing a session did: its last tool call, the reply it is
// writing, or the first line of its last reply.
// Terminal escapes a reply, a command or an error quotes are taken out.
export function lastLine(events: StoredEvent[] | undefined, cwd?: string): string {
  return stripAnsi(newest(events, cwd)).trim();
}

function newest(events: StoredEvent[] | undefined, cwd?: string): string {
  if (!events) return "";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "error") return String(e.data.message ?? "");
    if (e.kind === "assistant") {
      const blocks = e.data.blocks as any[];
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j];
        if (b.type === "text" && clean(b.text)) return clean(b.text.trim().split("\n")[0]!) || clean(b.text);
        if (b.type === "tool_use") return toolLine(b.name, b.input ?? {}, cwd);
      }
    }
    if (e.kind === "user" && ownWords(e)) return clean(e.data.text);
    // A subagent's first message is the harness's preamble around its task:
    // the line is the parent's words only (they start at task_at).
    if (e.kind === "user" && e.data.kind === "task") return clean(taskWords(e));
  }
  return "";
}

// What a session last said, for a place that shows a session the page has not opened (the card
// beside a row): asked of the daemon once per state of the session, when the place is shown.
const lastLines = new Map<string, { at: number; line: string }>();
export function useLastLine(s: Session | undefined, on: boolean): string {
  const [, tick] = useState(0);
  const id = s?.id, at = s?.updated ?? 0;
  useEffect(() => {
    if (!on || !id || splitId(id) || lastLines.get(id)?.at === at) return;
    let live = true;
    api<{ line: string }>(`/api/sessions/${id}/last-line`).then((r) => { lastLines.set(id, { at, line: stripAnsi(r.line ?? "").trim() }); if (live) tick((n) => n + 1); }).catch(() => {});
    return () => { live = false; };
  }, [on, id, at]);
  return (on && id && lastLines.get(id)?.line) || "";
}

const taskWords = (e: StoredEvent) => {
  const text = String(e.data.text ?? ""), at = e.data.task_at;
  return typeof at === "number" && at >= 0 && at <= text.length ? text.slice(at) : "";
};

// What the owner wrote (typed, steered, queued, spoken or sent from the CLI). Messages
// the harness delivers (a wait firing, a subagent's task or report, a hook) carry a
// kind or an origin of their own (engine.send spreads its meta into the event) and are not their.
const ownWords = (e: StoredEvent) => ownerPrompt(e.data) && !e.data.meta && !/^\s*(<[a-z_]+[\s>]|\[harness\])/i.test(String(e.data.text ?? ""));
// One readable line: no tags, no markdown marks.
const clean = (t: string) => stripAnsi(String(t)).replace(/<\/?[a-z_][^>]*>/gi, " ").replace(/[*`#_]/g, "").replace(/\s+/g, " ").trim();

export type Span = { start: number; end: number | null; reason?: string };
export type Tick = { ts: number; kind: ToolKind; error: boolean };

// Turns as time spans and tool calls as ticks, for the wake chart.
export function timeline(events: StoredEvent[] | undefined, working = false): { spans: Span[]; ticks: Tick[]; errors: number[] } {
  const spans: Span[] = [];
  const ticks: Tick[] = [];
  const errors: number[] = [];
  if (!events) return { spans, ticks, errors };
  const failed = new Set<string>();
  for (const e of events) if (e.kind === "tool_result") for (const r of e.data.results) if (r.is_error) failed.add(r.tool_use_id);
  for (const e of events) {
    if (e.kind === "turn_start") spans.push({ start: e.ts, end: null });
    else if (e.kind === "turn_end" && spans.length) Object.assign(spans[spans.length - 1]!, { end: e.ts, reason: e.data.reason });
    else if (e.kind === "assistant") {
      for (const b of e.data.blocks as any[]) if (b.type === "tool_use") ticks.push({ ts: e.ts, kind: toolKind(b.name), error: failed.has(b.id) });
    } else if (e.kind === "error") errors.push(e.ts);
  }
  // Only a working session has an open turn; one cut off ends at its last event.
  const last = spans[spans.length - 1];
  if (last && last.end === null && !working) Object.assign(last, { end: events[events.length - 1]!.ts, reason: "error" });
  return { spans, ticks, errors };
}
