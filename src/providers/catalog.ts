// Model metadata joined onto what a provider's listing returns. The listing
// decides which models exist; this catalog (models.dev, the public catalog
// opencode and Hermes read) only adds name, window, output limit, efforts and
// price. It never adds a model the listing did not return, except for an
// endpoint that has no listing at all and names its catalog section.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Price, SpeedOffer } from "./types.ts";

export type CatalogEntry = {
  id: string;
  name: string;
  family?: string;
  context?: number;
  output?: number;
  efforts?: string[];
  release?: string;
  reasoning?: boolean;
  tools?: boolean;
  images?: boolean;
  price?: Price;
  speeds?: SpeedOffer[];
};

const num = (x: any) => typeof x === "number";

// models.dev `cost`, with its context tiers (`tiers`, or the older
// `context_over_200k`).
function priceOf(c: any): Price | undefined {
  if (!c || !num(c.input) || !num(c.output)) return undefined;
  const p: Price = { input: c.input, output: c.output, cache_read: c.cache_read, cache_write: c.cache_write };
  const raw: any[] = Array.isArray(c.tiers) ? c.tiers : c.context_over_200k ? [{ ...c.context_over_200k, tier: { type: "context", size: 200_000 } }] : [];
  const tiers = raw
    .filter((t) => t?.tier?.type === "context" && num(t.tier.size) && num(t.input) && num(t.output))
    .map((t) => ({ above: t.tier.size, input: t.input, output: t.output, cache_read: t.cache_read, cache_write: t.cache_write }))
    .sort((a, b) => a.above - b.above);
  if (tiers.length) p.tiers = tiers;
  return p;
}

// models.dev `experimental.modes` that only change the speed tier (a body with
// `service_tier` or `speed`); other modes (a reasoning "pro") are not speeds.
function speedsOf(m: any): SpeedOffer[] | undefined {
  const modes = m.experimental?.modes;
  if (!modes || typeof modes !== "object") return undefined;
  const out: SpeedOffer[] = [];
  for (const [id, mode] of Object.entries<any>(modes)) {
    const body = mode?.provider?.body;
    if (!body || typeof body !== "object" || !Object.keys(body).length || !Object.keys(body).every((k) => k === "service_tier" || k === "speed")) continue;
    out.push({ id, label: id[0]!.toUpperCase() + id.slice(1), price: priceOf(mode.cost), body, headers: mode.provider.headers });
  }
  return out.length ? out : undefined;
}

const URL_ = process.env.KEEL_MODELS_DEV_URL ?? "https://models.dev/api.json";
const MAX_AGE = 24 * 3600_000;

function entry(id: string, m: any): CatalogEntry {
  const c = m.cost;
  return {
    id,
    name: m.name ?? id,
    family: m.family,
    context: m.limit?.context,
    output: m.limit?.output,
    efforts: m.reasoning_options?.find((o: any) => o.type === "effort")?.values,
    release: m.release_date,
    reasoning: m.reasoning,
    tools: m.tool_call,
    images: m.modalities?.input?.includes("image"),
    price: priceOf(c),
    speeds: speedsOf(m),
  };
}

// The full document to its sections, first-party providers first so their
// entry wins over resellers' (section order is kept in the saved copy).
type Sections = Record<string, Record<string, CatalogEntry>>;
const SHAPE = String(Bun.hash(entry.toString() + priceOf.toString() + speedsOf.toString()));

function compact(doc: Record<string, { models?: Record<string, any> }>): Sections {
  const out: Sections = {};
  for (const pid of new Set(["anthropic", "openai", "google", "xai", ...Object.keys(doc)])) {
    const models: Record<string, CatalogEntry> = {};
    for (const [id, m] of Object.entries(doc[pid]?.models ?? {})) {
      const { id: _id, ...rest } = entry(id, m);
      models[id] = rest as CatalogEntry;
    }
    out[pid] = models;
  }
  return out;
}

export class Catalog {
  private byId = new Map<string, CatalogEntry>();
  private byProvider = new Map<string, Map<string, CatalogEntry>>();
  private loaded = 0;

  constructor(private cacheDir: string) {}

  // The catalog is saved compact: only the fields above, per section. Parsing
  // the full models.dev document (several MB) costs tens of MB of resident
  // memory that the allocator keeps; a start reads the small copy instead and
  // the full document is parsed only when the copy is a day old.
  async load(): Promise<void> {
    if (Date.now() - this.loaded < MAX_AGE && this.byId.size) return;
    const file = Bun.file(join(this.cacheDir, "models-dev.compact.json"));
    const full = join(this.cacheDir, "models-dev.json"); // the earlier full copy, read once if nothing else is there
    let saved: { shape?: string; sections?: Sections } | null = null;
    if (await file.exists()) try { saved = JSON.parse(await file.text()); } catch {}
    // A copy made by another version of entry() lacks its fields: fetch again.
    const fresh = saved?.shape === SHAPE && Date.now() - file.lastModified < MAX_AGE;
    let sections: Sections | null = fresh ? saved!.sections ?? null : null;
    if (!sections) {
      try {
        const r = await fetch(URL_, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) sections = compact(JSON.parse(await r.text()));
      } catch {}
      if (!sections && !saved && existsSync(full)) {
        try { sections = compact(JSON.parse(readFileSync(full, "utf8"))); } catch {}
      }
      if (sections) {
        await Bun.write(file, JSON.stringify({ shape: SHAPE, sections }));
        rmSync(full, { force: true });
      }
    }
    sections ??= saved?.sections ?? null;
    if (!sections) return;
    this.byId.clear();
    this.byProvider.clear();
    for (const [pid, models] of Object.entries(sections)) {
      const section = new Map<string, CatalogEntry>();
      for (const [id, e] of Object.entries(models)) {
        const en = { ...e, id };
        section.set(id, en);
        if (!this.byId.has(id)) this.byId.set(id, en);
      }
      this.byProvider.set(pid, section);
    }
    this.loaded = fresh ? file.lastModified : Date.now();
  }

  section(pid: string): CatalogEntry[] {
    return [...(this.byProvider.get(pid)?.values() ?? [])];
  }

  // Bedrock and resellers decorate ids: `global.anthropic.claude-x-v1:0`,
  // `anthropic/claude-x`, `accounts/fireworks/models/x`, dated suffixes. Try
  // the provider's own section first (its price is the one paid), then the id
  // as given, then the bare model name.
  // Only the route's own section: its speed offers are the ones that route sells.
  own(id: string, section?: string): CatalogEntry | undefined {
    return section ? this.byProvider.get(section)?.get(id) : undefined;
  }

  lookup(id: string, section?: string): CatalogEntry | undefined {
    const own = section ? this.byProvider.get(section)?.get(id) : undefined;
    if (own) return own;
    const tries = [id];
    const bare = id.replace(/^(global|us|eu|apac|jp|au)\./, "").replace(/^[a-z]+\./, "").replace(/^.*\//, "");
    const noVer = bare.replace(/-v\d+(:\d+)?$/, "");
    tries.push(bare, noVer, noVer.replace(/-\d{8}$/, ""), bare.replace(/:[a-z]+$/, ""));
    for (const t of tries) {
      const e = this.byId.get(t);
      if (e) return e;
    }
    return undefined;
  }
}
