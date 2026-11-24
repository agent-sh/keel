// The words of a lesson (src/automation/lessons.ts): what the drafting model
// is asked and what of its answer holds, the plain draft a cause has before
// (or without) one, and the block an agent's task carries. Pure.
import { homedir } from "node:os";
import { scrubbed } from "../core/conceal.ts";
import type { Decision } from "../admin/experiments.ts";
import { DAYS, decidable, EXAMPLES, foldPaths, noPaths, type Candidate } from "./lessons-mine.ts";

// The drafting model's answer: a note of a sentence or two.
export const DRAFT_OUT = 300;
export const NOTE_CHARS = 600;

export const LESSON_SYSTEM = "You turn a failure that keeps recurring in a software repository into one short note for the coding agents that work in it. Answer only with the note, or with NONE and a reason.";

// What a failure said, as a model may read it: the vault's secrets as their placeholders (the values known
// to `session` too), anything else shaped like a key hidden, and the machine's folders folded. The miner
// folded its examples already; a stored candidate from before is folded here as well.
export const told = (text: string, session: string | null = null, repo: string | null = null) => foldPaths(scrubbed(text, session), repo, homedir());

// The words the drafting model reads: what failed, where, how often, and what it said (told).
export function draftPrompt(c: Candidate, session: string | null = null): string {
  const where = c.source === "tool" ? `A call of the tool ${c.label} failed` : c.source === "review" ? "A reviewer refused or flagged the agents' work" : `An agent's work failed (${c.label})`;
  return [
    `${where} in the repository ${c.repo_name}, the same way in ${c.trees} agent trees (${c.failures} failures in ${c.sessions} sessions over the last ${DAYS} days).`,
    "What it said, as recorded:",
    ...c.examples.slice(0, EXAMPLES).map((e) => `- ${told(e, session, c.repo)}`),
    "",
    "Write one note for the repository's agents, read at their start, that would prevent it: one or two plain sentences that say what to do (and the working form when the examples show it). No preamble, no quotes around it.",
    "If no agent could avoid it by its own choice (a provider outage or limit, a test failing because the work is not done yet, a machine's state), answer only: NONE: and the reason in a few words.",
  ].join("\n");
}
// A note that holds: some words, no longer than a note, and not a refusal.
export function draftHolds(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > NOTE_CHARS) return false;
  if (/^NONE\b/.test(t)) return true;
  return /\p{L}{3}/u.test(t) && !/^(i'?m sorry|i can(no|')t|sorry|as an ai)\b/i.test(t);
}
// The note a cause has before (or without) a model's draft: what failed, to be said in the owner's words.
// It names no path: its words may go to every agent of the repository as they are.
export function plainDraft(c: Candidate): string {
  const eg = c.examples[0] ? `: ${noPaths(told(c.examples[0], null, c.repo))}` : "";
  return c.source === "tool" ? `${c.label} failed the same way in ${c.trees} agent trees of this repository${eg}. Check the form before you call it.`
    : c.source === "review" ? `Reviewers found the same problem in ${c.trees} agent trees of this repository${eg}. Check for it before you report.`
    : `The same failure ended work in ${c.trees} agent trees of this repository${eg}.`;
}

// The proposals shown at once, and so the drafts a mine asks for: the owner reads each with its evidence,
// and the next one moves up when he settles one.
export const SHOWN = 5;
// What a stopped trial makes of its lesson: kept when the arm told it won on its class; dropped when the
// trial shows it hurt (the control won, or a guard found it worse); undecided otherwise, still in use with
// its numbers: no winner at the sample size is no harm found.
export function fateOf(d: Pick<Decision, "winner" | "verdict">): "kept" | "dropped" | "undecided" {
  if (d.winner === "with lesson") return "kept";
  if (d.verdict === "regression" || d.winner) return "dropped";
  return "undecided";
}
// The causes to draft now: the open slots of SHOWN filled from the waiting ones whose trial the repository
// decides within a week, the most trees first.
export function toDraft(waiting: readonly { id: string; evidence: Candidate }[], open: number, cap = SHOWN): string[] {
  const n = Math.max(0, Math.min(cap, SHOWN - open));
  return waiting.filter((w) => decidable(w.evidence)).sort((a, b) => b.evidence.trees - a.evidence.trees || b.evidence.failures - a.evidence.failures).slice(0, n).map((w) => w.id);
}

// The task block an agent starts with: the lessons it is given, in the order they were accepted.
export function lessonBlock(repoName: string, notes: string[]): string {
  if (!notes.length) return "";
  return [`Lessons of this repository (${repoName}), each from a failure that repeated across its agents; the owner accepted them:`, ...notes.map((n) => `- ${n.replace(/\s+/g, " ").trim()}`)].join("\n");
}

// The scripted provider's stand-in for the drafting model (src/providers/scripted.ts): a cause whose
// first example says "no lesson" has none; any other is told back as a note.
export function standInDraft(prompt: string): string {
  const eg = /^- (.*)$/m.exec(prompt)?.[1]?.trim() ?? "";
  if (/no lesson/i.test(eg)) return "NONE: the failure is the machine's, not a choice of the agent";
  return `Before you run a command here, check it cannot fail like this: ${eg}`;
}

// ---- the kind of a reviewer's finding ----
// A reviewer refuses work in its own words, about its own bug, so two findings of one kind rarely share
// their words. A small model puts each in one of the kinds of builder mistake reviews keep finding, or in
// none; findings of one kind are one class (src/automation/lessons-mine.ts).
export const REVIEW_KINDS = [
  "the whole test suite was not run after the last change",
  "a test that passed before fails with the change",
  "a new behaviour has no test that proves it",
  "a case the change must handle is not handled",
  "a UI part is made by hand instead of the shared component",
  "a test id, label or log line carries data it should not",
  "a secret or private data can leak",
  "a rule of the repository's instructions is broken",
] as const;
export const KIND_SYSTEM = "You sort a code reviewer's finding into one kind of builder mistake. Answer only with the number asked for.";
export const KIND_OUT = 8;
export function kindPrompt(text: string, session: string | null = null): string {
  return [
    "A reviewer refused or flagged a builder's work with this finding:",
    `<finding>\n${told(text.slice(0, 1500), session)}\n</finding>`,
    "Which kind of builder mistake is it? Answer with the number of the one kind that fits best, or 0 when none fits:",
    ...REVIEW_KINDS.map((k, i) => `${i + 1}. ${k}`),
  ].join("\n");
}
// The kind an answer names: a kind, null for none, undefined when the answer is not a number of the list.
export function kindOfAnswer(text: string): string | null | undefined {
  const m = /^\s*(\d{1,2})\b/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n === 0) return null;
  return REVIEW_KINDS[n - 1];
}
// The scripted provider's stand-in: a finding that names the suite is that kind; any other none.
export const standInKind = (prompt: string): string => (/<finding>[\s\S]*\bsuite\b[\s\S]*<\/finding>/i.test(prompt) ? "1" : "0");
