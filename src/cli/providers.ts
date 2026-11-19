// keel providers: what is set up, and adding an endpoint by hand (any
// OpenAI-, Anthropic- or Gemini-compatible server, a local one, an
// aggregator), testing it, probing a model, finding local servers.
import { clean, command, EXIT, pipedStdin, printJson, usageError, type Client } from "./client.ts";

const USAGE = `keel providers [list]                    every provider, its listing and its key source
keel providers add ID --base-url URL [options]
    --wire chat|anthropic|gemini|responses  the API it speaks (default chat: OpenAI-compatible)
    --key-env VAR          the key is in this environment variable
    --key-keyring NAME     the key is in this keyring entry
    --key-stdin            read a key from standard input and save it to the keyring
                           (as --key-keyring NAME, else ID-api-key); never written to a file
    --auth bearer|x-api-key|x-goog-api-key|none   how the key is sent (default per wire)
    --header 'Name: value' a header (repeat); write {env:VAR} or {keyring:NAME} for a secret part
    --model ID             a model to offer when the endpoint has no listing (repeat)
    --catalog SECTION      the models.dev section with its prices and windows
    --billing per_token|subscription|free
    --label TEXT           the name shown
    --no-test              save without testing first
keel providers test ID|--base-url URL [--wire W] [--key-env VAR] [--model M]
                                         reach it, list its models, ask one model for a word
keel providers probe PROVIDER:MODEL [--only tools,images,reasoning,caching]
                                         ask a model what it can do (a few short requests)
keel providers scan                      find Ollama, vLLM, SGLang, llama.cpp, MLX, LM Studio here
keel providers templates [QUERY]         local servers and the catalog's hosted providers
keel providers remove ID [--forget-key]  remove an endpoint file (and the key Keel saved)`;

const WIRE: Record<string, string> = { chat: "chat_completions", anthropic: "anthropic_messages", gemini: "gemini_generate_content", responses: "openai_responses" };
const mark = (ok: boolean) => (ok ? "ok  " : "FAIL");

function draft(v: any, id: string) {
  const wire = v.wire ? WIRE[v.wire] ?? v.wire : undefined;
  const headers: Record<string, string> = {};
  for (const h of v.header ?? []) {
    const i = h.indexOf(":");
    if (i < 1) throw Object.assign(new Error(`--header "${h}" is not Name: value`), { status: 400 });
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return {
    id, label: v.label, wire, base_url: v["base-url"], key_env: v["key-env"], key_cred: v["key-keyring"], auth: v.auth,
    billing: v.billing, catalog: v.catalog, models: v.model, headers: Object.keys(headers).length ? headers : undefined,
  };
}

function printTest(r: any) {
  for (const s of r.steps) {
    console.log(`${mark(s.ok)} ${s.id.padEnd(8)} ${clean(s.detail)}`);
    if (!s.ok) console.log(`          ${clean(s.problem ?? "")}\n          fix: ${clean(s.fix ?? "")}`);
  }
  if (r.suggest?.base_url) console.log(`\nIt answered at ${r.suggest.base_url}: use that as the base URL.`);
}

async function list(c: Client, json: boolean) {
  const r = await c.get<any>("/api/providers");
  if (json) return (printJson(r.providers), EXIT.ok);
  const w = Math.max(...r.providers.map((p: any) => p.id.length));
  for (const p of r.providers) {
    const state = !p.available ? "not set up" : p.listing.state === "failed" ? `listing failed: ${p.listing.error}` : `${p.listing.models} models`;
    console.log(`${p.id.padEnd(w)}  ${clean(p.label).padEnd(24)} ${state}${p.source === "endpoints" ? "  (endpoints/)" : ""}${p.server ? `  ${p.server}` : ""}`);
    if (p.detail) console.log(`${"".padEnd(w)}  ${clean(p.detail)}`);
  }
  return EXIT.ok;
}

export const providers = command("providers", USAGE, {
  "base-url": { type: "string" }, wire: { type: "string" }, "key-env": { type: "string" }, "key-keyring": { type: "string" },
  "key-stdin": { type: "boolean" }, auth: { type: "string" }, header: { type: "string", multiple: true }, model: { type: "string", multiple: true },
  catalog: { type: "string" }, billing: { type: "string" }, label: { type: "string" }, "no-test": { type: "boolean" },
  only: { type: "string" }, "forget-key": { type: "boolean" },
}, async (v, pos, c) => {
  const [sub = "list", arg] = pos;
  if (sub === "list" || sub === "ls") return list(c, !!v.json);

  if (sub === "add") {
    if (!arg) return usageError("providers", "name the endpoint: keel providers add ID --base-url URL", USAGE);
    if (!v["base-url"]) return usageError("providers", "give --base-url", USAGE);
    if (v.wire && !WIRE[v.wire] && !Object.values(WIRE).includes(v.wire)) return usageError("providers", `--wire is one of ${Object.keys(WIRE).join(", ")}`, USAGE);
    const config = draft(v, arg);
    let key: string | undefined;
    if (v["key-stdin"]) {
      key = (await pipedStdin())?.trim();
      if (!key) return usageError("providers", "--key-stdin read nothing: pipe the key in (for example from a password manager)", USAGE);
    }
    if (!v["no-test"]) {
      const t = await c.post<any>("/api/providers/test", { config, key, model: v.model?.[0] });
      if (!v.json) printTest(t);
      if (t.suggest?.base_url) config.base_url = t.suggest.base_url;
      const listed = t.steps.find((s: any) => s.id === "listing")?.ok;
      if (!listed) {
        if (v.json) printJson(t);
        console.error("\nNot saved: fix the step above, or add --no-test to save as it is.");
        return EXIT.error;
      }
    }
    const r = await c.put<any>(`/api/providers/endpoints/${encodeURIComponent(arg)}`, { config, key });
    if (v.json) return (printJson(r), EXIT.ok);
    console.log(`\nSaved ${arg}${key ? `; the key is in the keyring as ${r.config.key_cred}` : ""}. ${r.listing.models.length} models listed.`);
    return EXIT.ok;
  }

  if (sub === "test") {
    const body = arg && !v["base-url"] ? { id: arg, model: v.model?.[0] } : { config: draft(v, arg ?? ""), model: v.model?.[0] };
    if (!("id" in body) && !v["base-url"]) return usageError("providers", "name a saved endpoint, or give --base-url", USAGE);
    const r = await c.post<any>("/api/providers/test", body);
    if (v.json) printJson(r);
    else printTest(r);
    return r.ok ? EXIT.ok : EXIT.error;
  }

  if (sub === "probe") {
    if (!arg?.includes(":")) return usageError("providers", "name the model as PROVIDER:MODEL (keel models lists them)", USAGE);
    const r = await c.post<any>("/api/providers/probe", { model: arg, only: v.only ? String(v.only).split(",") : undefined });
    if (v.json) return (printJson(r), EXIT.ok);
    if (!r.result.ok) return (console.error(`${arg} did not answer: ${clean(r.result.error)}`), EXIT.error);
    console.log(`${arg} answered in ${(r.result.latency_ms / 1000).toFixed(1)} s`);
    for (const [k, f] of Object.entries<any>(r.result.found)) console.log(`  ${k.padEnd(9)} ${f.value === true ? "yes" : f.value === false ? "no " : "?  "}  ${clean(f.note)}`);
    console.log(`  (${r.result.usage.input} input and ${r.result.usage.output} output tokens)`);
    return EXIT.ok;
  }

  if (sub === "scan") {
    const r = await c.post<any>("/api/providers/scan");
    if (v.json) return (printJson(r.found), EXIT.ok);
    if (!r.found.length) return (console.log("No local server answers at the default addresses."), EXIT.ok);
    for (const f of r.found) console.log(`${f.label.padEnd(10)} ${f.base_url}  ${f.models.length} models${f.configured ? `  (set up as ${f.configured})` : `  keel providers add ${f.template} --base-url ${f.base_url} --billing free`}`);
    return EXIT.ok;
  }

  if (sub === "templates") {
    const r = await c.get<any>("/api/providers/setup");
    const q = (arg ?? "").toLowerCase();
    const rows = [...r.local, ...r.hosted].filter((t: any) => !q || `${t.id} ${t.label}`.toLowerCase().includes(q));
    if (v.json) return (printJson(rows), EXIT.ok);
    for (const t of rows) console.log(`${t.id.padEnd(24)} ${clean(t.label).padEnd(28)} ${t.wire.padEnd(24)} ${t.base_url || "(base URL in its docs)"}${t.key_env ? `  $${t.key_env}` : ""}`);
    return EXIT.ok;
  }

  if (sub === "remove" || sub === "rm") {
    if (!arg) return usageError("providers", "name the endpoint to remove", USAGE);
    const r = await c.del<any>(`/api/providers/endpoints/${encodeURIComponent(arg)}${v["forget-key"] ? "?forget_key=1" : ""}`);
    console.log(`Removed ${r.removed}${r.key_forgotten ? "; its key is gone from the keyring" : ""}.`);
    return EXIT.ok;
  }
  return usageError("providers", `no subcommand ${sub}`, USAGE);
});

export const providerCommands = { providers };
