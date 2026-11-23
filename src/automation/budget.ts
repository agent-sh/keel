// An agent's budget: model steps, minutes or dollars for one task (from its
// start, or from the message that continued it). Checked before each model
// step: when one limit is reached the agent gets one more step, with no call
// run, to write its report, and ends incomplete with ended="budget". A message
// continues it with the budget counted again from then (or the one it gives).
// Claude Code's maxTurns marks such a report partial and resumable; OpenHands'
// max_budget_per_run is checked after each step and may overshoot by one: so
// may this one (a long step is not cut).
// The decisions here are pure; src/automation/agents.ts reads what was used.

export type Budget = { steps?: number; minutes?: number; usd?: number };
export type Used = { steps: number; ms: number; usd: number };
export type Limit = keyof Budget;

const KEYS: Limit[] = ["steps", "minutes", "usd"];

// A budget from a tool's input or a stored row: positive numbers only, steps whole. Throws the
// refusal for a value that cannot be a budget; undefined for none.
export function parseBudget(v: unknown): Budget | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("budget is an object: { steps?, minutes?, usd? }");
  const o = v as Record<string, unknown>;
  const out: Budget = {};
  for (const k of KEYS) {
    const x = o[k];
    if (x === undefined || x === null) continue;
    const n = typeof x === "string" ? Number(x) : x;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) throw new Error(`budget.${k} is a number above 0`);
    if (k === "steps" && !Number.isInteger(n)) throw new Error("budget.steps is a whole number");
    out[k] = n;
  }
  const extra = Object.keys(o).filter((k) => !KEYS.includes(k as Limit));
  if (extra.length) throw new Error(`budget takes steps, minutes and usd, not ${extra.join(", ")}`);
  return Object.keys(out).length ? out : undefined;
}

// A definition's frontmatter: budget_steps, budget_minutes and budget_usd name each limit. (Claude
// Code's maxTurns is a step budget of each turn, the session's max_steps: src/automation/agents.ts.)
// A value that is not a positive number is ignored.
export function budgetOfMeta(meta: Record<string, string | string[] | undefined>): Budget | undefined {
  const num = (v: string | string[] | undefined) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return v !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const steps = num(meta.budget_steps);
  const out: Budget = { steps: steps === undefined ? undefined : Math.floor(steps) || undefined, minutes: num(meta.budget_minutes), usd: num(meta.budget_usd) };
  for (const k of KEYS) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

// The call's budget over the definition's, limit by limit.
export const mergeBudget = (def: Budget | undefined, given: Budget | undefined): Budget | undefined =>
  def || given ? { ...def, ...given } : undefined;

// The first limit reached, in the order steps, minutes, dollars; undefined while every one has room.
export function spentOn(b: Budget | undefined, u: Used): Limit | undefined {
  if (!b) return undefined;
  if (b.steps !== undefined && u.steps >= b.steps) return "steps";
  if (b.minutes !== undefined && u.ms >= b.minutes * 60_000) return "minutes";
  if (b.usd !== undefined && u.usd >= b.usd) return "usd";
  return undefined;
}

// Cents for a budget of dimes and up; two figures below that ($0.004), so a small limit never reads $0.00.
const usd = (n: number) => `$${n >= 1 ? n.toFixed(2).replace(/\.00$/, "") : n >= 0.1 ? n.toFixed(2) : String(Number(n.toPrecision(2)))}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
// "3 steps", "10 minutes", "$0.05": one limit in words.
export function limitWords(b: Budget, k: Limit): string {
  if (k === "steps") return plural(b.steps!, "step");
  if (k === "minutes") return plural(Math.round(b.minutes! * 10) / 10, "minute");
  return usd(b.usd!);
}
export const budgetWords = (b: Budget) => KEYS.filter((k) => b[k] !== undefined).map((k) => limitWords(b, k)).join(", ");
// What was used of that limit, in the same words.
export function usedWords(u: Used, k: Limit): string {
  if (k === "steps") return plural(u.steps, "step");
  if (k === "minutes") return plural(Math.round(u.ms / 6_000) / 10, "minute");
  return usd(u.usd);
}

// The harness's words for the step that writes the report.
// `above`: the title of the agent above whose budget is spent, when it is not this agent's own.
export const closingText = (b: Budget, u: Used, k: Limit, above?: string) =>
  `[harness] ${above ? `The budget of "${above}", an agent above you, is spent` : "Your budget for this task is spent"} (${limitWords(b, k)}; used ${usedWords(u, k)}). This is your last step: no tool call runs, and any agents you started stop with you. Write your report now: what you did, where the work stands, what is left (what your own agents were doing included), and anything the agent that started you needs to go on.`;

// What the record and the report say of the end.
export const endedWords = (b: Budget | undefined, k: Limit | undefined, above?: string) =>
  b && k ? (above ? `the budget of "${above}", an agent above it, ran out (${limitWords(b, k)})` : `it ran out of its budget (${limitWords(b, k)})`) : "it ran out of its budget";
