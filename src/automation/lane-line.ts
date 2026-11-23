// An agent's lane in five lines: what it is doing now, what it waits for and
// since when, what went wrong in its scope, what it changed, and what comes
// next. Every line is made from facts Keel keeps (its record, its session's
// served state, the "now" line of its turn, its failures, its worktree, the
// check ledger, its hours), with no model request. The one line in the
// agent's own words is "next": its plan, or the last sentence of its own that
// states one, quoted and marked as its words. A fact that is not there is
// said to be missing, never guessed.
//
// Pure: src/automation/lane.ts reads the facts, the page and the phone show
// the lines.
import { localDay, localTime } from "../core/clock.ts";
import { dur } from "../admin/timeline-rows.ts";
import { HOUR_WORDS, type HourClass } from "../admin/hours-rows.ts";
import type { Said } from "../core/state-words.ts";
import { ASK_LEAD } from "../core/watch.ts";

export type LaneKey = "doing" | "waits" | "wrong" | "changed" | "next";
// fact: made from what Keel keeps; own: the agent's own words, quoted; missing: the fact is not there.
export type LaneFrom = "fact" | "own" | "missing";
export type LaneTone = "need" | "fail" | "wait";
export type LaneLine = { key: LaneKey; text: string; from: LaneFrom; tone?: LaneTone; at?: number };
// As served: each line with its label. `ms`: what making it took in the daemon.
export type Lane = { agent_id: string; session_id: string; at: number; ms: number; lines: (LaneLine & { label: string })[] };

export const LANE_KEYS: readonly LaneKey[] = ["doing", "waits", "wrong", "changed", "next"];
export const LANE_LABEL: Record<LaneKey, string> = { doing: "Doing", waits: "Waits for", wrong: "Went wrong", changed: "Changed", next: "Next" };

export type CheckFact = { name: string; result: string; pass: number | null; fail: number | null; ended: number };
export type GitFact =
  // `files`: every file it carries over its base; `dirty`: of them, the ones not committed.
  | { branch: string | null; head: string; subject: string; commits: number; files: number; dirty?: number; added: number; removed: number; names: string[] }
  | { why: string }
  // A worktree on another machine: its tools run there, so its folder is not read here.
  | { remote: string; branch: string | null }
  // Its row says removed, or the folder is gone: its branch and where that branch points, when it is kept.
  | { gone: true; branch: string | null; head: string | null };
export type LaneFacts = {
  now: number;
  live: boolean;
  said: Said; // the agent's state in the vocabulary (src/core/state-words.ts)
  state?: { watch: string; why?: string; text?: string; since?: number; until?: number } | null; // its session's served state
  doing?: { text: string; from: string; steps: number; since: number } | null; // its "now" line (src/automation/now.ts)
  ended?: { at: number; steps: number; why?: string } | null;
  lost?: number; // the contexts its current task lost, each taken up by a successor
  call?: { line: string; shell: boolean; since: number } | null; // the oldest call its turn runs now
  waitsOn?: string; // what its waits are, in words (src/automation/agents.ts waitsOn)
  slot?: boolean; // in line for a slot of its parent
  // `below`: the agent below it whose failure this is (none: its own).
  failure?: { kind: string; cls: string; text: string; at: number; count: number; below?: string } | null;
  hours?: { wall_ms: number; classes: Partial<Record<HourClass, number>> } | null;
  worktree?: boolean;
  git?: GitFact | null;
  wrote?: { names: string[]; n: number } | null; // files its own calls wrote (no worktree of its own)
  checks?: { tree: CheckFact[]; earlier: CheckFact[] } | null; // runs on its tree as it is now, and on earlier ones
  plan?: { text: string; status: string }[] | null;
  words?: string | null; // its newest text of its own (not thinking)
};

const MAX = 240;
const cut = (s: string, n = MAX) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const tidy = (s: string) => s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
// A time as the owner reads it: HH:MM today, else with its day.
export const clock = (ts: number, now: number) => (localDay(ts) === localDay(now) ? localTime(ts).slice(0, 5) : `${localDay(ts)} ${localTime(ts).slice(0, 5)}`);
// "since 14:02 (4 min)": a time with how long ago.
export const sinceWords = (ts: number, now: number) => `since ${clock(ts, now)} (${dur(Math.max(0, now - ts)) || "0 s"})`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (s: string) => `\u201c${s}\u201d`;

// Where its time went, from its hours: the two largest classes. "Of 34 min: model requests 20 min, commands and tools 10 min".
export function hoursTail(h: LaneFacts["hours"]): string {
  if (!h || !h.wall_ms) return "";
  const top = (Object.entries(h.classes) as [HourClass, number][]).filter(([c, ms]) => c !== "unknown" && ms >= 1000).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (!top.length) return "";
  return `Of ${dur(h.wall_ms)}: ${top.map(([c, ms]) => `${HOUR_WORDS[c]} ${dur(ms)}`).join(", ")}`;
}

function doing(f: LaneFacts): LaneLine {
  const l = doingOf(f);
  // A successor: the work goes on in a fresh context, and the reader is told so.
  if (!f.lost) return l;
  return { ...l, text: cut(`${l.text}. It continues after a lost context (${f.lost})`) };
}
function doingOf(f: LaneFacts): LaneLine {
  // Its hours once it ended: a live agent's running step has no record yet, so its split would be a guess.
  const tail = f.live ? "" : hoursTail(f.hours);
  if (!f.live) {
    const e = f.ended;
    const head = e ? `${f.said.phrase} at ${clock(e.at, f.now)} after ${plural(e.steps, "step")}` : f.said.phrase;
    return { key: "doing", text: cut([head + (e?.why ? `. ${e.why}` : ""), tail].filter(Boolean).join(". ")), from: "fact", ...(e ? { at: e.at } : {}) };
  }
  const d = f.doing;
  // Its turn ended on something it waits for: the next line says what.
  if (d?.from === "wait" || (!d?.text && f.waitsOn)) return { key: "doing", text: `No step runs: its turn ended, and it goes on when what it waits for comes${d ? `. ${plural(d.steps, "step")}` : ""}`, from: "fact", ...(d ? { at: d.since } : {}) };
  if (!d?.text) return { key: "doing", text: cut(["No step of its current task seen yet", tail].filter(Boolean).join(". ")), from: "missing" };
  // A sentence of its thinking is its own words: said as such.
  const own = d.from === "thinking";
  return { key: "doing", text: cut([own ? `${quote(d.text)} (its thinking)` : d.text, `${plural(d.steps, "step")}`, tail].filter(Boolean).join(". ")), from: own ? "own" : "fact", at: d.since };
}

// What the owner is asked, with the model's own words marked: a question or a plan is its prose, an
// approval names the call itself.
const ASKED: Record<string, string> = { question: "its question", plan: "its plan" };
export function askWords(why: string | undefined, text: string): string {
  const lead = why ? ASK_LEAD[why as keyof typeof ASK_LEAD] : undefined;
  const mark = why ? ASKED[why] : undefined;
  if (!lead || !mark || !text.startsWith(lead)) return text;
  const m = /^(.*?)(, and \d+ more)?$/s.exec(text.slice(lead.length))!;
  return `${mark.charAt(0).toUpperCase()}${mark.slice(1)}, ${quote(m[1]!)}${m[2] ?? ""}`;
}

const MODEL_WAIT: Record<string, string> = { model: "The model's reply", stalled: "The model's reply, which has gone quiet", compacting: "Its context to be compacted", retry: "The provider, to try again" };
function waits(f: LaneFacts): LaneLine {
  const s = f.state;
  const at = s?.since;
  const since = at ? ` ${sinceWords(at, f.now)}` : "";
  if (!f.live) return { key: "waits", text: "Nothing: it has ended", from: "fact" };
  if (f.slot) return { key: "waits", text: `A free agent slot of its parent${since}`, from: "fact", tone: "wait", ...(at ? { at } : {}) };
  if (s?.watch === "need") {
    const what = s.text ? askWords(s.why, s.text) : f.said.what || "an answer";
    return { key: "waits", text: cut(`You${since}: ${what}`), from: "fact", tone: "need", ...(at ? { at } : {}) };
  }
  if (s?.watch === "wait" || s?.watch === "resume") {
    const what = f.waitsOn || s.text || f.said.what || "a wait it set";
    const due = s.until && s.until > f.now ? `, due ${clock(s.until, f.now)}` : "";
    return { key: "waits", text: cut(`${what.charAt(0).toUpperCase()}${what.slice(1)}${since}${due}`), from: "fact", tone: "wait", ...(at ? { at } : {}) };
  }
  if (f.call) {
    const what = f.call.shell ? "Its command" : "Its call";
    return { key: "waits", text: cut(`${what}, running ${sinceWords(f.call.since, f.now)}: ${f.call.line}`), from: "fact", at: f.call.since };
  }
  if (s?.why && MODEL_WAIT[s.why]) return { key: "waits", text: cut(`${MODEL_WAIT[s.why]}${since}${s.why === "retry" && s.text ? `: ${s.text}` : ""}`), from: "fact", ...(at ? { at } : {}) };
  // Its turn ended on a command it left running: that command's end starts its next turn.
  if (f.waitsOn) return { key: "waits", text: cut(`${f.waitsOn.charAt(0).toUpperCase()}${f.waitsOn.slice(1)}${since}`), from: "fact", tone: "wait", ...(at ? { at } : {}) };
  return { key: "waits", text: "Nothing it is held by: between steps", from: "fact" };
}

const KIND_NOUN: Record<string, string> = { turn: "A turn", provider: "A model request", tool: "A tool call", wait: "A wait", loop: "A loop", land: "A landing" };
// Whose failure it is: its own, or of the agent below it that had it, by name.
export function failedWords(kind: string, below?: string): string {
  const of = below ? ` of agent ${below} (below it)` : "";
  if (kind === "agent") return below ? `Agent ${below} (below it) failed` : "It failed";
  if (kind === "message") return `A message${of} was not delivered`;
  return `${KIND_NOUN[kind] ?? "A failure"}${of} failed`;
}
function wrong(f: LaneFacts): LaneLine {
  const x = f.failure;
  if (x) {
    const head = `${failedWords(x.kind, x.below)} at ${clock(x.at, f.now)}${x.count > 1 ? `, ${x.count} times` : ""}`;
    const text = tidy(x.text.split("\n")[0] ?? "");
    return { key: "wrong", text: cut(`${head}${x.cls && x.cls !== "other" ? ` (${x.cls})` : ""}: ${text || "no words"}`), from: "fact", tone: "fail", at: x.at };
  }
  if (f.said.watch === "fail" || f.said.watch === "declined") return { key: "wrong", text: cut(`${f.said.phrase}${f.ended?.why ? `. ${f.ended.why}` : ""}: no failure of it was recorded`), from: "missing", tone: "fail" };
  return { key: "wrong", text: "Nothing failed in its scope", from: "fact" };
}

const names = (list: string[], n: number) => `${list.slice(0, 3).join(", ")}${n > 3 ? ` and ${n - 3} more` : ""}`;
const RESULT: Record<string, string> = { pass: "passed", fail: "failed", stopped: "stopped", unknown: "ended, result not known", answered: "passed (answered from the ledger)" };
const checkWords = (c: CheckFact) => `${c.name} ${RESULT[c.result] ?? c.result}${c.result === "fail" && c.fail ? ` (${c.fail} failed)` : c.result === "pass" && c.pass ? ` (${c.pass} passed)` : ""}`;
// The newest run of each check, the newest first.
export function newestByName(runs: readonly CheckFact[]): CheckFact[] {
  const by = new Map<string, CheckFact>();
  for (const r of runs) if (!by.has(r.name) || by.get(r.name)!.ended < r.ended) by.set(r.name, r);
  return [...by.values()].sort((a, b) => b.ended - a.ended);
}
export function checksWords(c: LaneFacts["checks"], now: number): string {
  if (!c) return "";
  const on = newestByName(c.tree);
  if (on.length) return `Checks on this tree: ${on.map(checkWords).join(", ")}`;
  const before = newestByName(c.earlier);
  if (before.length) return `No check ran on this tree; on an earlier one: ${before.slice(0, 3).map((r) => `${checkWords(r)} at ${clock(r.ended, now)}`).join(", ")}`;
  return "No check ran on it";
}
function changed(f: LaneFacts): LaneLine {
  const checks = checksWords(f.checks, f.now);
  const g = f.git;
  if (f.worktree) {
    if (!g) return { key: "changed", text: "Its worktree was not read", from: "missing" };
    if ("why" in g) return { key: "changed", text: cut(`Its worktree could not be read: ${g.why}`), from: "missing" };
    if ("remote" in g) return { key: "changed", text: cut(`Its worktree is on ${g.remote}${g.branch ? `, on ${g.branch}` : ""}: not read from here`), from: "missing" };
    if ("gone" in g) {
      const kept = g.branch ? (g.head ? `its branch ${g.branch} at ${g.head}` : `its branch ${g.branch} is gone too`) : "no branch of it is known";
      return { key: "changed", text: cut([`Its worktree was removed (${kept})`, checks].filter(Boolean).join(". "), 360), from: "fact" };
    }
    // (A commit's subject is the model's words: marked as such.)
    const at = `${g.branch ?? "a detached head"} at ${g.head}${g.subject ? ` ${quote(cut(g.subject, 60))} (its commit message)` : ""}`;
    const lines = g.added || g.removed ? ` (+${g.added} \u2212${g.removed})` : "";
    const open = !g.dirty ? "" : g.dirty >= g.files ? ", not committed" : `, ${g.dirty} not committed`;
    const files = g.files ? `${plural(g.files, "file")}${lines} on ${at}${open}: ${names(g.names, g.files)}` : `No file changed on ${at}`;
    const commits = g.commits ? `, ${plural(g.commits, "commit")} over its base` : "";
    return { key: "changed", text: cut([files + commits, checks].filter(Boolean).join(". "), 360), from: "fact" };
  }
  const w = f.wrote;
  const head = !w ? "What it wrote was not read" : w.n ? `${plural(w.n, "file")} written in the shared folder, no worktree of its own: ${names(w.names, w.n)}` : "No file written, no worktree of its own";
  return { key: "changed", text: cut([head, w?.n ? checks : ""].filter(Boolean).join(". "), 360), from: w ? "fact" : "missing" };
}

// A sentence that states what the speaker will do. Its own words, never rewritten.
const PLAN = /\b(next|then|now I|I'll|I will|I'm going to|I am going to|going to|will now|let me|my plan|plan is|after that)\b/i;
export function statedPlan(text: string): string {
  const sentences = text.replace(/```[\s\S]*?```/g, " ").split(/(?<=[.!?])\s+|\n+/).map(tidy).filter((p) => p.length > 8);
  const hit = sentences.filter((p) => PLAN.test(p)).at(-1);
  return hit ? cut(hit, 200) : "";
}
function next(f: LaneFacts): LaneLine {
  const plan = f.plan ?? [];
  const open = plan.filter((p) => p.status !== "completed" && p.status !== "cancelled");
  const done = plan.filter((p) => p.status === "completed").length;
  if (open.length) {
    const item = open.find((p) => p.status === "in_progress") ?? open[0]!;
    const of = `its plan, ${done} of ${plan.length} done`;
    return { key: "next", text: cut(f.live ? `${quote(tidy(item.text))} (${of})` : `Left in ${of}: ${quote(tidy(item.text))}`), from: "own" };
  }
  if (!f.live) return { key: "next", text: f.said.watch === "done" ? "Nothing: its report went to its parent" : "Nothing until a message continues it", from: "fact" };
  const said = f.words ? statedPlan(f.words) : "";
  if (said) return { key: "next", text: `${quote(said)} (its last words)`, from: "own" };
  if (plan.length) return { key: "next", text: `Its plan is done (${done} of ${plan.length}); it has stated nothing after it`, from: "missing" };
  return { key: "next", text: "It has stated no plan", from: "missing" };
}

export function laneLines(f: LaneFacts): LaneLine[] {
  return [doing(f), waits(f), wrong(f), changed(f), next(f)];
}

// The lane as text: one line each, for the phone's notice and a reader with no page.
export const laneText = (lines: readonly LaneLine[]) => lines.map((l) => `${LANE_LABEL[l.key]}: ${l.text}`).join("\n");
