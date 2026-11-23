// What an ACP agent lets a session choose, as Keel's model listing shows it.
// ACP has no model list outside a session: an agent states its choices in the
// result of session/new, load and resume, as session config options
// (agentclientprotocol.com/protocol/v1/session-config-options: a select of
// category "model", one of category "thought_level", one of category "mode")
// or, from agents older than config options, as `modes` (session-modes). A
// session changes one with session/set_config_option or session/set_mode.
//
// The listing follows the rule every provider does: a model exists when the
// agent states it. Each agent is listed as itself (`acp:<agent>`, whatever it
// picks), and each model it offers as `acp:<agent>/<value>`; an agent with no
// model choice offers its modes there instead. Its reasoning levels are the
// efforts of each of its models. What an agent stated is kept per agent and
// program (choices.json beside the state), learned again from every session
// it opens.
import type { ListedModel } from "../providers/types.ts";

type Json = any;
export type Choice = { value: string; name: string; description?: string };
// How a choice is made: a config option by its id, or the older session mode.
export type ChoiceSet = { via: "config"; configId: string; name: string; current: string; options: Choice[] } | { via: "mode"; name: string; current: string; options: Choice[] };
export type AgentChoices = { models?: ChoiceSet; modes?: ChoiceSet; efforts?: ChoiceSet };
// What was learned of one agent: under which program (`key`), when, and what failed if it did.
export type Learned = AgentChoices & { key: string; at: number; error?: string };

// The values of a select, its groups flattened in order.
function values(options: Json): Choice[] {
  const out: Choice[] = [];
  for (const o of Array.isArray(options) ? options : []) {
    if (Array.isArray(o?.options)) out.push(...values(o.options));
    else if (o && typeof o.value === "string") out.push({ value: o.value, name: typeof o.name === "string" && o.name ? o.name : o.value, ...(typeof o.description === "string" && o.description ? { description: o.description } : {}) });
  }
  return out;
}

// The choices a session setup result states. The first select of a category
// wins (the agent orders its options by priority); a select with no values is
// no choice. Config options come first; `modes` only when no mode option is given.
export function choicesOf(result: Json): AgentChoices {
  const out: AgentChoices = {};
  const opts: Json[] = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const pick = (category: string): ChoiceSet | undefined => {
    const o = opts.find((x) => x?.category === category && (x.type ?? "select") === "select" && typeof (x.id ?? x.configId) === "string" && values(x.options).length);
    return o ? { via: "config", configId: String(o.id ?? o.configId), name: String(o.name ?? category), current: String(o.currentValue ?? ""), options: values(o.options) } : undefined;
  };
  const models = pick("model"), efforts = pick("thought_level");
  let modes = pick("mode");
  const legacy = result?.modes;
  if (!modes && Array.isArray(legacy?.availableModes)) {
    const options = legacy.availableModes.filter((m: Json) => typeof m?.id === "string").map((m: Json) => ({ value: m.id, name: typeof m.name === "string" && m.name ? m.name : m.id, ...(m.description ? { description: String(m.description) } : {}) }));
    if (options.length) modes = { via: "mode", name: "Mode", current: String(legacy.currentModeId ?? ""), options };
  }
  if (models) out.models = models;
  if (modes) out.modes = modes;
  if (efforts) out.efforts = efforts;
  return out;
}

// The choices after the agent sent its whole config option list again (a
// set_config_option result, a config_option_update): the older session modes
// stay as they were when no option is a mode.
export function withOptions(prev: AgentChoices, configOptions: Json[]): AgentChoices {
  const next = choicesOf({ configOptions });
  return !next.modes && prev.modes?.via === "mode" ? { ...next, modes: prev.modes } : next;
}

// The choices a session picks from the picker: models when the agent offers them, else its modes.
export const pickable = (c: AgentChoices | undefined): ChoiceSet | undefined => c?.models ?? c?.modes;

// `acp:<agent>/<value>` as its agent and its choice. An agent id holds no slash
// (registry ids are slugs, the owner's entries are checked on add); a value may.
export function splitModel(model: string): { agent: string; choice?: string } {
  const i = model.indexOf("/");
  return i < 0 ? { agent: model } : { agent: model.slice(0, i), choice: model.slice(i + 1) };
}

// The listing of one agent: itself, then each of its choices.
export function listedOf(agent: { id: string; name: string }, c?: AgentChoices): ListedModel[] {
  const base = { billing: { kind: "subscription" as const, plan: agent.name }, images: true, ...(c?.efforts ? { efforts: c.efforts.options.map((o) => o.value) } : {}) };
  const out: ListedModel[] = [{ model: agent.id, name: agent.name, ...base }];
  const set = pickable(c);
  for (const o of set?.options ?? []) out.push({ model: `${agent.id}/${o.value}`, name: `${agent.name}: ${o.name}`, ...base });
  return out;
}

// The requests that bring a live agent session to what the Keel session wants:
// its choice (when the model names one) and its effort (when the agent has
// reasoning levels and the effort is one of them). Nothing when it is there already.
export function settle(c: AgentChoices, want: { choice?: string; effort?: string }): { method: string; params: Json }[] {
  const out: { method: string; params: Json }[] = [];
  const set = pickable(c);
  if (want.choice && set && set.current !== want.choice && set.options.some((o) => o.value === want.choice))
    out.push(set.via === "config" ? { method: "session/set_config_option", params: { configId: set.configId, value: want.choice } } : { method: "session/set_mode", params: { modeId: want.choice } });
  const e = c.efforts;
  if (want.effort && e && e.via === "config" && e.current !== want.effort && e.options.some((o) => o.value === want.effort))
    out.push({ method: "session/set_config_option", params: { configId: e.configId, value: want.effort } });
  return out;
}
