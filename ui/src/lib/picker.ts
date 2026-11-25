// The model picker's lists, apart from the menu so they can be checked alone.
// Nothing here names a model: it all comes from the listings.
import type { ListedModel } from "./store.ts";

export type Item = {
  value: string; label: string; model: string; provider: string; providerLabel: string;
  context: number; vision?: boolean; pdf?: boolean; plan: boolean; hidden?: "model" | "provider" | "both"; key: string; hay: string;
  // What a screen reader says: the name and where it goes.
  aria: string;
  // The ACP agent a route belongs to (`agent` or `agent/choice` under the ACP provider).
  agent?: string;
  // Why it cannot answer now (an ACP agent whose probe failed), in a few words.
  unavailable?: string;
};
// `sub`: one agent of the ACP provider, folded to its own row under a header that opens it (`folded`, absent while searching); `total` is
// the models the agent offers besides itself.
export type Group = { value: string; label: string; provider?: string; plan?: boolean; total: number; items: Item[]; sub?: boolean; folded?: boolean };

// The provider whose models are the agents an ACP runner drives and each agent's own choices.
export const ACP_PROVIDER = "acp";

// A provider group shows this many models until it is opened or searched.
export const CAP = 6;
export const RECENT = 5;

export function buildItems(models: ListedModel[], labels: Record<string, string>) {
  // Two providers under one label (two keys of one vendor): the route id tells them apart.
  const seen = new Map<string, Set<string>>();
  for (const m of models) {
    const l = labels[m.provider] ?? m.provider;
    (seen.get(l) ?? seen.set(l, new Set()).get(l)!).add(m.provider);
  }
  const labelOf = (p: string) => {
    const l = labels[p] ?? p;
    return (seen.get(l)?.size ?? 0) > 1 && l !== p ? `${l} (${p})` : l;
  };
  const item = (m: ListedModel): Item => {
    const providerLabel = labelOf(m.provider);
    return {
      value: m.id, label: m.name, model: m.model, provider: m.provider, providerLabel,
      context: m.context, vision: m.images, pdf: m.pdf, plan: m.billing === "subscription",
      hidden: m.hidden ? (m.hidden_by ?? "model") : undefined,
      key: m.id, hay: `${m.name} ${m.model} ${providerLabel} ${m.provider} ${m.id}`.toLowerCase(),
      aria: `${m.name}, ${providerLabel}`,
      ...(m.provider === ACP_PROVIDER ? { agent: m.model.split("/")[0] } : {}),
      ...(m.unavailable ? { unavailable: m.unavailable } : {}),
    };
  };
  // A later entry of one program (an ACP agent the listing holds twice) is not offered; a session on it still names its model.
  const every = models.map(item);
  const byId = new Map(every.map((i) => [i.value, i]));
  const all = every.filter((_, n) => !models[n]!.same_as);
  return { all, byId, labelOf };
}

// Provider order: the default's provider, then plans, then by label.
export function providerOrder(all: Item[], def: string, labelOf: (p: string) => string) {
  const plan = new Set(all.filter((i) => i.plan).map((i) => i.provider));
  const defP = all.find((i) => i.value === def)?.provider;
  return [...new Set(all.map((i) => i.provider))].sort((a, b) =>
    Number(b === defP) - Number(a === defP) || Number(plan.has(b)) - Number(plan.has(a)) || labelOf(a).localeCompare(labelOf(b)));
}

// With no query: favorites, recent picks, then one group per provider,
// each folded to its newest few. A query searches every model: an exact
// route id comes first, the hidden ones last so they can be shown again.
export function buildGroups(o: {
  query: string; all: Item[]; byId: Map<string, Item>; order: string[]; pinned: string[]; recent: string[];
  expanded: Set<string>; labelOf: (p: string) => string;
}): Group[] {
  const raw = o.query.trim().toLowerCase();
  const q = raw.split(/\s+/).filter(Boolean);
  const hit = (i: Item) => q.every((t) => i.hay.includes(t));
  const pins = o.pinned.map((id) => o.byId.get(id)).filter((i): i is Item => !!i);
  const pinSet = new Set(o.pinned);
  const out: Group[] = [];
  const add = (value: string, label: string, items: Item[]) => items.length && out.push({ value, label, items, total: items.length });
  const perProvider = (pool: Item[], fold: boolean) => {
    const by = new Map<string, Item[]>();
    for (const i of pool) (by.get(i.provider) ?? by.set(i.provider, []).get(i.provider)!).push(i);
    for (const p of o.order) {
      const list = by.get(p);
      if (!list) continue;
      if (p === ACP_PROVIDER) {
        // One header an agent: the agent's own row, and its models once the header is opened (or searched).
        const by = new Map<string, Item[]>();
        for (const i of list) (by.get(i.agent!) ?? by.set(i.agent!, []).get(i.agent!)!).push(i);
        for (const [agent, items] of by) {
          const value = `agent:${agent}`, head = items.find((i) => i.model === agent), choices = items.filter((i) => i !== head).length;
          const folded = fold && choices > 0 && !o.expanded.has(value);
          out.push({ value, label: head?.label ?? agent, provider: p, plan: items.some((i) => i.plan), total: choices, sub: true, ...(fold && choices > 0 ? { folded } : {}), items: folded ? items.filter((i) => i === head) : items });
        }
        continue;
      }
      const folded = fold && !o.expanded.has(p) && list.length > CAP + 2;
      out.push({ value: p, label: o.labelOf(p), provider: p, plan: list.some((i) => i.plan), total: list.length, items: folded ? list.slice(0, CAP) : list });
    }
  };
  if (!q.length) {
    add("favorites", "Favorites", pins.filter((i) => !i.hidden));
    const recent = [...new Set(o.recent)].map((id) => o.byId.get(id)).filter((i): i is Item => !!i && !i.hidden && !pinSet.has(i.value)).slice(0, RECENT);
    add("recent", "Recent", recent);
    perProvider(o.all.filter((i) => !i.hidden), true);
  } else {
    const exact = o.all.find((i) => i.value.toLowerCase() === raw);
    const found = o.all.filter((i) => i !== exact && hit(i));
    if (exact) add("exact", exact.hidden ? "Exact id (hidden)" : "Exact id", [exact]);
    add("favorites", "Favorites", pins.filter((i) => i !== exact && !i.hidden && hit(i)));
    perProvider(found.filter((i) => !i.hidden && !pinSet.has(i.value)), false);
    add("hidden", "Hidden", found.filter((i) => i.hidden));
  }
  return out;
}

// The figure beside the search field: what is offered with no query, what
// matched while searching. Distinct models, so a favorite listed twice is one.
export function countLabel(query: string, all: Item[], groups: Group[]): string {
  if (!query.trim()) {
    const n = all.filter((i) => !i.hidden).length;
    return `${n} available`;
  }
  const shown = new Set<string>(), hidden = new Set<string>();
  for (const g of groups) for (const i of g.items) (i.hidden ? hidden : shown).add(i.value);
  for (const id of shown) hidden.delete(id);
  const n = shown.size, h = hidden.size;
  if (!n && !h) return "No matches";
  if (!n) return `${h} hidden ${h === 1 ? "match" : "matches"}`;
  return `${n} ${n === 1 ? "match" : "matches"}${h ? ` · ${h} hidden` : ""}`;
}

// `/model <words>`: an exact route id picks that route; otherwise the best
// match wins only when no other route scores the same.
export function resolveModelArg(arg: string, models: ListedModel[], score: (q: string, text: string) => number):
  { id: string } | { tie: string[] } | { none: true } {
  const a = arg.trim();
  const exact = models.find((m) => m.id === a);
  if (exact) return { id: exact.id };
  const scored = models.map((m) => ({ m, s: score(a, `${m.name} ${m.id}`) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
  if (!scored.length) return { none: true };
  const top = scored.filter((x) => x.s === scored[0]!.s);
  if (top.length > 1) return { tie: top.map((x) => x.m.id).sort() };
  return { id: scored[0]!.m.id };
}

// Why a hidden row is hidden, and what its show buttons do.
export function hiddenReason(i: Item): string | undefined {
  if (i.hidden === "both") return "Provider and model hidden";
  if (i.hidden === "provider") return "Provider hidden";
  if (i.hidden === "model") return "Hidden";
  return undefined;
}
