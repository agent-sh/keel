// Claude on the Anthropic API and on Amazon Bedrock, over plain fetch with the
// shared Messages wire codec. Bedrock takes the same body (model in the path,
// the API version in the body) and streams it in AWS event-stream frames.
import { sigv4, type AwsCreds } from "./aws.ts";
import { ctxFor, httpEvents, runEvents } from "./drive.ts";
import { getJson } from "./http.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderResult } from "./types.ts";
import { anthropicWire } from "./wires/anthropic.ts";

// The Messages API version the official TypeScript SDK sends.
const API_VERSION = "2026-10-21";

type Auth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "api-key"; key: string }
  | { kind: "sigv4"; creds: AwsCreds };

export class AnthropicProvider implements Provider {
  private auth: Auth | null;

  constructor(
    readonly id: "anthropic" | "bedrock",
    private env: Record<string, string | undefined> = process.env,
  ) {
    this.auth = this.makeAuth();
  }

  private makeAuth(): Auth | null {
    const e = this.env;
    if (this.id === "bedrock") {
      if (!e.ANTHROPIC_BEDROCK_BASE_URL && !e.AWS_BEARER_TOKEN_BEDROCK && !e.AWS_ACCESS_KEY_ID) return null;
      // A proxy that signs for us (the local broker) gets no auth at all.
      if (e.CLAUDE_CODE_SKIP_BEDROCK_AUTH === "1") return { kind: "none" };
      if (e.AWS_BEARER_TOKEN_BEDROCK) return { kind: "bearer", token: e.AWS_BEARER_TOKEN_BEDROCK };
      if (e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY) {
        return { kind: "sigv4", creds: { accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY, sessionToken: e.AWS_SESSION_TOKEN } };
      }
      return { kind: "none" };
    }
    if (e.ANTHROPIC_API_KEY) return { kind: "api-key", key: e.ANTHROPIC_API_KEY };
    if (e.ANTHROPIC_AUTH_TOKEN) return { kind: "bearer", token: e.ANTHROPIC_AUTH_TOKEN };
    return null;
  }

  available() {
    return this.auth !== null;
  }

  readonly family = "claude" as const;
  readonly wire = "anthropic_messages" as const;
  get label() { return this.id === "bedrock" ? "Amazon Bedrock" : "Anthropic API"; }

  private get region() { return this.env.AWS_REGION ?? "us-east-1"; }
  private get secrets() {
    const a = this.auth;
    return a?.kind === "bearer" ? [a.token] : a?.kind === "api-key" ? [a.key] : a?.kind === "sigv4" ? [a.creds.secretAccessKey, a.creds.sessionToken ?? ""] : [];
  }

  // Static auth headers; SigV4 is made per request from the body.
  private headers(): Record<string, string> {
    const a = this.auth;
    if (a?.kind === "bearer") return { authorization: `Bearer ${a.token}` };
    if (a?.kind === "api-key") return { "x-api-key": a.key };
    return {};
  }

  private signer(url: string, method = "POST") {
    const a = this.auth;
    if (a?.kind !== "sigv4") return undefined;
    return (body: string) => sigv4({ method, url, body, region: this.region, service: "bedrock", creds: a.creds });
  }

  // What the account can use, from the provider's own listing.
  async list(): Promise<ListedModel[]> {
    if (!this.auth) return [];
    if (this.id === "anthropic") {
      const base = (this.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
      const out: ListedModel[] = [];
      let after = "";
      for (let page = 0; page < 20; page++) {
        const d = await getJson(this.label, `${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, { ...this.headers(), "anthropic-version": API_VERSION }, this.secrets);
        for (const m of d.data ?? []) out.push({ model: m.id, name: m.display_name, context: m.max_input_tokens, output: m.max_tokens });
        if (!d.has_more || !d.last_id) break;
        after = d.last_id;
      }
      return out;
    }
    // Bedrock: the inference profiles on the control plane. A local broker
    // serves the same path on its own address.
    const e = this.env;
    const base = e.ANTHROPIC_BEDROCK_BASE_URL ?? `https://bedrock.${this.region}.amazonaws.com`;
    const ids: string[] = [];
    let next = "";
    for (let page = 0; page < 20; page++) {
      const url = `${base}/inference-profiles?maxResults=1000${next ? `&nextToken=${encodeURIComponent(next)}` : ""}`;
      const d = await getJson(this.label, url, { ...this.headers(), ...this.signer(url, "GET")?.("") }, this.secrets);
      for (const p of d.inferenceProfileSummaries ?? []) {
        if (p.status === "ACTIVE" && /\.anthropic\.claude-/.test(p.inferenceProfileId)) ids.push(p.inferenceProfileId);
      }
      if (!d.nextToken || d.nextToken === next) break;
      next = d.nextToken;
    }
    // One entry per model: the global profile where there is one.
    const bare = (id: string) => id.replace(/^[a-z]+\./, "");
    const globals = new Set(ids.filter((i) => i.startsWith("global.")).map(bare));
    return ids.filter((i) => i.startsWith("global.") || !globals.has(bare(i))).map((model) => ({ model }));
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult> {
    if (!this.auth) throw new Error(`${this.id}: no credentials`);
    const ctx = { ...ctxFor(this.id, req, []), legacyIsMine: true };
    if (this.id === "anthropic") {
      const base = (this.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
      return runEvents(anthropicWire, req, ctx, onDelta, httpEvents({
        label: this.label, url: `${base}/v1/messages`, secrets: this.secrets,
        headers: { ...this.headers(), "anthropic-version": API_VERSION },
      }, req));
    }
    const base = (this.env.ANTHROPIC_BEDROCK_BASE_URL ?? `https://bedrock-runtime.${this.region}.amazonaws.com`).replace(/\/$/, "");
    const url = `${base}/model/${encodeURIComponent(req.model)}/invoke-with-response-stream`;
    const codec = {
      ...anthropicWire,
      // Bedrock: the model is the path, streaming is the endpoint, the version is in the body.
      body: (r: ProviderRequest, c: typeof ctx) => {
        const { model: _m, stream: _s, ...rest } = anthropicWire.body(r, c);
        return { anthropic_version: API_VERSION, ...(betas.length ? { anthropic_beta: betas } : {}), ...rest };
      },
    };
    // Bedrock takes betas in the body, not as a header (as the official SDK sends them).
    const { "anthropic-beta": beta, ...headers } = req.extraHeaders ?? {};
    const betas = beta ? beta.split(",").map((b) => b.trim()).filter(Boolean) : [];
    req = { ...req, extraHeaders: req.extraHeaders ? headers : undefined };
    return runEvents(codec, req, ctx, onDelta, httpEvents({
      label: this.label, url, secrets: this.secrets,
      headers: { ...this.headers(), accept: "application/vnd.amazon.eventstream" }, sign: this.signer(url),
    }, req));
  }
}
