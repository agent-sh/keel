// Adding an endpoint by hand: the starting points (local servers, the
// catalog's providers), the connection test with errors that say what to fix
// (finding the models is one action, asking a model for a word another), and
// the scan of this machine for a running local server.
import type { CatalogProvider } from "./catalog.ts";
import { ID_RE, type EndpointConfig } from "./config.ts";
import { shown } from "./creds.ts";
import { EndpointProvider, wireBase } from "./endpoint.ts";
import { ProviderError } from "./http.ts";
import type { ListedModel, Wire } from "./types.ts";

export type Template = {
  id: string;
  label: string;
  group: "local" | "hosted";
  wire: Wire;
  base_url: string;
  key_env?: string;
  billing?: EndpointConfig["billing"];
  catalog?: string;  // the models.dev section that prices it
  note?: string;
  doc?: string;
  models?: number;   // models the catalog knows there
};

// Local servers and where each listens by default. Only the addresses: what
// they serve comes from their listing and their own metadata routes.
export const LOCAL_SERVERS: Template[] = [
  { id: "ollama", label: "Ollama", group: "local", wire: "chat_completions", base_url: "http://127.0.0.1:11434/v1", billing: "free",
    note: "Ollama runs a model with the window OLLAMA_CONTEXT_LENGTH sets (by default it depends on memory, 4k under 24 GB); agents need 64k or more." },
  { id: "vllm", label: "vLLM", group: "local", wire: "chat_completions", base_url: "http://127.0.0.1:8000/v1", billing: "free",
    note: "Tool calls need the server started with --enable-auto-tool-choice and a --tool-call-parser; thinking needs a --reasoning-parser." },
  { id: "sglang", label: "SGLang", group: "local", wire: "chat_completions", base_url: "http://127.0.0.1:30000/v1", billing: "free",
    note: "Tool calls need --tool-call-parser and thinking --reasoning-parser at launch." },
  { id: "llamacpp", label: "llama.cpp", group: "local", wire: "chat_completions", base_url: "http://127.0.0.1:8080/v1", billing: "free",
    note: "Name the model with --alias, or its id is the file path." },
  { id: "mlx", label: "MLX", group: "local", wire: "chat_completions", base_url: "http://127.0.0.1:8080/v1", billing: "free",
    note: "mlx_lm.server lists model ids only: probe a model to learn what it can do." },
  { id: "lmstudio", label: "LM Studio", group: "local", wire: "chat_completions", base_url: "http://127.0.0.1:1234/v1", billing: "free" },
  { id: "litellm", label: "LiteLLM proxy", group: "local", wire: "chat_completions", base_url: "http://127.0.0.1:4000/v1", key_env: "LITELLM_API_KEY",
    note: "The proxy's virtual key; the provider keys stay in the proxy's own configuration." },
];

// The wire a models.dev provider speaks, from the SDK package it names.
export function wireOfPackage(npm?: string): Wire | null {
  if (!npm) return null;
  if (npm === "@ai-sdk/anthropic") return "anthropic_messages";
  if (npm === "@ai-sdk/google") return "gemini_generate_content";
  if (npm === "@ai-sdk/openai") return "openai_responses";
  if (/openai-compatible|openrouter|^@ai-sdk\/(groq|deepinfra|togetherai|cerebras|mistral|perplexity|xai|fireworks|deepseek)$/.test(npm)) return "chat_completions";
  return null;
}

// The catalog's providers as starting points: an address and the variable
// its key is usually in. Providers whose wire is none of the four, or that
// Keel already reaches on its own route, are left out.
export function catalogTemplates(list: CatalogProvider[], builtin: Set<string>): Template[] {
  const out: Template[] = [];
  for (const p of list) {
    const wire = wireOfPackage(p.npm);
    if (!wire || builtin.has(p.id) || !p.models) continue;
    out.push({ id: p.id, label: p.name, group: "hosted", wire, base_url: p.api ?? "", key_env: p.env?.[0], catalog: p.id, doc: p.doc, models: p.models });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ---- what went wrong, and what to change ----

export type Failure = { status?: number; code?: string; message: string; contentType?: string; body?: string };
export type Explained = { problem: string; fix: string };
type Ctx = { url: string; wire: Wire; keyless: boolean; keyWhere?: string; step: "listing" | "model"; model?: string };

const hostPort = (url: string) => {
  try { const u = new URL(url); return u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { return url; }
};
const versioned = (url: string) => /\/v\d+(beta|alpha)?$|\/api\/v\d+$|\/openai$/.test(url.replace(/\/+$/, ""));

export function explain(f: Failure, c: Ctx): Explained {
  const m = `${f.code ?? ""} ${f.message}`;
  const at = hostPort(c.url);
  if (/ConnectionRefused|ECONNREFUSED|Unable to connect/i.test(m))
    return { problem: `Nothing answers at ${at}.`, fix: "Start the server, or correct the host and port in the base URL." };
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(m))
    return { problem: `The host name in ${at} does not resolve.`, fix: "Check the spelling of the base URL's host." };
  if (/CERT|certificate|SSL|TLS/i.test(m))
    return { problem: `The TLS certificate of ${at} is not trusted (${f.code ?? f.message.slice(0, 60)}).`, fix: "Use the server's real https address, or http:// for a local server without TLS." };
  if (/Timeout|timed out|ETIMEDOUT/i.test(m))
    return { problem: `${at} did not answer in time.`, fix: c.step === "model" ? "The model may still be loading: wait and test again, or raise stream_idle_timeout_ms for a slow server." : "Check that the address is reachable from this machine (a firewall or VPN)." };
  const html = /text\/html/.test(f.contentType ?? "") || /^\s*<(!doctype|html)/i.test(f.body ?? "");
  if (html || (f.status === 404 && c.step === "listing"))
    return {
      problem: html ? `${c.url} answers with a web page, not the API.` : `${c.url} has no model listing (HTTP 404).`,
      fix: c.wire === "chat_completions" || c.wire === "openai_responses"
        ? versioned(c.url) ? "Check the path: the base URL is the part before /chat/completions. If the server has no /models, list the models by hand." : "The base URL usually ends in /v1 (for example http://127.0.0.1:8000/v1)."
        : c.wire === "anthropic_messages" ? "The base URL is the part before /v1/messages." : "The base URL is the part before /v1beta/models.",
    };
  if (f.status === 401 || f.status === 403) {
    if (c.keyless) return { problem: `${at} wants a key (HTTP ${f.status}).`, fix: "Choose where the key is: an environment variable or a keyring entry." };
    return { problem: `The key${c.keyWhere ? ` in ${c.keyWhere}` : ""} was refused (HTTP ${f.status}).`, fix: "Check the key is current and belongs to this service. If it is right, the endpoint may expect it in another header: try the other key header." };
  }
  if (f.status === 402) return { problem: "The account has no credit left (HTTP 402).", fix: "Add credit on the provider's site, then test again." };
  if (f.status === 429) return { problem: "The endpoint is rate limiting or the quota is spent (HTTP 429).", fix: "Wait a moment and test again, or check the plan's limits." };
  if (f.status === 404 && c.step === "model")
    return { problem: `The endpoint does not serve ${c.model ?? "this model"} (HTTP 404).`, fix: "Pick a model from the endpoint's own listing." };
  if (f.status === 400 && /model/i.test(f.message) && /not|unknown|invalid|exist/i.test(f.message))
    return { problem: `The endpoint does not know ${c.model ?? "this model"}.`, fix: "Pick a model from the endpoint's own listing." };
  if (f.status === 503 && /loading/i.test(f.message)) return { problem: "The server is still loading the model.", fix: "Wait until it is loaded, then test again." };
  if (f.status && f.status >= 500) return { problem: `The server failed (HTTP ${f.status}).`, fix: "The request reached the server: its own log says why it failed." };
  if (/not JSON|Unexpected token|JSON Parse/i.test(m))
    return { problem: `${c.url} answered, but not with JSON.`, fix: "The base URL likely points at something other than the API: check the path." };
  return { problem: f.message.slice(0, 300), fix: "Check the base URL, the wire and the key." };
}

// ---- the connection test ----

export type TestStep = { id: "address" | "key" | "listing" | "model"; ok: boolean; detail: string; problem?: string; fix?: string; ms?: number };
export type TestResult = {
  ok: boolean;
  steps: TestStep[];
  models: { model: string; name?: string; context?: number }[];
  server?: string;
  // A change that made the test pass (a base URL with /v1 added), offered to the owner.
  suggest?: { base_url: string };
};

const failureOf = (e: unknown): Failure => {
  const err = e as any;
  const status = err instanceof ProviderError ? err.status : undefined;
  return { status, code: err?.code, message: String(err?.message ?? e) };
};

// Where the key comes from, in words.
const keyWhere = (c: EndpointConfig) => [c.key_env && `$${c.key_env}`, c.key_cred && `keyring entry ${c.key_cred}`].filter(Boolean).join(" or ") || undefined;

// A raw GET of the listing's first page, keeping what explain() reads (status,
// code, content type) and the page itself, which is read once.
async function getListing(p: EndpointProvider): Promise<{ ok: true; first: any } | { ok: false; f: Failure }> {
  let a: Awaited<ReturnType<EndpointProvider["auth"]>>;
  try { a = await p.auth(); } catch (e) { return { ok: false, f: failureOf(e) }; }
  try {
    const r = await fetch(p.listUrl, { headers: { accept: "application/json", ...a.headers }, signal: AbortSignal.timeout(10_000) });
    const body = await r.text();
    const ct = r.headers.get("content-type") ?? "";
    if (!r.ok) {
      let message = body.slice(0, 300);
      try { const j = JSON.parse(body); message = j.error?.message ?? j.error ?? j.message ?? j.detail ?? message; } catch {}
      for (const s of a.secrets) if (s) message = String(message).split(s).join("<redacted>");
      return { ok: false, f: { status: r.status, message: String(message), contentType: ct, body: body.slice(0, 200) } };
    }
    try { return { ok: true, first: JSON.parse(body) }; } catch { return { ok: false, f: { status: r.status, message: "not JSON", contentType: ct, body: body.slice(0, 200) } }; }
  } catch (e) {
    return { ok: false, f: failureOf(e) };
  }
}

// Finds the endpoint's models: the address, the key, the listing. No model is
// asked anything unless `model` names one: that request costs tokens, so it is
// the owner's own action. `only: "model"` asks the model without listing again.
// `section`: the catalog section's models, for an endpoint that has no listing
// (listing = false), the same list the saved endpoint offers.
export async function testEndpoint(cfg: EndpointConfig, o: { pastedKey?: string; model?: string; only?: "model"; section?: (cfg: EndpointConfig) => ListedModel[] } = {}): Promise<TestResult> {
  const steps: TestStep[] = [];
  const done = (extra: Partial<TestResult> = {}): TestResult => ({ ok: steps.every((s) => s.ok), steps, models: [], ...extra });
  const wire = cfg.wire ?? "chat_completions";

  // The address.
  let url: URL;
  try {
    url = new URL(cfg.base_url.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("not http");
  } catch {
    steps.push({ id: "address", ok: false, detail: cfg.base_url || "(empty)", problem: "The base URL is not an http or https address.", fix: "Write it in full, for example http://127.0.0.1:8000/v1." });
    return done();
  }
  if (cfg.id && !ID_RE.test(cfg.id)) {
    steps.push({ id: "address", ok: false, detail: cfg.id, problem: `"${cfg.id}" cannot be a provider id.`, fix: "Use lowercase letters, digits, - and _ (up to 40)." });
    return done();
  }
  steps.push({ id: "address", ok: true, detail: wireBase(wire, url.href) });

  // The key.
  const p = new EndpointProvider({ ...cfg, id: cfg.id || "draft" }, o.pastedKey);
  if (p.keyless) steps.push({ id: "key", ok: true, detail: "no key is sent" });
  else if (o.pastedKey) steps.push({ id: "key", ok: true, detail: "the key typed here (saved only to the keyring)" });
  else {
    try {
      await p.auth();
      steps.push({ id: "key", ok: true, detail: `found in ${shown({ env: cfg.key_env, cred: cfg.key_cred })}` });
    } catch (e) {
      steps.push({ id: "key", ok: false, detail: keyWhere(cfg) ?? "", problem: (e as Error).message.replace(/^[^:]+: /, ""), fix: cfg.key_env ? `Export ${cfg.key_env} where the daemon starts, or save the key to the keyring here.` : "Save the key to the keyring here, or name a variable that holds it." });
      return done();
    }
  }

  const ctx = { url: p.listUrl, wire, keyless: p.keyless, keyWhere: keyWhere(cfg), step: "listing" as const };
  let t = Date.now();
  let provider = p;
  let suggest: TestResult["suggest"];
  let models: ListedModel[] = [];
  if (o.only === "model") {
    // The model alone: its listing was read by the test before this one.
  } else if (cfg.listing === false) {
    // No listing is asked for: the catalog section names the models, as it does once saved.
    models = o.section?.(cfg) ?? [];
    steps.push({
      id: "listing", ok: models.length > 0, ms: Date.now() - t,
      detail: `${models.length} model${models.length === 1 ? "" : "s"} of the catalog section ${cfg.catalog || "(none named)"}; the endpoint's own listing is not asked for`,
      ...(models.length ? {} : { problem: cfg.catalog ? `The catalog section ${cfg.catalog} names no models.` : "No catalog section is named.", fix: "Name the models.dev section that lists this endpoint's models, or take out listing = false so the endpoint is asked." }),
    });
  } else {
    // The listing, with /v1 tried when the base URL lacks a version.
    let got = await getListing(p);
    const wrongPath = (f: Failure) => f.status === 404 || /html/.test(f.contentType ?? "") || f.message === "not JSON";
    if (!got.ok && (wire === "chat_completions" || wire === "openai_responses") && !versioned(p.base) && wrongPath(got.f)) {
      // The API under /v1: what it answers there (a listing, or a refused key) is the real state.
      const alt = new EndpointProvider({ ...cfg, id: cfg.id || "draft", base_url: `${p.base}/v1` }, o.pastedKey);
      const again = await getListing(alt);
      if (again.ok || !wrongPath(again.f)) { got = again; provider = alt; suggest = { base_url: alt.base }; ctx.url = alt.listUrl; }
    }
    if (got.ok) {
      try { models = await provider.list(got.first); } catch (e) { got = { ok: false, f: failureOf(e) }; }
    }
    if (!got.ok) {
      if (cfg.models?.length) {
        steps.push({ id: "listing", ok: true, detail: `no listing (${explain(got.f, ctx).problem}); the ${cfg.models.length} models named by hand are offered`, ms: Date.now() - t });
        models = cfg.models.map((model) => ({ model }));
      } else {
        const x = explain(got.f, ctx);
        steps.push({ id: "listing", ok: false, detail: ctx.url, ...x, ms: Date.now() - t });
        return done();
      }
    } else {
      steps.push({
        id: "listing", ok: models.length > 0, ms: Date.now() - t,
        detail: `${models.length} chat model${models.length === 1 ? "" : "s"}${provider.server ? ` on ${provider.server}` : ""}${suggest ? ` at ${suggest.base_url}` : ""}`,
        ...(models.length ? {} : { problem: "The listing has no chat models.", fix: "Load a model on the server, or name the models by hand." }),
      });
    }
  }

  // One short request to a model, when the owner named one.
  const model = o.model;
  if (model) {
    // A few tokens prove the address, the key and the model; a thinking
    // model may spend them all thinking, which still counts as an answer.
    t = Date.now();
    const limit = AbortSignal.timeout(60_000);
    try {
      const res = await provider.stream({
        model, system: "You are a connection check.", messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] }],
        tools: [], maxTokens: 16, signal: limit, purpose: "side",
      }, () => {});
      const said = res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("").trim();
      const how = said ? ` "${said.slice(0, 40)}"` : res.blocks.some((b) => b.type === "thinking") ? " (thinking)" : "";
      steps.push({ id: "model", ok: true, detail: `${model} answered${how} in ${((Date.now() - t) / 1000).toFixed(1)} s`, ms: Date.now() - t });
    } catch (e) {
      const f = limit.aborted ? { code: "Timeout", message: "timed out" } : failureOf(e);
      steps.push({ id: "model", ok: false, detail: model, ...explain(f, { ...ctx, url: provider.base, step: "model", model }), ms: Date.now() - t });
    }
  }
  return done({ models: models.map((m) => ({ model: m.model, name: m.name, context: m.context })), server: provider.server, suggest });
}

// ---- this machine's local servers ----

export type Found = { template: string; label: string; base_url: string; models: string[]; server?: string };

// Asks each local server's default address for its listing (a short timeout
// each, all at once). Two servers on one port are told apart by the listing.
export async function scanLocal(): Promise<Found[]> {
  const byUrl = new Map<string, Template[]>();
  for (const t of LOCAL_SERVERS) byUrl.set(t.base_url, [...(byUrl.get(t.base_url) ?? []), t]);
  const out = await Promise.all([...byUrl].map(async ([base, ts]): Promise<Found | null> => {
    try {
      const r = await fetch(`${base}/models`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(1_500) });
      if (!r.ok) return null;
      const d: any = await r.json();
      const rows: any[] = d.data ?? [];
      const owner = String(rows[0]?.owned_by ?? "");
      const t = ts.find((x) => x.id === (owner === "llamacpp" ? "llamacpp" : owner === "vllm" ? "vllm" : owner === "sglang" ? "sglang" : owner === "library" ? "ollama" : "")) ?? (ts.length > 1 ? ts.find((x) => x.id === "mlx")! : ts[0]!);
      return { template: t.id, label: t.label, base_url: base, models: rows.map((m) => String(m.id)) };
    } catch {
      return null;
    }
  }));
  return out.filter((x): x is Found => !!x);
}
