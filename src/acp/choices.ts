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
// A boolean config option (offered only to a client that says it shows them: session.configOptions.boolean).
// `current` is unknown after a resume that stated nothing.
export type Switch = { id: string; name: string; description?: string; current?: boolean };
export type AgentChoices = { models?: ChoiceSet; modes?: ChoiceSet; efforts?: ChoiceSet; switches?: Switch[] };
// What was learned of one agent: under which program (`key`), when, and what failed if it did.
// `commands`: the slash commands it last advertised.
export type Learned = AgentChoices & { key: string; at: number; error?: string; commands?: SlashCommand[] };

// An agent's slash commands as it advertised them (ACP v1 slash-commands): a name the message box can take
// (`/name`, then free text), what it does, and the hint for its input.
export type SlashCommand = { name: string; description: string; hint?: string };
export function commandsOf(list: unknown): SlashCommand[] {
  if (!Array.isArray(list)) return [];
  const out: SlashCommand[] = [];
  for (const c of list.slice(0, 200)) {
    const name = typeof c?.name === "string" ? c.name.replace(/^\//, "") : "";
    if (!/^[\w:.-]{1,64}$/.test(name) || out.some((x) => x.name === name)) continue;
    const hint = typeof c.input?.hint === "string" && c.input.hint.trim() ? c.input.hint.trim().slice(0, 80) : undefined;
    out.push({ name, description: typeof c.description === "string" ? c.description.replace(/\s+/g, " ").trim().slice(0, 200) : "", ...(hint ? { hint } : {}) });
  }
  return out;
}


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
  const switches = opts.filter((x) => x?.type === "boolean" && typeof (x.id ?? x.configId) === "string" && typeof x.currentValue === "boolean").slice(0, 50)
    .map((x): Switch => ({ id: String(x.id ?? x.configId), name: typeof x.name === "string" && x.name ? x.name : String(x.id ?? x.configId), ...(typeof x.description === "string" && x.description ? { description: x.description } : {}), current: x.currentValue }));
  if (models) out.models = models;
  if (modes) out.modes = modes;
  if (efforts) out.efforts = efforts;
  if (switches.length) out.switches = switches;
  return out;
}

// What a setup result says on top of what was known. Config options and
// modes are optional in session/load and session/resume results: a result
// that states neither changes nothing, and one that states only one kind
// keeps the other as it was. A config option list is the agent's whole
// state (session-config-options: "the complete configuration state"), so
// the sets it is the source of are taken from it as they are.
export function mergeChoices(prev: AgentChoices, result: Json): AgentChoices {
  const next = choicesOf(result);
  const config = Array.isArray(result?.configOptions), legacy = result?.modes && Array.isArray(result.modes.availableModes);
  const out: AgentChoices = {};
  const models = config ? next.models : prev.models;
  const efforts = config ? next.efforts : prev.efforts;
  // Modes: a config mode option when the list has one, else the older modes the result states, else what was known.
  const modes = next.modes?.via === "config" ? next.modes : legacy ? next.modes : config && prev.modes?.via === "config" ? undefined : prev.modes;
  const switches = config ? next.switches : prev.switches;
  if (models) out.models = models;
  if (modes) out.modes = modes;
  if (efforts) out.efforts = efforts;
  if (switches) out.switches = switches;
  return out;
}

// The same sets with nothing known to be current: what a fresh connection to
// a session the agent resumed without saying its options holds, so the
// session's own choice is sent to it rather than taken for granted.
export function unknownCurrent(c: AgentChoices): AgentChoices {
  const out: AgentChoices = {};
  for (const k of ["models", "modes", "efforts"] as const) if (c[k]) out[k] = { ...c[k]!, current: "" };
  if (c.switches) out.switches = c.switches.map(({ current: _, ...s }) => s);
  return out;
}

// Modes that loosen what the agent may do without asking (a bypass of its
// own permission checks): Keel's gate decides that, so none is offered as a
// model of the agent. Read from the agent's own words for the mode.
const LOOSENS = /bypass|yolo|dangerous|brave|skip[\s_-]?(permission|confirm|approv)|no[\s_-]?approval|auto[\s_-]?approv|without (asking|approval|confirm)|full[\s_-]?access|dont[\s_-]?ask|don't ask/i;
export const offeredModes = (set: ChoiceSet): Choice[] => set.options.filter((o) => !LOOSENS.test(`${o.value} ${o.name} ${o.description ?? ""}`));
// A switch about what the agent may do without the owner (asking, approving, confirming, permissions, trust,
// the sandbox, the network, acting by itself), in either direction ("Ask before running commands" too): Keel's
// permission mode and sandbox decide that, so the owner does not set it here, and one the agent has on is
// turned off. Read from the agent's own words for it, word by word (an id's parts too: auto_execute, autoApprove).
const HOLDS = /(^|[^a-z])(ask|asks|asking|approv\w*|confirm\w*|permission\w*|prompt\w*|trust\w*|sandbox\w*|network\w*|auto\w*|accept\w*|allow\w*|unattended|bypass\w*|yolo|dangerous\w*|brave|freely|unrestricted|full access|without)(?![a-z])/i;
const words = (t: string) => t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
export const heldSwitch = (s: Switch): boolean => HOLDS.test(words(`${s.id} ${s.name} ${s.description ?? ""}`)) || LOOSENS.test(`${s.id} ${s.name} ${s.description ?? ""}`);

// The choices after the agent sent its whole config option list again (a
// set_config_option result, a config_option_update): the older session modes
// stay as they were when no option is a mode.
export function withOptions(prev: AgentChoices, configOptions: Json[]): AgentChoices {
  const next = choicesOf({ configOptions });
  return !next.modes && prev.modes?.via === "mode" ? { ...next, modes: prev.modes } : next;
}

// The choices a session picks from the picker: models when the agent offers them, else its modes.
// Modes stand in only with what they offer (offeredModes).
export const pickable = (c: AgentChoices | undefined): ChoiceSet | undefined => c?.models ?? (c?.modes ? { ...c.modes, options: offeredModes(c.modes) } : undefined);

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
// And each switch the owner set (`switches`, by id) that differs from the agent's (a held one never).
export function settle(c: AgentChoices, want: { choice?: string; effort?: string; switches?: Record<string, boolean> }): { method: string; params: Json }[] {
  const out: { method: string; params: Json }[] = [];
  const set = pickable(c);
  if (want.choice && set && set.current !== want.choice && set.options.some((o) => o.value === want.choice))
    out.push(set.via === "config" ? { method: "session/set_config_option", params: { configId: set.configId, value: want.choice } } : { method: "session/set_mode", params: { modeId: want.choice } });
  const e = c.efforts;
  if (want.effort && e && e.via === "config" && e.current !== want.effort && e.options.some((o) => o.value === want.effort))
    out.push({ method: "session/set_config_option", params: { configId: e.configId, value: want.effort } });
  for (const s of c.switches ?? []) {
    // (A held one is turned off when the agent has it on, or may: after a resume its value is not known.)
    const v = heldSwitch(s) ? false : want.switches?.[s.id];
    if (typeof v === "boolean" && v !== s.current) out.push({ method: "session/set_config_option", params: { configId: s.id, type: "boolean", value: v } });
  }
  return out;
}
