// Providers: what is set up, each listing's state, plugins, choices, and the
// Grok plan sign-in.
import { registerHooks } from "../../engine/hooks.ts";
import type { RouteModule } from "../app.ts";
import { CLOSE_PERCENT, isClose } from "../../providers/limits.ts";
import { recordRepairs } from "../../providers/project.ts";
import { Check } from "../../providers/plugins/check.ts";
import { readPlugins } from "../../providers/plugins/config.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
// Whether a full model id is hidden under these choices (its own rule or its provider's).
const hiddenIn = (c: { hidden: Record<string, string[]>; hidden_providers?: string[] }, id: string) => {
  const p = id.slice(0, id.indexOf(":")), m = id.slice(id.indexOf(":") + 1);
  return !!c.hidden_providers?.includes(p) || !!c.hidden[p]?.includes(m);
};

export const providersRoutes: RouteModule = ({ providers, store, errors }) => {
  // The session's speed, read before each request so a change applies from
  // the next one, also in the middle of a turn. The registry turns it into the
  // offer's fields; a model without that offer runs at standard.
  registerHooks({
    beforeRequest: (s, req) => ({ ...req, speed: store.session(s.id)?.settings.speed }),
  });

  // A request that had to be repaired so its wire takes it is recorded once
  // per session and kind, as a warning (src/providers/project.ts).
  recordRepairs(errors);

  const report = async () => {
    await providers.plugins.freshen();
    const models = providers.current();
    const count = new Map<string, number>();
    for (const m of models) count.set(m.provider, (count.get(m.provider) ?? 0) + 1);
    return {
      providers: providers.statuses().map((s) => {
        const l = providers.listing(s.id);
        return { ...s, listing: { state: l.state, fetched_ms: l.fetched, error: l.error, models: count.get(s.id) ?? 0 }, problem: providers.problem(s.id) };
      }),
      plugins: providers.plugins.summary(),
      plugins_file: providers.plugins.file,
      plugins_error: providers.plugins.error,
      choices: providers.choices(),
      windows: await providers.windows(),
    };
  };

  return {
    "/api/providers": { GET: async () => json(await report()) },

    // The windows alone, for the picker: every provider's, with the close ones
    // named, and the account problems that stop turns.
    "/api/limits": {
      GET: async (req: Request) => {
        const windows = await providers.windows(new URL(req.url).searchParams.has("refresh"));
        const problems = Object.fromEntries(providers.statuses().map((s) => [s.id, providers.problem(s.id)]).filter(([, p]) => p));
        return json({ windows, close: windows.filter(isClose).map((w) => `${w.provider}:${w.id}`), problems, close_percent: CLOSE_PERCENT });
      },
    },

    "/api/providers/refresh": {
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => ({}))) as { provider?: string };
        await providers.refresh(b.provider || undefined);
        return json(await report());
      },
    },

    // { default?: id | null, provider?, hide?: ids, show?: ids, pin?: ids, unpin?: ids, hide_provider?, show_provider? }
    "/api/providers/choices": {
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => null)) as any;
        if (!b || typeof b !== "object") return json({ error: "the body is not an object" }, 400);
        const c = providers.choices();
        const models = providers.current();
        if (b.default === null) delete c.default;
        else if (typeof b.default === "string") {
          if (!models.some((m) => m.id === b.default)) return json({ error: `no provider lists ${b.default}` }, 400);
          c.default = b.default;
        }
        // The default the owner or the configuration names stays in the
        // picker: it cannot be hidden, and a hidden model is shown again
        // before it becomes the default. A fallback default is never hidden
        // (defaultModel passes over hidden models), so it needs no guard.
        const named = await providers.namedDefault(c);
        if (b.hide || b.show) {
          if (!b.provider) return json({ error: "a list change names its provider" }, 400);
          const hidden = new Set(c.hidden[b.provider] ?? []);
          for (const id of b.hide ?? []) {
            if (`${b.provider}:${id}` === named) return json({ error: "the default model cannot be hidden: choose another default first" }, 400);
            hidden.add(id);
          }
          for (const id of b.show ?? []) hidden.delete(id);
          c.hidden[b.provider] = [...hidden];
        }
        // Favorites: full ids; a pin goes to the end, an unpin leaves the order.
        if (Array.isArray(b.pin) || Array.isArray(b.unpin)) {
          const pinned = (c.pinned ?? []).filter((id) => !(b.unpin ?? []).includes(id));
          for (const id of b.pin ?? []) {
            if (!models.some((m) => m.id === id)) return json({ error: `no provider lists ${id}` }, 400);
            if (!pinned.includes(id)) pinned.push(id);
          }
          c.pinned = pinned;
        }
        // A whole provider out of the picker (its models stay findable by search).
        if (typeof b.hide_provider === "string" || typeof b.show_provider === "string") {
          const off = new Set(c.hidden_providers ?? []);
          if (b.hide_provider) {
            if (named?.startsWith(`${b.hide_provider}:`)) return json({ error: "the default model's provider cannot be hidden: choose another default first" }, 400);
            off.add(b.hide_provider);
          }
          if (b.show_provider) off.delete(b.show_provider);
          c.hidden_providers = [...off];
        }
        if (typeof b.default === "string" && hiddenIn(c, b.default))
          return json({ error: `${b.default} is hidden: show it again before making it the default` }, 400);
        providers.setChoices(c);
        return json(await report());
      },
    },

    // The conformance check of a configured plugin (what `keel plugin check <id>`
    // runs): a scratch process with fake credentials against a fake vendor.
    "/api/plugins/:id/check": {
      POST: async (req: Request & { params: { id: string } }) => {
        const e = readPlugins().entries.find((x) => x.id === req.params.id);
        if (!e) return json({ error: `no [plugins.${req.params.id}] in plugins.toml` }, 404);
        if (e.problem) return json({ error: e.problem }, 400);
        const c = new Check({
          id: e.id, command: e.command, args: e.args, env: e.env, settings: e.settings,
          providerSettings: Object.fromEntries(Object.entries(e.providers).map(([k, v]) => [k, v.settings ?? {}])),
        }, providers.stateDir);
        await c.run();
        const count = (r: string) => c.rows.filter((x) => x.result === r).length;
        return json({ rows: c.rows, summary: { passed: count("pass"), failed: count("fail"), not_applicable: count("n/a") } });
      },
    },

    "/api/providers/grok/sign-in": {
      GET: () => json(providers.xai.signInState()),
      POST: async () => {
        try {
          return json(await providers.xai.startSignIn());
        } catch (e) {
          const status = (e as any).kind === "network" ? 503 : 400;
          return json({ error: (e as Error).message, ...providers.xai.signInState() }, status);
        }
      },
    },

    "/api/providers/grok/sign-out": {
      POST: async () => json({ signed_out: await providers.xai.signOut() }),
    },
  };
};
