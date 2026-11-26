// The pure part of the daily sweep's recall figures (src/helper/sweep.ts): for a native memory (Claude
// Code's auto memory index, Codex's memory summary) loaded into a session's prompt, which of its facts
// the model then used in its next steps, which mistake a correction note names it made anyway, and
// what the load cost in tokens; one ranked improvement for each memory system; and whether a number
// moved since the last card, the only case the owner's helper is woken for.
//
// "Used" is the memory meter's proxy (`usedBy`): a later answer names the fact or repeats three of its
// words in a row, or a later call holds a path, file, flag or quoted command it names. A mistake is a
// call that a note's own prohibition names (`bansOf`, `callBreaks`): the same rule the meter applies
// to the memory store's rules.
import { bansOf, callBreaks, factLines, factOf, saidOf, usedIn, type Fact } from "../integrations/memory-meter.ts";
import { tacitToolCall, type StoreCall } from "../integrations/tacit-tools.ts";

// The steps after a load that are read for it: the turns that follow carry the block too, but a fact
// first used past this many replies says little about the block (and the read stays bounded).
export const STEPS_MAX = 200;
// The sessions of a day read for each native system: the rest are counted as loaded, not judged.
export const SESSIONS_MAX = 60;

// --- facts of a native memory -----------------------------------------------------------

// A Claude index line "- [Title](file.md): hook" as a fact named by its title and its file's stem; its
// text ends with the file, so a call that opens the note uses it.
export function indexFacts(index: string): Fact[] {
  const out: Fact[] = [];
  for (const line of factLines(index)) {
    const m = /^\s*-\s+\[([^\]]+)\]\(([^)\s]+?)(?:\.md)?\)\s*:?\s*(.*)$/.exec(line);
    if (!m) { out.push(factOf(line)); continue; }
    const file = m[2]!.replace(/^.*\//, "");
    out.push({ names: [m[1]!.trim(), file.replace(/[_-]+/g, " ")], text: `${m[3]!.trim()} (${file}.md)` });
  }
  return out;
}

// A Codex summary's lines as facts: its bullets, each a fact of its own.
export const summaryFacts = (summary: string): Fact[] => factLines(summary).map(factOf);

// The calls a correction note forbids: its prohibitions ("never run `git stash`").
export function bansIn(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const b of bansOf(t)) out.add(b);
  return [...out];
}

// --- what the steps did -------------------------------------------------------------------

export type Step = { text: string; acted: string; calls: StoreCall[] };

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
};

// An assistant event's data as a step: its words, the words of its calls, its calls as the store reads them.
export function stepOf(data: unknown): Step {
  const blocks = Array.isArray((data as { blocks?: unknown })?.blocks) ? (data as { blocks: any[] }).blocks : [];
  const text: string[] = [], acted: string[] = [], calls: StoreCall[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string" && !b.system) text.push(b.text);
    else if (b?.type === "tool_use" && typeof b.name === "string") {
      acted.push(strings(b.input).join("\n"));
      const c = tacitToolCall(b.name, b.input);
      if (c) calls.push(c);
    }
  }
  return { text: text.join("\n"), acted: acted.join("\n"), calls };
}

export type Judged = { given: number; used: boolean[]; broken: string[] };

// One load judged against the steps that followed it: each fact used or not, each ban broken or not.
// `touched`: the memory's files the session's tools read or wrote (the native log's rows), whatever step did it.
export function judge(facts: readonly Fact[], bans: readonly string[], steps: readonly Step[], touched: readonly string[] = []): Judged {
  const take = [...steps.slice(0, STEPS_MAX), { text: "", acted: touched.join("\n"), calls: [] }];
  const text = take.map((s) => s.text).join("\n"), acted = take.map((s) => s.acted).join("\n");
  const said = saidOf(text, acted);
  const used = facts.map((f) => usedIn(f, said));
  const broken = bans.filter((b) => take.some((s) => s.calls.some((c) => callBreaks(b, c))));
  return { given: facts.length, used, broken };
}

// The day of one native system: the facts of each judged session, summed, and each fact's own count.
export type Recall = { sessions: number; judged: number; given: number; used: number; mistakes: number; tokens: number; facts: { name: string; given: number; used: number }[]; broken: { ban: string; sessions: number }[] };

export function recallOf(loads: readonly { facts: readonly Fact[]; judged: Judged | null; tokens: number }[]): Recall {
  const byFact = new Map<string, { name: string; given: number; used: number }>();
  const byBan = new Map<string, number>();
  let judged = 0, given = 0, used = 0, tokens = 0;
  for (const l of loads) {
    tokens += l.tokens;
    if (!l.judged) continue;
    judged++;
    given += l.judged.given;
    l.facts.forEach((f, i) => {
      const name = f.names[0] ?? f.text.slice(0, 60);
      const r = byFact.get(name) ?? { name, given: 0, used: 0 };
      r.given++;
      if (l.judged!.used[i]) { r.used++; used++; }
      byFact.set(name, r);
    });
    for (const b of l.judged.broken) byBan.set(b, (byBan.get(b) ?? 0) + 1);
  }
  const broken = [...byBan].map(([ban, sessions]) => ({ ban, sessions })).sort((a, b) => b.sessions - a.sessions);
  return { sessions: loads.length, judged, given, used, mistakes: broken.reduce((n, b) => n + b.sessions, 0), tokens, facts: [...byFact.values()], broken };
}

// --- the improvement of each system --------------------------------------------------------

export type Next = { text: string; score: number };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The best of what each system could do better, highest score first. A repeated mistake comes before
// facts that cost tokens and were never used, which come before a share that fell. `facts`: each
// fact's given and used counts in the window; `tokens`: what one fact costs on average.
export function nextOf(i: {
  label: string; given: number; used: number; mistakes: number; tokens: number; days?: number;
  facts?: readonly { name: string; given: number; used: number; tokens?: number }[];
  broken?: readonly { ban: string; sessions: number }[];
  extra?: readonly Next[];
}): Next | null {
  const found: Next[] = [...(i.extra ?? [])];
  const top = i.broken?.[0];
  if (top) found.push({ text: `"${top.ban}" ran after a note forbade it in ${plural(top.sessions, "session")}: make it a deny rule so the call is stopped, not just told.`, score: 1000 + top.sessions });
  const per = i.given > 0 ? i.tokens / i.given : 0;
  const idle = (i.facts ?? []).filter((f) => f.used === 0 && f.given >= 2).sort((a, b) => b.given - a.given);
  if (idle.length) {
    const names = idle.slice(0, 2).map((f) => f.name).join(", ");
    const days = i.days ?? 1, spent = Math.round(idle.reduce((n, f) => n + (f.tokens ?? per * f.given), 0));
    found.push({ text: `${plural(idle.length, "fact")} given and never used (${names}${idle.length > 2 ? ", ..." : ""}): narrow or retire ${idle.length === 1 ? "it" : "them"}, about ${spent} tokens in ${days === 1 ? "the day" : `${days} days`}.`, score: 100 + idle.reduce((n, f) => n + f.given, 0) });
  }
  return found.sort((a, b) => b.score - a.score)[0] ?? null;
}

// --- did a number move ----------------------------------------------------------------------

// The four figures each system is read by, the same on every card.
export type Measure = { given: number; used: number; mistakes: number; tokens: number };
// A share moved when both cards judged this many facts and it changed by this much; tokens moved when they
// doubled or halved over this many; a mistake moved when there are more than before.
export const MOVE_GIVEN = 20;
export const MOVE_SHARE = 0.15;
export const MOVE_TOKENS = 2_000;

export function moved(prev: Measure | undefined, cur: Measure, label: string): string | null {
  if (!prev) return null;
  if (cur.mistakes > prev.mistakes) return `${label}: ${plural(cur.mistakes, "repeated mistake")}, up from ${prev.mistakes}`;
  if (cur.given >= MOVE_GIVEN && prev.given >= MOVE_GIVEN) {
    const a = prev.used / prev.given, b = cur.used / cur.given;
    if (Math.abs(b - a) >= MOVE_SHARE) return `${label}: ${Math.round(100 * b)}% of facts used, ${b > a ? "up" : "down"} from ${Math.round(100 * a)}%`;
  }
  const hi = Math.max(prev.tokens, cur.tokens), lo = Math.min(prev.tokens, cur.tokens);
  if (hi >= MOVE_TOKENS && hi >= 2 * lo) return `${label}: recall cost ${cur.tokens} tokens, ${cur.tokens > prev.tokens ? "up" : "down"} from ${prev.tokens}`;
  return null;
}

// The helper's one line: each system's used share and repeated mistakes, the systems with nothing left out.
export function lineOf(systems: readonly { label: string; short: string; measure?: Measure }[]): string {
  const parts = systems.filter((s) => s.measure && (s.measure.given || s.measure.mistakes)).map((s) => {
    const m = s.measure!;
    return `${s.short} ${m.given ? `${Math.round((100 * m.used) / m.given)}% used` : "nothing judged"}${m.mistakes ? `, ${plural(m.mistakes, "repeat")}` : ""}`;
  });
  return parts.length ? parts.join("; ") : "nothing recalled to judge";
}

// --- what followed a supervisor's nudge ---------------------------------------------------

export type Act = { id: number; ts: number; action: string };
// A user event momentum's text became (origin "momentum"), and a turn's end.
export type Delivered = { seq: number; ts: number };
export type TurnEnd = { id: string; seq: number; ts: number; reason: string | null; stopped_by: string | null };
export type Nudges = { ended: number; interrupted: number; failed: number; stops: number; pending: number; turns: string[] };

// The outcome of one session's nudges, each credited to the turn it was delivered into: a queue or a
// steer to the first of momentum's messages stored at or after it that no earlier nudge took, then
// to the end of the turn that read it; an interrupt to the turn end after it that says the supervisor
// stopped it, each stop once. Two nudges read by one turn, or answered by one stop, are one outcome. A nudge with no delivery, or a delivery
// no turn has ended yet, is pending: unobserved, never a success. Observed outcomes, not their cause.
export function nudgeOutcomes(acts: readonly Act[], delivered: readonly Delivered[], ends: readonly TurnEnd[]): Nudges {
  const out: Nudges = { ended: 0, interrupted: 0, failed: 0, stops: 0, pending: 0, turns: [] };
  const taken = new Set<number>(), stopped = new Set<number>(), turns = new Map<string, TurnEnd>();
  const byTs = [...acts].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const msgs = [...delivered].sort((a, b) => a.seq - b.seq), fin = [...ends].sort((a, b) => a.seq - b.seq);
  for (const a of byTs) {
    if (a.action === "interrupt") {
      // Each stop is one outcome: a second interrupt the same stop answered adds nothing.
      const stop = (x: TurnEnd) => x.ts >= a.ts && x.stopped_by === "supervisor";
      const e = fin.find((x) => stop(x) && !stopped.has(x.seq));
      if (e) { stopped.add(e.seq); out.stops++; }
      else if (!fin.some(stop)) out.pending++;
      continue;
    }
    const m = msgs.find((x) => x.ts >= a.ts && !taken.has(x.seq));
    if (!m) { out.pending++; continue; }
    taken.add(m.seq);
    const e = fin.find((x) => x.seq > m.seq);
    if (!e) { out.pending++; continue; }
    turns.set(e.id, e);
  }
  for (const e of turns.values()) {
    out.turns.push(e.id);
    if (e.reason === "interrupted") out.interrupted++;
    else if (e.reason === "error" || e.reason === "failed") out.failed++;
    else out.ended++;
  }
  return out;
}
