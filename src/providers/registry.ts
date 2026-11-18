// Every model comes from its provider's own listing, joined with the catalog.
// A provider whose listing fails keeps its last good list (also across
// restarts, in <state>/model-listings.json) and its error is recorded.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addUsage, emptyUsage, type Usage } from "../core/types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { Catalog } from "./catalog.ts";
import { CodexProvider } from "./codex.ts";
import { endpoints } from "./config.ts";
import { familyOf } from "./family.ts";
import { CompatProvider, GeminiProvider, OpenAIProvider } from "./keyed.ts";
import { Plugins } from "./plugins/index.ts";
import { priceOf } from "./pricing.ts";
import type { ListedModel, ModelInfo, Provider, ProviderRequest, ProviderStatus } from "./types.ts";
import { XaiProvider } from "./xai.ts";

const LISTING_MAX_AGE = 30 * 60_000;

// The models.dev section that prices each built-in route.
const SECTION: Record<string, string> = {
  bedrock: "amazon-bedrock", anthropic: "anthropic", openai: "openai", chatgpt: "openai", gemini: "google", grok: "xai",
};

export type Listing = { state: "ok" | "failed" | "saved" | "never"; fetched?: number; error?: string; models: ListedModel[] };
export type Choices = { default?: string; hidden: Record<string, string[]> };

type Opts = { capture?: (source: "provider", e: unknown, ctx?: unknown) => void; providers?: Provider[] };

export class Providers {
  readonly catalog: Catalog;
  readonly xai = new XaiProvider();
  readonly plugins: Plugins;
  private builtins: Provider[];
  private listings = new Map<string, Listing>();
  private refreshedAt = 0;
  private pending: Promise<void> | null = null;
  private fixed: Provider[] | null;

  constructor(private stateDir: string, private opts: Opts = {}) {
    this.catalog = new Catalog(stateDir);
    this.fixed = opts.providers ?? null;
    this.builtins = [
      new AnthropicProvider("bedrock"),
      new AnthropicProvider("anthropic"),
      new OpenAIProvider(),
      new CodexProvider(),
      new GeminiProvider(),
      this.xai,
    ];
    this.plugins = new Plugins(stateDir, (e, ctx) => this.capture(e, ctx));
    this.xai.onSignedIn = () => void this.refresh("grok");
    this.loadSaved();
  }

  private capture(e: unknown, ctx?: unknown) {
    this.opts.capture?.("provider", e, ctx);
  }

  start() {
    if (!this.fixed) this.plugins.load();
  }

  all(): Provider[] {
    if (this.fixed) return this.fixed;
    return [...this.builtins, ...endpoints().map((e) => new CompatProvider(e)), ...this.plugins.providers()];
  }

  get(id: string) {
    return this.all().find((p) => p.id === id);
  }

  // ---- listings ----

  private get savedFile() { return join(this.stateDir, "model-listings.json"); }

  private loadSaved() {
    try {
      if (!existsSync(this.savedFile)) return;
      const d = JSON.parse(readFileSync(this.savedFile, "utf8"));
      for (const [id, l] of Object.entries<any>(d)) this.listings.set(id, { state: l.error && !l.models?.length ? "failed" : "saved", fetched: l.fetched, error: l.error, models: l.models ?? [] });
    } catch (e) {
      this.capture(e, { at: "reading model-listings.json" });
    }
  }

  private persist() {
    const out: Record<string, { fetched?: number; error?: string; models: ListedModel[] }> = {};
    for (const [id, l] of this.listings) if (l.models.length || l.error) out[id] = { fetched: l.fetched, error: l.error, models: l.models };
    const tmp = `${this.savedFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, this.savedFile);
  }

  listing(id: string): Listing {
    return this.listings.get(id) ?? { state: "never", models: [] };
  }

  // Asks every available provider (or the one named) for its listing again.
  async refresh(only?: string): Promise<void> {
    await this.catalog.load();
    if (!only && !this.fixed) this.plugins.load();
    if (!this.fixed) await this.plugins.settled();
    const targets = this.all().filter((p) => (!only || p.id === only) && p.available());
    await Promise.all(targets.map(async (p) => {
      const prev = this.listings.get(p.id);
      try {
        const models = p instanceof CompatProvider && p.cfg.listing === false ? this.fromSection(p) : await p.list();
        this.listings.set(p.id, { state: "ok", fetched: Date.now(), models });
      } catch (e) {
        const error = (e as Error).message;
        this.listings.set(p.id, { state: "failed", fetched: prev?.fetched, error, models: prev?.models ?? [] });
        // Recorded once: the same failure on every refresh is one error.
        if (prev?.error !== error) this.capture(e, { provider: p.id, at: "listing" });
      }
    }));
    if (!only) this.refreshedAt = Date.now();
    try { this.persist(); } catch (e) { this.capture(e, { at: "saving model-listings.json" }); }
  }

  // An endpoint without a listing offers the models of its catalog section.
  private fromSection(p: CompatProvider): ListedModel[] {
    return this.catalog.section(p.cfg.catalog!).filter((c) => c.tools !== false).map((c) => ({
      model: c.id, family: familyOf(c.id), billing: p.cfg.billing === "subscription" ? { kind: "subscription", plan: p.label } : { kind: "per_token" },
    }));
  }

  private join(p: Provider, m: ListedModel): ModelInfo {
    const section = p instanceof CompatProvider ? p.cfg.catalog : SECTION[p.id];
    const c = this.catalog.lookup(m.model, section);
    const billing = m.billing?.kind ?? (p instanceof CompatProvider && p.cfg.billing === "subscription" ? "subscription" : "per_token");
    return {
      id: `${p.id}:${m.model}`,
      provider: p.id,
      model: m.model,
      name: m.name ?? c?.name ?? m.model,
      family: m.family ?? familyOf(m.model, p.family),
      context: m.context ?? c?.context ?? 128_000,
      output: m.output ?? c?.output ?? 0,
      efforts: m.efforts ?? c?.efforts ?? [],
      release: c?.release,
      price: billing === "per_token" ? m.price ?? c?.price : undefined,
      billing,
      images: m.images ?? c?.images,
    };
  }

  async models(force = false): Promise<ModelInfo[]> {
    if (force || Date.now() - this.refreshedAt > LISTING_MAX_AGE) {
      this.pending ??= this.refresh().finally(() => (this.pending = null));
      // A first read waits; later reads answer from the last lists meanwhile.
      if (force || !this.refreshedAt) await this.pending;
    }
    return this.current();
  }

  current(): ModelInfo[] {
    const out: ModelInfo[] = [];
    const rank = new Map<string, number>();
    for (const p of this.all()) {
      if (!p.available()) continue;
      rank.set(p.id, rank.size);
      for (const m of this.listing(p.id).models) out.push(this.join(p, m));
    }
    // Newest first; among equals the provider listed first (the built-in routes).
    out.sort((a, b) => (b.release ?? "").localeCompare(a.release ?? "") || rank.get(a.provider)! - rank.get(b.provider)! || a.name.localeCompare(b.name));
    return out;
  }

  // ---- choices ----

  private get choicesFile() { return join(this.stateDir, "model-choices.json"); }

  choices(): Choices {
    try {
      return { hidden: {}, ...JSON.parse(readFileSync(this.choicesFile, "utf8")) };
    } catch {
      return { hidden: {} };
    }
  }

  // The models the picker shows: what the owner did not hide.
  visible(models: ModelInfo[]): ModelInfo[] {
    const h = this.choices().hidden;
    return models.filter((m) => !h[m.provider]?.includes(m.model));
  }

  setChoices(c: Choices) {
    writeFileSync(this.choicesFile, JSON.stringify(c, null, 2));
  }

  // The owner's choice, else the configured variable (the one Claude Code reads).
  async defaultModel(configured?: string): Promise<string> {
    const models = await this.models();
    // Claude Code's variable may carry a context suffix (`[1m]`).
    const want = (configured ?? this.choices().default ?? process.env.KEEL_DEFAULT_MODEL ?? process.env.ANTHROPIC_DEFAULT_MODEL)?.replace(/\[[^\]]*\]$/, "");
    if (want) {
      const hit = models.find((m) => m.id === want || m.model === want || m.model.endsWith(`.${want}`));
      if (hit) return hit.id;
    }
    // Else the newest model of the first provider that is set up, in the
    // order the providers are listed (the built-in routes first).
    for (const p of this.all()) {
      const own = models.filter((m) => m.provider === p.id);
      if (own.length) return own[0]!.id;
    }
    return "";
  }

  statuses(): ProviderStatus[] {
    return this.all().map((p) => p.status?.() ?? { id: p.id, label: p.label ?? p.id, wire: p.wire ?? "anthropic_messages", kind: "builtin", available: p.available() });
  }

  // ---- requests ----

  async resolve(id: string): Promise<{ provider: Provider; info: ModelInfo }> {
    const pid = id.slice(0, id.indexOf(":"));
    if (!this.fixed && pid.includes("/")) await this.plugins.settled();
    const provider = this.get(pid);
    if (!provider || !provider.available()) throw new Error(`provider ${pid} is not available`);
    let info = (await this.models()).find((m) => m.id === id);
    if (!info) {
      // A model the last list does not hold may be new: ask that provider once.
      await this.refresh(pid);
      info = this.current().find((m) => m.id === id);
    }
    if (!info) throw new Error(`model ${id} is not in ${pid}'s listing`);
    return { provider: this.wrap(provider, info), info };
  }

  // What every request gets from the listing (efforts, a stated output limit)
  // and every answer from the catalog (its price, the origin of its blocks).
  private wrap(p: Provider, info: ModelInfo): Provider {
    return {
      id: p.id,
      family: info.family,
      wire: p.wire,
      label: p.label,
      available: () => p.available(),
      list: () => p.list(),
      stream: async (req: ProviderRequest, onDelta) => {
        const res = await p.stream({ ...req, efforts: info.efforts, maxTokens: info.output || undefined }, onDelta);
        const origin = `${p.id}:${req.model}`;
        for (const b of res.blocks) if ((b.type === "thinking" || b.type === "tool_use" || b.type === "text") && !b.origin && (b.type === "thinking" || b.signature)) b.origin = origin;
        res.usage = priced(res.usage, info);
        return res;
      },
    };
  }

  shutdown() {
    this.plugins.stopAll();
  }
}

function priced(u: Usage, info: ModelInfo): Usage {
  const out = addUsage(emptyUsage(), u);
  const cost = priceOf(u, info.price);
  if (cost !== undefined) out.cost = cost;
  else if (info.billing !== "subscription") out.unpriced = 1;
  else out.cost = undefined;
  return out;
}
