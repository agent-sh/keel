// A successor for a lost agent: an agent whose task ended without its own end
// (the model declined, its context could not be made to fit, or its provider
// failed past the retries) is taken up by a fresh
// context of the same agent: the same id, place in the tree and worktree, a
// new session, and a brief the harness writes from its records. The parent is
// told in one line and gets the report when the work is done.
//
// Why the harness starts it, and not the parent: a parent that hears of the
// loss writes a new brief by hand and starts a new agent, which is what the
// harness can do from its own records at no model cost. Claude Code, Codex
// and OpenCode hand the loss to the parent's model as a tool result.
//
// Not a loss: the step budget of a turn (max_steps). It is the owner's or the
// agent's definition's, and a fresh context would get it whole again. Nor a
// provider failure while its outage is open, an unreachable provider, or a wait
// the provider asked for that is longer than a turn waits: a successor would
// fail the same way at once.
//
// What a task used (steps, dollars, the agents under it) is counted over every
// context it had: src/automation/agents.ts usedOf.
//
// Bounds: at most MAX_SUCCESSORS successors a task. A second refusal moves the
// work to a model of another family (a model's safety check flags the
// conversation, and the same model tends to decline it again). After that the
// parent is told and decides.
//
// The brief carries no word of the declined reply or of what the lost agent
// wrote: its task, the facts of its work (files, commits, checks) and its last
// failure as a class. Pure: src/automation/agents.ts reads the facts and acts.
import { skippedWords, type Skipped } from "../providers/account.ts";
import type { Family } from "../providers/types.ts";

export const MAX_SUCCESSORS = 2;

export type LossKind = "refusal" | "context" | "provider";
// What was lost before, in this task: the session, the model, how, and the
// messages its parent sent while that context worked (they go on to the next).
export type Lost = { kind: LossKind; model: string; family: Family; session: string; category?: string; at: number; steers?: string[] };

export const LOSS_WORDS: Record<LossKind, string> = {
  refusal: "the model declined to go on",
  context: "its context could not be made to fit the model's window",
  provider: "its provider kept failing",
};

// The classes of a failed turn (src/admin/classes.ts) a fresh context can get
// past: the provider failed past the retries on this request, or the context
// no longer fit. Not credentials, quota, a malformed request or an image the
// provider refused, and not an unreachable provider: a successor would fail
// the same way.
const PROVIDER_CLASSES = new Set(["rate_limit", "overloaded", "server", "stream_drop"]);

// How an agent's task was lost, or undefined when it ended on its own terms
// (it reported, was stopped, ran out of a step budget or the budget it was
// given). `outage`: the provider's outage is open (src/providers/outage.ts);
// `retryAt`: the provider asked for a wait longer than a turn waits.
export function lossOf(o: { status: string; end_reason?: string | null; cls?: string; outage?: boolean; retryAt?: number }): LossKind | undefined {
  if (o.status === "incomplete") return o.end_reason === "refusal" ? "refusal" : undefined;
  if (o.status !== "failed" || o.end_reason === "restart") return undefined;
  if (o.cls === "context_overflow") return "context";
  if (o.outage || o.retryAt !== undefined) return undefined;
  return o.cls && PROVIDER_CLASSES.has(o.cls) ? "provider" : undefined;
}

// The task a successor gets: its brief as the first context had it, and every
// message its parent sent to any context of it, oldest first.
export function taskWithSteers(task: string, steers: readonly string[]): string {
  return steers.length ? `${task}\n\nMessages from the session that started you, oldest first:\n${steers.join("\n---\n")}` : task;
}

export type SuccessorPlan =
  | { go: true; n: number; switchFamily: boolean; avoid: Family[] }
  | { go: false; why: string };

// Whether a successor starts, the how-manyth it is, and whether it runs on a
// model of another family than those that declined the work.
export function decideSuccessor(loss: LossKind, lost: readonly Lost[], family: Family): SuccessorPlan {
  if (lost.length >= MAX_SUCCESSORS) {
    return { go: false, why: `${lost.length} successors were started for this task already, the most a task gets` };
  }
  const refused = [...lost.filter((l) => l.kind === "refusal").map((l) => l.family), ...(loss === "refusal" ? [family] : [])];
  const switchFamily = loss === "refusal" && refused.length >= 2;
  return { go: true, n: lost.length + 1, switchFamily, avoid: switchFamily ? [...new Set(refused)] : [] };
}

export type Candidate = { id: string; provider: string; family: Family; tools?: boolean; release?: string };

// A model of a family the work was not declined on: the parent's model, then
// the owner's default, then one of the lost model's provider (an aggregator
// lists several families), then any; the newest first. None: no listed model
// of another family takes tools.
export function otherFamily(models: readonly Candidate[], o: { current: string; avoid: readonly Family[]; parent?: string; preferred?: string }): string | undefined {
  return ranked(models, (m) => !o.avoid.includes(m.family), o)[0];
}

// The models that take tools and pass `fit`, in otherFamily's order.
function ranked(models: readonly Candidate[], fit: (m: Candidate) => boolean, o: { current: string; parent?: string; preferred?: string }): string[] {
  const ok = (m: Candidate | undefined): m is Candidate => !!m && m.tools !== false && fit(m);
  const byId = (id?: string) => (id ? models.find((m) => m.id === id) : undefined);
  const provider = byId(o.current)?.provider ?? o.current.slice(0, o.current.indexOf(":"));
  const newest = (xs: Candidate[]) => [...xs].sort((a, b) => (b.release ?? "").localeCompare(a.release ?? ""));
  const out = [...[o.parent, o.preferred].map(byId).filter(ok), ...newest(models.filter((m) => ok(m) && m.provider === provider)), ...newest(models.filter(ok))].map((m) => m.id);
  return [...new Set(out)];
}

// Every model a successor can start on, best first. After a second refusal:
// otherFamily's order. Otherwise the lost model, then the others of its family,
// then the rest: the first whose route takes work is chosen
// (src/providers/account.ts firstOpen), so a route out of credit or signed out
// is passed over for the next.
export function successorOrder(models: readonly Candidate[], o: { current: string; family: Family; switchFamily: boolean; avoid: readonly Family[]; parent?: string; preferred?: string }): string[] {
  if (o.switchFamily) return ranked(models, (m) => !o.avoid.includes(m.family), o);
  return [...new Set([o.current, ...ranked(models, (m) => m.family === o.family, o), ...ranked(models, (m) => m.family !== o.family, o)])];
}

// The facts a capsule carries: the harness's own records, never the model's words.
export type CapsuleFacts = {
  title: string;
  task: string;             // the brief it works on (the task, reworded when the model declined it)
  reworded: boolean;
  loss: LossKind;
  category?: string;        // the provider's category of a refusal
  did: string;              // steps, calls and files, counted (src/automation/report-did.ts)
  worktree?: string;
  branch?: string;
  head?: { id: string; subject: string }; // the branch's newest commit
  files: string[];          // what differs from where the worktree started, committed or not
  checks: string;           // what the check ledger saw (src/checks/proof.ts)
  failure?: string;         // the last failure, as its class
  lost: readonly Lost[];    // the losses before this one in the task
  agents?: readonly { id: string; title: string }[]; // agents the lost context started that still work: the successor's now
};

const FILES_SHOWN = 40;
const declined = (f: Pick<CapsuleFacts, "loss" | "lost">) => f.loss === "refusal" || f.lost.some((l) => l.kind === "refusal");

// The successor's brief. The frame is the harness's own; the declined reply
// and what the lost context said are not in it, so the new context does not
// start from what the model's check flagged.
export function capsuleBrief(f: CapsuleFacts): string {
  const n = f.lost.length + 1;
  const files = f.files.length
    ? `${f.files.slice(0, FILES_SHOWN).join("\n")}${f.files.length > FILES_SHOWN ? `\n(and ${f.files.length - FILES_SHOWN} more)` : ""}`
    : "(none)";
  const place = f.worktree
    ? `You work in the same git worktree at ${f.worktree}${f.branch ? ` on branch ${f.branch}` : ""}. Edit only there and commit your work on that branch; your parent merges it.`
    : "";
  return [
    `You take up the task of agent "${f.title}" with a fresh context: its earlier context ended because ${LOSS_WORDS[f.loss]}${f.category ? ` (category: ${f.category})` : ""}. This capsule is written by the harness from its records; it holds none of that context's words.${n > 1 ? ` This is the ${n === 2 ? "second" : `${n}th`} fresh start of this task.` : ""}`,
    place,
    "Start by reading where the work stands (the branch, the files below, their diff), then finish the task and report as the task asks. Your final message is the report.",
    `What was done so far: ${f.did || "nothing recorded"}`,
    // (After a refusal in the task the commit's subject is left out: a lost context wrote it, and it can carry the framing.)
    ...(f.head ? [`Branch head: ${declined(f) ? f.head.id : `${f.head.id} ${f.head.subject}`}`] : []),
    `Files changed so far:\n${files}`,
    ...(f.checks ? [`Checks: ${f.checks}`] : []),
    ...(f.failure ? [`Last failure: ${f.failure}`] : []),
    ...(f.agents?.length ? [`Agents the earlier context started still work, and are yours now: their reports come to you, and you can message or stop them by id. ${f.agents.map((x) => `${x.title ? `"${x.title}" ` : ""}(${x.id})`).join(", ")}`] : []),
    `Task${f.reworded ? " (its brief restated: what the work builds or checks)" : ""}:\n${f.task}`,
  ].filter(Boolean).join("\n\n");
}

// The one line the parent hears.
// `skipped`: the models passed over because their routes take no work now, each with why.
export function parentLine(o: { title: string; id: string; loss: LossKind; category?: string; n: number; model: string; moved: boolean; skipped?: readonly Skipped[] }): string {
  const passed = o.skipped?.length ? ` It skipped ${skippedWords(o.skipped)}.` : "";
  return `[harness] Agent "${o.title}" (${o.id}) lost its context: ${LOSS_WORDS[o.loss]}${o.category ? ` (${o.category})` : ""}. Keel started it again with a fresh context from a capsule of its work, in the same worktree, on ${o.model}${o.moved ? ", a model of another family" : ""} (successor ${o.n} of at most ${MAX_SUCCESSORS}).${passed} Its report comes when it finishes: nothing to do.`;
}

// What its report says when no successor starts.
export function givenUpNote(o: { why: string; lost: readonly Lost[] }): string {
  const models = [...new Set(o.lost.map((l) => l.model))].join(", ");
  return `(Keel started no fresh context for it: ${o.why}${models ? `; earlier contexts ran on ${models}` : ""}. Decide how the work goes on: another model, a brief that says what the work builds or checks, or the work yourself.)`;
}

// The request that restates a declined task's brief: the task alone, never the
// declined reply or the lost context.
export const REWORD_SYSTEM = "You restate task briefs for a software agent. Return only the restated brief, nothing else.";
export function rewordPrompt(task: string): string {
  return [
    "Restate this task brief so that it says plainly what the work builds or checks, in neutral engineering words.",
    "Keep every concrete requirement: paths, commands, names, numbers, acceptance criteria and checks, in the same order.",
    "Do not change, hide or add to what is asked. Where a word such as attack, bypass, exploit or probe describes the work, say what is built or checked instead; keep such a word where it names a file, a test or an identifier.",
    "",
    "<brief>",
    task,
    "</brief>",
  ].join("\n");
}

// A restated brief is used only when it looks like one: not empty, not much
// shorter than the task (requirements dropped), and not opening with an
// apology or a refusal. That is all it checks: it does not read whether the
// restatement kept each requirement or dropped the framing. When it fails, the
// task goes as it was given; a verbatim brief that is declined again is bounded
// by the family switch and MAX_SUCCESSORS.
export function rewordHolds(task: string, out: string): boolean {
  const t = out.trim();
  if (!t) return false;
  if (t.length < Math.min(task.trim().length * 0.6, task.trim().length - 40)) return false;
  return !/^(i (can(no|')t|won't|will not)|sorry|i'm sorry|i am unable)/i.test(t);
}
