// What a model on an endpoint can do, found by asking it: a few short
// requests through the same driver a turn uses. Kept per model (and per
// account and endpoint) in <state>/provider-probes.json; the registry joins
// it below what the owner states and above the listing and the catalog.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, Usage } from "../core/types.ts";
import { ProviderError } from "./http.ts";
import type { Provider, ProviderRequest, ProviderResult, ToolSpec } from "./types.ts";

export type Cap = "tools" | "images" | "reasoning" | "caching";
export type Finding = { value?: boolean; note: string };
export type ProbeResult = {
  at: number;
  identity?: string;
  ok: boolean;              // the model answered the first request
  latency_ms?: number;
  error?: string;
  found: Partial<Record<Cap, Finding>>;
  usage: { input: number; output: number; cache_read: number };
};

// A 16 by 16 red square.
const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4IyJCEmIY1TCqYfhqAAACcQQQFd0BdQAAAABJRU5ErkJggg==";

const WEATHER: ToolSpec = {
  name: "get_weather",
  description: "The current weather in a city.",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

// A prefix over every vendor's cache minimum (4096 tokens is the largest;
// about 4800 Claude tokens, 2600 OpenAI ones), the same bytes on both calls.
const LONG = Array.from({ length: 180 }, (_, i) => `Reference line ${i + 1}: the probe repeats this text so the endpoint can cache it.`).join("\n");

const user = (text: string, image = false): Message[] => [{
  role: "user",
  content: image ? [{ type: "image", media_type: "image/png", data: RED_PNG }, { type: "text", text }] : [{ type: "text", text }],
}];

type Step = { res?: ProviderResult; error?: unknown; ms: number; thought: boolean };

async function ask(p: Provider, model: string, r: Partial<ProviderRequest>, timeoutMs: number): Promise<Step> {
  const t = Date.now();
  let thought = false;
  try {
    const res = await p.stream({
      model, system: "You are a connection check. Follow the instruction exactly.", messages: [], tools: [], maxTokens: 1024,
      signal: AbortSignal.timeout(timeoutMs), purpose: "side", ...r,
    }, (d) => { if (d.kind === "thinking") thought = true; });
    return { res, ms: Date.now() - t, thought: thought || res.blocks.some((b) => b.type === "thinking" || b.type === "redacted_thinking") };
  } catch (error) {
    return { error, ms: Date.now() - t, thought };
  }
}

const text = (s: Step) => s.res?.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("").trim() ?? "";
// A request the endpoint refused as malformed says the feature is not taken.
const refused = (s: Step) => s.error instanceof ProviderError && s.error.kind === "invalid";
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function probe(p: Provider, model: string, opts: { timeoutMs?: number; only?: Cap[] } = {}): Promise<ProbeResult> {
  const timeout = opts.timeoutMs ?? 90_000;
  const want = (c: Cap) => !opts.only || opts.only.includes(c);
  const usage = { input: 0, output: 0, cache_read: 0 };
  const add = (s: Step) => { const u: Usage | undefined = s.res?.usage; if (u) { usage.input += u.input + u.cache_read + u.cache_write; usage.output += u.output; usage.cache_read += u.cache_read; } };
  const found: ProbeResult["found"] = {};

  const first = await ask(p, model, { messages: user("Reply with the single word OK.") }, timeout);
  add(first);
  if (first.error) return { at: Date.now(), ok: false, latency_ms: first.ms, error: why(first.error), found, usage };
  if (first.thought) found.reasoning = { value: true, note: "it thinks before answering" };

  await Promise.all([
    want("tools") && (async () => {
      const s = await ask(p, model, { messages: user("Call the get_weather tool for Paris. Do not answer in text."), tools: [WEATHER] }, timeout);
      add(s);
      const call = s.res?.blocks.find((b) => b.type === "tool_use") as any;
      found.tools = call ? { value: true, note: `called ${call.name}` }
        : refused(s) ? { value: false, note: `the endpoint refused tools: ${why(s.error)}` }
        : s.error ? { note: `not known: ${why(s.error)}` }
        : s.res?.stop === "max_tokens" ? { note: "not known: it used its whole answer thinking" }
        : { value: false, note: "answered in text instead of calling the tool (a server may need tool parsing turned on)" };
    })(),
    want("images") && (async () => {
      const s = await ask(p, model, { messages: user("What single color fills this image? Answer with one word.", true) }, timeout);
      add(s);
      const t = text(s).toLowerCase();
      found.images = /red|crimson|scarlet/.test(t) ? { value: true, note: "named the color of a test image" }
        : refused(s) ? { value: false, note: `the endpoint refused the image: ${why(s.error)}` }
        : s.error ? { note: `not known: ${why(s.error)}` }
        : !t && s.res?.stop === "max_tokens" ? { note: "not known: it used its whole answer thinking" }
        : { value: false, note: `took the image but answered "${t.slice(0, 40)}"` };
    })(),
    want("reasoning") && !found.reasoning && (async () => {
      const s = await ask(p, model, { messages: user("What is 17 * 23? Work it out, then answer with the number."), effort: "medium", efforts: ["low", "medium", "high"] }, timeout);
      add(s);
      found.reasoning = s.thought ? { value: true, note: "returned its thinking when asked for an effort" }
        : refused(s) ? { value: false, note: `the endpoint refused an effort: ${why(s.error)}` }
        : s.error ? { note: `not known: ${why(s.error)}` }
        // Some models think without returning the text (OpenAI's): no answer either way.
        : { note: "no thinking came back; it may think without showing it" };
    })(),
    want("caching") && (async () => {
      const r = { system: `You are a connection check.\n\n${LONG}`, messages: user("Reply with the single word OK."), maxTokens: 64 };
      const a = await ask(p, model, r, timeout);
      add(a);
      const b = a.error ? a : await ask(p, model, r, timeout);
      if (b !== a) add(b);
      const hit = b.res?.usage.cache_read ?? 0;
      found.caching = hit > 0 ? { value: true, note: `the second call read ${hit} tokens from the cache` }
        : b.error ? { note: `not known: ${why(b.error)}` }
        : { value: false, note: "no cached tokens were reported on a repeated prompt" };
    })(),
  ]);
  return { at: Date.now(), ok: true, latency_ms: first.ms, found, usage };
}

// The saved findings.
export class Probes {
  private data: Record<string, ProbeResult> = {};

  constructor(private stateDir: string, private onError?: (e: unknown) => void) {
    try { if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, "utf8")); } catch (e) { onError?.(e); }
  }

  private get file() { return join(this.stateDir, "provider-probes.json"); }

  // The finding for a model, when it was made for the account and endpoint the provider has now.
  get(id: string, identity?: string): ProbeResult | undefined {
    const r = this.data[id];
    return r && (!r.identity || !identity || r.identity === identity) ? r : undefined;
  }

  set(id: string, r: ProbeResult) {
    this.data[id] = r;
    this.save();
  }

  forget(provider: string) {
    for (const k of Object.keys(this.data)) if (k.startsWith(`${provider}:`)) delete this.data[k];
    this.save();
  }

  private save() {
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { this.onError?.(e); }
  }
}
