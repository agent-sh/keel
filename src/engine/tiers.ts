// The owner's agent tiers (the setting `agents.tiers`, Settings > Models): a short table of a tier's
// name, the listed model it runs on, its effort, and the agent types or task kinds that use it. A spawn
// that names no model starts on its tier: the one the spawn names, else the one its type's definition
// names, else one that lists its type, else the reader tier for an Explore agent, else the tier for
// every other agent. A tier whose model does not list (or takes no work now) gives way to the next one
// down the table, and the spawn's result says so. Pure: the listing and the route check come in.
// Nothing here names a model: the table is the owner's, and it starts empty.

export type Tier = { name: string; model: string; effort?: string; use?: string[] };

// What a spawn is started on, and why, in words its result carries.
export type TierPick = { tier: string; model: string; effort?: string; why: string; passed: string[] };

// The words a tier lists that mean every agent no other tier takes.
const EVERY = new Set(["default", "*", "every", "all", "other"]);
// The tier readers and Explore agents use.
export const READER_TIER = "reader";
// How many rows a table holds at most, and how long a name or a word of it is.
export const TIERS_MAX = 20;
const WORD_MAX = 60;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const uses = (t: Tier, word: string) => (t.use ?? []).some((u) => same(u, word));

// Why a table is not one (the setting's check), or undefined.
export function tiersProblem(v: unknown): string | undefined {
  if (!Array.isArray(v)) return "tiers is a list of { name, model, effort?, use? }";
  if (v.length > TIERS_MAX) return `tiers holds at most ${TIERS_MAX} rows`;
  const seen = new Set<string>();
  for (const t of v) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return "each tier is { name, model, effort?, use? }";
    for (const k of Object.keys(t)) if (!["name", "model", "effort", "use"].includes(k)) return `a tier has no field ${k}`;
    if (typeof t.name !== "string" || !t.name.trim() || t.name.length > WORD_MAX) return `a tier's name is a word of up to ${WORD_MAX} characters`;
    if (seen.has(t.name.trim().toLowerCase())) return `two tiers are named ${t.name.trim()}`;
    seen.add(t.name.trim().toLowerCase());
    if (typeof t.model !== "string" || !t.model.trim()) return `tier ${t.name}: model is a listed model's id`;
    if (t.effort !== undefined && (typeof t.effort !== "string" || !t.effort.trim() || t.effort.length > WORD_MAX)) return `tier ${t.name}: effort is one of the model's efforts`;
    if (t.use !== undefined && (!Array.isArray(t.use) || t.use.some((u: unknown) => typeof u !== "string" || !u.trim() || u.length > WORD_MAX))) return `tier ${t.name}: use is a list of agent types or task kinds`;
  }
  return undefined;
}

export type TierAsk = {
  asked?: string;      // the tier (or a task kind a tier lists) the spawn names
  defTier?: string;    // the tier its type's definition names
  type: string;        // its agent type, as its definition names it
  explore?: boolean;   // a built-in Explore agent
  readOnly?: boolean;  // an agent that only reads (Explore, a read-only type): only such a one falls to the reader tier
};

// How a row was found: `every` is the tier for every other agent, which gives way to a trial's model (the caller's).
export type TierBy = "asked" | "def" | "type" | "explore" | "every";

// The row a spawn starts from, with why; undefined when the table says nothing of it. A tier the spawn
// names that the table lacks is an error the caller sees (it named it, as it would a model).
export function tierRow(tiers: readonly Tier[], o: TierAsk): { at: number; why: string; by: TierBy } | { error: string } | undefined {
  const find = (f: (t: Tier) => boolean) => tiers.findIndex(f);
  if (o.asked?.trim()) {
    const byName = find((t) => same(t.name, o.asked!));
    if (byName >= 0) return { at: byName, by: "asked", why: `the spawn names tier ${tiers[byName]!.name}` };
    const byKind = find((t) => uses(t, o.asked!));
    if (byKind >= 0) return { at: byKind, by: "asked", why: `the spawn names the kind ${o.asked.trim()}, which tier ${tiers[byKind]!.name} lists` };
    return { error: `no tier "${o.asked.trim()}" in agents.tiers; the tiers are ${tiers.length ? tiers.map((t) => t.name).join(", ") : "none (the owner has set none)"}. Omit tier, or name one of them` };
  }
  if (o.defTier?.trim()) {
    const at = find((t) => same(t.name, o.defTier!) || uses(t, o.defTier!));
    if (at >= 0) return { at, by: "def", why: `its type ${o.type} names tier ${tiers[at]!.name}` };
  }
  const byType = find((t) => uses(t, o.type));
  if (byType >= 0) return { at: byType, by: "type", why: `tier ${tiers[byType]!.name} lists the type ${o.type}` };
  if (o.explore) {
    const at = find((t) => same(t.name, READER_TIER));
    if (at >= 0) return { at, by: "explore", why: `Explore agents use the ${READER_TIER} tier` };
  }
  const every = find((t) => (t.use ?? []).some((u) => EVERY.has(u.trim().toLowerCase())));
  if (every >= 0) return { at: every, by: "every", why: `tier ${tiers[every]!.name} is for every other agent` };
  return undefined;
}

type Listed = { id: string; model: string; efforts?: string[] };

// The listed models a tier's model names: its id, else every provider's listing of its model as the provider names it.
export function listedOf(listed: readonly Listed[], model: string): Listed[] {
  const w = model.trim();
  const byId = listed.filter((m) => m.id === w);
  return byId.length ? byId : listed.filter((m) => m.model === w);
}

// The tier a spawn starts on: its row, else the next one down whose model lists and takes work
// (`blocked` says why one does not). Each row passed over is a line. Undefined: no row applies, or
// none from it down can take the work (`passed` then says why, for the caller's line).
export function pickTier(tiers: readonly Tier[], o: TierAsk, listed: readonly Listed[], blocked: (id: string) => string | undefined = () => undefined):
  { pick: TierPick; by: TierBy } | { error: string } | { none: string[] } | undefined {
  const row = tierRow(tiers, o);
  if (!row || "error" in row) return row;
  const passed: string[] = [];
  for (let i = row.at; i < tiers.length; i++) {
    const t = tiers[i]!;
    // Falling down the table stops before the reader tier for an agent that does more than read.
    if (i > row.at && !o.readOnly && same(t.name, READER_TIER)) { passed.push(`tier ${t.name} is for agents that only read`); continue; }
    const all = listedOf(listed, t.model);
    const whys = all.map((x) => blocked(x.id));
    const k = whys.findIndex((w) => !w);
    const m = k >= 0 ? all[k] : undefined;
    const why = !all.length ? "is not listed now" : !m ? [...new Set(whys)].join("; ") : undefined;
    if (why) { passed.push(`tier ${t.name}'s model ${t.model} ${why}`); continue; }
    const effort = t.effort?.trim() && (!m!.efforts || m!.efforts.includes(t.effort.trim())) ? t.effort.trim() : undefined;
    if (t.effort?.trim() && !effort) passed.push(`tier ${t.name}'s effort ${t.effort.trim()}: ${m!.id} does not list it`);
    const fell = i > row.at ? `, in place of tier ${tiers[row.at]!.name}` : "";
    return { pick: { tier: t.name, model: m!.id, ...(effort ? { effort } : {}), why: `${row.why}${fell}`, passed }, by: row.by };
  }
  return { none: passed };
}

// The spawn's result line for a pick.
export const tierLine = (p: TierPick) =>
  `Tier ${p.tier}: ${p.model}${p.effort ? ` at ${p.effort} effort` : ""}, because ${p.why}.${p.passed.length ? ` Not taken: ${p.passed.join("; ")}.` : ""}`;
