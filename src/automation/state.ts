// A session's state as the daemon tells it (the pages, the session tools, the
// helper, the phone, the command line, the alerts): the one fact of
// src/core/watch.ts, worked out from what the daemon knows now. This file
// gathers that knowledge: what waits on the owner in the session or in an
// agent under it (approvals, questions, plans), the agents still at work, and
// what the session waits on (its waits, the commands it left running, its
// agents that wait). A parent whose own turn ended reads as working while an
// agent it started still runs, and as waiting while all that is left waits.
import type { Store } from "../core/store.ts";
import type { Session, TurnStatus } from "../core/types.ts";
import { failWord, oneLine, stateOf, watchLabel, watchWord, type Ask, type Pending, type SessionState as State, type Watch, type WatchFacts } from "../core/watch.ts";
import * as perm from "../server/routes/permissions.ts";
import { plansWaiting } from "../server/routes/plan.ts";
import { allPendingQuestions } from "../tools/interact.ts";
import { liveJobs, running } from "../tools/jobs.ts";
import { errorClass } from "../admin/classes.ts";
import { toolLine } from "../../ui/src/lib/tools.ts";
import { D } from "./core.ts";

// The fact with its words: `label` as a page shows it, `word` as a tool says it.
export type SessionState = State & { label: string; word: string };
// What the state is read from: the daemon's store and engine (the automation's by default).
export type From = { store: Store; engine: { isRunning(id: string): boolean; statusOf?(id: string): TurnStatus; turnOf?(id: string): string | undefined; outputOf?(id: string): number | undefined } };
const from = (): From => D();

// A table another module makes (agents, waits): absent in a store that module never opened.
const tables = new WeakMap<Store, Set<string>>();
function hasTable(store: Store, name: string): boolean {
  const seen = tables.get(store) ?? tables.set(store, new Set()).get(store)!;
  if (seen.has(name)) return true;
  const has = !!store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (has) seen.add(name);
  return has;
}

// Live agents per parent session, in one read.
export function agentCounts(d: Pick<From, "store"> = from()): Map<string, number> {
  if (!hasTable(d.store, "agents")) return new Map();
  const rows = d.store.db.query<{ parent_id: string; n: number }, []>("SELECT parent_id, COUNT(*) AS n FROM agents WHERE status IN ('running', 'waiting') GROUP BY parent_id").all();
  return new Map(rows.map((r) => [r.parent_id, r.n]));
}

export const liveAgents = (sessionId: string, d: Pick<From, "store"> = from()) =>
  hasTable(d.store, "agents") ? d.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM agents WHERE parent_id = ? AND status IN ('running', 'waiting')").get(sessionId)!.n : 0;

// The words of a question, read once from the call that asked it.
const asked = new Map<string, { text: string; since: number }>();
function questionOf(store: Store, sessionId: string, callId: string): { text: string; since?: number } {
  const key = `${sessionId}:${callId}`;
  const hit = asked.get(key);
  if (hit) return hit;
  const e = store.db.query<{ data: string; ts: number }, [string, string]>("SELECT data, ts FROM events WHERE session_id = ? AND kind = 'assistant' AND instr(data, ?) > 0 ORDER BY seq DESC LIMIT 1").get(sessionId, JSON.stringify(callId));
  if (!e) return { text: "" };
  let text = "";
  try {
    const use = (JSON.parse(e.data).blocks ?? []).find((b: any) => b.type === "tool_use" && b.id === callId);
    const q = (use?.input?.questions ?? [])[0];
    text = String(q?.question ?? use?.input?.question ?? use?.input?.prompt ?? "");
  } catch {}
  const out = { text, since: e.ts };
  if (asked.size > 500) asked.clear();
  asked.set(key, out);
  return out;
}

// The failure a session's last turn ended in: its class and its first line,
// read once per failure from the error the turn recorded.
const failures = new Map<string, { cls?: string; text?: string; at: number }>();
function failureOf(store: Store, s: Session): { cls?: string; text?: string; at?: number } | undefined {
  const at = s.settings.failed_ms;
  if (!at) return undefined;
  const key = `${s.id}:${at}`;
  const hit = failures.get(key);
  if (hit) return hit;
  const e = store.db.query<{ data: string }, [string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'error' ORDER BY seq DESC LIMIT 1").get(s.id);
  let message = "";
  try { message = String(JSON.parse(e?.data ?? "{}").message ?? ""); } catch {}
  const cls = message ? errorClass({ message }) ?? undefined : undefined;
  const out = { ...(cls && cls !== "other" ? { cls } : {}), ...(message ? { text: message.split("\n")[0]! } : {}), at };
  if (failures.size > 2000) failures.clear();
  failures.set(key, out);
  return out;
}

// What is read once for many sessions: everything that waits on the owner,
// everything a session waits on, and the live agents of each parent.
type Kid = { session_id: string; title: string; status: string };
export type Lens = { d: From; asks: Map<string, Ask[]>; counts: Map<string, number>; pending: Map<string, Pending[]>; kids: Map<string, Kid[]> };
const push = <T>(m: Map<string, T[]>, k: string, v: T) => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);
export function lens(d: From = from(), counts?: Map<string, number>): Lens {
  const asks = new Map<string, Ask[]>();
  for (const a of perm.gate?.approvals({ pending: true }) ?? []) push(asks, a.session_id, { kind: "approval", text: `${a.tool}: ${a.summary}`, since: a.created });
  for (const q of allPendingQuestions()) push(asks, q.session_id, { kind: "question", ...questionOf(d.store, q.session_id, q.call_id) });
  for (const p of plansWaiting()) push(asks, p.session_id, { kind: "plan", text: p.title ?? "", since: p.created });
  // What will start a session's next turn: its active waits (a timer is due at its wake time) and the commands it left running.
  const pending = new Map<string, Pending[]>();
  if (hasTable(d.store, "waits")) {
    for (const w of d.store.db.query<{ session_id: string; kind: string; spec: string; note: string; created: number }, []>("SELECT session_id, kind, spec, note, created FROM waits WHERE status = 'active' ORDER BY created").all()) {
      let until: number | undefined;
      if (w.kind === "timer") try { until = Number(JSON.parse(w.spec).at_ms) || undefined; } catch {}
      push(pending, w.session_id, { kind: w.kind, text: w.note, since: w.created, ...(until ? { until } : {}) });
    }
  }
  for (const j of liveJobs()) if (j.background && running(j)) push(pending, j.sessionId, { kind: "command", text: j.description || j.command, since: j.started });
  const kids = new Map<string, Kid[]>();
  if (hasTable(d.store, "agents")) {
    for (const a of d.store.db.query<Kid & { parent_id: string }, []>("SELECT parent_id, session_id, title, status FROM agents WHERE status IN ('running', 'waiting') ORDER BY created").all()) push(kids, a.parent_id, a);
  }
  return { d, asks, pending, kids, counts: counts ?? new Map([...kids].map(([k, v]) => [k, v.length])) };
}

// The tool step a turn is on, in the words the transcript uses for the call:
// the command, the file, the pattern. With several calls in one step, the first and a count.
function stepOf(store: Store, s: Session, names: string[]): string | undefined {
  const e = store.db.query<{ data: string }, [string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'assistant' ORDER BY seq DESC LIMIT 1").get(s.id);
  if (!e) return undefined;
  try {
    const uses = ((JSON.parse(e.data).blocks ?? []) as any[]).filter((b) => b.type === "tool_use" && names.includes(b.name));
    if (!uses.length) return undefined;
    const first = oneLine(toolLine(uses[0].name, uses[0].input ?? {}, s.workspace), 160);
    return uses.length > 1 ? `${first}, and ${uses.length - 1} more` : first;
  } catch { return undefined; }
}

// What the daemon knows of one session.
export function factsOf(s: Session, l: Lens): WatchFacts {
  const asks: Ask[] = [...(l.asks.get(s.id) ?? [])];
  // An agent's card is its parent's to answer too: named with the agent it waits in.
  if (l.asks.size > (asks.length ? 1 : 0)) {
    for (const id of l.d.store.descendants(s.id)) {
      const theirs = l.asks.get(id);
      if (!theirs) continue;
      const agent = l.d.store.session(id)?.title;
      for (const a of theirs) asks.push({ ...a, child: id, agent });
    }
  }
  // Its own waits and commands, then what each of its waiting agents waits on.
  const pending: Pending[] = [...(l.pending.get(s.id) ?? [])];
  const parked = (l.kids.get(s.id) ?? []).filter((k) => k.status === "waiting");
  for (const k of parked) {
    const theirs = l.pending.get(k.session_id);
    if (theirs?.length) for (const p of theirs) pending.push({ ...p, agent: k.title });
    else pending.push({ kind: "wake", agent: k.title });
  }
  // A running turn: what it waits on now, when it started, whether its reply is streaming.
  const e = l.d.engine;
  const turn = e.isRunning(s.id) ? e.turnOf?.(s.id) : undefined;
  const status = turn ? e.statusOf?.(s.id) : undefined;
  const live = turn ? { status, turn: l.d.store.event(turn)?.ts, output: e.outputOf?.(s.id), ...(status?.kind === "tool" ? { step: stepOf(l.d.store, s, status.names) } : {}) } : {};
  return { asks, agents: l.counts.get(s.id) ?? 0, parked: parked.length, pending, ...live, failure: failureOf(l.d.store, s) };
}

// The state in a tool's words. What a session waits on is named by its kind
// only: a wait's note or a command line may hold what another session's
// model should not read.
const WAITS: Record<string, string> = { timer: "a timer", command: "a background command", agent: "an agent that waits" };
export function stateWord(st: State): string {
  if (st.watch === "wait") return `waiting on ${WAITS[st.why ?? ""] ?? "a condition it set"}`;
  if (st.watch === "fail" && failWord(st.cls)) return `failed (${failWord(st.cls)})`;
  return watchWord(st.watch, st.agents);
}

// `counts`: agentCounts() when many sessions are told at once; `lens`: lens() the same way.
export function sessionState(s: Session, o: { counts?: Map<string, number>; from?: From; lens?: Lens } = {}): SessionState {
  const l = o.lens ?? lens(o.from ?? from(), o.counts);
  const running = l.d.engine.isRunning(s.id);
  const row = running && s.phase !== "working" ? { ...s, phase: "working" as const } : s;
  const st = stateOf(row, undefined, factsOf(s, l));
  return { ...st, label: watchLabel(st.watch, st.agents), word: stateWord(st) };
}

export type { Watch };
