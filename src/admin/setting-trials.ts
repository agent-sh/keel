// A trial of a setting that changes what an agent costs: half of the new agent trees run with the
// other value, the rest as before, and the owner keeps the setting or drops it from what each arm cost.
// It is a live experiment (src/admin/experiments.ts), the one machinery for arms, results and stops:
// new trees get an arm there at their start, the report there holds the intervals, and its stop rule
// ends the trial. This file only says which settings can be tried, what the experiment of one is,
// and how big and how long it is from the rate new agent trees start at.
//
// The settings, and what an arm sets on the tree's first agent (every agent under it reads that one):
// - agent_window: the share of the model's window an agent compacts at (session `compact_share`; the
//   owner's default for agents is `agents.window_share`). The other arm compacts at half of the share.
// - cache_plan: whether an agent's waits get a cache plan (session `cache_plan`; `agents.cache_plan`).
//   The other arm lets the cache lapse, as before the plan.
// - read_through: whether an agent's file reads come back as a reader's compiled reading (session
//   `read_through`; `agents.read_through`; src/tools/reading.ts). The other arm reads the files itself.
import { MIN_WINDOW_SHARE } from "../engine/agent-defaults.ts";
import { COMPACT_SHARE } from "../engine/compact.ts";
import { FAMILIES_PER_ARM, type Experiment } from "./experiments.ts";

export const SETTING_TRIAL_KIND = "setting_trial";
const DAY = 86_400_000;

export type AgentSettings = { window_share: number | null; cache_plan: boolean; read_through: boolean };
export type SettingTrialId = "agent_window" | "cache_plan" | "read_through";
type Value = number | boolean;
type Def = {
  id: SettingTrialId;
  label: string;
  // What the trial asks, in the card's words.
  ask: string;
  // The owner's setting under `agents` and the session setting an arm sets.
  key: keyof AgentSettings;
  session: "compact_share" | "cache_plan" | "read_through";
  current: (a: AgentSettings) => Value;
  // The value the other arm runs with; none when there is nothing lower or other to try.
  other: (current: Value) => Value | undefined;
  say: (v: Value) => string;
};

const percent = (v: number) => `${Number((v * 100).toFixed(1))}%`;

export const SETTING_TRIALS: readonly Def[] = [
  {
    id: "agent_window", label: "Agents' working window",
    ask: "Do agents cost less a tree when they compact at a smaller context, though they write more summaries?",
    key: "window_share", session: "compact_share",
    current: (a) => a.window_share ?? COMPACT_SHARE,
    // Half of the share, not under the share a small window still has room for a step at.
    other: (c) => { const v = Math.max(MIN_WINDOW_SHARE, Math.round((c as number) * 500) / 1000); return v < (c as number) ? v : undefined; },
    say: (v) => `compacts at ${percent(v as number)} of the window`,
  },
  {
    id: "cache_plan", label: "Agents' cache plan",
    ask: "Does planning the cache of a waiting agent (keep it warm, prepare a summary, or let it lapse, whichever the wait's length and the model's price make cheapest) cost less a tree than letting it lapse?",
    key: "cache_plan", session: "cache_plan",
    current: (a) => a.cache_plan,
    other: (c) => !c,
    say: (v) => (v ? "plans its waits" : "lets its cache lapse"),
  },
  {
    id: "read_through", label: "Agents' file reads",
    ask: "Do agents cost less a tree when a long file comes back as a reader model's compiled reading, with the file's own lines only where the agent needs them, though some lines are then read a second time?",
    key: "read_through", session: "read_through",
    current: (a) => a.read_through,
    other: (c) => !c,
    say: (v) => (v ? "reads long files through a reader" : "reads files itself"),
  },
];

export const settingTrial = (id: string) => SETTING_TRIALS.find((t) => t.id === id);

// How many new agent trees start a day, from when they started (an agent a top-level session started,
// with everything under it, is one tree): the count over the last `RATE_DAYS` days, or over the days
// the folder has been recording when it is younger than that.
export const RATE_DAYS = 7;
export function treesPerDay(started: readonly number[], now: number, firstSession = now - RATE_DAYS * DAY): { per_day: number; trees: number; days: number } {
  const from = now - RATE_DAYS * DAY;
  const recent = started.filter((t) => t >= from && t <= now);
  const days = Math.min(RATE_DAYS, Math.max(1, (now - Math.max(from, firstSession)) / DAY));
  return { per_day: recent.length / days, trees: recent.length, days: Number(days.toFixed(1)) };
}

// A trial covers at least this many days of new trees: how many agents start a day moves with the
// days of the week, and a sample of less than two of them would be read from the busy day alone.
export const MIN_DAYS = 2;
// The most it runs: two weeks, two of the weekly cycles. A setting that needs longer to be told apart
// is not worth half of the trees on a possibly dearer arm for that long.
export const MAX_DAYS = 14;
// It ends at twice the days its sample is expected to take at the live rate: the rate can halve.
export const DEADLINE_FACTOR = 2;

export type Plan = { per_arm: number; expected_days: number; until_days: number; startable: boolean; why?: string };
// The trees per arm and the time of a trial of two arms, at `rate` new trees a day: the sample the
// experiments' templates start from (FAMILIES_PER_ARM), or `MIN_DAYS` of trees when that is more.
export function plan(rate: number, arms = 2): Plan {
  const per_arm = Math.max(FAMILIES_PER_ARM, Math.ceil((MIN_DAYS * rate) / arms));
  // (To a tenth of a day: the sample is a whole number of trees, and two days of them is a little over two days.)
  const expected_days = rate > 0 ? Number(((per_arm * arms) / rate).toFixed(1)) : Infinity;
  const until_days = Math.min(MAX_DAYS, Math.max(MIN_DAYS + 1, Math.ceil(DEADLINE_FACTOR * expected_days)));
  const startable = expected_days <= MAX_DAYS;
  return {
    per_arm, expected_days, until_days, startable,
    ...(startable ? {} : { why: `At ${Number(rate.toFixed(1))} new agent trees a day, ${per_arm * arms} trees take ${Number.isFinite(expected_days) ? `${Math.ceil(expected_days)} days` : "longer than there is"}: a trial runs ${MAX_DAYS} days at most.` }),
  };
}

// The experiment a press on a trial starts: control and variant arms of equal weight, units are agent
// trees. What a tree costs (all of its sessions' calls, summaries and warm reads included) judges it; the
// guards are what an arm that works worse would show, as in a trial of a model.
export function trialExperiment(def: Def, current: Value, other: Value, p: Plan, now: number): Pick<Experiment, "name" | "hypothesis" | "mode" | "unit" | "arms" | "primary" | "guards" | "stop" | "setting"> {
  const [from, to] = [def.say(current), def.say(other)];
  return {
    name: `Trial: ${def.label}`,
    mode: "live", unit: "agent",
    hypothesis: `What a tree costs when its agent ${from} and when it ${to}: the one that costs less stays, if neither has more failed turns, failed tool calls, lost contexts, stops by the owner or replies rated down.`,
    arms: [{ name: from, settings: { [def.session]: current } }, { name: to, settings: { [def.session]: other } }],
    primary: "tree_cost_usd",
    guards: [{ metric: "error", mde: 0.1 }, { metric: "tool_errors", mde: 0.25, relative: true }, { metric: "successor", mde: 0.05 },
      { metric: "stopped_by_owner", mde: 0.1 }, { metric: "thumbs_down", mde: 0.1 }],
    stop: { sessions_per_arm: p.per_arm, until_ms: now + p.until_days * DAY },
    setting: { trial: def.id, key: def.key, from: current, to: other },
  };
}
