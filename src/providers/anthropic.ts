import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { AssistantBlock } from "../core/types.ts";
import { emptyUsage } from "../core/types.ts";
import { anthropicBody } from "./wires/anthropic.ts";
import { idleGuard, streamIdleMs } from "./http.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderResult } from "./types.ts";

type AnyClient = Anthropic | AnthropicBedrock;

export class AnthropicProvider implements Provider {
  private client: AnyClient | null;

  constructor(
    readonly id: "anthropic" | "bedrock",
    private env: Record<string, string | undefined> = process.env,
  ) {
    this.client = this.makeClient();
  }

  private makeClient(): AnyClient | null {
    const e = this.env;
    if (this.id === "bedrock") {
      if (!e.ANTHROPIC_BEDROCK_BASE_URL && !e.AWS_BEARER_TOKEN_BEDROCK && !e.AWS_ACCESS_KEY_ID) return null;
      return new AnthropicBedrock({
        baseURL: e.ANTHROPIC_BEDROCK_BASE_URL,
        skipAuth: e.CLAUDE_CODE_SKIP_BEDROCK_AUTH === "1",
        awsRegion: e.AWS_REGION ?? "us-east-1",
        maxRetries: 0,
      });
    }
    if (!e.ANTHROPIC_API_KEY && !e.ANTHROPIC_AUTH_TOKEN) return null;
    return new Anthropic({ maxRetries: 0 });
  }

  available() {
    return this.client !== null;
  }

  readonly family = "claude" as const;
  readonly wire = "anthropic_messages" as const;
  get label() { return this.id === "bedrock" ? "Amazon Bedrock" : "Anthropic API"; }

  // What the account can use, from the provider's own listing.
  async list(): Promise<ListedModel[]> {
    if (!this.client) return [];
    if (this.id === "anthropic") {
      const out: ListedModel[] = [];
      for await (const m of (this.client as Anthropic).models.list({ limit: 1000 })) {
        const a = m as any;
        out.push({ model: m.id, name: m.display_name, context: a.max_input_tokens, output: a.max_tokens });
      }
      return out;
    }
    // Bedrock: the inference profiles on the control plane. A local broker
    // serves the same path on its own address.
    const e = this.env;
    const base = e.ANTHROPIC_BEDROCK_BASE_URL ?? `https://bedrock.${e.AWS_REGION ?? "us-east-1"}.amazonaws.com`;
    const headers: Record<string, string> = {};
    if (e.AWS_BEARER_TOKEN_BEDROCK && e.CLAUDE_CODE_SKIP_BEDROCK_AUTH !== "1") headers.authorization = `Bearer ${e.AWS_BEARER_TOKEN_BEDROCK}`;
    const ids: string[] = [];
    let next = "";
    for (let page = 0; page < 20; page++) {
      const r = await fetch(`${base}/inference-profiles?maxResults=1000${next ? `&nextToken=${encodeURIComponent(next)}` : ""}`, {
        headers, signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(`bedrock listing: HTTP ${r.status}`);
      const d: any = await r.json();
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
    if (!this.client) throw new Error(`${this.id}: no credentials`);
    const ctx = { origin: `${this.id}:${req.model}`, sessionKey: req.sessionKey ?? "", efforts: [], legacyIsMine: true };
    const params: any = { ...anthropicBody(req, ctx), ...req.extraBody };
    const guard = idleGuard(req.signal, streamIdleMs(), this.label);
    try {
      return await this.read(params, ctx, req, guard, onDelta);
    } catch (e) {
      throw guard.stalled() ?? e;
    } finally {
      guard.done();
    }
  }

  private async read(params: any, ctx: { origin: string }, req: ProviderRequest, guard: ReturnType<typeof idleGuard>, onDelta: (d: Delta) => void): Promise<ProviderResult> {
    const stream = (this.client as Anthropic).messages.stream(params, { signal: guard.signal, headers: req.extraHeaders });
    // The answer's rate-limit headers (the Anthropic API states them; Bedrock does not).
    if (req.onHeaders) stream.withResponse().then((r) => req.onHeaders!(r.response.headers as any), () => {});
    const toolNames = new Map<number, string>();
    for await (const ev of stream) {
      guard.touch();
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
        toolNames.set(ev.index, ev.content_block.name);
        onDelta({ kind: "tool_input", index: ev.index, text: "", name: ev.content_block.name });
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta as any;
        if (d.type === "text_delta") onDelta({ kind: "text", index: ev.index, text: d.text });
        else if (d.type === "thinking_delta") onDelta({ kind: "thinking", index: ev.index, text: d.thinking });
        else if (d.type === "input_json_delta") onDelta({ kind: "tool_input", index: ev.index, text: d.partial_json, name: toolNames.get(ev.index) });
      }
    }
    const msg = await stream.finalMessage();
    const blocks: AssistantBlock[] = [];
    for (const b of msg.content as any[]) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text });
      else if (b.type === "thinking") blocks.push({ type: "thinking", thinking: b.thinking, signature: b.signature, origin: ctx.origin });
      else if (b.type === "redacted_thinking") blocks.push({ type: "redacted_thinking", data: b.data });
      else if (b.type === "tool_use") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
    const u = msg.usage as any;
    return {
      blocks,
      model: req.model,
      stop: msg.stop_reason ?? "end_turn",
      stop_details: (msg as any).stop_details ?? undefined,
      served: u.speed ?? undefined,
      usage: {
        ...emptyUsage(),
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
        cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens || undefined,
      },
    };
  }
}
