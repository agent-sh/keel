// One endpoint the owner configured (or a preset): any server that speaks one
// of the four wires, local or hosted, with or without a key. Its id is the
// provider id. The models come from the endpoint's own listing; what a local
// server says about each model there (window, tools, images, thinking) is
// read from its own metadata routes, never assumed.
import type { AuthStyle, EndpointConfig } from "./config.ts";
import { configured, fingerprint, forget, key, recheck, shown, sourceIdentity, type KeySource } from "./creds.ts";
import { ctxFor, httpEvents, runEvents } from "./drive.ts";
import { familyOf, notChat } from "./family.ts";
import { getJson, NoKey, ProviderError } from "./http.ts";
import { fromOpenRouterKey, type WindowReading } from "./limits.ts";
import type { Billing, Delta, ListedModel, Price, Provider, ProviderRequest, ProviderResult, ProviderStatus, Wire } from "./types.ts";
import { anthropicWire } from "./wires/anthropic.ts";
import { chatWire } from "./wires/chat.ts";
import { geminiWire } from "./wires/gemini.ts";
import { responsesWire } from "./wires/responses.ts";

const API_VERSION = "2026-10-21";

// The key header each wire's own vendor uses when the endpoint names none.
export const defaultAuth = (w: Wire): AuthStyle => (w === "anthropic_messages" ? "x-api-key" : w === "gemini_generate_content" ? "x-goog-api-key" : "bearer");

// The address the wire's paths go under. OpenAI-style bases end at their
// version (`/v1`, `/api/v1`, `/v4`); Anthropic and Gemini bases are the root
// the vendor's paths (`/v1/messages`, `/v1beta/models`) are added to, so a
// pasted `.../v1` or `.../v1beta` is taken off.
export function wireBase(wire: Wire, url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (wire === "anthropic_messages") return u.replace(/\/v1$/, "");
  if (wire === "gemini_generate_content") return u.replace(/\/v1(beta|alpha)?$/, "");
  return u;
}

// `{env:NAME}` and `{keyring:NAME}` in a header value, filled in when sent.
export const REF = /\{(env|keyring):([A-Za-z0-9_.-]+)\}/g;

// An Anthropic-style capability entry (`{ supported: true }`, or a bare boolean).
const said = (c: any): boolean | undefined => (typeof c === "boolean" ? c : typeof c?.supported === "boolean" ? c.supported : undefined);

const per = (x: any) => (x === undefined || x === null || x === "" || isNaN(Number(x)) ? undefined : Number(x) * 1e6);

// What a local server's own routes say about its models, by server kind.
type Meta = { server?: string; context?: number; tools?: boolean; images?: boolean; reasoning?: boolean };
const metaCache = new Map<string, { at: number; ids: string; meta: Map<string, Meta> }>();
// Gemini listings say per model whether it thinks; the stream asks for thoughts only then.
const thinks = new Map<string, boolean>();
const META_TTL = 10 * 60_000;

export class EndpointProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly wire: Wire;
  readonly family = "other" as const;
  readonly base: string;
  private src: KeySource;

  // `pastedKey`: a key typed into the add form, used for that test only and
  // never written (the saved endpoint names a variable or a keyring entry).
  constructor(readonly cfg: EndpointConfig, private pastedKey?: string) {
    this.id = cfg.id;
    this.label = cfg.label ?? cfg.id;
    this.wire = cfg.wire ?? "chat_completions";
    this.base = wireBase(this.wire, cfg.base_url);
    this.src = { env: cfg.key_env, cred: cfg.key_cred };
  }

  // No key reference (or auth = "none"): a local server or a gateway that signs for us.
  get keyless() {
    return this.cfg.auth === "none" || (!this.cfg.key_env && !this.cfg.key_cred && !this.pastedKey);
  }

  available() {
    return this.keyless || !!this.pastedKey || configured(this.src);
  }

  async recheck(olderThanMs?: number) {
    if (!this.keyless && !this.pastedKey) await recheck(this.src, olderThanMs);
  }

  identity() {
    return fingerprint(this.id, this.wire, this.base, this.keyless ? "" : sourceIdentity(this.src));
  }

  get billing(): Billing {
    return this.cfg.billing === "subscription" ? { kind: "subscription", plan: this.label } : { kind: "per_token" };
  }

  // A free endpoint (a local server) costs nothing unless a model says otherwise.
  get price(): Price | undefined {
    return this.cfg.price ?? (this.cfg.billing === "free" ? { input: 0, output: 0 } : undefined);
  }

  status(): ProviderStatus {
    const where = this.keyless ? "no key" : shown(this.src);
    return {
      id: this.id, label: this.label, wire: this.wire, kind: "endpoint", available: this.available(),
      detail: `${this.base} (${where})`, source: this.cfg.source, server: this.server,
    };
  }

  private async secret(): Promise<string> {
    if (this.pastedKey) return this.pastedKey;
    const k = await key(this.src);
    if (!k) {
      const where = [this.src.env && `$${this.src.env}`, this.src.cred && `keyring entry ${this.src.cred}`].filter(Boolean).join(" or ");
      throw new NoKey(`${this.label}: no key in ${where}`);
    }
    return k;
  }

  // The headers every call sends, the key in its style and the references in
  // header values filled in, with every secret named so errors can scrub it.
  async auth(sessionKey?: string): Promise<{ headers: Record<string, string>; secrets: string[] }> {
    const headers: Record<string, string> = {};
    const secrets: string[] = [];
    if (!this.keyless) {
      const k = await this.secret();
      secrets.push(k);
      const style = this.cfg.auth ?? defaultAuth(this.wire);
      if (style === "bearer") headers.authorization = `Bearer ${k}`;
      else if (style !== "none") headers[style] = k;
    }
    for (const [name, raw] of Object.entries(this.cfg.headers ?? {})) {
      let v = String(raw);
      for (const m of [...v.matchAll(REF)]) {
        const got = m[1] === "env" ? process.env[m[2]!]?.trim() : await key({ cred: m[2] });
        if (!got) throw new ProviderError("auth", `${this.label}: header ${name} names ${m[0]}, which holds nothing`);
        secrets.push(got);
        v = v.replace(m[0], got);
      }
      headers[name] = v;
    }
    if (this.wire === "anthropic_messages") headers["anthropic-version"] = API_VERSION;
    if (sessionKey && this.cfg.session_header) headers[this.cfg.session_header] = sessionKey;
    return { headers, secrets };
  }

  // OpenRouter states a key's limit and spend at /key.
  async usage(): Promise<WindowReading[]> {
    if (!/(^|\.)openrouter\.ai$/.test(new URL(this.base).hostname)) return [];
    const a = await this.auth();
    return fromOpenRouterKey(await getJson(this.label, `${this.base}/key`, a.headers, a.secrets));
  }

  // The listing URL for this wire.
  get listUrl() {
    return this.wire === "anthropic_messages" ? `${this.base}/v1/models?limit=1000`
      : this.wire === "gemini_generate_content" ? `${this.base}/v1beta/models?pageSize=1000`
      : `${this.base}/models`;
  }

  async list(): Promise<ListedModel[]> {
    const a = await this.auth();
    let d: any;
    try {
      d = await getJson(this.label, this.listUrl, a.headers, a.secrets);
    } catch (e) {
      // An endpoint with no listing offers the models its configuration names.
      if (this.cfg.models?.length) return this.cfg.models.map((model) => ({ model, family: familyOf(model), billing: this.billing }));
      throw e;
    }
    if (this.wire === "gemini_generate_content") {
      return (d.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? ["generateContent"]).includes("generateContent"))
        .map((m: any) => ({ id: String(m.name ?? "").replace(/^models\//, ""), m }))
        .filter((x: any) => x.id && !notChat(x.id))
        .map(({ id, m }: any): ListedModel => (thinks.set(`${this.base} ${id}`, !!m.thinking), { model: id, name: m.displayName, context: m.inputTokenLimit, output: m.outputTokenLimit, family: familyOf(id), billing: this.billing }));
    }
    const rows: any[] = d.data ?? d.models ?? [];
    const meta = await this.meta(rows);
    return rows
      .filter((m) => (m?.id ?? m?.name) && !notChat(String(m.id ?? m.name)))
      // OpenRouter says which models take tools; the agent loop needs them.
      .filter((m) => !Array.isArray(m.supported_parameters) || m.supported_parameters.includes("tools"))
      .map((m): ListedModel => {
        const id = String(m.id ?? m.name);
        const p = m.pricing;
        const price = p && per(p.prompt) !== undefined && per(p.completion) !== undefined && Number(p.prompt) >= 0
          ? { input: per(p.prompt)!, output: per(p.completion)!, cache_read: per(p.input_cache_read), cache_write: per(p.input_cache_write) }
          : undefined;
        const x = meta.get(id) ?? {};
        const sp: string[] | undefined = Array.isArray(m.supported_parameters) ? m.supported_parameters : undefined;
        return {
          model: id,
          name: m.display_name ?? m.name,
          context: m.context_length ?? m.context_window ?? m.max_model_len ?? m.max_input_tokens ?? m.meta?.n_ctx_train ?? x.context,
          output: m.top_provider?.max_completion_tokens ?? m.max_tokens ?? undefined,
          family: familyOf(id),
          price,
          billing: this.billing,
          images: m.architecture?.input_modalities?.includes?.("image") ?? said(m.capabilities?.image_input) ?? x.images,
          tools: sp ? sp.includes("tools") : x.tools,
          reasoning: sp ? sp.includes("reasoning") || sp.includes("include_reasoning") : said(m.capabilities?.thinking) ?? x.reasoning,
        };
      });
  }

  // The root of an OpenAI-style base (`http://host:11434/v1` to `http://host:11434`).
  private get root() {
    return this.base.replace(/\/v1$/, "");
  }

  // Per model, what the server's own routes say. Asked once per ten minutes;
  // a server that has none of these routes costs one failed call each.
  private async meta(rows: any[]): Promise<Map<string, Meta>> {
    const owner = String(rows[0]?.owned_by ?? "");
    const host = new URL(this.base).hostname;
    const local = /^(127\.|localhost$|\[::1\]$|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.(local|lan|internal)$/.test(host);
    if (!local && !/^(library|ollama|llamacpp|sglang|vllm)$/.test(owner)) return new Map();
    // Kept while the server lists the same models (a model loaded or pulled since is asked about).
    const ids = rows.map((r) => String(r.id)).sort().join("\n");
    const hit = metaCache.get(this.base);
    if (hit && hit.ids === ids && Date.now() - hit.at < META_TTL) return hit.meta;
    const out = new Map<string, Meta>();
    const a = await this.auth();
    const get = (path: string, init?: RequestInit) =>
      fetch(`${this.root}${path}`, { ...init, headers: { accept: "application/json", "content-type": "application/json", ...a.headers }, signal: AbortSignal.timeout(5_000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;
    const all = (m: Meta) => { for (const r of rows) out.set(String(r.id), { ...m }); };
    if (owner === "vllm") all({ server: "vLLM" }); // vLLM's flags for tools and reasoning are not visible: the probe tells
    else if (owner === "sglang") {
      // SGLang names its tool-call and reasoning parsers (/model_info; /get_model_info before it).
      const i = (await get("/model_info")) ?? (await get("/get_model_info"));
      all({ server: "SGLang", tools: i ? !!i.tool_call_parser : undefined, reasoning: i ? !!i.reasoning_parser : undefined });
    } else if (owner === "llamacpp") {
      // llama.cpp: /props has the running window, modalities and the template's caps.
      const p = await get("/props");
      const caps = p?.chat_template_caps ?? {};
      all({
        server: "llama.cpp",
        context: p?.default_generation_settings?.n_ctx,
        images: p?.modalities?.vision,
        tools: caps.supports_tools ?? caps.supports_tool_calls,
        reasoning: Array.isArray(caps.reasoning_effort_levels) ? caps.reasoning_effort_levels.length > 0 : undefined,
      });
    } else if (owner === "library" || owner === "ollama" || (await get("/api/version"))?.version) {
      // Ollama: /api/show names each model's capabilities; a loaded model's
      // running window (/api/ps) is the one that counts, not the trained one.
      const ps = await get("/api/ps");
      const running = new Map<string, number>((ps?.models ?? []).map((m: any) => [m.name ?? m.model, m.context_length]));
      await Promise.all(rows.slice(0, 64).map(async (m) => {
        const s = await get("/api/show", { method: "POST", body: JSON.stringify({ model: m.id }) });
        if (!s) return;
        const caps: string[] = s.capabilities ?? [];
        const trained = Object.entries<any>(s.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1];
        out.set(m.id, { server: "Ollama", context: running.get(m.id) ?? (typeof trained === "number" ? trained : undefined), tools: caps.includes("tools"), images: caps.includes("vision"), reasoning: caps.includes("thinking") });
      }));
    } else {
      // LM Studio's own listing (v1, else v0): vision, tool use, reasoning, the loaded window.
      const v1 = await get("/api/v1/models");
      const list: any[] = v1?.models ?? v1?.data ?? (await get("/api/v0/models"))?.data ?? [];
      for (const m of list) {
        const c = m.capabilities;
        out.set(String(m.key ?? m.id), {
          server: "LM Studio",
          context: m.loaded_instances?.[0]?.config?.context_length ?? m.loaded_context_length ?? m.max_context_length,
          images: typeof c?.vision === "boolean" ? c.vision : m.type === "vlm" ? true : undefined,
          tools: typeof c?.trained_for_tool_use === "boolean" ? c.trained_for_tool_use : Array.isArray(c) ? c.includes("tool_use") : undefined,
          reasoning: c?.reasoning ? true : undefined,
        });
      }
    }
    metaCache.set(this.base, { at: Date.now(), ids, meta: out });
    return out;
  }

  // The server kind the metadata found (Ollama, vLLM, ...), when it found one.
  get server(): string | undefined {
    for (const m of metaCache.get(this.base)?.meta.values() ?? []) if (m.server) return m.server;
    return undefined;
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult> {
    const a = await this.auth(req.sessionKey);
    const ctx = ctxFor(this.id, req, req.efforts ?? []);
    const common = {
      label: this.label, headers: a.headers, secrets: a.secrets, idleMs: this.cfg.stream_idle_timeout_ms,
      onAuthFailure: async () => { forget(this.src); return null; },
    };
    const extra = { ...this.cfg.extra_body };
    if (this.wire === "anthropic_messages") {
      const r = Object.keys(extra).length ? { ...req, extraBody: { ...extra, ...req.extraBody } } : req;
      return runEvents(anthropicWire, r, { ...ctx, legacyIsMine: true }, onDelta, httpEvents({ ...common, url: `${this.base}/v1/messages` }, r));
    }
    if (this.wire === "gemini_generate_content") {
      const r = Object.keys(extra).length ? { ...req, extraBody: { ...extra, ...req.extraBody } } : req;
      return runEvents(geminiWire({ sentinel: true, thinking: thinks.get(`${this.base} ${req.model}`) ?? false }), r, ctx, onDelta, httpEvents({
        ...common, url: `${this.base}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
      }, r));
    }
    if (this.wire === "openai_responses") {
      const r = Object.keys(extra).length ? { ...req, extraBody: { ...extra, ...req.extraBody } } : req;
      return runEvents(responsesWire("openai"), r, ctx, onDelta, httpEvents({ ...common, url: `${this.base}/responses` }, r));
    }
    // OpenRouter caches Claude prompts only with an explicit mark.
    if (this.cfg.effort_field === "reasoning" && /anthropic\/|claude/.test(req.model) && !extra.cache_control) extra.cache_control = { type: "ephemeral" };
    const codec = chatWire({
      effortField: this.cfg.effort_field ?? "reasoning_effort",
      replayReasoning: this.cfg.replay_reasoning,
      extraBody: extra,
      sendMaxTokens: true,
    });
    return runEvents(codec, req, ctx, onDelta, httpEvents({ ...common, url: `${this.base}/chat/completions` }, req));
  }
}
