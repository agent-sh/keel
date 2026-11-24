// A trial of a new model (src/engine/model-trial.ts) as a live experiment: made and started by a press
// on the model's card (src/server/routes/model-trials.ts), stopped by a press or by its own end.
import { FAMILIES_PER_ARM, type Experiment } from "./experiments.ts";
import { isTrial, ROLE_WORDS, type Role, type Trial } from "../engine/model-trial.ts";

export const TRIAL_KIND = "model_trial";

// The experiment a press on a new model's card starts: control and trial arms of equal weight.
// The primary metric is what a tree costs a turn; the guards are the ones a model that works
// worse would show (its template is `TRIAL_KIND`, which `trialIn` reads): failed turns, failed tool calls, contexts lost to a successor, the owner's
// Stop, replies rated down.
export function trialExperiment(m: { id: string; name: string }, role: Role, exp: string): Pick<Experiment, "name" | "hypothesis" | "mode" | "arms" | "primary" | "guards" | "stop"> {
  return {
    name: `New model: ${m.name}, ${role}`,
    mode: "live",
    hypothesis: `${m.name} in the ${role} role (${ROLE_WORDS[role]}) costs less per turn than the model the tree uses now, without more failed turns, failed tool calls, lost contexts, stops by the owner or replies rated down.`,
    arms: [{ name: "current" }, { name: m.name, settings: { trial: { role, model: m.id, exp } satisfies Trial } }],
    primary: "cost_usd",
    guards: [{ metric: "error", mde: 0.1 }, { metric: "tool_errors", mde: 0.25, relative: true }, { metric: "successor", mde: 0.05 },
      { metric: "stopped_by_owner", mde: 0.1 }, { metric: "thumbs_down", mde: 0.1 }],
    stop: { sessions_per_arm: FAMILIES_PER_ARM },
  };
}

// The trial an experiment is, if it is one.
export const trialIn = (e: Pick<Experiment, "template" | "arms">): Trial | undefined => {
  if (e.template !== TRIAL_KIND) return undefined;
  const t = (e.arms[1]?.settings as { trial?: unknown } | undefined)?.trial;
  return isTrial(t) ? t : undefined;
};
