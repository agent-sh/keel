// Each live agent's "now" line (src/automation/now-line.ts says what it is),
// kept with no model request and no read of events: the thinking of its
// current step and the calls it runs come from the turn's own hooks as they
// happen, its steps and spend from two reads of the ledger's session index
// when a line is made, whether it needs the owner from its state frames. A
// line is made at most once every NOW_MS for an agent, and only when
// something of it changed. The lines of one tree go out as one frame,
// `agents_now`, to the views that show that tree (src/server/scope.ts): the
// session of the agent that started each, and the feed `tree:<root>` a
// sidebar names while it shows the tree's rows.
import type { Frame, Session } from "../core/types.ts";
import { registerHooks } from "../engine/hooks.ts";
import { joinPulse } from "../core/pulse.ts";
import { capture, D } from "./core.ts";
import * as agents from "./agents.ts";
import { dueAt, NOW_MS, nowPrint, nowWords, statusLine, type NowLine } from "./now-line.ts";

export { NOW_MS, type NowLine };

const THINK_KEEP = 1_200; // characters of a step's thinking kept: its newest sentence is at the end

type Live = { thinking: string; calls: Map<string, { name: string; input: unknown; at: number }>; need: boolean };
const live = new Map<string, Live>(); // agent session -> what its turn is doing
const told = new Map<string, { at: number; print: string; need?: boolean }>(); // agent session -> its last telling
const lines = new Map<string, NowLine>(); // agent session -> its newest line
const dirty = new Map<string, number>(); // agent session -> when its line may be told
// For the measure (GET /api/automation/now?stats=1): what making the lines cost.
export const nowStats = { made: 0, ms: 0, frames: 0, bytes: 0 };

const of = (id: string) => {
  let l = live.get(id);
  if (!l) live.set(id, (l = { thinking: "", calls: new Map(), need: false }));
  return l;
};
const touch = (id: string) => {
  const t = told.get(id);
  const due = dueAt(t, live.get(id)?.need, Date.now());
  const was = dirty.get(id);
  if (was === undefined || due < was) dirty.set(id, due);
};
const isAgent = (s: Pick<Session, "parent_id">) => !!s.parent_id;

// What the turn's hooks tell of an agent's session, kept for its line. A step's thinking is the
// line's only while that step runs: a new request clears it, so a step that calls a tool with no
// thinking of its own shows the call, never the thinking of a step before it.
export const track = {
  requestSent: (id: string) => { of(id).thinking = ""; touch(id); },
  thinking: (id: string, text: string) => { const l = of(id); l.thinking = (l.thinking + text).slice(-THINK_KEEP); touch(id); },
  callStarted: (id: string, callId: string, name: string, input: unknown, at = Date.now()) => { of(id).calls.set(callId, { name, input, at }); touch(id); },
  callEnded: (id: string, callId: string) => { live.get(id)?.calls.delete(callId); touch(id); },
  turnEnded: (id: string) => { const l = live.get(id); if (l) { l.calls.clear(); l.thinking = ""; } touch(id); },
  forget: (id: string) => forget(id),
};
// The words of an agent's line from what its turn is doing now.
export function seenWords(id: string, more: { waits?: string; cwd?: string } = {}) {
  const l = live.get(id);
  return nowWords({ thinking: l?.thinking, calls: l ? [...l.calls.values()] : [], ...more });
}

// The oldest call an agent's turn runs now, and since when (an agent's lane: src/automation/lane.ts).
export function callOf(id: string): { name: string; input: unknown; at: number } | undefined {
  const l = live.get(id);
  if (!l?.calls.size) return undefined;
  return [...l.calls.values()].reduce((a, b) => (b.at < a.at ? b : a));
}

// The line as it stands now. Two reads of the ledger (usedOf), on its index.
function make(sessionId: string, now = Date.now()): NowLine | undefined {
  const a = agents.byChild(sessionId);
  if (!a || agents.isEnded(a)) return undefined;
  const l = live.get(sessionId);
  const s = D().store.session(sessionId);
  const used = agents.usedOf(a, now);
  const waits = a.status === "waiting" ? agents.waitsOn(a) || "a wait" : undefined;
  const words = seenWords(sessionId, { waits, cwd: s?.workspace });
  return { agent_id: a.id, session_id: sessionId, parent_id: a.parent_id, ...words, steps: used.steps, since: a.task_at ?? a.created, usd: used.usd, ...(used.unpriced ? { unpriced: used.unpriced } : {}), ...(l?.need ? { need: true } : {}), at: now };
}

// The lines that are due go out, one frame for each tree.
export function flush(now = Date.now()) {
  if (!dirty.size) return;
  const t0 = performance.now();
  const out = new Map<string, NowLine[]>();
  for (const [id, due] of dirty) {
    if (due > now) continue;
    dirty.delete(id);
    try {
      const line = make(id, now);
      nowStats.made++;
      if (!line) { forget(id); continue; }
      const print = nowPrint(line);
      if (told.get(id)?.print === print) continue;
      told.set(id, { at: now, print, need: line.need });
      lines.set(id, line);
      const root = agents.rootSession(id);
      (out.get(root) ?? out.set(root, []).get(root)!).push(line);
    } catch (e) {
      capture(e, { at: "agent now line", session: id });
    }
  }
  nowStats.ms += performance.now() - t0;
  for (const [root, list] of out) {
    const f: Frame = { t: "feature", name: "agents_now", session_id: root, data: { root, lines: list } };
    nowStats.frames++;
    nowStats.bytes += JSON.stringify(f).length;
    D().bus.emit(f);
  }
}

const forget = (id: string) => { live.delete(id); told.delete(id); lines.delete(id); dirty.delete(id); };

// One live agent's line as it stands now, not as last told (a told line can be NOW_MS old): for a
// read that asks once, as an agent's lane does.
export const freshLineOf = (sessionId: string, now = Date.now()): NowLine | null => make(sessionId, now) ?? null;

// One live agent's newest line, made now when it has none yet.
export const lineOf = (sessionId: string, now = Date.now()): NowLine | null => lines.get(sessionId) ?? make(sessionId, now) ?? null;

// The newest line of each live agent of a tree, made now where it has none yet (the page's first
// read, the parent's status read): what the frames would have told.
export function linesOf(rootOrParent: string, now = Date.now()): NowLine[] {
  const out: NowLine[] = [];
  for (const { agent: row } of agents.tree(rootOrParent)) {
    if (agents.isEnded(row)) continue;
    const line = lines.get(row.session_id) ?? make(row.session_id, now);
    if (line) out.push(line);
  }
  return out;
}

// The parent's status read: one line per live agent of its tree, below it.
export function statusText(sessionId: string, now = Date.now()): string {
  const rows = agents.tree(sessionId).filter((r) => !agents.isEnded(r.agent));
  if (!rows.length) return "No agent of yours is at work.";
  const byId = new Map(linesOf(sessionId, now).map((l) => [l.agent_id, l]));
  return rows.map(({ agent: a, depth }) => {
    const l = byId.get(a.id);
    const pad = "  ".repeat(Math.max(0, depth - 1));
    return pad + (l ? statusLine({ ...l, title: a.title, status: a.status }, now) : `${a.title} (${a.id}): ${a.status}`);
  }).join("\n");
}

// A state frame of an agent's session: whether it waits on the owner.
function onFrame(f: Frame) {
  if (f.t !== "feature") return;
  if (f.name === "state" && f.session_id) {
    const st = f.data as { watch?: string } | null;
    if (!st) return forget(f.session_id);
    if (!live.has(f.session_id) && !lines.has(f.session_id)) {
      if (st.watch !== "need" || !D().store.session(f.session_id)?.parent_id) return;
    }
    const need = st.watch === "need";
    const l = of(f.session_id);
    if (l.need !== need) { l.need = need; touch(f.session_id); }
    return;
  }
  // An agent that ends or parks: its line goes, or says what it waits on.
  if (f.name === "automation" && (f.data as any)?.kind === "agent") {
    const a = (f.data as any).data as { session_id?: string; status?: string } | undefined;
    if (!a?.session_id) return;
    if (a.status === "running" || a.status === "waiting") touch(a.session_id);
    else forget(a.session_id);
  }
}

export function init() {
  registerHooks({
    requestSent: (s, req) => { if (isAgent(s) && (req.purpose ?? "turn") === "turn") track.requestSent(s.id); },
    requestDelta: (s, req, d) => { if (isAgent(s) && d.kind === "thinking" && (req.purpose ?? "turn") === "turn" && d.text) track.thinking(s.id, d.text); },
    beforeTool: (s, call) => { if (isAgent(s)) track.callStarted(s.id, call.id, call.tool.name, call.input); return undefined; },
    toolRan: (s, call) => { if (isAgent(s)) track.callEnded(s.id, call.id); },
    stepDone: (s) => { if (isAgent(s)) touch(s.id); },
    turnEnd: (s) => { if (isAgent(s)) track.turnEnded(s.id); },
  });
  const g = globalThis as { __keelNowOff?: () => void };
  g.__keelNowOff?.();
  g.__keelNowOff = D().bus.on(onFrame);
  // On the daemon's one tick, only while a line is owed.
  joinPulse("agent now lines", (now) => flush(now), { every: 1000, due: () => (dirty.size ? Math.min(...dirty.values()) : undefined) });
}
