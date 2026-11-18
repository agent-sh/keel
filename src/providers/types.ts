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

// A model id the provider's own listing returned, plus catalog metadata.
export type ListedModel = { model: string; name?: string; context?: number; output?: number; efforts?: string[] };

export type ModelInfo = {
  id: string;          // "<provider>:<model as the provider names it>"
  provider: string;
  model: string;
  name: string;
  family: "claude" | "gpt" | "gemini" | "other";
  context: number;
  output: number;
  efforts: string[];
  release?: string;
};

export interface Provider {
  readonly id: string;
  readonly family: ModelInfo["family"];
  available(): boolean;
  list(): Promise<ListedModel[]>;
  stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult>;
}
