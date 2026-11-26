// Your asks: what the owner asked for in a top-level session, each with its state from facts. Pure: the
// read thread runs `linkAsks` (src/board/asks-read.ts), the page runs `askState` against the work board's
// rows (src/board/board.ts), so the state moves when the board does. Imports nothing of the daemon.
//
// An ask is one message of the owner's own words in the session: a prompt he typed, steered, queued,
// spoke or sent from the command line (src/core/owner.ts), or the words he typed on a question card.
// No model splits or restates it: the agents it started already split the work, and the list shows his
// words as he wrote them. An ask is tied to an agent by facts only:
// - turn: the agent was started in the turn his message started or steered, after the message (every message of
//   his from the turn's start to the agent's start: the prompt, a steer, a typed card answer), by the store's times;
// - task, only for an agent no turn ties: its task names the message's id, or quotes a run of QUOTE words of it,
//   verbatim, that no other ask holds and that the tasks of only one turn hold.
// The agents under a tied agent are its work too. Its state is read from the board's rows: working while
// an agent of it works, in review while a branch of it has a review at work or refused, to land while a
// branch is done and not on the base, on main once the base holds every branch, running once what runs
// holds them (the board's live: the after-land step's commit or this daemon's own build).
import type { BoardRow } from "./rules.ts";
import { STATE_WORD } from "../core/state-words.ts";

export const QUOTE = 8;          // words of an ask in a row that tie a task to it
export const SHORT = 4;          // an ask of fewer words is shown only when work is tied to it
export const ASKS_MAX = 200;     // the newest asks a list holds
export const WORDS_MAX = 2_000;  // characters of an ask's words sent to the page

export type AskHow = "prompt" | "steer" | "queued" | "voice" | "cli" | "answer";
// What the read thread gives: the owner's inputs and turn ends of the session's line, oldest first, and the
// agents of its tree with their tasks' words.
export type AskInput = { id: string; seq: number; ts: number; how: AskHow; text: string };
export type AskAgent = { id: string; parent_id: string; session_id: string; created: number; task: string };
export type AskFacts = { root: string; inputs: AskInput[]; ends: number[]; agents: AskAgent[] };

export type AskLink = { agent: string; by: "turn" | "task" | "under" };
// `ended`: a turn ended after it (the session answered it, in words or work).
export type Ask = { id: string; seq: number; at: number; how: AskHow; text: string; more: boolean; ended: boolean; links: AskLink[] };

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const grams = (w: string[], n: number) => { const out = new Set<string>(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" ")); return out; };

export function linkAsks(f: AskFacts): Ask[] {
  const inputs = [...f.inputs].sort((a, b) => a.seq - b.seq);
  const ends = [...f.ends].sort((a, b) => a - b);
  const links = new Map<string, AskLink[]>(inputs.map((i) => [i.id, []]));
  const tie = (ask: string, agent: string, by: AskLink["by"]) => {
    const l = links.get(ask)!;
    if (!l.some((x) => x.agent === agent)) l.push({ agent, by });
  };
  // The last turn end before a time (-1: none), and the first input after one: by halving, both lists sorted.
  const endBefore = (t: number) => { let lo = 0, hi = ends.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ends[m]! < t) lo = m + 1; else hi = m; } return lo - 1; };
  const inputAfter = (t: number) => { let lo = 0, hi = inputs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (inputs[m]!.ts <= t) lo = m + 1; else hi = m; } return lo; };
  // The turn: every input of the owner's from the turn's start to the agent's start (the prompt, and the steers
  // and typed card answers after it), with no turn end between the first of them and the agent.
  const turnOf = new Map<string, number>(); // agent -> the turn it started in (the count of turn ends before it)
  const turned = new Set<string>();
  for (const a of f.agents) {
    const e = endBefore(a.created);
    turnOf.set(a.id, e + 1);
    if (a.parent_id !== f.root) continue;
    for (let i = inputAfter(e < 0 ? -Infinity : ends[e]!); i < inputs.length && inputs[i]!.ts <= a.created; i++) {
      tie(inputs[i]!.id, a.id, "turn");
      turned.add(a.id);
    }
  }
  // The task, for an agent no turn ties: it names the ask's id, or quotes a run of QUOTE words (fewer for a shorter
  // ask) that one ask alone holds and that the tasks of only one turn hold (a coordinator copies standing phrases
  // into every brief: those tie nothing).
  const ids = new Set(inputs.map((i) => i.id));
  const gram = new Map<string, string | null>(); // run -> the one ask holding it (null: several)
  const sizes = new Set<number>();
  for (const i of inputs) {
    const w = words(i.text);
    if (w.length < SHORT) continue;
    const n = Math.min(QUOTE, w.length);
    sizes.add(n);
    for (const x of grams(w, n)) gram.set(x, gram.has(x) && gram.get(x) !== i.id ? null : i.id);
  }
  const hits = new Map<string, { ask: string; turns: Set<number>; agents: string[] }>();
  for (const a of f.agents) {
    for (const t of a.task.match(/[\w-]+/g) ?? []) if (ids.has(t) && !turned.has(a.id)) tie(t, a.id, "task");
    if (!gram.size) continue;
    const w = words(a.task);
    for (const n of sizes) for (let i = 0; i + n <= w.length; i++) {
      const x = w.slice(i, i + n).join(" ");
      const ask = gram.get(x);
      if (!ask) continue;
      let h = hits.get(x);
      if (!h) hits.set(x, (h = { ask, turns: new Set(), agents: [] }));
      h.turns.add(turnOf.get(a.id)!);
      if (!turned.has(a.id) && h.agents.at(-1) !== a.id) h.agents.push(a.id);
    }
  }
  for (const h of hits.values()) if (h.turns.size === 1) for (const a of h.agents) tie(h.ask, a, "task");
  // The agents under a tied one.
  const kids = new Map<string, AskAgent[]>();
  for (const a of f.agents) { const k = kids.get(a.parent_id); if (k) k.push(a); else kids.set(a.parent_id, [a]); }
  const byId = new Map(f.agents.map((a) => [a.id, a]));
  for (const [ask, l] of links) {
    if (!l.length) continue;
    const walk = (sid: string, depth: number) => {
      if (depth > 12) return;
      for (const k of kids.get(sid) ?? []) { tie(ask, k.id, "under"); walk(k.session_id, depth + 1); }
    };
    for (const x of [...l]) { const a = byId.get(x.agent); if (a) walk(a.session_id, 0); }
  }
  const last = ends.at(-1) ?? -Infinity;
  const asks = inputs.map((i): Ask => ({
    id: i.id, seq: i.seq, at: i.ts, how: i.how,
    text: i.text.length > WORDS_MAX ? i.text.slice(0, WORDS_MAX) : i.text, more: i.text.length > WORDS_MAX,
    ended: last >= i.ts, links: links.get(i.id)!,
  }));
  return asks.filter((a) => a.links.length || words(a.text).length >= SHORT).reverse().slice(0, ASKS_MAX);
}

// ---- state, against the board's rows

// Least advanced first: an ask is as far as the least advanced of its work.
export const ASK_STATES = ["asked", "working", "in review", "to land", "stopped", "on main", "running", "reported", "replied", "unknown"] as const;
export type AskState = (typeof ASK_STATES)[number];
export const ASK_WORDS: Record<AskState, string> = {
  asked: "Asked", working: STATE_WORD.work, "in review": "In review", "to land": "To land", stopped: STATE_WORD.stop,
  "on main": "On main", running: "Running", reported: "Reported", replied: "Replied", unknown: "Not known",
};
// What each state is read from, said where the owner asks (a tooltip).
export const ASK_WHY: Record<AskState, string> = {
  asked: "the session has not answered it yet",
  working: "an agent of it is at work",
  "in review": "a branch of it has a review at work, or a refusal on its head",
  "to land": "a branch of it is done and the base does not hold it",
  stopped: "its agent ended without finishing",
  "on main": "the base holds its branches; what runs does not yet",
  running: "what runs holds its branches",
  reported: "its agents ended with no branch of their own: their reports are the answer",
  replied: "the session answered it with no agent",
  unknown: "its agents are not on the work board",
};

export type AgentLine = { id: string; session_id: string; title: string; state: AskState; branch: string | null };
const live = (s: string) => s === "running" || s === "waiting";

export function agentAskState(r: BoardRow): AskState {
  if (live(r.state)) return "working";
  if (r.branch && r.landed?.state === "yes") return r.live?.state === "yes" ? "running" : "on main";
  if (r.branch && r.landed?.state === "no") {
    const v = r.review;
    if (v && v.current !== false && (live(v.state) || v.verdict === "refused" || v.verdict === "disputed")) return "in review";
    return r.state === "completed" ? "to land" : "stopped";
  }
  return r.state === "completed" ? "reported" : "stopped";
}

// `unknown`: the tied agents the board has no row of (gone from it, or not on it yet): said with their count,
// never read as no agent. An ask whose every agent is unknown is "unknown".
export function askState(a: Pick<Ask, "links" | "ended">, rows: readonly BoardRow[]): { state: AskState; agents: AgentLine[]; unknown: number } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const line = (r: BoardRow): AgentLine => ({ id: r.id, session_id: r.session_id, title: r.title, state: agentAskState(r), branch: r.branch });
  const tied = a.links.map((l) => byId.get(l.agent)).filter((r): r is BoardRow => !!r);
  const unknown = a.links.length - tied.length;
  if (!tied.length && unknown) return { state: "unknown", agents: [], unknown };
  // A reviewer's work is its branch's review, said on that branch; an ask that started only reviewers is as far as they are.
  const workers = tied.filter((r) => !r.reviews.length);
  const agents = (workers.length ? workers : tied.map((r) => ({ ...r, branch: null }))).map(line);
  if (!agents.length) return { state: a.ended ? "replied" : "asked", agents, unknown };
  // Branches decide where there are some; an agent with no branch counts only while it works.
  const branched = agents.filter((x) => x.branch && x.state !== "reported");
  const counted = branched.length ? [...branched, ...agents.filter((x) => !x.branch && x.state === "working")] : agents;
  const rank = (s: AskState) => ASK_STATES.indexOf(s);
  const state = counted.reduce<AskState>((m, x) => (rank(x.state) < rank(m) ? x.state : m), counted[0]!.state);
  // (An agent the board does not show could be behind any state but working, the least advanced one there is.)
  return { state: unknown && state !== "working" ? "unknown" : state, agents, unknown };
}
