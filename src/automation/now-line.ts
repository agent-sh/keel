// What an agent is doing now, in one line, made with no model request: the
// newest sentence of the thinking of its current step, else the call it is
// running as the transcript says it (src/core/tool-line.ts), else what it waits
// on. With it go its steps, when its task began, its spend and whether it
// needs the owner. A line is told at most once every NOW_MS per agent, as
// Claude Code's agent view updates a row "at most once every 15 seconds from
// the session's own recent output". The decisions here are pure;
// src/automation/now.ts keeps what they read.
import { toolLine } from "../core/tool-line.ts";

export const NOW_MS = 15_000;
const MAX = 160; // characters of a line: a row's width at the widest

export type NowLine = {
  agent_id: string;
  session_id: string;
  parent_id: string;
  text: string;
  from: "thinking" | "tool" | "wait" | "none";
  steps: number;
  since: number; // when its current task began: the page counts the time from it
  usd: number;
  unpriced?: number; // calls of its task with no listed price (a plan, a local model): its spend leaves them out
  need?: boolean; // it waits on the owner (an approval, a question, a plan)
  at: number; // when the line was made
};

const tidy = (s: string) => s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
const cut = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1).trimEnd()}…` : s);

// The newest whole sentence of a piece of thinking; the start of the unfinished one when it has
// none whole yet. A sentence ends at . ! ? or a line break.
export function newestSentence(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map(tidy).filter((p) => p.length > 1);
  if (!parts.length) return "";
  const done = parts.filter((p) => /[.!?:]$/.test(p));
  const last = parts.at(-1)!;
  // The unfinished tail is newer, but a few words of it say less than the sentence before.
  const pick = /[.!?:]$/.test(last) || !done.length || last.length >= 40 ? last : done.at(-1)!;
  return cut(pick);
}

export type Seen = {
  thinking?: string; // the thinking of the current step so far
  calls?: { name: string; input: unknown }[]; // the calls running now, oldest first
  waits?: string; // what it waits on, in words, when it waits
  cwd?: string;
};

// The words of the line, and where they came from.
export function nowWords(s: Seen): { text: string; from: NowLine["from"] } {
  const t = s.thinking ? newestSentence(s.thinking) : "";
  if (t) return { text: t, from: "thinking" };
  const call = s.calls?.at(-1);
  if (call) return { text: cut(tidy(toolLine(call.name, (call.input ?? {}) as any, s.cwd))), from: "tool" };
  if (s.waits) return { text: cut(`Waiting for ${s.waits}`), from: "wait" };
  return { text: "", from: "none" };
}

// What a change of the line is told by: its words, its steps, its spend to the cent and the owner's
// part. Its clock is not in it (the page counts the time from `since`).
export const nowPrint = (l: Pick<NowLine, "text" | "steps" | "usd" | "need" | "since">) => `${l.text}\u0000${l.steps}\u0000${Math.round(l.usd * 100)}\u0000${l.need ? 1 : 0}\u0000${l.since}`;

// When a changed line may be told: at once the first time and when the owner's part changed
// (a card waits on them), else NOW_MS after the last telling.
export function dueAt(told: { at: number; need?: boolean } | undefined, need: boolean | undefined, now: number): number {
  if (!told || !!told.need !== !!need) return now;
  return Math.max(now, told.at + NOW_MS);
}

// One line of the parent's status read: "Counter (a1b2c3): Running bun test · 12 steps, 4 min, $0.31".
export function statusLine(l: NowLine & { title: string; status: string }, now: number): string {
  const s = Math.max(0, Math.round((now - l.since) / 1000));
  const ran = s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  const usd = l.usd >= 0.01 ? `, $${l.usd.toFixed(2)}${l.unpriced ? " and unpriced calls" : ""}` : l.unpriced ? ", no price listed" : "";
  const what = l.need ? "needs the owner" : l.text || (l.status === "waiting" ? "waiting" : "working");
  return `${l.title} (${l.agent_id}): ${what} · ${l.steps} step${l.steps === 1 ? "" : "s"}, ${ran}${usd}`;
}
