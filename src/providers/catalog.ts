// Model metadata joined onto what a provider's listing returns. The listing
// decides which models exist; this catalog (models.dev, the public catalog
// opencode and Hermes read) only adds name, window, output limit, efforts and
// price. It never adds a model the listing did not return, except for an
// endpoint that has no listing at all and names its catalog section.
import { join } from "node:path";
import type { Price } from "./types.ts";

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
};

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
    price: c && typeof c.input === "number" && typeof c.output === "number"
      ? { input: c.input, output: c.output, cache_read: c.cache_read, cache_write: c.cache_write }
      : undefined,
  };
}

export class Catalog {
  private byId = new Map<string, CatalogEntry>();
  private byProvider = new Map<string, Map<string, CatalogEntry>>();
  private loaded = 0;

  constructor(private cacheDir: string) {}

  async load(): Promise<void> {
    if (Date.now() - this.loaded < MAX_AGE && this.byId.size) return;
    const file = Bun.file(join(this.cacheDir, "models-dev.json"));
    let text: string | null = null;
    try {
      const r = await fetch(URL_, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) {
        text = await r.text();
        await Bun.write(file, text);
      }
    } catch {}
    if (!text && (await file.exists())) text = await file.text();
    if (!text) return;
    const doc = JSON.parse(text) as Record<string, { models?: Record<string, any> }>;
    this.byId.clear();
    this.byProvider.clear();
    // First-party providers first so their entry wins over resellers'.
    const order = ["anthropic", "openai", "google", "xai", ...Object.keys(doc)];
    for (const pid of new Set(order)) {
      const section = new Map<string, CatalogEntry>();
      for (const [id, m] of Object.entries(doc[pid]?.models ?? {})) {
        const e = entry(id, m);
        section.set(id, e);
        if (!this.byId.has(id)) this.byId.set(id, e);
      }
      this.byProvider.set(pid, section);
    }
    this.loaded = Date.now();
  }

  section(pid: string): CatalogEntry[] {
    return [...(this.byProvider.get(pid)?.values() ?? [])];
  }

  // Bedrock and resellers decorate ids: `global.anthropic.claude-x-v1:0`,
  // `anthropic/claude-x`, `accounts/fireworks/models/x`, dated suffixes. Try
  // the provider's own section first (its price is the one paid), then the id
  // as given, then the bare model name.
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
