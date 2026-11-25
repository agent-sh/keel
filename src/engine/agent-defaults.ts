// What an agent does by default where a trial can try the other way (src/admin/setting-trials.ts): the
// working window it compacts at, whether its cache plan runs, and whether its file reads come back as a
// reader's compiled reading (src/tools/reading.ts). The owner's setting is the section
// `agents` (settings.json); a trial's arm sets the session setting on the tree's first agent, and every
// agent under it reads that one. Only agents are covered: a session the owner talks to keeps the window
// share and the cache plan it always had, and reads through a reader by the owner's setting for sessions
// (`sessions.read_through`, on) unless its own setting says otherwise. An agent reads files itself until
// the trial of the other way ends with Keep, which sets `agents.read_through`.
import { registerSettings, settings } from "../admin/settings.ts";
import type { Session, SessionSettings } from "../core/types.ts";
import { COMPACT_SHARE } from "./compact.ts";

// The smallest share of a window an agent compacts at. Under it the system prompt, the tools and a
// summary leave too little room for a step in a small window, and the agent would compact at every step.
export const MIN_WINDOW_SHARE = 0.3;

export const AGENT_DEFAULTS = { window_share: null as number | null, cache_plan: true, read_through: false };
const DEFAULTS = AGENT_DEFAULTS;
const check = (v: any) =>
  v.window_share !== null && !(typeof v.window_share === "number" && v.window_share >= MIN_WINDOW_SHARE && v.window_share <= 1) ? `window_share is a share of the model's window from ${MIN_WINDOW_SHARE} to 1, or null for the usual ${COMPACT_SHARE}`
  : typeof v.cache_plan !== "boolean" ? "cache_plan is true or false"
  : typeof v.read_through !== "boolean" ? "read_through is true or false" : undefined;
registerSettings("agents", DEFAULTS, check);
// What a session the owner talks to does by default: its long file reads come back as a reader's compiled reading.
export const SESSION_DEFAULTS = { read_through: true };
registerSettings("sessions", SESSION_DEFAULTS, (v) => (typeof v.read_through !== "boolean" ? "read_through is true or false" : undefined));

const agents = (): typeof DEFAULTS => settings().agents;

// The first value of a session setting up the tree: the session's own, else its parent's, and so on.
function up<K extends keyof SessionSettings>(key: K, s: Session, parentOf: (id: string) => Session | undefined): SessionSettings[K] | undefined {
  for (let at: Session | undefined = s, n = 0; at && n < 32; at = at.parent_id ? parentOf(at.parent_id) : undefined, n++) {
    if (at.settings[key] !== undefined) return at.settings[key];
  }
  return undefined;
}

// The share of the model's window the session compacts at.
export function windowShare(s: Session, parentOf: (id: string) => Session | undefined): number {
  return up("compact_share", s, parentOf) ?? (s.parent_id ? agents().window_share : null) ?? COMPACT_SHARE;
}

// The context size, in tokens, the session compacts at in a model with `context` tokens of window: the
// owner's own ceiling, else the share.
export const compactLimit = (s: Session, context: number, parentOf: (id: string) => Session | undefined) =>
  s.settings.compact_at ?? Math.floor(context * windowShare(s, parentOf));

// Whether the session's waits are planned (src/engine/cache-plans.ts).
export function cachePlanOn(s: Session, parentOf: (id: string) => Session | undefined): boolean {
  return up("cache_plan", s, parentOf) ?? (s.parent_id ? agents().cache_plan : true);
}

// Whether the session's file reads come back as a reader's compiled reading (src/tools/reading.ts): its own
// setting or the nearest one up its tree, else the owner's default: for an agent `agents.read_through`, for a
// session the owner talks to `sessions.read_through`.
export function readThrough(s: Session, parentOf: (id: string) => Session | undefined): boolean {
  return up("read_through", s, parentOf) ?? (s.parent_id ? agents().read_through : settings().sessions.read_through);
}
