// When each model was first returned by its provider's listing, per provider.
// The listing decides which models exist; this keeps the day a model first
// appeared in it, so a model that was not there before can be told apart from
// the ones the provider always listed.
//
// The first listings Keel reads for a provider are the baseline: BASELINE_LISTINGS of them, so a first
// answer that was partial does not make the rest of the catalog new when the full one comes. The
// models they return are known, not new. So is every model of the first listing for another account
// (a changed identity, including one that appears or goes) which starts a baseline again. A model a
// later listing returns that the provider never listed before is new, with the time of that listing.
// One that leaves the listing and comes back keeps its first date, so a flaky listing does not make old
// models new.
//
// A provider that learns its models in parts (an ACP agent states its models only once it was asked, one
// agent after the other, long after the baseline) names the part of a model (`batchOf`). The first models
// of a part that the listing has not returned before are known, not new: they are that part's baseline.
// A model a known part adds later is new.
export const BASELINE_LISTINGS = 2;

export type Seen = {
  baseline: number;                 // when the baseline began
  listings?: number;                // baseline listings read so far (none stored: the baseline is done)
  identity?: string;                // the account the listing was made for
  models: Record<string, number>;   // model -> first time listed
  dismissed?: string[];             // new models the owner put away
};

// How long a new model stays news after it first listed.
export const NEWS_DAYS = 14;

export function noteListing(prev: Seen | undefined, models: readonly string[], now: number, identity?: string, batchOf?: (model: string) => string | undefined): { seen: Seen; added: string[] } {
  const known = (at: number, from: Record<string, number> = {}) => {
    const out = { ...from };
    for (const m of models) if (!(m in out)) out[m] = at;
    return out;
  };
  if (!prev) return { seen: { baseline: now, listings: 1, ...(identity ? { identity } : {}), models: known(now) }, added: [] };
  // Another account lists what it lists: a new baseline, never news.
  if (prev.identity !== identity) return { seen: { ...prev, baseline: now, listings: 1, identity, models: known(now, prev.models) }, added: [] };
  const base = prev.listings ?? BASELINE_LISTINGS;
  if (base < BASELINE_LISTINGS) return { seen: { ...prev, listings: base + 1, models: known(prev.baseline, prev.models) }, added: [] };
  const fresh = models.filter((m) => !(m in prev.models));
  if (!fresh.length) return { seen: prev, added: [] };
  // The parts the listing had before this one: a model of another part is that part's first.
  const had = new Set(batchOf ? Object.keys(prev.models).flatMap((m) => batchOf(m) ?? []) : []);
  const opening = (m: string) => { const b = batchOf?.(m); return b !== undefined && !had.has(b); };
  const added = fresh.filter((m) => !opening(m));
  const out = { ...prev.models };
  for (const m of fresh) out[m] = opening(m) ? prev.baseline : now;
  return { seen: { ...prev, models: out }, added };
}

// The models that listed after the baseline, still news, newest first.
export function freshModels(seen: Seen | undefined, now: number): { model: string; first_seen: number }[] {
  if (!seen) return [];
  const gone = new Set(seen.dismissed);
  return Object.entries(seen.models)
    .filter(([m, t]) => t > seen.baseline && now - t <= NEWS_DAYS * 86_400_000 && !gone.has(m))
    .map(([model, first_seen]) => ({ model, first_seen }))
    .sort((a, b) => b.first_seen - a.first_seen || (a.model < b.model ? -1 : 1));
}

export function dismiss(seen: Seen, model: string): Seen {
  return seen.dismissed?.includes(model) ? seen : { ...seen, dismissed: [...(seen.dismissed ?? []), model] };
}
