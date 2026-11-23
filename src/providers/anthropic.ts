// Claude on the Anthropic API and on Amazon Bedrock, over plain fetch with the
// shared Messages wire codec. Bedrock takes the same body (model in the path,
// the API version in the body) and streams it in AWS event-stream frames.
import { sigv4, type AwsCreds } from "./aws.ts";
import { BrokerAddress } from "./broker-address.ts";
import { fingerprint } from "./creds.ts";
import { ctxFor, httpEvents, runEvents } from "./drive.ts";
import { allPages, getJson, type ProviderError } from "./http.ts";
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
  readonly broker: BrokerAddress;

  constructor(
    readonly id: "anthropic" | "bedrock",
    private env: Record<string, string | undefined> = process.env,
  ) {
    const base = id === "bedrock" ? "ANTHROPIC_BEDROCK_BASE_URL" : "ANTHROPIC_BASE_URL";
    this.broker = new BrokerAddress(base, env[base]);
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

  identity() {
    const e = this.env, a = this.auth;
    // A Bedrock bearer key is short-lived and rotates; the region names the account's listing.
    const who = a?.kind === "bearer" ? (this.id === "bedrock" ? "bearer" : a.token) : a?.kind === "api-key" ? a.key : a?.kind === "sigv4" ? a.creds.accessKeyId : a?.kind ?? "";
    const where = this.id === "bedrock" ? `${e.ANTHROPIC_BEDROCK_BASE_URL ?? ""}|${this.region}` : e.ANTHROPIC_BASE_URL ?? "";
    return fingerprint(this.id, where, who);
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

  private signer(method = "POST") {
    const a = this.auth;
    if (a?.kind !== "sigv4") return undefined;
    return (body: string, url: string) => sigv4({ method, url, body, region: this.region, service: "bedrock", creds: a.creds });
  }

  // What the account can use, from the provider's own listing.
  async list(): Promise<ListedModel[]> {
    if (!this.auth) return [];
    if (this.id === "anthropic") {
      const base = (this.broker.value || "https://api.anthropic.com").replace(/\/$/, "");
      // Every page, to the end: a listing that names a cursor twice or has no end fails and says so.
      return allPages(this.label, async (after, until) => {
        const d = await getJson(this.label, `${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, { ...this.headers(), "anthropic-version": API_VERSION }, this.secrets, until);
        return { rows: (d.data ?? []).map((m: any): ListedModel => ({ model: m.id, name: m.display_name, context: m.max_input_tokens, output: m.max_tokens })), next: d.has_more && d.last_id };
      });
    }
    // Bedrock: the inference profiles on the control plane. A local broker
    // serves the same path on its own address.
    const base = this.broker.value ?? `https://bedrock.${this.region}.amazonaws.com`;
    const ids: string[] = [];
    let next = "";
    for (let page = 0; page < 20; page++) {
      const url = `${base}/inference-profiles?maxResults=1000${next ? `&nextToken=${encodeURIComponent(next)}` : ""}`;
      const d = await getJson(this.label, url, this.headers(), this.secrets, undefined, (target) => this.signer("GET")?.("", target));
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

  // Sent-back thinking under the provider's prefix check, as Anthropic's
  // preserved-thinking guide says to handle it: the beta and "error" on every
  // request (the wire already left out the thinking it knows is stale), and on
  // the refusal that names a block bound to a different conversation, this
  // request again once with "drop_block"; the engine keeps that for the
  // session. A route that does not take the setting goes on without it.
  async stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult> {
    const route = `${this.id}:${req.model}`;
    if (bindingRefused.has(route)) return this.send(req, onDelta);
    const bound = (mode: "error" | "drop_block") => withBeta({ ...req, blockBinding: mode }, BINDING_BETA);
    try {
      return await this.send(bound(req.dropThinking ? "drop_block" : "error"), onDelta);
    } catch (e) {
      const text = String((e as Error)?.message ?? e);
      if ((e as any)?.status !== 400) throw e;
      if (BOUND_ELSEWHERE.test(text) && !req.dropThinking) return { ...(await this.send(bound("drop_block"), onDelta)), binding_refused: text };
      if (!/block_binding|thinking-binding-controls/.test(text)) throw e;
      bindingRefused.add(route);
      return this.send(req, onDelta);
    }
  }

  private async send(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult> {
    if (!this.auth) throw new Error(`${this.id}: no credentials`);
    const ctx = { ...ctxFor(this.id, req, []), legacyIsMine: true };
    // Deferred tools and tool_reference blocks: the beta each platform names
    // (Claude Code sends the same two).
    if (req.tools.some((t) => t.defer)) req = withBeta(req, this.id === "bedrock" ? "tool-search-tool-2025-10-19" : "advanced-tool-use-2025-11-20");
    if (this.id === "anthropic") {
      const base = (this.broker.value || "https://api.anthropic.com").replace(/\/$/, "");
      return runEvents(anthropicWire, req, ctx, onDelta, httpEvents({
        label: this.label, url: `${base}/v1/messages`, secrets: this.secrets,
        headers: { ...this.headers(), "anthropic-version": API_VERSION },
      }, req));
    }
    const base = (this.broker.value ?? `https://bedrock-runtime.${this.region}.amazonaws.com`).replace(/\/$/, "");
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
    const sent = { ...this.headers(), accept: "application/vnd.amazon.eventstream" };
    return runEvents(codec, req, ctx, onDelta, httpEvents({
      label: this.label, url, secrets: this.secrets, headers: sent, sign: this.signer(), maxBodyBytes: BEDROCK_MAX_BODY,
      // A broker that signs for us renews an expired credential itself: the request goes once more after it had time to.
      ...(this.auth.kind === "none" ? { onAuthFailure: async (err: ProviderError) => (EXPIRED.test(err.message) ? (await Bun.sleep(BROKER_RENEW_MS), sent) : null) } : {}),
    }, req));
  }
}

// Bedrock limits a request to 20 MB, and answers a larger one with an HTTP 500
// ("The system encountered an unexpected error"), not a 413: every retry
// fails the same. Read as decimal megabytes, the lower of the two readings.
// https://platform.claude.com/docs/en/api/overview#request-size-limits
const BEDROCK_MAX_BODY = 20_000_000;
// A credential the broker's own source says has expired, and how long the broker gets to renew it.
const EXPIRED = /expired/i;
const BROKER_RENEW_MS = 1_000;
const BINDING_BETA = "thinking-binding-controls-2026-08-01";
// Anthropic says to match this refusal by these words only; the rest of its text can change.
const BOUND_ELSEWHERE = /The block is bound to a different conversation/;
// Routes that refused the setting (a model or platform without it).
const bindingRefused = new Set<string>();

function withBeta(req: ProviderRequest, beta: string): ProviderRequest {
  const have = req.extraHeaders?.["anthropic-beta"];
  if (have?.split(",").some((b) => b.trim() === beta)) return req;
  return { ...req, extraHeaders: { ...req.extraHeaders, "anthropic-beta": have ? `${have},${beta}` : beta } };
}
