// Drivers that authenticate with an API key: the OpenAI API (Responses) and
// the Gemini API. Configured endpoints are endpoint.ts.
import { BrokerAddress } from "./broker-address.ts";
import { configured, fingerprint, forget, key, look, recheck, shown, sourceIdentity, unread, type KeySource } from "./creds.ts";
import { ctxFor, httpEvents, runEvents } from "./drive.ts";
import { notChat } from "./family.ts";
import { allPages, getJson, NoKey } from "./http.ts";
import type { Delta, Family, ListedModel, Provider, ProviderRequest, ProviderResult, ProviderStatus, SpeechAccess, Wire } from "./types.ts";
import { geminiWire } from "./wires/gemini.ts";
import { responsesWire } from "./wires/responses.ts";

abstract class KeyedProvider implements Provider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly wire: Wire;
  abstract readonly family: Family;
  protected abstract src: KeySource;

  protected abstract readonly base: string;
  abstract readonly broker: BrokerAddress;

  available() {
    return configured(this.src);
  }

  identity() {
    return fingerprint(this.id, this.broker.identity?.replace(/\/$/, "") ?? this.base, sourceIdentity(this.src));
  }

  status(): ProviderStatus {
    return { id: this.id, label: this.label, wire: this.wire, kind: "builtin", available: this.available(), detail: shown(this.src) };
  }

  protected async key(): Promise<string> {
    const k = await key(this.src);
    if (!k) throw new NoKey(`${this.label}: no key (${shown(this.src)})`);
    return k;
  }

  recheck(olderThanMs?: number) {
    return recheck(this.src, olderThanMs);
  }

  look() {
    return look(this.src);
  }

  unread() {
    return unread(this.src);
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
  readonly broker = new BrokerAddress("OPENAI_BASE_URL", process.env.OPENAI_BASE_URL);
  protected get base() { return (this.broker.value ?? "https://api.openai.com/v1").replace(/\/$/, ""); }

  async speech(): Promise<SpeechAccess | null> {
    const k = await this.key();
    return { base: this.base, headers: { authorization: `Bearer ${k}` }, secrets: [k] };
  }

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
    }, req));
  }
}

export class GeminiProvider extends KeyedProvider {
  readonly id = "gemini";
  readonly label = "Gemini API";
  readonly wire = "gemini_generate_content" as const;
  readonly family = "gemini" as const;
  protected src = { env: process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY", cred: "gemini-api-key" };
  readonly broker = new BrokerAddress("GEMINI_BASE_URL", process.env.GEMINI_BASE_URL);
  protected get base() { return (this.broker.value ?? "https://generativelanguage.googleapis.com").replace(/\/$/, ""); }
  private thinks = new Map<string, boolean>();

  async list(): Promise<ListedModel[]> {
    const k = await this.key();
    // Every page, to the end: a listing that names a token twice or has no end fails and says so.
    return allPages(this.label, async (token, until) => {
      const d = await getJson(this.label, `${this.base}/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, { "x-goog-api-key": k }, [k], until);
      const rows: ListedModel[] = [];
      for (const m of d.models ?? []) {
        const id = String(m.name ?? "").replace(/^models\//, "");
        if (!(m.supportedGenerationMethods ?? []).includes("generateContent") || notChat(id) || !/gemini/.test(id)) continue;
        this.thinks.set(id, !!m.thinking);
        rows.push({ model: id, name: m.displayName, context: m.inputTokenLimit, output: m.outputTokenLimit, family: "gemini" });
      }
      return { rows, next: d.nextPageToken };
    });
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void) {
    const k = await this.key();
    const codec = geminiWire({ sentinel: true, thinking: this.thinks.get(req.model) ?? /gemini-[3-9]|2\.5/.test(req.model) });
    const ctx = ctxFor(this.id, req, req.efforts ?? []);
    return runEvents(codec, req, ctx, onDelta, httpEvents({
      label: this.label,
      url: `${this.base}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
      headers: { "x-goog-api-key": k }, secrets: [k],
    }, req));
  }
}
