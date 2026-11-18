import type { AssistantBlock, Message, Usage } from "../core/types.ts";

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  // A freeform tool (OpenAI custom tool with a grammar, e.g. apply_patch):
  // drivers that support it send the grammar and pass the raw text as
  // `{ input }`; others send input_schema.
  freeform?: { syntax: "lark" | "regex"; definition: string };
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ProviderRequest = {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  effort?: string;
  maxTokens?: number;
  signal: AbortSignal;
  // Stable per session: prompt cache affinity, conversation headers.
  sessionKey?: string;
  // Filled by the registry from the listing: the levels the model takes.
  efforts?: string[];
};

export type Delta =
  | { kind: "text"; index: number; text: string }
  | { kind: "thinking"; index: number; text: string }
  | { kind: "tool_input"; index: number; text: string; name?: string };

export type ProviderResult = {
  blocks: AssistantBlock[];
  usage: Usage;
  stop: string; // end_turn | tool_use | max_tokens | refusal | pause_turn | ...
  model: string;
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
};

export type ModelInfo = {
  id: string;          // "<provider>:<model as the provider names it>"
  provider: string;
  model: string;
  name: string;
  family: Family;
  context: number;
  output: number;
  efforts: string[];
  release?: string;
  price?: Price;       // absent: unknown, never free
  billing: Billing["kind"];
  images?: boolean;
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
};

export interface Provider {
  readonly id: string;
  readonly label?: string;
  readonly wire?: Wire;
  readonly family: Family; // the default for models whose id says nothing
  available(): boolean;
  status?(): ProviderStatus;
  list(): Promise<ListedModel[]>;
  stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult>;
}
