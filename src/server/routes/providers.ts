// Providers: what is set up, each listing's state, plugins, choices, and the
// Grok plan sign-in.
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const providersRoutes: RouteModule = ({ providers }) => {
  const report = async () => {
    await providers.plugins.freshen();
    const models = providers.current();
    const count = new Map<string, number>();
    for (const m of models) count.set(m.provider, (count.get(m.provider) ?? 0) + 1);
    return {
      providers: providers.statuses().map((s) => {
        const l = providers.listing(s.id);
        return { ...s, listing: { state: l.state, fetched_ms: l.fetched, error: l.error, models: count.get(s.id) ?? 0 } };
      }),
      plugins: providers.plugins.summary(),
      plugins_file: providers.plugins.file,
      plugins_error: providers.plugins.error,
      choices: providers.choices(),
      windows: [await providers.xai.window()].filter(Boolean).map((w) => ({ provider: "grok", ...w })),
    };
  };

  return {
    "/api/providers": { GET: async () => json(await report()) },

    "/api/providers/refresh": {
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => ({}))) as { provider?: string };
        await providers.refresh(b.provider || undefined);
        return json(await report());
      },
    },

    // { default?: id | null, provider?, hide?: ids, show?: ids }
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
        if (b.hide || b.show) {
          if (!b.provider) return json({ error: "a list change names its provider" }, 400);
          const hidden = new Set(c.hidden[b.provider] ?? []);
          for (const id of b.hide ?? []) {
            if (`${b.provider}:${id}` === c.default) return json({ error: "the default model cannot be hidden" }, 400);
            hidden.add(id);
          }
          for (const id of b.show ?? []) hidden.delete(id);
          c.hidden[b.provider] = [...hidden];
        }
        providers.setChoices(c);
        return json(await report());
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
