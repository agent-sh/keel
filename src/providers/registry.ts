import { AnthropicProvider } from "./anthropic.ts";
import { Catalog } from "./catalog.ts";
import type { ModelInfo, Provider } from "./types.ts";

const LISTING_MAX_AGE = 30 * 60_000;

export class Providers {
  private list: Provider[];
  private cache: { at: number; models: ModelInfo[] } | null = null;
  private pending: Promise<ModelInfo[]> | null = null;
  readonly catalog: Catalog;

  constructor(cacheDir: string, extra: Provider[] = []) {
    this.catalog = new Catalog(cacheDir);
    this.list = [new AnthropicProvider("bedrock"), new AnthropicProvider("anthropic"), ...extra];
  }

  async models(force = false): Promise<ModelInfo[]> {
    if (!force && this.cache && Date.now() - this.cache.at < LISTING_MAX_AGE) return this.cache.models;
    this.pending ??= this.refresh().finally(() => (this.pending = null));
    return this.pending;
  }

  private async refresh(): Promise<ModelInfo[]> {
    await this.catalog.load();
    const lists = await Promise.allSettled(
      this.list.filter((p) => p.available()).map(async (p) => ({ p, models: await p.list() })),
    );
    const out: ModelInfo[] = [];
    for (const r of lists) {
      if (r.status !== "fulfilled") continue; // the last good list stays below
      const { p, models } = r.value;
      for (const m of models) {
        const c = this.catalog.lookup(m.model);
        out.push({
          id: `${p.id}:${m.model}`,
          provider: p.id,
          model: m.model,
          name: m.name ?? c?.name ?? m.model,
          family: p.family,
          context: m.context ?? c?.context ?? 200_000,
          output: m.output ?? c?.output ?? 32_000,
          efforts: m.efforts ?? c?.efforts ?? [],
          release: c?.release,
        });
      }
    }
    out.sort((a, b) => (b.release ?? "").localeCompare(a.release ?? "") || a.name.localeCompare(b.name));
    if (out.length || !this.cache) this.cache = { at: Date.now(), models: out };
    return this.cache.models;
  }

  // The owner's own configured default (the same variable Claude Code reads),
  // else the newest listed model.
  async defaultModel(configured?: string): Promise<string> {
    const models = await this.models();
    const want = configured ?? process.env.KEEL_DEFAULT_MODEL ?? process.env.ANTHROPIC_DEFAULT_MODEL;
    if (want) {
      const hit = models.find((m) => m.id === want || m.model === want || m.model.endsWith(`.${want}`));
      if (hit) return hit.id;
    }
    return models[0]?.id ?? "";
  }

  async resolve(id: string): Promise<{ provider: Provider; info: ModelInfo }> {
    const pid = id.slice(0, id.indexOf(":"));
    const provider = this.list.find((p) => p.id === pid);
    if (!provider || !provider.available()) throw new Error(`provider ${pid} is not available`);
    const info = (await this.models()).find((m) => m.id === id);
    if (!info) throw new Error(`model ${id} is not in ${pid}'s listing`);
    return { provider, info };
  }
}
