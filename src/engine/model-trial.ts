// A trial of a model that listed for the first time (src/providers/first-seen.ts):
// half of the new session trees try it in one role, the other half run as before.
// The trial is a live experiment (src/admin/model-trials.ts) whose second arm sets the
// session setting `trial` on the tree's top session. Nothing here names a model.
//
// The roles, and what the trial model does in each:
// - reader: it is the first choice of the readers that read long material for
//   the tree's sessions (src/engine/readers.ts), ahead of the owner's small models.
// - small: it is the first choice of the small requests a tree makes (session
//   titles, a restated task, a ruling's match), ahead of the owner's small models.
// - builder: the agents the tree starts run on it when neither the spawn nor the
//   agent's definition names a model. The top session keeps its own model.
// A trial model that is not listed, or whose route takes no work, is passed over
// as any other choice is.
import type { Session } from "../core/types.ts";

export const ROLES = ["reader", "small", "builder"] as const;
export type Role = (typeof ROLES)[number];
// `exp` is the experiment the trial is: the tree is in the trial only while that experiment runs.
export type Trial = { role: Role; model: string; exp: string };

// Whether an experiment is running: the experiments' answer, set when they are made (src/admin/experiments.ts).
let running: (exp: string) => boolean = () => false;
export const registerTrialRunning = (f: (exp: string) => boolean) => void (running = f);

export const ROLE_WORDS: Record<Role, string> = {
  reader: "the readers that read long material",
  small: "small requests such as titles",
  builder: "the agents a session starts",
};

export const isTrial = (v: unknown): v is Trial =>
  !!v && typeof v === "object" && ROLES.includes((v as Trial).role) && typeof (v as Trial).model === "string" && (v as Trial).model.length > 0 && typeof (v as Trial).exp === "string";

// The trial a session's tree is in: set on its top session, read up the parents, and only while its
// experiment runs (a stop, a guard's stop or the end of its sample sets the tree back to as before).
export function trialOf(s: Session | undefined, parentOf: (id: string) => Session | undefined, live: (exp: string) => boolean = running): Trial | undefined {
  for (let at = s, up = 0; at && up < 32; at = at.parent_id ? parentOf(at.parent_id) : undefined, up++) {
    const v = (at.settings as { trial?: unknown }).trial;
    if (v !== undefined) return isTrial(v) && live(v.exp) ? v : undefined;
  }
  return undefined;
}

// The model the session's tree tries in `role`, if it is in a trial of that role.
export const trialModel = (role: Role, s: Session | undefined, parentOf: (id: string) => Session | undefined, live?: (exp: string) => boolean): string | undefined => {
  const t = trialOf(s, parentOf, live);
  return t?.role === role ? t.model : undefined;
};
