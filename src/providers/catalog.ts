// Model metadata joined onto what a provider's listing returns. The listing
// decides which models exist; this catalog (models.dev, the public catalog
// opencode and Hermes read) only adds name, window, output limit, efforts.
// It never adds a model the listing did not return.
import { join } from "node:path";

export type CatalogEntry = {
  name: string;
  family?: string;
  context?: number;
  output?: number;
  efforts?: string[];
  release?: string;
  reasoning?: boolean;
  tools?: boolean;
  images?: boolean;
};

const URL_ = process.env.KEEL_MODELS_DEV_URL ?? "https://models.dev/api.json";
const MAX_AGE = 24 * 3600_000;

export class Catalog {
  private byId = new Map<string, CatalogEntry>();
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
    // First-party providers first so their entry wins over resellers'.
    const order = ["anthropic", "openai", "google", "xai", ...Object.keys(doc)];
    for (const pid of new Set(order)) {
      for (const [id, m] of Object.entries(doc[pid]?.models ?? {})) {
        if (this.byId.has(id)) continue;
        this.byId.set(id, {
          name: m.name ?? id,
          family: m.family,
          context: m.limit?.context,
          output: m.limit?.output,
          efforts: m.reasoning_options?.find((o: any) => o.type === "effort")?.values,
          release: m.release_date,
          reasoning: m.reasoning,
          tools: m.tool_call,
          images: m.modalities?.input?.includes("image"),
        });
      }
    }
    this.loaded = Date.now();
  }

  // Bedrock and resellers decorate ids: `global.anthropic.claude-x-v1:0`,
  // dated suffixes. Try the id as given, then the bare model name.
  lookup(id: string): CatalogEntry | undefined {
    const tries = [id];
    const bare = id.replace(/^(global|us|eu|apac|jp|au)\./, "").replace(/^[a-z]+\./, "");
    tries.push(bare, bare.replace(/-v\d+(:\d+)?$/, ""), bare.replace(/-v\d+(:\d+)?$/, "").replace(/-\d{8}$/, ""));
    for (const t of tries) {
      const e = this.byId.get(t);
      if (e) return e;
    }
    return undefined;
  }
}
