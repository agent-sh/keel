// Every model comes from its provider's own listing, joined with the catalog.
// A provider whose listing fails keeps its last good list (also across
// restarts, in <state>/model-listings.json) and its error is recorded.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addUsage, emptyUsage, type Usage } from "../core/types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { brokerEnvFile } from "./broker-address.ts";
import { Catalog } from "./catalog.ts";
import { CodexProvider } from "./codex.ts";
import { endpoints } from "./config.ts";
import { familyOf } from "./family.ts";
import { EndpointProvider } from "./endpoint.ts";
import { MISSING_RECHECK_MS } from "./creds.ts";
import { GeminiProvider, OpenAIProvider } from "./keyed.ts";
import { Outages } from "./outage.ts";
import { unreachable } from "./unreachable.ts";
import { Probes } from "./probe.ts";
import { PluginProvider, Plugins } from "./plugins/index.ts";
import { priceOf } from "./pricing.ts";
import { NoKey, ProviderError } from "./http.ts";
import { fromHeaders, Limits, type Window } from "./limits.ts";
import { ScriptedProvider, scriptedEnabled } from "./scripted.ts";
import type { ListedModel, ModelInfo, Provider, ProviderRequest, ProviderStatus, SpeedOffer } from "./types.ts";
import { XaiProvider } from "./xai.ts";
import { AcpProvider } from "../acp/agents.ts";
import { runMode } from "../core/runmode.ts";

const LISTING_MAX_AGE = 30 * 60_000;

// The models.dev section that prices each built-in route.
const SECTION: Record<string, string> = {
  bedrock: "amazon-bedrock", anthropic: "anthropic", openai: "openai", chatgpt: "openai", gemini: "google", grok: "xai",
};

export class ModelLookupError extends Error {
  constructor(message: string, readonly listingFailed = false) { super(message); }
}

export type Listing = { state: "ok" | "failed" | "saved" | "never"; fetched?: number; error?: string; models: ListedModel[]; identity?: string };
// The owner's picks: the default, models hidden per provider, whole providers
// hidden from the picker, and favorites (full ids, in the owner's order).
export type Choices = { default?: string; hidden: Record<string, string[]>; hidden_providers?: string[]; pinned?: string[] };

// An account state the owner has to act on: a refused credential, or turns
// refused over billing. Kept (also across restarts) until a call succeeds, so
// Settings says it once instead of every turn failing anew.
export type Problem = { kind: "auth" | "billing"; message: string; at: number; source: "listing" | "turn"; link?: string };

// Keep each provider's listing timeouts in their own recoverable group.
const timeoutGroup = (id: string) => `provider listing timeout: ${Bun.hash(id).toString(16).replace(/\d/g, (n) => String.fromCharCode(103 + Number(n)))}`;
const USAGE_MAX_AGE = 60_000;

type ListingResult = { ok: true } | { ok: false; error: unknown };

type Opts = { capture?: (source: "provider", e: unknown, ctx?: unknown, at?: { recovered?: true; group?: string }) => void; recover?: (group: string) => void; providers?: Provider[] };

// A key read this recently is not read again by the refresh that asked for it.
const JUST_LOOKED_MS = 1000;
// How long a report of the providers waits for the keys' first looks.
export const LOOK_WAIT_MS = 3000;

export class Providers {
  readonly catalog: Catalog;
  readonly xai = new XaiProvider();
  readonly plugins: Plugins;
  private builtins: Provider[];
  private listings = new Map<string, Listing>();
  private refreshedAt = 0;
  // Per provider: the newest refresh started, and the newest whose answer was
  // applied. A slower, older answer never replaces a newer one.
  private started = new Map<string, number>();
  private applied = new Map<string, number>();
  private pending: Promise<void> | null = null;
  private refreshing = new Map<string, { identity?: string; done: Promise<ListingResult> }>();
  private fixed: Provider[] | null;
  readonly limits = new Limits();
  private usageAt = new Map<string, number>();
  private problems = new Map<string, Problem>();
  readonly probes: Probes;
  // The providers that cannot be reached now, and the wait their sessions share (src/providers/outage.ts).
  readonly outages: Outages;
  private badFiles = new Set<string>();
  private brokerFile = brokerEnvFile();

  constructor(readonly stateDir: string, private opts: Opts = {}) {
    this.catalog = new Catalog(stateDir);
    this.probes = new Probes(stateDir, (e) => this.capture(e, { at: "provider-probes.json" }));
    this.fixed = opts.providers ?? null;
    this.outages = new Outages({ file: join(stateDir, "provider-outages.json"), probe: (id) => this.reach(id) });
    this.builtins = [
      new AnthropicProvider("bedrock"),
      new AnthropicProvider("anthropic"),
      new OpenAIProvider(),
      new CodexProvider(),
      new GeminiProvider(),
      this.xai,
      // ACP agents installed here (the registry and the owner's own entries), driven by src/acp/external.ts.
      new AcpProvider(stateDir),
      // Test-only, never listed unless the daemon starts with KEEL_SCRIPTED_PROVIDER=1.
      ...(scriptedEnabled() ? [new ScriptedProvider(stateDir)] : []),
    ];
    this.plugins = new Plugins(stateDir, (e, ctx) => this.capture(e, ctx));
    this.xai.onSignedIn = () => void this.refresh("grok");
    this.loadSaved();
    try { for (const [k, v] of Object.entries<Problem>(JSON.parse(readFileSync(this.problemsFile, "utf8")))) this.problems.set(k, v); } catch {}
  }

  // ---- account problems and limits ----

  private get problemsFile() { return join(this.stateDir, "provider-problems.json"); }

  problem(id: string): Problem | undefined {
    return this.problems.get(id);
  }

  // A refused credential or billing, from a listing or a turn; anything else is not an account state.
  private note(id: string, e: unknown, source: Problem["source"]) {
    // No key at all is a provider that is not set up, not a key that was refused.
    if (!(e instanceof ProviderError) || e instanceof NoKey) return;
    const billing = e.kind === "quota" && e.status !== 429;
    if (e.kind !== "auth" && !billing) return;
    const link = /https:\/\/[^\s"'<>)]+/.exec(e.message)?.[0]?.replace(/[.,]$/, "");
    const p: Problem = { kind: billing ? "billing" : "auth", message: e.message, at: Date.now(), source, link };
    const prev = this.problems.get(id);
    if (prev?.message === p.message && prev.source === p.source) return;
    this.problems.set(id, p);
    this.saveProblems();
  }

  private cleared(id: string, source?: Problem["source"]) {
    const p = this.problems.get(id);
    if (!p || (source && p.source !== source)) return;
    this.problems.delete(id);
    this.saveProblems();
  }

  private saveProblems() {
    try { writeFileSync(this.problemsFile, JSON.stringify(Object.fromEntries(this.problems))); } catch (e) { this.capture(e, { at: "saving provider-problems.json" }); }
  }

  // Every provider's windows: header readings from its answers, and the usage
  // endpoints asked again when their reading is older than a minute.
  async windows(force = false): Promise<Window[]> {
    const now = Date.now();
    await Promise.all(this.all().filter((p) => p.usage && p.available()).map(async (p) => {
      // A provider whose key nobody has read yet is asked once it is read: its
      // usage would wait on the key (a keyring that waits on an unlock, a
      // helper that hangs), and this answer with it. The look goes on.
      if (p.unread?.()) return void p.look?.();
      if (!force && now - (this.usageAt.get(p.id) ?? 0) < USAGE_MAX_AGE) return;
      this.usageAt.set(p.id, now);
      try {
        this.limits.record(p.id, await p.usage!());
      } catch (e) {
        this.note(p.id, e, "listing");
      }
    }));
    return this.limits.list();
  }

  private capture(e: unknown, ctx?: unknown) {
    this.opts.capture?.("provider", e, ctx);
  }

  start() {
    if (!this.fixed) this.plugins.load();
  }

  all(): Provider[] {
    if (this.fixed) return this.fixed;
    const own = endpoints((file, e) => {
      // A file that does not parse is said once, not on every read.
      if (this.badFiles.has(file)) return;
      this.badFiles.add(file);
      this.capture(e, { at: "reading an endpoint file", file });
    });
    return [...this.builtins, ...own.map((e) => new EndpointProvider(e)), ...this.plugins.providers()];
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
      for (const [id, l] of Object.entries<any>(d)) this.listings.set(id, { state: l.error && !l.models?.length ? "failed" : "saved", fetched: l.fetched, error: l.error, models: l.models ?? [], identity: l.identity });
    } catch (e) {
      this.capture(e, { at: "reading model-listings.json" });
    }
  }

  private persist() {
    const out: Record<string, { fetched?: number; error?: string; models: ListedModel[]; identity?: string }> = {};
    for (const [id, l] of this.listings) if (l.models.length || l.error) out[id] = { fetched: l.fetched, error: l.error, models: l.models, identity: l.identity };
    const tmp = `${this.savedFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, this.savedFile);
  }

  // The provider's listing, when it was made for the account and endpoint the
  // provider has now: a list saved under another key, sign-in or base URL is
  // not offered as this one's last known list.
  listing(id: string): Listing {
    const l = this.listings.get(id);
    if (!l) return { state: "never", models: [] };
    const now = this.get(id)?.identity?.();
    if (l.identity && now && l.identity !== now) return { state: "never", models: [] };
    return l;
  }

  listingFailure(id: string): string | undefined {
    const error = this.listing(id).error;
    if (!error) return;
    const label = this.get(id)?.label ?? id;
    const prefix = `${label}: `;
    return `${label}'s model listing failed: ${error.startsWith(prefix) ? error.slice(prefix.length) : error}`;
  }

  // Every provider has looked for its key once: from here on available()
  // is what was found, not the benefit of the doubt a key gets before its
  // first read. A report of the providers waits for this, for `withinMs` at
  // most (a keyring that waits on an unlock prompt, or a helper that hangs,
  // holds no answer back): false says some key is still being looked for, so
  // "available" may yet be that benefit of the doubt.
  looked(withinMs?: number): Promise<boolean> {
    const all = Promise.all(this.all().map((p) => p.look?.())).then(() => true);
    return withinMs === undefined ? all : Promise.race([all, Bun.sleep(withinMs).then(() => false)]);
  }

  // Asks every available provider (or the one named) for its listing again.
  async refresh(only?: string): Promise<void> {
    // The keys first, beside the catalog (a fetch that may take seconds): which
    // providers are set up does not wait for it.
    void this.looked();
    await this.catalog.load();
    if (!only && !this.fixed) this.plugins.load();
    if (!this.fixed) await this.plugins.settled();
    const asked = this.all().filter((p) => !only || p.id === only);
    await Promise.all(asked.map((p) => this.refreshProvider(p)));
    if (!only) this.refreshedAt = Date.now();
    try { this.persist(); } catch (e) { this.capture(e, { at: "saving model-listings.json" }); }
  }

  // A scoped refresh joins the same provider's work in a full refresh, not
  // the whole batch. After an account or endpoint changes, its old answer
  // still has to race by generation, not serve the new identity.
  private async refreshProvider(p: Provider): Promise<void> {
    // Its first look has ended (it began above).
    if (p.look) await p.look();
    // A key found missing before is looked for again: one saved since makes its
    // provider available. Not one found missing a moment ago (by the look above).
    await p.recheck?.(JUST_LOOKED_MS);
    if (!p.available()) return;
    await this.listOnce(p);
  }

  // Outage probes and both kinds of refresh share the same listing in flight.
  private listOnce(p: Provider): Promise<ListingResult> {
    const identity = p.identity?.();
    const active = this.refreshing.get(p.id);
    if (active && active.identity === identity) return active.done;
    const done = this.fetchListing(p, identity).finally(() => {
      if (this.refreshing.get(p.id)?.done === done) this.refreshing.delete(p.id);
    });
    this.refreshing.set(p.id, { identity, done });
    return done;
  }

  private async fetchListing(p: Provider, identity?: string): Promise<ListingResult> {
    const seq = (this.started.get(p.id) ?? 0) + 1;
    this.started.set(p.id, seq);
    // Keep address discovery inside the same in-flight listing as a model pick.
    await p.broker?.reread(this.brokerFile);
    const base = p.broker?.value;
    try {
      const models = p instanceof EndpointProvider && p.cfg.listing === false ? this.sectionModels(p) : await p.list();
      if ((this.applied.get(p.id) ?? 0) > seq) return { ok: true };
      this.applied.set(p.id, seq);
      this.listings.set(p.id, { state: "ok", fetched: Date.now(), models, identity });
      this.cleared(p.id, "listing");
      this.brokerAnswered(p, base);
      if (base === p.broker?.value && !(p instanceof EndpointProvider && p.cfg.listing === false)) {
        this.opts.recover?.(timeoutGroup(p.id));
        this.outages.answered(p.id);
      }
      return { ok: true };
    } catch (e) {
      p.broker?.noteRefusal(e);
      // A newer answer already landed: this older failure says nothing about it.
      if ((this.applied.get(p.id) ?? 0) > seq) return { ok: false, error: e };
      this.applied.set(p.id, seq);
      if (e instanceof NoKey) {
        // The first read of its key found none: the provider is not set up
        // (available() says so from here on). Nothing failed, nothing was
        // refused, so no error is recorded and an earlier one is dropped.
        const last = this.listing(p.id);
        if (last.models.length) this.listings.set(p.id, { ...last, state: "saved", error: undefined });
        else this.listings.delete(p.id);
        this.cleared(p.id, "listing");
        return { ok: false, error: e };
      }
      const error = (e as Error).message;
      // The last good list as it is now (not as it was when this refresh began).
      const prev = this.listing(p.id);
      this.listings.set(p.id, { state: "failed", fetched: prev.fetched, error, models: prev.models, identity: prev.identity ?? identity });
      // A failed listing during a known outage belongs to its shared error row.
      const timedOut = !!(e as { listingTimeout?: boolean })?.listingTimeout;
      const outage = (unreachable(e) || timedOut) && this.outages.known(p.id);
      if (prev?.error !== error && !outage) {
        this.opts.capture?.("provider", e, { provider: p.id, at: "listing" }, timedOut ? { group: timeoutGroup(p.id) } : undefined);
      }
      this.note(p.id, e, "listing");
      return { ok: false, error: e };
    }
  }

  // An endpoint without a listing offers the models of its catalog section
  // (a draft's connection test shows the same list).
  sectionModels(p: EndpointProvider): ListedModel[] {
    return this.catalog.section(p.cfg.catalog ?? "").filter((c) => c.tools !== false).map((c) => ({
      model: c.id, family: familyOf(c.id), billing: p.cfg.billing === "subscription" ? { kind: "subscription", plan: p.label } : { kind: "per_token" },
    }));
  }

  private join(p: Provider, m: ListedModel): ModelInfo {
    const ep = p instanceof EndpointProvider ? p : undefined;
    const section = ep ? ep.cfg.catalog : p instanceof PluginProvider ? p.catalog : SECTION[p.id];
    const c = this.catalog.lookup(m.model, section);
    const own = this.catalog.own(m.model, section);
    const billing = m.billing?.kind ?? (ep?.cfg.billing === "subscription" ? "subscription" : "per_token");
    // What the owner states about the model, then what a probe found.
    const said = ep?.cfg.model?.[m.model] ?? {};
    const probed = this.probes.get(`${p.id}:${m.model}`, p.identity?.())?.found ?? {};
    const known_from: NonNullable<ModelInfo["known_from"]> = {};
    const cap = (k: "tools" | "images" | "reasoning" | "caching", listed: boolean | undefined, catalog: boolean | undefined) => {
      const v: [boolean | undefined, "owner" | "probe" | "listing" | "catalog"][] = [[said[k], "owner"], [probed[k]?.value, "probe"], [listed, "listing"], [catalog, "catalog"]];
      const hit = v.find(([x]) => x !== undefined);
      if (hit) known_from[k] = hit[1];
      return hit?.[0];
    };
    return {
      id: `${p.id}:${m.model}`,
      provider: p.id,
      model: m.model,
      name: said.name ?? m.name ?? c?.name ?? m.model,
      family: m.family ?? familyOf(m.model, p.family),
      context: said.context ?? m.context ?? c?.context ?? 128_000,
      ...(said.context ?? m.context ?? c?.context ? {} : { context_assumed: true as const }),
      output: said.output ?? m.output ?? c?.output ?? 0,
      efforts: m.efforts ?? c?.efforts ?? [],
      release: c?.release,
      price: billing === "per_token" ? said.price ?? m.price ?? ep?.price ?? c?.price : undefined,
      billing,
      // A capability is the listing's or the route's own catalog entry. An entry
      // of another provider (the bare-id fallback) may say the model reads
      // images, never that this route does not: an unknown route sends them.
      images: cap("images", m.images, own ? own.images : c?.images || undefined),
      pdf: m.pdf ?? (own ? own.pdf : c?.pdf || undefined),
      tools: cap("tools", m.tools, own ? own.tools : c?.tools || undefined),
      reasoning: cap("reasoning", m.reasoning, own ? own.reasoning : c?.reasoning || undefined),
      caching: cap("caching", undefined, undefined),
      ...(Object.keys(known_from).length ? { known_from } : {}),
      // The listing's own offers win; else the route's catalog section's.
      speeds: m.speeds ?? own?.speeds,
      // A fact of the route: the catalog names it per provider (one model has
      // reasoning_content on one route, reasoning_details or nothing on
      // another). A route with a section takes only its own entry; one
      // without a section takes the entry the lookup found.
      interleaved: section ? own?.interleaved : c?.interleaved,
    };
  }

  async models(force = false): Promise<ModelInfo[]> {
    await this.catalog.ready();
    // A command's own daemon reads the stored listings; resolve() still asks one provider for a model they lack.
    if (!force && runMode.client && [...this.listings.values()].some((l) => l.models.length)) return this.current();
    if (force || Date.now() - this.refreshedAt > LISTING_MAX_AGE) {
      this.pending ??= this.refresh().finally(() => (this.pending = null));
      // A read waits only when no saved list can answer meanwhile (a first
      // start); else it answers from the last lists, marked saved.
      if (force || (!this.refreshedAt && !this.all().some((p) => p.available() && this.listing(p.id).models.length))) await this.pending;
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

  // Every listed model, the ones the owner hid marked (the picker finds
  // them by search, so they can be shown again).
  // `hidden_by` says which rule hides it: the model, its provider, or both.
  marked(models: ModelInfo[]): (ModelInfo & { hidden?: true; hidden_by?: "model" | "provider" | "both" })[] {
    const c = this.choices();
    const off = new Set(c.hidden_providers ?? []);
    return models.map((m) => {
      const p = off.has(m.provider), own = !!c.hidden[m.provider]?.includes(m.model);
      return p || own ? { ...m, hidden: true, hidden_by: p && own ? "both" : p ? "provider" : "model" } : m;
    });
  }

  // The default the owner or the configuration names; a fallback pick is not one.
  async namedDefault(c = this.choices()): Promise<string | undefined> {
    const want = (c.default ?? process.env.KEEL_DEFAULT_MODEL ?? process.env.ANTHROPIC_DEFAULT_MODEL)?.replace(/\[[^\]]*\]$/, "");
    if (!want) return undefined;
    const models = await this.models();
    return models.find((m) => m.id === want || m.model === want || m.model.endsWith(`.${want}`))?.id;
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
    // Else the newest model the owner has not hidden of the first provider
    // that is set up, in the order the providers are listed (the built-in
    // routes first): a new session never starts on a model taken out of the picker.
    const shown = this.marked(models).filter((m) => !m.hidden);
    for (const p of this.all()) {
      const own = shown.filter((m) => m.provider === p.id);
      if (own.length) return own[0]!.id;
    }
    return "";
  }

  statuses(): ProviderStatus[] {
    return this.all().map((p) => p.status?.() ?? { id: p.id, label: p.label ?? p.id, wire: p.wire ?? "anthropic_messages", kind: "builtin", available: p.available() });
  }

  // ---- requests ----

  // An endpoint without a listing uses its next waiting request as the probe.
  private async reach(id: string): Promise<void> {
    const p = this.get(id);
    if (!p || (p instanceof EndpointProvider && p.cfg.listing === false)) return;
    const result = await this.listOnce(p);
    if (!result.ok) throw result.error;
  }

  private brokerAnswered(p: Provider, base: string | undefined) {
    const moved = p.broker?.answered(base);
    // ErrorTracker writes the log and the recovered Errors row together.
    if (moved) this.opts.capture?.("provider", new Error(moved), { provider: p.id }, { recovered: true });
  }

  cachedModel(id: string): ModelInfo | undefined {
    const provider = this.get(id.slice(0, id.indexOf(":")));
    if (!provider?.available()) return;
    const listed = this.listing(provider.id).models.find((m) => m.model === id.slice(provider.id.length + 1));
    return listed && this.join(provider, listed);
  }

  async resolve(id: string, { scoped = false } = {}): Promise<{ provider: Provider; info: ModelInfo }> {
    const pid = id.slice(0, id.indexOf(":"));
    if (!this.fixed && pid.includes("/")) await this.plugins.settled();
    const provider = this.get(pid);
    // A key that could not be read a while ago (a locked keyring, one saved since) is read again before refusing.
    if (provider && !provider.available()) await provider.recheck?.(MISSING_RECHECK_MS);
    const label = scoped ? provider?.label ?? pid : pid;
    if (!provider?.available()) throw new ModelLookupError(`provider ${label} is not available`);
    // A switch only needs the named route. Do not ask unrelated providers
    // for their listings when the picker is ahead of this cache.
    if (scoped) await this.catalog.ready();
    let info = scoped ? this.cachedModel(id) : (await this.models()).find((m) => m.id === id);
    if (!info) {
      // A model the last list does not hold may be new: ask that provider once.
      await this.refresh(pid);
      info = scoped ? this.cachedModel(id) : this.current().find((m) => m.id === id);
    }
    if (!info) {
      if (scoped) {
        const failure = this.listingFailure(pid);
        if (failure) throw new ModelLookupError(failure, true);
        if (!this.get(pid)?.available()) throw new ModelLookupError(`provider ${label} is not available`);
      }
      throw new ModelLookupError(`model ${id} is not in ${label}'s listing`);
    }
    return { provider: this.wrap(provider, info), info };
  }

  // What every request gets from the listing (efforts, a stated output limit)
  // and every answer from the catalog (its price, the origin of its blocks).
  private wrap(p: Provider, info: ModelInfo): Provider {
    return {
      id: p.id,
      family: info.family,
      wire: p.wireOf?.(info.model) ?? p.wire,
      caching: p.caching,
      label: p.label,
      available: () => p.available(),
      list: () => p.list(),
      stream: async (req: ProviderRequest, onDelta) => {
        const offer = speedOffer(info, req.speed);
        const base = p.broker?.value;
        let sawHeaders = false;
        const onHeaders = (h: Headers) => {
          sawHeaders = true;
          const r = fromHeaders(h);
          if (r.length) this.limits.record(p.id, r);
          req.onHeaders?.(h);
        };
        // The provider answered: an outage of it is over, and what waited for it goes (once a request).
        let told = false;
        const onAnswer = () => {
          if (told) return;
          told = true;
          // A response from the retired port cannot recover the new one.
          if (base === p.broker?.value) {
            this.brokerAnswered(p, base);
            if (this.outages.known(p.id)) this.opts.recover?.(timeoutGroup(p.id));
            this.outages.answered(p.id);
          }
          req.onAnswer?.();
        };
        let res: Awaited<ReturnType<Provider["stream"]>>;
        try {
          res = await p.stream({
            // (A warm request asks for the least output it can: it is read, not answered.)
            ...req, onHeaders, onAnswer, efforts: info.efforts, maxTokens: req.purpose === "warm" && req.maxTokens ? req.maxTokens : info.output || undefined, interleaved: info.interleaved,
            extraBody: offer ? { ...req.extraBody, ...offer.body } : req.extraBody,
            extraHeaders: offer?.headers ? { ...req.extraHeaders, ...offer.headers } : req.extraHeaders,
          }, (d) => { onAnswer(); onDelta(d); });
        } catch (e) {
          // Once a reply began, even a claimed connect error is bounded. A
          // broker's explicit HTTP refusal can have headers but no model reply.
          const status = (e as ProviderError)?.status;
          if (unreachable(e) && (told || (sawHeaders && !status))) {
            throw new ProviderError("network", `the stream broke: ${(e as Error).message}`);
          }
          // Only an API reply or successful listing releases unrelated waiters.
          p.broker?.noteRefusal(e);
          this.note(p.id, e, "turn");
          throw e;
        }
        onAnswer();
        this.cleared(p.id);
        const origin = `${p.id}:${req.model}`;
        for (const b of res.blocks) if ((b.type === "thinking" || b.type === "tool_use" || b.type === "text") && !b.origin && (b.type === "thinking" || b.signature)) b.origin = origin;
        const tier = servedTier(info, offer, res.served);
        res.usage = priced(res.usage, tier.offer?.price ? { ...info, price: tier.offer.price } : info);
        if (offer) res.usage.speed_asked = offer.id;
        if (tier.reported) res.usage.speed = tier.reported;
        return res;
      },
    };
  }

  shutdown() {
    this.outages.stop();
    this.plugins.stopAll();
  }
}

// The model's offer for a session's speed choice: by id, else one of the same
// label (a session moved from a model whose "Fast" is `priority` to one whose
// is `fast`); none means standard.
export function speedOffer(info: ModelInfo, want?: string) {
  if (!want) return undefined;
  const all = info.speeds ?? [];
  return all.find((o) => o.id === want) ?? all.find((o) => o.label.toLowerCase() === want.toLowerCase());
}

// The tier a call is billed at. The provider's own word wins when it names
// standard or one of the model's offers (`service_tier`, `usage.speed`); a
// reply that names nothing, or a tier this route does not list, is estimated at
// the offer asked for, and `speed` stays unset, so the record says the tier
// was asked for, not confirmed.
export function servedTier(info: ModelInfo, asked: SpeedOffer | undefined, served?: string): { offer?: SpeedOffer; reported?: string } {
  if (served === undefined) return { offer: asked };
  if (/^(default|standard|auto)$/.test(served)) return { reported: "standard" };
  const hit = (info.speeds ?? []).find((o) => o.id === served || o.body.service_tier === served || o.body.speed === served);
  return hit ? { offer: hit, reported: hit.id } : { offer: asked };
}

function priced(u: Usage, info: ModelInfo): Usage {
  const out = addUsage(emptyUsage(), u);
  const cost = priceOf(u, info.price);
  if (cost !== undefined) out.cost = cost;
  else if (info.billing !== "subscription") out.unpriced = 1;
  else out.cost = undefined;
  return out;
}
