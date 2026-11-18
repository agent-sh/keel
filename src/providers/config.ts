// keel-bun's configuration directory and the providers file in it.
//
// <config>/providers.toml (all optional):
//
//   [[endpoint]]                         # an OpenAI-compatible endpoint
//   id = "openrouter"                    # also its provider id; replaces a preset of that id
//   label = "OpenRouter"
//   base_url = "https://openrouter.ai/api/v1"
//   key_env = "OPENROUTER_API_KEY"       # the key: this variable, else
//   key_cred = "openrouter-api-key"      #   this keyring entry (cred-get)
//   billing = "per_token"                # or "subscription" (a coding plan)
//   effort_field = "reasoning"           # "reasoning_effort" (default) or "reasoning"
//   replay_reasoning = true              # send thinking back as reasoning_content
//   models = ["a", "b"]                  # offered only when the endpoint has no listing
//   headers = { "x-title" = "Keel" }
//   extra_body = { cache_control = { type = "ephemeral" } }
//   catalog = "openrouter"               # models.dev section for prices
//   listing = false                      # no /models: offer the catalog section's models
//   enabled = false                      # turn a preset off
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  if (process.env.KEEL_CONFIG_DIR) return process.env.KEEL_CONFIG_DIR;
  const x = process.env.XDG_CONFIG_HOME;
  return join(x && x.startsWith("/") ? x : join(homedir(), ".config"), "keel-bun");
}

export type EndpointConfig = {
  id: string;
  label?: string;
  base_url: string;
  key_env?: string;
  key_cred?: string;
  billing?: "per_token" | "subscription";
  effort_field?: "reasoning_effort" | "reasoning";
  replay_reasoning?: boolean;
  models?: string[];
  headers?: Record<string, string>;
  extra_body?: Record<string, unknown>;
  session_header?: string;
  catalog?: string;   // the models.dev section with this endpoint's prices
  listing?: boolean;  // false: the endpoint has no /models; its catalog section names the models
  enabled?: boolean;
};

// Endpoints every install knows: where they are and which key they read. The
// models always come from the endpoint's own listing.
export const ENDPOINT_PRESETS: EndpointConfig[] = [
  { id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", key_env: "OPENROUTER_API_KEY", key_cred: "openrouter-api-key", catalog: "openrouter", effort_field: "reasoning", session_header: "x-session-id" },
  { id: "glm", label: "Z.ai coding plan", base_url: "https://api.z.ai/api/coding/paas/v4", key_env: "GLM_API_KEY", key_cred: "glm-api-key", catalog: "zai-coding-plan", billing: "subscription", replay_reasoning: true },
  { id: "fireworks", label: "Fireworks", base_url: "https://api.fireworks.ai/inference/v1", key_env: "FIREWORKS_API_KEY", key_cred: "fireworks-api-key", catalog: "fireworks-ai" },
  { id: "nvidia", label: "NVIDIA", base_url: "https://integrate.api.nvidia.com/v1", key_env: "NVIDIA_API_KEY", key_cred: "nvidia-api-key", catalog: "nvidia" },
  { id: "kimi", label: "Kimi coding plan", base_url: "https://api.kimi.com/coding/v1", key_env: "KIMI_API_KEY", key_cred: "kimi-code-api-key", catalog: "kimi-code-plan-global", billing: "subscription", replay_reasoning: true },
  { id: "alibaba", label: "Alibaba token plan", base_url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", key_env: "DASHSCOPE_API_KEY", key_cred: "alibaba-token-plan-api-key", catalog: "alibaba-token-plan", listing: false, billing: "subscription" },
  { id: "meta", label: "Meta", base_url: "https://api.meta.ai/v1", key_env: "META_API_KEY", key_cred: "meta-api-key", catalog: "meta" },
];

let cached: { at: number; mtime: number; doc: any } | null = null;

// The parsed providers.toml, read again when the file changes.
export function providersFile(): { endpoint?: EndpointConfig[] } & Record<string, any> {
  const p = join(configDir(), "providers.toml");
  if (!existsSync(p)) return {};
  const mtime = statSync(p).mtimeMs;
  if (cached && cached.mtime === mtime) return cached.doc;
  const doc = Bun.TOML.parse(readFileSync(p, "utf8")) as any;
  cached = { at: Date.now(), mtime, doc };
  return doc;
}

export function endpoints(): EndpointConfig[] {
  const own = providersFile().endpoint ?? [];
  const byId = new Map(ENDPOINT_PRESETS.map((e) => [e.id, e]));
  for (const e of own) byId.set(e.id, { ...byId.get(e.id), ...e });
  return [...byId.values()].filter((e) => e.enabled !== false && e.base_url);
}
