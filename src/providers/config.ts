// keel-bun's configuration directory and the endpoints configured in it.
//
// An endpoint lives in <config>/providers.toml (hand-written, as many as you
// like) or in <config>/endpoints/<id>.toml (one each, written by Settings >
// Providers and `keel providers add`; the same keys at the top level):
//
//   [[endpoint]]
//   id = "openrouter"                    # also its provider id; replaces a preset of that id
//   label = "OpenRouter"
//   wire = "chat_completions"            # or "anthropic_messages", "gemini_generate_content", "openai_responses"
//   base_url = "https://openrouter.ai/api/v1"
//   key_env = "OPENROUTER_API_KEY"       # the key: this variable, else
//   key_cred = "openrouter-api-key"      #   this keyring entry; neither: no key (a local server)
//   auth = "bearer"                      # how the key is sent: bearer, x-api-key, x-goog-api-key (default per wire)
//   billing = "per_token"                # "subscription" (a coding plan) or "free" (a local server)
//   effort_field = "reasoning"           # "reasoning_effort" (default) or "reasoning"
//   replay_reasoning = true              # send thinking back as reasoning_content
//   models = ["a", "b"]                  # offered only when the endpoint has no listing
//   headers = { "x-title" = "Keel", "x-team-key" = "{env:TEAM_KEY}" }   # {env:NAME} and {keyring:NAME} are filled in
//   extra_body = { cache_control = { type = "ephemeral" } }
//   catalog = "openrouter"               # models.dev section for prices and windows
//   listing = false                      # no /models: offer the catalog section's models
//   price = { input = 0, output = 0 }    # USD per million tokens for every model without its own
//   enabled = false                      # turn a preset off
//   stream_idle_timeout_ms = 900000      # cut a silent stream after this (default 300000)
//
//   [endpoint.model."qwen3-coder"]       # what the owner states about one model; wins over listing and probe
//   context = 262144
//   output = 32768
//   tools = true
//   images = false
//   price = { input = 0.2, output = 0.8, cache_read = 0.02 }
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { removeOwnFile, writeOwnFile } from "../core/ownfile.ts";
import { contains, ownersFolder } from "../core/paths.ts";
import type { Price, Wire } from "./types.ts";

export function configDir(): string {
  if (process.env.KEEL_CONFIG_DIR) return process.env.KEEL_CONFIG_DIR;
  ownersFolder("config folder", "KEEL_CONFIG_DIR");
  const x = process.env.XDG_CONFIG_HOME;
  return join(x && x.startsWith("/") ? x : join(homedir(), ".config"), "keel-bun");
}
// A file of Keel's own config folder: an edit of one keeps what it held as <name>.prev (core/ownfile.ts).
export const inConfigDir = (path: string) => {
  const dir = resolve(configDir()), p = resolve(path);
  return p !== dir && contains(dir, p);
};

export type ModelOverride = {
  name?: string;
  context?: number;
  output?: number;
  tools?: boolean;
  images?: boolean;
  reasoning?: boolean;
  caching?: boolean;
  price?: Price;
};

export type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key" | "none";

export type EndpointConfig = {
  id: string;
  label?: string;
  wire?: Wire;
  base_url: string;
  key_env?: string;
  key_cred?: string;
  auth?: AuthStyle;
  billing?: "per_token" | "subscription" | "free";
  effort_field?: "reasoning_effort" | "reasoning";
  replay_reasoning?: boolean;
  models?: string[];
  headers?: Record<string, string>;
  extra_body?: Record<string, unknown>;
  session_header?: string;
  catalog?: string;   // the models.dev section with this endpoint's prices
  listing?: boolean;  // false: the endpoint has no /models; its catalog section names the models
  price?: Price;
  model?: Record<string, ModelOverride>;
  enabled?: boolean;
  stream_idle_timeout_ms?: number;
  // Where it came from (set when read, never written).
  source?: "preset" | "providers.toml" | "endpoints";
};

// Endpoints every install knows: where they are and which key they read. The
// models always come from the endpoint's own listing.
export const ENDPOINT_PRESETS: EndpointConfig[] = ([
  { id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", key_env: "OPENROUTER_API_KEY", key_cred: "openrouter-api-key", catalog: "openrouter", effort_field: "reasoning", session_header: "x-session-id" },
  { id: "glm", label: "Z.ai coding plan", base_url: "https://api.z.ai/api/coding/paas/v4", key_env: "GLM_API_KEY", key_cred: "glm-api-key", catalog: "zai-coding-plan", billing: "subscription", replay_reasoning: true },
  { id: "fireworks", label: "Fireworks", base_url: "https://api.fireworks.ai/inference/v1", key_env: "FIREWORKS_API_KEY", key_cred: "fireworks-api-key", catalog: "fireworks-ai" },
  { id: "nvidia", label: "NVIDIA", base_url: "https://integrate.api.nvidia.com/v1", key_env: "NVIDIA_API_KEY", key_cred: "nvidia-api-key", catalog: "nvidia" },
  { id: "kimi", label: "Kimi coding plan", base_url: "https://api.kimi.com/coding/v1", key_env: "KIMI_API_KEY", key_cred: "kimi-code-api-key", catalog: "kimi-code-plan-global", billing: "subscription", replay_reasoning: true },
  { id: "alibaba", label: "Alibaba token plan", base_url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", key_env: "DASHSCOPE_API_KEY", key_cred: "alibaba-token-plan-api-key", catalog: "alibaba-token-plan", listing: false, billing: "subscription" },
  { id: "meta", label: "Meta", base_url: "https://api.meta.ai/v1", key_env: "META_API_KEY", key_cred: "meta-api-key", catalog: "meta" },
] as EndpointConfig[]).map((e) => ({ ...e, source: "preset" as const }));

const parsed = new Map<string, { mtime: number; doc: any }>();

// A TOML file, parsed again only when it changes.
function readToml(p: string): any {
  if (!existsSync(p)) return null;
  const mtime = statSync(p).mtimeMs;
  const hit = parsed.get(p);
  if (hit && hit.mtime === mtime) return hit.doc;
  const doc = Bun.TOML.parse(readFileSync(p, "utf8")) as any;
  parsed.set(p, { mtime, doc });
  return doc;
}

// The parsed providers.toml.
export function providersFile(): { endpoint?: EndpointConfig[] } & Record<string, any> {
  return readToml(join(configDir(), "providers.toml")) ?? {};
}

export const endpointsDir = () => join(configDir(), "endpoints");

// The endpoints written one per file. A file that does not parse is reported
// once by the caller and skipped, never a reason for the others to vanish.
export function endpointFiles(onError?: (file: string, e: unknown) => void): EndpointConfig[] {
  const dir = endpointsDir();
  if (!existsSync(dir)) return [];
  const out: EndpointConfig[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".toml")).sort()) {
    try {
      const doc = readToml(join(dir, f));
      if (doc?.base_url) out.push({ ...doc, id: f.slice(0, -5), source: "endpoints" });
    } catch (e) {
      onError?.(join(dir, f), e);
    }
  }
  return out;
}

export function endpoints(onError?: (file: string, e: unknown) => void): EndpointConfig[] {
  const byId = new Map(ENDPOINT_PRESETS.map((e) => [e.id, e]));
  for (const e of providersFile().endpoint ?? []) byId.set(e.id, { ...byId.get(e.id), ...e, source: "providers.toml" });
  for (const e of endpointFiles(onError)) byId.set(e.id, { ...byId.get(e.id), ...e });
  return [...byId.values()].filter((e) => e.enabled !== false && e.base_url);
}

// ---- writing one endpoint file ----

const BARE = /^[A-Za-z0-9_-]+$/;
const key = (k: string) => (BARE.test(k) ? k : JSON.stringify(k));

function value(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(value).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${key(k)} = ${value(x)}`).join(", ")} }`;
  throw new Error(`cannot write ${typeof v} to TOML`);
}

// The endpoint as TOML: plain keys first, then one table per model override.
export function endpointToml(e: EndpointConfig): string {
  const { id: _id, source: _s, model, ...rest } = e;
  const lines = [`# ${e.label ?? e.id}: written by Keel (Settings > Providers, keel providers). Edit freely.`];
  for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== "") lines.push(`${key(k)} = ${value(v)}`);
  for (const [m, o] of Object.entries(model ?? {})) {
    const set = Object.entries(o).filter(([, v]) => v !== undefined);
    if (!set.length) continue;
    lines.push("", `[model.${key(m)}]`, ...set.map(([k, v]) => `${key(k)} = ${value(v)}`));
  }
  return lines.join("\n") + "\n";
}

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function writeEndpoint(e: EndpointConfig) {
  if (!ID_RE.test(e.id)) throw new Error(`the id "${e.id}" is not a name: lowercase letters, digits, - and _`);
  const p = join(endpointsDir(), `${e.id}.toml`);
  const text = endpointToml(e);
  Bun.TOML.parse(text); // what is written must read back
  writeOwnFile(p, text);
}

export function removeEndpoint(id: string): boolean {
  const p = join(endpointsDir(), `${id}.toml`);
  if (!ID_RE.test(id)) return false;
  return removeOwnFile(p); // kept as <id>.toml.prev, which the listing does not read
}

// ---- moving a providers.toml entry to its own file ----

const canonJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

// providers.toml's [[endpoint]] entry `id` as a file of its own, and the
// providers.toml text with that entry commented out under a note. The entry's
// lines move as written, comments included; nothing else changes. Both texts
// are parsed back and compared with the original, so a layout this cannot
// cut cleanly is refused instead of guessed.
export function splitEndpoint(text: string, id: string, today = new Date().toISOString().slice(0, 10)): { file: string; rest: string } {
  const doc = Bun.TOML.parse(text) as any;
  const list: any[] = doc.endpoint ?? [];
  const k = list.findIndex((e) => e?.id === id);
  if (k < 0) throw new Error(`providers.toml has no [[endpoint]] with id = "${id}"`);
  const lines = text.split("\n");
  const header = /^\s*\[\[\s*endpoint\s*\]\]\s*(#.*)?$/;
  const sub = /^\s*\[{1,2}\s*endpoint\s*\./;
  const starts = lines.flatMap((l, i) => (header.test(l) ? [i] : []));
  if (starts.length !== list.length) throw new Error("providers.toml declares endpoints in a form Keel cannot move (inline or dotted): move it by hand");
  const from = starts[k]!;
  let to = from + 1;
  while (to < lines.length && !(/^\s*\[/.test(lines[to]!) && !sub.test(lines[to]!))) to++;
  // Comments and blank lines just above the next table belong to it.
  while (to > from + 1 && /^\s*(#.*)?$/.test(lines[to - 1]!)) to--;
  const block = lines.slice(from, to);
  const body = block.slice(1).filter((l) => !/^\s*id\s*=/.test(l)).map((l) => l.replace(/^(\s*\[{1,2})\s*endpoint\s*\./, "$1"));
  const file = [`# Moved from providers.toml by Keel on ${today}. Edit freely.`, ...body].join("\n").replace(/\n*$/, "\n");
  const rest = [
    ...lines.slice(0, from),
    `# Moved to endpoints/${id}.toml by Keel on ${today}: edit it there. Kept here as comments only.`,
    ...block.map((l) => (/^\s*(#.*)?$/.test(l) ? l : `# ${l}`)),
    ...lines.slice(to),
  ].join("\n");
  const { id: _id, ...entry } = list[k];
  if (canonJson(Bun.TOML.parse(file)) !== canonJson(entry)) throw new Error(`the ${id} entry did not read back the same from its own file: move it by hand`);
  const left = Bun.TOML.parse(rest) as any;
  const want = { ...doc, endpoint: list.filter((_, i) => i !== k) };
  if (!want.endpoint.length) delete want.endpoint;
  if (canonJson({ ...left, endpoint: left.endpoint?.length ? left.endpoint : undefined }) !== canonJson({ ...want, endpoint: want.endpoint })) throw new Error("providers.toml would change beyond that entry: move it by hand");
  return { file, rest };
}

// Writes endpoints/<id>.toml from the entry, then providers.toml with the entry commented out.
export function moveEndpoint(id: string) {
  if (!ID_RE.test(id)) throw new Error(`the id "${id}" is not a name`);
  const src = join(configDir(), "providers.toml");
  const dest = join(endpointsDir(), `${id}.toml`);
  if (existsSync(dest)) throw new Error(`endpoints/${id}.toml already exists: it is the one in use`);
  const { file, rest } = splitEndpoint(readFileSync(src, "utf8"), id);
  writeOwnFile(dest, file);
  writeOwnFile(src, rest);
}

// ---- checking an endpoint before it is written ----

const WIRES = ["chat_completions", "anthropic_messages", "gemini_generate_content", "openai_responses"];
const CRED_HEADER = /authorization|api[-_]?key|token|secret|password|cookie|signature/i;
const LOOKS_SECRET = /\b(sk|pk|rk|xai|gsk|AIza)[-_A-Za-z0-9]{16,}|\b[A-Za-z0-9_\-+/=]{40,}\b/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CRED_NAME = /^[A-Za-z0-9_.-]{1,80}$/;

// What is wrong with an endpoint, in words that say what to change; empty
// when it can be written. A credential is only ever named, never written.
export function checkEndpoint(e: EndpointConfig): string[] {
  const out: string[] = [];
  if (!ID_RE.test(e.id ?? "")) out.push(`The id "${e.id ?? ""}" is not a name: use lowercase letters, digits, - and _ (up to 40).`);
  try {
    const u = new URL(String(e.base_url ?? "").trim());
    if (!/^https?:$/.test(u.protocol)) out.push("The base URL must start with http:// or https://.");
    if (u.username || u.password) out.push("The base URL carries a user and password: name the key by reference instead.");
    for (const [k, v] of u.searchParams) if (CRED_HEADER.test(k) || LOOKS_SECRET.test(v)) out.push(`The base URL's ${k} looks like a credential: name the key by reference instead.`);
  } catch {
    out.push("The base URL is not an address: write it in full, for example http://127.0.0.1:8000/v1.");
  }
  if (e.wire && !WIRES.includes(e.wire)) out.push(`The wire "${e.wire}" is not one of ${WIRES.join(", ")}.`);
  if (e.key_env && !ENV_NAME.test(e.key_env)) out.push(`"${e.key_env}" is not an environment variable name.`);
  if (e.key_cred && !CRED_NAME.test(e.key_cred)) out.push(`"${e.key_cred}" is not a keyring entry name: letters, digits, ., - and _.`);
  if (e.key_env && LOOKS_SECRET.test(e.key_env)) out.push("The key variable field holds what looks like a key: write the variable's name, or save the key to the keyring.");
  for (const [name, raw] of Object.entries(e.headers ?? {})) {
    const v = String(raw);
    const rest = v.replace(/\{(env|keyring):[A-Za-z0-9_.-]+\}/g, "").replace(/^\s*(bearer|basic|token)\s*/i, "").trim();
    if ((CRED_HEADER.test(name) && rest) || LOOKS_SECRET.test(rest))
      out.push(`The ${name} header holds a credential in plain text: write {env:NAME} or {keyring:NAME} in its place.`);
  }
  for (const [m, o] of Object.entries(e.model ?? {})) {
    const p = o?.price;
    if (p && (typeof p.input !== "number" || typeof p.output !== "number" || p.input < 0 || p.output < 0)) out.push(`The price of ${m} needs input and output, in USD per million tokens, not below 0.`);
  }
  if (e.price && (typeof e.price.input !== "number" || typeof e.price.output !== "number")) out.push("The endpoint's price needs input and output, in USD per million tokens.");
  return out;
}
