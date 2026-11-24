// The owner's rule for moving an agent off a route that is out. An agent whose provider cannot be
// reached waits in the provider's shared outage for as long as it lasts (src/providers/outage.ts),
// and one whose model is overloaded waits, up to five minutes a try (src/engine/retry.ts): a
// coordinator's whole tree stalls behind one route. The rule says, for an agent type (a role): when
// its route has been out for N minutes, the agent goes on on a model the listing names, on another
// provider.
//
// Only agents (never a session of the owner's), only between steps (the request that failed was
// never answered, so the history ends at a step), only to a route that is itself working, and never
// back: the agent finishes where it moved. Nothing here names a model; the rule does, and a model
// the listing does not return is not a target.
//
// Why the same session and not a successor (src/automation/successor.ts): a successor starts a
// fresh context from a capsule, which is right for a context that was lost. Here the context is
// whole and only the route is out, so the turn's own history goes to the other model, as it does
// when the owner switches a session's model: the new model's tools and prompt are made for its
// family, and it is told that the model changed. A model that takes no tools is no target, as it is
// none for a successor.
//
// How the leading harnesses treat it (Claude Code docs, model-config "fallback model chains",
// read 2026-11-23; the rest in research/provider-outage.md): Claude Code switches to a fallback
// model on an overloaded or unavailable model, for subagents too, for the current turn only, never
// on a transport error; Codex has no switch for capacity; OpenCode documents none. None lets the
// owner say "when a route has been out for N minutes, move background agents to another provider",
// and none moves for good: here the agent that moved finishes where it is.
import { registerSettings } from "../admin/settings.ts";
import { asksFirst } from "./switch-rule.ts";

export type Rule = {
  // The agent type the rule is for, as its definition names it ("" or "*": every agent).
  role: string;
  // How long the route has been out (a provider that cannot be reached) or has answered overloaded.
  minutes: number;
  // The listed model the agent goes on on.
  to: string;
  // The provider the rule is for ("" or absent: any provider).
  from?: string;
};

export const providerOf = (model: string): string => model.slice(0, Math.max(0, model.indexOf(":")));

export function check(v: any): string | undefined {
  if (!Array.isArray(v?.rules)) return "rules must be a list";
  for (const [i, r] of v.rules.entries()) {
    const at = `rule ${i + 1}`;
    if (!r || typeof r !== "object" || Array.isArray(r)) return `${at} must be an object`;
    if (typeof r.role !== "string") return `${at}: role must be text (empty for every agent)`;
    if (typeof r.minutes !== "number" || !Number.isFinite(r.minutes) || r.minutes <= 0) return `${at}: minutes must be a number above 0`;
    if (typeof r.to !== "string" || !providerOf(r.to) || r.to.length <= providerOf(r.to).length + 1) return `${at}: to must be a model id, provider:model`;
    if (r.from !== undefined && (typeof r.from !== "string" || r.from.includes(":"))) return `${at}: from must be a provider id`;
    if (r.from && r.from === providerOf(r.to)) return `${at}: the model must be on another provider than the one it leaves`;
  }
  return undefined;
}

registerSettings("route_change", { rules: [] as Rule[] }, check);

const everyone = (role: string) => role.trim() === "" || role.trim() === "*";
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// The rule that holds for an agent of type `role` on `provider`: one that names its type over one
// that names every agent, then one that names the provider over one that names any; the first in
// the list among equals. None for a session that is no agent (`role` undefined), and none whose
// model is on the provider already.
export function ruleFor(rules: readonly Rule[], role: string | undefined, provider: string): Rule | undefined {
  if (role === undefined) return undefined;
  let best: Rule | undefined;
  let score = -1;
  for (const r of rules) {
    if (!everyone(r.role) && !same(r.role, role)) continue;
    if (r.from && r.from !== provider) continue;
    if (providerOf(r.to) === provider) continue;
    const s = (everyone(r.role) ? 0 : 2) + (r.from ? 1 : 0);
    if (s > score) { best = r; score = s; }
  }
  return best;
}

// How long until the rule's time is up for a route out since `since`; 0 when it is.
export const dueIn = (rule: Pick<Rule, "minutes">, since: number, now: number): number => Math.max(0, since + Math.round(rule.minutes * 60_000) - now);

export type Target = { id: string; name: string; provider: string; tools?: boolean };
// What the target is judged by: the provider that is out, the providers that cannot be reached
// now, the models that answer overloaded now, and why the target's route is shut (out of credit or
// signed out), if it is.
export type TargetFacts = { out: string; down: readonly string[]; busy: readonly string[]; shut?: string };
export type Judged = { ok: true; model: Target } | { ok: false; why: string };

// Whether the rule's model is somewhere the agent can go on now.
export function judge(rule: Pick<Rule, "to">, listing: readonly Target[], f: TargetFacts): Judged {
  const m = listing.find((x) => x.id === rule.to);
  if (!m) return { ok: false, why: `${rule.to} is not in the listing` };
  if (m.provider === f.out) return { ok: false, why: `${m.name} is on the provider that is out` };
  if (m.tools === false) return { ok: false, why: `${m.name} takes no tools` };
  if (f.down.includes(m.provider)) return { ok: false, why: `the provider of ${m.name} cannot be reached either` };
  if (f.busy.includes(m.id)) return { ok: false, why: `${m.name} answers that it is overloaded too` };
  if (f.shut) return { ok: false, why: `the route of ${m.name} takes no work: ${f.shut}` };
  return { ok: true, model: m };
}

// What the move costs and whether it fits, judged as the owner's own model switch is (the picker's
// question, asksFirst in src/engine/switch-rule.ts) but with nobody to ask: an agent cannot be asked,
// so a move that would ask is not made, and why is said once in its failures. `warning`: what the
// switch loses of a warm cache (switchWarning), null when nothing warm is lost; `over`: the context
// is past where the target compacts; `askUsd`: the owner's "ask before a switch that adds this much".
export type MoveFacts = { warning: { cost_usd?: number; cached_cost_usd?: number } | null; over: boolean; askUsd: number };
export type Moved = { ok: true; extra?: number } | { ok: false; why: string };

export const dollars = (x: number): string => (x >= 0.01 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`);

export function judgeMove(f: MoveFacts, target: string): Moved {
  if (f.over) return { ok: false, why: `its context does not fit ${target} without compacting first, and an agent cannot be asked` };
  const a = asksFirst({ lost: f.warning, over: false, askUsd: f.askUsd });
  if (a.ask && a.why === "unpriced") return { ok: false, why: `the move would lose the warm cache and ${target} lists no price, so its cost cannot be shown to be small, and an agent cannot be asked` };
  if (a.ask) return { ok: false, why: `the move would cost ${dollars(a.extra_usd ?? 0)} more than staying, past the ${dollars(f.askUsd)} the owner asks before a model switch, and an agent cannot be asked` };
  return { ok: true, ...(a.extra_usd ? { extra: a.extra_usd } : {}) };
}

export type Why = "outage" | "overloaded";
export const span = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
const was = (o: { why: Why; from: string; ms: number }) => (o.why === "outage" ? `the provider of ${o.from} could not be reached for ${span(o.ms)}` : `${o.from} answered that it is overloaded for ${span(o.ms)}`);

// What the move changed besides the model: the effort it carries (to the nearest the target lists)
// and what re-reading the context there costs past staying.
export type Carried = { effort?: { from?: string; to?: string }; extra?: number };
const carried = (o: Carried) => {
  const e = o.effort && o.effort.from !== o.effort.to ? o.effort : undefined;
  const effort = e ? (e.to ? ` Effort ${e.from} is now ${e.to}.` : ` The model does not take effort ${e.from}: it runs at its default.`) : "";
  const cost = o.extra ? ` Re-reading its context there costs about ${dollars(o.extra)} more than staying.` : "";
  return `${effort}${cost}`;
};

// What the agent's own transcript says.
export const noteText = (o: { why: Why; from: string; to: string; ms: number } & Carried): string =>
  `${was(o)[0]!.toUpperCase()}${was(o).slice(1)}. By the owner's rule for a route that is out, this agent continues on ${o.to} from here and finishes there.${carried(o)}`;

// The one line its parent hears, with its next input.
export const parentLine = (o: { title: string; id: string; why: Why; from: string; to: string; ms: number } & Carried): string =>
  `[harness] Agent "${o.title}" (${o.id}) was waiting: ${was(o)}. By the owner's rule, Keel moved it to ${o.to} with its context; it finishes there.${carried(o)} Its report comes when it finishes: nothing to do.`;
