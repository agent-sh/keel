// Drivers that authenticate with an API key: the OpenAI API (Responses), the
// Gemini API, and every OpenAI-compatible endpoint (/chat/completions).
import type { EndpointConfig } from "./config.ts";
import { configured, forget, key, shown, type KeySource } from "./creds.ts";
import { ctxFor, httpEvents, runEvents } from "./drive.ts";
import { familyOf, notChat } from "./family.ts";
import { getJson, ProviderError } from "./http.ts";
import type { Delta, Family, ListedModel, Provider, ProviderRequest, ProviderResult, ProviderStatus, Wire } from "./types.ts";
import { chatWire } from "./wires/chat.ts";
import { geminiWire } from "./wires/gemini.ts";
import { responsesWire } from "./wires/responses.ts";

abstract class KeyedProvider implements Provider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly wire: Wire;
  abstract readonly family: Family;
  protected abstract src: KeySource;

  available() {
    return configured(this.src);
  }

  status(): ProviderStatus {
    return { id: this.id, label: this.label, wire: this.wire, kind: "builtin", available: this.available(), detail: shown(this.src) };
  }

  protected async key(): Promise<string> {
    const k = await key(this.src);
    if (!k) throw new ProviderError("auth", `${this.label}: no key (${shown(this.src)})`);
    return k;
  }

  abstract list(): Promise<ListedModel[]>;
  abstract stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult>;
}

export class OpenAIProvider extends KeyedProvider {
  readonly id = "openai";
  readonly label = "OpenAI API";
  readonly wire = "openai_responses" as const;
  readonly family = "gpt" as const;
  protected src = { env: "OPENAI_API_KEY", cred: "openai-api-key" };
  private base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");

  async list(): Promise<ListedModel[]> {
    const k = await this.key();
    const d = await getJson(this.label, `${this.base}/models`, { authorization: `Bearer ${k}` }, [k]);
    return (d.data ?? [])
      .map((m: any) => String(m.id))
      .filter((id: string) => /^(gpt-|o\d|codex|chatgpt-)/.test(id) && !notChat(id) && !/instruct|search|audio|mini-tts/.test(id))
      .map((model: string) => ({ model, family: "gpt" as const }));
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void) {
    const k = await this.key();
    const codec = responsesWire("openai");
    const ctx = ctxFor(this.id, req, req.efforts ?? []);
    return runEvents(codec, req, ctx, onDelta, httpEvents({
      label: this.label, url: `${this.base}/responses`, headers: { authorization: `Bearer ${k}` }, secrets: [k],
      onAuthFailure: async () => { forget(this.src); return null; },
    }, req.signal));
  }
}

export class GeminiProvider extends KeyedProvider {
  readonly id = "gemini";
  readonly label = "Gemini API";
  readonly wire = "gemini_generate_content" as const;
  readonly family = "gemini" as const;
  protected src = { env: process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY", cred: "gemini-api-key" };
  private base = (process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  private thinks = new Map<string, boolean>();

  async list(): Promise<ListedModel[]> {
    const k = await this.key();
    const out: ListedModel[] = [];
    let token = "";
    for (let page = 0; page < 20; page++) {
      const d = await getJson(this.label, `${this.base}/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, { "x-goog-api-key": k }, [k]);
      for (const m of d.models ?? []) {
        const id = String(m.name ?? "").replace(/^models\//, "");
        if (!(m.supportedGenerationMethods ?? []).includes("generateContent") || notChat(id) || !/gemini/.test(id)) continue;
        this.thinks.set(id, !!m.thinking);
        out.push({ model: id, name: m.displayName, context: m.inputTokenLimit, output: m.outputTokenLimit, family: "gemini" });
      }
      token = d.nextPageToken ?? "";
      if (!token) break;
    }
    return out;
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void) {
    const k = await this.key();
    const codec = geminiWire({ sentinel: true, thinking: this.thinks.get(req.model) ?? /gemini-[3-9]|2\.5/.test(req.model) });
    const ctx = ctxFor(this.id, req, req.efforts ?? []);
    return runEvents(codec, req, ctx, onDelta, httpEvents({
      label: this.label,
      url: `${this.base}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
      headers: { "x-goog-api-key": k }, secrets: [k],
    }, req.signal));
  }
}

// One OpenAI-compatible endpoint; its id is the provider id.
export class CompatProvider extends KeyedProvider {
  readonly id: string;
  readonly label: string;
  readonly wire = "chat_completions" as const;
  readonly family = "other" as const;
  protected src: KeySource;
  private base: string;

  constructor(readonly cfg: EndpointConfig) {
    super();
    this.id = cfg.id;
    this.label = cfg.label ?? cfg.id;
    this.src = { env: cfg.key_env, cred: cfg.key_cred };
    this.base = cfg.base_url.replace(/\/$/, "");
  }

  override status(): ProviderStatus {
    return { ...super.status(), kind: "endpoint", detail: `${this.base} (${shown(this.src)})` };
  }

  private headers(k: string, sessionKey?: string): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${k}`, ...this.cfg.headers };
    if (sessionKey && this.cfg.session_header) h[this.cfg.session_header] = sessionKey;
    return h;
  }

  async list(): Promise<ListedModel[]> {
    const k = await this.key();
    const billing = this.cfg.billing === "subscription" ? { kind: "subscription" as const, plan: this.label } : { kind: "per_token" as const };
    let d: any;
    try {
      d = await getJson(this.label, `${this.base}/models`, this.headers(k), [k]);
    } catch (e) {
      // An endpoint with no listing offers the models its configuration names.
      if (this.cfg.models?.length) return this.cfg.models.map((model) => ({ model, family: familyOf(model), billing }));
      throw e;
    }
    const rows: any[] = d.data ?? d.models ?? [];
    return rows
      .filter((m) => m?.id && !notChat(m.id))
      // OpenRouter says which models take tools; the agent loop needs them.
      .filter((m) => !Array.isArray(m.supported_parameters) || m.supported_parameters.includes("tools"))
      .map((m): ListedModel => {
        const p = m.pricing;
        const per = (x: any) => (x === undefined || x === null || isNaN(Number(x)) ? undefined : Number(x) * 1e6);
        const price = p && per(p.prompt) !== undefined && per(p.completion) !== undefined && (Number(p.prompt) >= 0)
          ? { input: per(p.prompt)!, output: per(p.completion)!, cache_read: per(p.input_cache_read), cache_write: per(p.input_cache_write) }
          : undefined;
        return {
          model: m.id,
          name: m.name,
          context: m.context_length ?? m.context_window ?? m.max_model_len,
          output: m.top_provider?.max_completion_tokens ?? undefined,
          family: familyOf(m.id),
          price,
          billing,
          images: m.architecture?.input_modalities?.includes?.("image"),
        };
      });
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void) {
    const k = await this.key();
    const extra = { ...this.cfg.extra_body };
    // OpenRouter caches Claude prompts only with an explicit mark.
    if (this.cfg.effort_field === "reasoning" && /anthropic\/|claude/.test(req.model) && !extra.cache_control) extra.cache_control = { type: "ephemeral" };
    const codec = chatWire({
      effortField: this.cfg.effort_field ?? "reasoning_effort",
      replayReasoning: this.cfg.replay_reasoning,
      extraBody: extra,
      sendMaxTokens: true,
    });
    const ctx = ctxFor(this.id, req, req.efforts ?? []);
    return runEvents(codec, req, ctx, onDelta, httpEvents({
      label: this.label, url: `${this.base}/chat/completions`, headers: this.headers(k, req.sessionKey), secrets: [k],
      onAuthFailure: async () => { forget(this.src); return null; },
    }, req.signal));
  }
}
