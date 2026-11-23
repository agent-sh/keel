import type { AssistantBlock, Message, Usage } from "../core/types.ts";

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  // A freeform tool (OpenAI custom tool with a grammar, e.g. apply_patch):
  // drivers that support it send the grammar and pass the raw text as
  // `{ input }`; others send input_schema.
  freeform?: { syntax: "lark" | "regex"; definition: string };
  // Sent with defer_loading: not in the prompt until a tool search names it
  // (the Anthropic wire and the Responses wire; see src/tools/defer.ts).
  defer?: boolean;
  // A deferred tool's group on the Responses wire (mcp__<server>): it loads
  // there as a function of that namespace, named by the rest of its name.
  namespace?: string;
  // The tool search of a family whose wire runs it as its own item (the
  // Responses wire's client tool_search) rather than as a function.
  search?: true;
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ProviderRequest = {
  model: string;
  system: string;
  // Where the per-session part of `system` starts. Before it is text every
  // session on this machine shares (identity, skills, MCP servers), so a new
  // session reads it from the provider's cache instead of writing it again.
  systemSplit?: number;
  // Where the session's own part of `system` starts (its artifacts folder,
  // its project). Before it, from the split, is what the sessions of one
  // folder share (the place and its instruction files): a new session or
  // agent in the folder reads that from the cache too. Absent for a prompt
  // kept from before this was recorded: its blocks stay as they were sent.
  systemOwn?: number;
  messages: Message[];
  tools: ToolSpec[];
  effort?: string;
  maxTokens?: number;
  signal: AbortSignal;
  // Stable per session: prompt cache affinity, conversation headers.
  sessionKey?: string;
  // Why the engine asks: a step of a turn, a compaction summary, a side
  // answer outside the history, or a reader's one read of long content for a
  // tool, or an MCP server's sampling request the owner allowed (no history,
  // the server's own messages). Read by telemetry, and by a driver that keeps
  // a connection per session to keep the turn's apart from the others'.
  // A "warm" request reads the cache beside the history while the session waits (src/engine/cache-plans.ts).
  purpose?: "turn" | "summary" | "side" | "reader" | "warm" | "sampling";
  // false: a one-off request nothing will repeat; no cache breakpoints (a
  // write costs more than plain input when no later request reads it).
  cache?: false;
  // The cache lifetime asked for, where the wire offers a choice (cacheLives):
  // "short" its shortest, "long" its longest; absent = the wire's default.
  cacheLife?: "short" | "long";
  // How long the prefix this request writes is kept, in ms: the lifetime it
  // asked for, else the one its route documents; absent when the provider
  // states none. Set by the engine, read by telemetry; drivers ignore it.
  cacheMs?: number;
  // The qualified model id (provider:model) the request goes to, for
  // measuring; `model` is the name on the wire.
  route?: string;
  // Filled by the registry from the listing: the levels the model takes.
  efforts?: string[];
  // Filled by the registry from the catalog: ModelInfo.interleaved.
  interleaved?: string;
  // The session's speed choice (a SpeedOffer id); the registry turns it into
  // the body fields and headers of that offer.
  speed?: string;
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  // Anthropic's prefix check on sent-back thinking (thinking.block_binding),
  // set by a driver whose platform takes it: "error" refuses a request with a
  // changed prefix; "drop_block" lets the provider leave such thinking out.
  blockBinding?: "error" | "drop_block";
  // The session asks for "drop_block" (a refused prefix was seen on it before).
  dropThinking?: boolean;
  // Set by the registry: every answer's headers, for its rate-limit windows.
  // A turn can check reachability sooner before its first HTTP headers.
  connectWaitMs?: number;
  onHeaders?: (h: Headers) => void;
  // Set by the registry: the provider accepted the request and its answer begins
  // (an outage of the provider is over: src/providers/outage.ts).
  onAnswer?: () => void;
};

export type Delta =
  | { kind: "text"; index: number; text: string }
  | { kind: "thinking"; index: number; text: string }
  | { kind: "tool_input"; index: number; text: string; name?: string };

export type ProviderResult = {
  blocks: AssistantBlock[];
  usage: Usage;
  stop: string; // end_turn | tool_use | max_tokens | refusal | pause_turn | ...
  // Set with stop "refusal": the provider's category and explanation.
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  model: string;
  // The tier the provider says served the call (`service_tier`, `usage.speed`).
  served?: string;
  // What the provider did to the input (Anthropic's input_transformations): thinking it dropped or let through.
  input_transformations?: { type: string; path?: string; reason?: string }[];
  // The provider refused the request's sent-back thinking as bound to another
  // conversation (its message); it was answered again with "drop_block".
  binding_refused?: string;
};

// The tool profile and projection rules a model gets. A family is per model:
// an aggregator lists Claude, GPT and Gemini models side by side.
export type Family = "claude" | "gpt" | "gemini" | "other";

// The wire a provider speaks (the plugin protocol's names).
export type Wire = "anthropic_messages" | "openai_responses" | "chat_completions" | "gemini_generate_content";

export type Price = {
  input: number; // USD per million tokens
  output: number;
  cache_read?: number;
  cache_write?: number;
  estimated?: boolean;
  // Rates for a request whose prompt is above `above` tokens (models.dev
  // `cost.tiers` of type context): the whole request is billed at that tier.
  tiers?: { above: number; input: number; output: number; cache_read?: number; cache_write?: number }[];
};

// A speed the provider sells for a model besides its standard one: what the
// listing (ChatGPT's `service_tiers`) or the catalog (models.dev `modes`)
// says, the fields and headers that ask for it, and its price when per token.
export type SpeedOffer = {
  id: string;           // the offer's own name: "fast", "priority", "ultrafast", "flex"
  label: string;
  note?: string;        // the provider's description ("2x speed, increased usage")
  price?: Price;        // per-token price at this speed; absent on a plan
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type Billing = { kind: "per_token" } | { kind: "subscription"; plan?: string } | { kind: "unknown" };

// A model id the provider's own listing returned, plus whatever the listing says.
export type ListedModel = {
  model: string;
  name?: string;
  context?: number;
  output?: number;
  efforts?: string[];
  family?: Family;
  price?: Price;
  billing?: Billing;
  images?: boolean;
  pdf?: boolean; // reads PDF documents (the catalog's input modalities)
  tools?: boolean;     // takes tool definitions (the listing's word)
  reasoning?: boolean; // thinks before it answers
  speeds?: SpeedOffer[];
};

export type ModelInfo = {
  id: string;          // "<provider>:<model as the provider names it>"
  provider: string;
  model: string;
  name: string;
  family: Family;
  context: number;
  context_assumed?: true; // neither the listing nor the catalog gave a window: `context` is the fallback compaction uses
  output: number;
  efforts: string[];
  release?: string;
  price?: Price;       // absent: unknown, never free
  billing: Billing["kind"];
  images?: boolean;
  pdf?: boolean; // reads PDF documents (the catalog's input modalities)
  // What is known of the model's tool calls, thinking and prompt cache: the
  // owner's statement, else a probe of the endpoint, else its listing, else
  // the route's catalog entry. Absent: not known.
  tools?: boolean;
  reasoning?: boolean;
  caching?: boolean;
  // Where each known capability came from.
  known_from?: Partial<Record<"tools" | "images" | "reasoning" | "caching", "owner" | "probe" | "listing" | "catalog">>;
  speeds?: SpeedOffer[];
  // The message field the model reads its earlier reasoning from (the
  // catalog's `interleaved.field`): a Chat Completions request carries it on
  // every assistant message (src/providers/wires/chat.ts).
  interleaved?: string;
};

export type ProviderStatus = {
  id: string;
  label: string;
  wire: Wire;
  kind: "builtin" | "endpoint" | "plugin";
  available: boolean;
  detail?: string;     // why not available, or where the credential comes from
  account?: string;
  sign_in?: { command?: string; route?: string; note?: string };
  // An endpoint's configuration: a preset, providers.toml, or its own file
  // under endpoints/ (the one Settings and `keel providers` edit).
  source?: "preset" | "providers.toml" | "endpoints";
  server?: string;     // the server kind an endpoint's metadata names (Ollama, vLLM, llama.cpp)
};

export interface Provider {
  readonly id: string;
  // An environment-configured address of an HTTP provider. Not a credential source.
  readonly broker?: import("./broker-address.ts").BrokerAddress;
  readonly label?: string;
  readonly wire?: Wire;
  // How the provider keeps a prompt's cache, when it says so itself (else its
  // wire's documented behaviour, src/engine/cache-plans.ts): for how long a
  // request's prefix is kept for sure, and whether a read refreshes that.
  readonly caching?: { life: number; refresh?: "read" };
  readonly family: Family; // the default for models whose id says nothing
  // The wire one of its models stands for, when it is not the provider's own
  // (the scripted stand-in of each family): what decides how its tools load.
  wireOf?(model: string): Wire | undefined;
  available(): boolean;
  // Looks again for a credential last found missing (at least `olderThanMs`
  // ago), so available() can change without a restart.
  recheck?(olderThanMs?: number): Promise<void>;
  // Looks for a credential nobody has read yet. Until then available() counts
  // it as there; after it, available() says what was found.
  look?(): Promise<void>;
  // Its credential has not been read yet (nobody looked, or the look is still
  // out): anything that needs the key would wait on that read.
  unread?(): boolean;
  // Which account and endpoint a listing comes from, as a one-way fingerprint
  // (never a credential): a saved listing is offered only to the same identity.
  identity?(): string;
  status?(): ProviderStatus;
  list(): Promise<ListedModel[]>;
  stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult>;
  // The account's usage windows, from an endpoint that states them.
  usage?(): Promise<import("./limits.ts").WindowReading[]>;
}
