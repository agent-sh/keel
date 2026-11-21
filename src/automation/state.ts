// A session's state as the daemon tells it (the pages, the session tools, the
// helper, the phone, the command line, the alerts): the one fact of
// src/core/watch.ts, worked out from what the daemon knows now. This file
// gathers that knowledge: what waits on the owner in the session or in an
// agent under it (approvals, questions, plans), and the agents still at work.
// A parent whose own turn ended reads as working while an agent it started
// still runs or waits.
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { stateOf, watchLabel, watchWord, type Ask, type SessionState as State, type Watch, type WatchFacts } from "../core/watch.ts";
import * as perm from "../server/routes/permissions.ts";
import { plansWaiting } from "../server/routes/plan.ts";
import { allPendingQuestions } from "../tools/interact.ts";
import { D } from "./core.ts";

// The fact with its words: `label` as a page shows it, `word` as a tool says it.
export type SessionState = State & { label: string; word: string };
// What the state is read from: the daemon's store and engine (the automation's by default).
export type From = { store: Store; engine: { isRunning(id: string): boolean } };
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

// What is read once for many sessions: everything that waits on the owner, and the agent counts.
export type Lens = { d: From; asks: Map<string, Ask[]>; counts: Map<string, number> };
export function lens(d: From = from(), counts?: Map<string, number>): Lens {
  const asks = new Map<string, Ask[]>();
  const put = (sessionId: string, a: Ask) => void (asks.get(sessionId) ?? asks.set(sessionId, []).get(sessionId)!).push(a);
  for (const a of perm.gate?.approvals({ pending: true }) ?? []) put(a.session_id, { kind: "approval", text: `${a.tool}: ${a.summary}`, since: a.created });
  for (const q of allPendingQuestions()) put(q.session_id, { kind: "question", ...questionOf(d.store, q.session_id, q.call_id) });
  for (const p of plansWaiting()) put(p.session_id, { kind: "plan", text: p.title ?? "", since: p.created });
  return { d, asks, counts: counts ?? agentCounts(d) };
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
  return { asks, agents: l.counts.get(s.id) ?? 0 };
}

// `counts`: agentCounts() when many sessions are told at once; `lens`: lens() the same way.
export function sessionState(s: Session, o: { counts?: Map<string, number>; from?: From; lens?: Lens } = {}): SessionState {
  const l = o.lens ?? lens(o.from ?? from(), o.counts);
  const running = l.d.engine.isRunning(s.id);
  const row = running && s.phase !== "working" ? { ...s, phase: "working" as const } : s;
  const st = stateOf(row, undefined, factsOf(s, l));
  return { ...st, label: watchLabel(st.watch, st.agents), word: watchWord(st.watch, st.agents) };
}

export type { Watch };
