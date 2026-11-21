// Adding a provider by hand: starting points, the connection test, the
// scan for local servers, writing and removing an endpoint (its key goes to
// the keyring, never to a file), and probing what a model can do.
import { catalogTemplates, LOCAL_SERVERS, scanLocal, testEndpoint } from "../../providers/connect.ts";
import { checkEndpoint, endpoints, endpointsDir, moveEndpoint, providersFile, removeEndpoint, writeEndpoint, type EndpointConfig } from "../../providers/config.ts";
import { deleteKey, keyringService, saveKey } from "../../providers/creds.ts";
import { EndpointProvider } from "../../providers/endpoint.ts";
import { probe, type Cap } from "../../providers/probe.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string | string[], status = 400) => json({ error: Array.isArray(error) ? error.join(" ") : error, problems: Array.isArray(error) ? error : [error] }, status);

// The fields an endpoint takes from a request body (nothing else is written).
const FIELDS = ["label", "wire", "base_url", "key_env", "key_cred", "auth", "billing", "effort_field", "replay_reasoning", "models", "headers", "extra_body", "session_header", "catalog", "listing", "price", "model", "enabled", "stream_idle_timeout_ms"] as const;
function pick(id: string, b: any): EndpointConfig {
  const out: any = { id };
  for (const k of FIELDS) {
    const v = b?.[k];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

const keyringReady = async () => {
  try { await Bun.secrets.get({ service: keyringService(), name: "keel-keyring-check" }); return true; } catch { return false; }
};

export const providerSetupRoutes: RouteModule = ({ providers, errors }) => {
  const capture = (e: unknown, ctx: unknown) => errors.capture("provider", e, ctx);
  // Where an id is configured now (a preset, providers.toml, its own file).
  const sourceOf = (id: string) => endpoints().find((e) => e.id === id)?.source;

  return {
    // The starting points: local servers, the catalog's hosted providers, the plan sign-ins.
    "/api/providers/setup": {
      GET: async () => {
        await providers.catalog.load();
        const taken = new Set(providers.all().map((p) => p.id));
        const statuses = providers.statuses();
        return json({
          local: LOCAL_SERVERS,
          hosted: catalogTemplates(providers.catalog.providers(), new Set(["anthropic", "openai", "google", "xai", "amazon-bedrock"])),
          taken: [...taken],
          plans: statuses.filter((s) => s.id === "chatgpt" || s.id === "grok"),
          keyring: { service: keyringService(), ready: await keyringReady() },
          dir: endpointsDir(),
        });
      },
    },

    "/api/providers/scan": {
      POST: async () => {
        const found = await scanLocal();
        const configured = new Map(endpoints().map((e) => [new EndpointProvider(e).base, e.id]));
        return json({ found: found.map((f) => ({ ...f, configured: configured.get(f.base_url) })) });
      },
    },

    // { config, key? } finds a draft's models (a typed key is used for this test
    // only); { id } a saved endpoint's. No model is asked anything unless `model`
    // names one; with only = "model" that model is asked and nothing is listed.
    "/api/providers/test": {
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => null)) as any;
        if (!b || typeof b !== "object") return bad("the body is not an object");
        let cfg: EndpointConfig | undefined;
        if (b.config) cfg = { ...pick(String(b.config.id ?? ""), b.config) };
        else if (b.id) cfg = endpoints().find((e) => e.id === b.id);
        if (!cfg) return bad(b.id ? `no endpoint ${b.id}` : "give config or id", b.id ? 404 : 400);
        const key = typeof b.key === "string" && b.key.trim() ? b.key.trim() : undefined;
        const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined;
        if (b.only !== undefined && b.only !== "model") return bad(`only is "model" or absent`);
        if (b.only === "model" && !model) return bad("name the model to ask");
        try {
          if (cfg.listing === false) await providers.catalog.load();
          return json(await testEndpoint(cfg, { pastedKey: key, model, only: b.only, section: (c) => providers.sectionModels(new EndpointProvider({ ...c, id: c.id || "draft" })) }));
        } catch (e) {
          capture(e, { at: "testing an endpoint", provider: cfg.id });
          return bad(`the test itself failed: ${(e as Error).message}`, 500);
        }
      },
    },

    "/api/providers/endpoints/:id": {
      GET: (req: Request & { params: { id: string } }) => {
        const e = endpoints().find((x) => x.id === req.params.id) ?? (providersFile().endpoint ?? []).find((x: EndpointConfig) => x.id === req.params.id);
        return e ? json({ config: e }) : bad(`no endpoint ${req.params.id}`, 404);
      },
      // { config, key? }: writes endpoints/<id>.toml. A typed key goes to the
      // keyring under key_cred (named <id>-api-key when none is given).
      PUT: async (req: Request & { params: { id: string } }) => {
        const id = req.params.id;
        const b = (await req.json().catch(() => null)) as any;
        if (!b?.config || typeof b.config !== "object") return bad("give the endpoint as config");
        if (sourceOf(id) === "providers.toml") return bad(`${id} is configured in providers.toml: edit it there, or remove it there first`, 409);
        const cfg = pick(id, b.config);
        const key = typeof b.key === "string" ? b.key.trim() : "";
        if (key) cfg.key_cred ??= `${id}-api-key`;
        const problems = checkEndpoint(cfg);
        if (problems.length) return bad(problems);
        if (key) {
          try { await saveKey(cfg.key_cred!, key); } catch (e) {
            capture(e, { at: "saving a key to the keyring", provider: id });
            return bad(`the keyring did not take the key (${(e as Error).message}): export it in a variable and name that instead`, 500);
          }
        }
        const before = endpoints().find((e) => e.id === id);
        writeEndpoint(cfg);
        // Another address or account: what was probed there says nothing here.
        if (before && (before.base_url !== cfg.base_url || before.wire !== cfg.wire)) providers.probes.forget(id);
        await providers.refresh(id);
        return json({ config: endpoints().find((e) => e.id === id), listing: providers.listing(id) });
      },
      // ?forget_key=1 also removes the key Keel saved for it from the keyring.
      DELETE: async (req: Request & { params: { id: string } }) => {
        const id = req.params.id;
        const e = endpoints().find((x) => x.id === id);
        if (e?.source !== "endpoints") return bad(e ? `${id} is ${e.source === "preset" ? "a preset: turn it off with enabled = false" : "in providers.toml: remove it there"}` : `no endpoint ${id}`, e ? 409 : 404);
        removeEndpoint(id);
        let forgot = false;
        if (new URL(req.url).searchParams.get("forget_key") === "1" && e.key_cred) forgot = await deleteKey(e.key_cred);
        providers.probes.forget(id);
        return json({ removed: id, key_forgotten: forgot });
      },
    },

    // An endpoint of providers.toml moves to endpoints/<id>.toml, where the UI
    // edits it; the entry stays in providers.toml as comments under a note.
    "/api/providers/endpoints/:id/move": {
      POST: async (req: Request & { params: { id: string } }) => {
        const id = req.params.id;
        if (sourceOf(id) !== "providers.toml") return bad(`${id} is not an entry of providers.toml`, 409);
        try { moveEndpoint(id); } catch (e) { return bad((e as Error).message, 409); }
        await providers.refresh(id);
        return json({ config: endpoints().find((e) => e.id === id) });
      },
    },

    // { model: "provider:model", only?: caps } asks the model and keeps what it found.
    "/api/providers/probe": {
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => null)) as any;
        const id = String(b?.model ?? "");
        const pid = id.slice(0, id.indexOf(":")), model = id.slice(id.indexOf(":") + 1);
        const p = providers.get(pid);
        if (!pid || !p) return bad(`no provider ${pid || "named"}`, 404);
        if (!p.available()) return bad(`${p.label ?? pid} is not set up`);
        const only = Array.isArray(b?.only) ? (b.only.filter((c: string) => ["tools", "images", "reasoning", "caching"].includes(c)) as Cap[]) : undefined;
        const r = await probe(p, model, { only });
        r.identity = p.identity?.();
        if (r.ok) providers.probes.set(id, { ...providers.probes.get(id), ...r, found: { ...providers.probes.get(id)?.found, ...r.found } });
        return json({ result: r, model: providers.current().find((m) => m.id === id) });
      },
    },
  };
};
