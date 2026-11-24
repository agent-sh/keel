// A run of read-only steps: an agent that explores sends one read a step, and
// every step reads its whole context again on the agent's own model. Most of
// those reads did not need the one before them: they could have gone as
// parallel calls in one step, which every family's API takes and the turn
// already runs side by side. A search whose text the agent needs only as an
// answer could have gone to a cheaper model's own context. At the second such
// step in a row Keel says so on the step's result, once a run, with what one
// step of this context reads and costs. Nothing the agent sees is changed or
// summarized: the note only says what the next steps cost and what else
// there is, and the agent decides.
//
// Claude Code and Codex ask for parallel reads in general words in their
// prompts, and Claude Code's Explore agent searches on a small model; the
// note is the same ask at the moment it pays, with its price. A trial decides
// whether it stays and in which form (src/admin/experiments.ts, "Agents
// batch their reads"): a tree runs it when the session at its top has
// `read_runs` ("batch": the note asks for parallel reads; "reader": it also
// offers an Explore agent, which then searches on the reader model).
import type { Session, StoredEvent } from "../core/types.ts";
import type { ModelInfo, Price } from "../providers/types.ts";
import { readerChoices, readRate } from "./reader.ts";
import { readOnlyCommand } from "../safety/shell.ts";
import { shellText } from "../safety/policy.ts";
import { toolKind } from "../core/tool-line.ts";

export type ReadRuns = "batch" | "reader";
export const READ_RUNS: readonly ReadRuns[] = ["batch", "reader"];

// The step of a run the note comes on: the second read-only step in a row,
// each of one call. The first read of a run is often the only one (the median
// run of sampled agent steps is one step), so a note there would come on every
// lone read; at the second the run is a run. In the replay of those steps a
// note at the second step gave three quarters of the first step's saving with
// half as many notes.
export const NOTE_AT = 2;

// A call that only reads local files: a file read, a search, a glob or a
// listing of any family, or a shell command the permission gate reads as one
// that changes nothing and reaches nothing (src/safety/shell.ts). A web fetch,
// a wait, a plan or a question is not exploration, and neither is a sleep.
export function explores(name: string, input: unknown): boolean {
  const k = toolKind(name);
  if (k === "read" || k === "search" || k === "glob" || k === "list") return true;
  if (k !== "shell" || name === "keel__run_on") return false;
  const cmd = shellText(input);
  return !!cmd && !/^\s*sleep\b/.test(cmd) && readOnlyCommand(cmd);
}

// One step as the rule reads it: its calls, and how many of them only read.
export type ReadStep = { calls: number; reads: number };
// Where a session is in a run: read-only steps in a row, whether each was of
// one call, whether this run was told.
export type RunState = { run: number; single: boolean; noted: boolean };
export const START: RunState = { run: 0, single: true, noted: false };

// The state after a step, and whether the step's result carries the note.
// A step that does anything but read ends the run; a run in which a step
// already sent several reads at once is batching, and is not told.
export function nextRun(s: RunState, step: ReadStep): { state: RunState; note: boolean } {
  if (step.calls === 0 || step.reads < step.calls) return { state: START, note: false };
  const run = s.run + 1, single = s.single && step.calls === 1;
  const note = !s.noted && single && run === NOTE_AT;
  return { state: { run, single, noted: s.noted || note }, note };
}

// Requests a read took in a turn: its read-only steps over the reads they
// sent (1 is one read a step; lower is batched). Null when the turn read nothing.
export function stepsPerRead(steps: readonly ReadStep[]): number | null {
  let n = 0, reads = 0;
  for (const s of steps) if (s.calls > 0 && s.reads === s.calls) { n++; reads += s.calls; }
  return reads ? n / reads : null;
}

// The same of a turn as its events keep it: each step's calls, and how many only read.
export function readSteps(span: readonly Pick<StoredEvent, "kind" | "data">[]): number | null {
  return stepsPerRead(span.filter((e) => e.kind === "assistant").map((e) => {
    const calls = (((e.data as any)?.blocks ?? []) as any[]).filter((b) => b?.type === "tool_use");
    return { calls: calls.length, reads: calls.filter((b) => explores(String(b.name), b.input)).length };
  }));
}

// What a tree runs: the setting of the nearest session up the tree that has
// one (a trial's arm sets the top session's). Agents only: a session the
// owner works in is not told.
export function readRunsOf(s: Session, parentOf: (id: string) => Session | undefined): ReadRuns | undefined {
  if (!s.parent_id) return undefined;
  for (let at: Session | undefined = s, up = 0; at && up < 32; at = at.parent_id ? parentOf(at.parent_id) : undefined, up++) {
    const v = at.settings.read_runs;
    if (v !== undefined) return READ_RUNS.includes(v) ? v : undefined;
  }
  return undefined;
}

// The model an Explore agent of a tree on "reader" searches on: the session's
// first reader choice (the owner's small models, KEEL_READER_MODEL, the
// configured small model, then the cheapest of its own provider and family:
// src/engine/reader.ts), when that is cheaper to read with than its own. It
// must hold what the session's own window holds: it takes over reads the
// session would have made. Undefined: the agent runs on the session's model.
export function readerFor(models: ModelInfo[], current: ModelInfo, env: Record<string, string | undefined>, listPrice: (m: ModelInfo) => Price | undefined, ownSmall: string[]): ModelInfo | undefined {
  const own = readRate(current, listPrice);
  const pick = readerChoices(models, current, current.context, env, listPrice, ownSmall).find((m) => m.id !== current.id);
  const rate = pick ? readRate(pick, listPrice) : undefined;
  return pick && own !== undefined && rate !== undefined && rate < own ? pick : undefined;
}

// The note. `context`: the tokens the step's request carried; `rate`: what a
// million of them cost to read from the cache on this model, when it has a
// price. `reader`: the Explore offer, with the tool that starts it in this
// session's words and the share of this model's read price the reader costs.
export function readNote(context: number, rate?: number, reader?: { start: string; model: string; share: number }): string {
  const k = context >= 1000 ? `${Math.round(context / 1000)}K` : String(context);
  const usd = rate !== undefined && rate > 0 ? (context * rate) / 1e6 : undefined;
  const price = usd === undefined ? "" : `, about $${usd >= 0.01 ? usd.toFixed(2) : usd.toFixed(4)}`;
  const lines = [
    `[harness] ${NOTE_AT} read-only steps in a row, one call each. Each step reads your whole context again (${k} tokens${price}).`,
    "Send the reads you already know you need as parallel calls in one step; read one at a time only when a read depends on what the one before it returned.",
  ];
  if (reader) {
    const share = reader.share >= 0.1 ? `${Math.round(reader.share * 100)}%` : `1/${Math.round(1 / reader.share)}`;
    lines.push(`For a search whose text you need only as an answer, ${reader.start} searches in its own context on ${reader.model}, which reads at ${share} of this model's price, and returns what it found; read a file yourself when you will edit it.`);
  }
  return lines.join(" ");
}
