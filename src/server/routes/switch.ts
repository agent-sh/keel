// What a model or effort switch does to the session's prompt cache, for the
// pickers to warn before they switch.
import { switchWarning } from "../../engine/cachewarn.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const switchRoutes: RouteModule = ({ store, engine, providers }) => ({
  "/api/sessions/:id/switch-warning": {
    GET: async (req: any) => {
      const s = store.session(req.params.id);
      if (!s) return json({ error: "no such session" }, 404);
      const q = new URL(req.url).searchParams;
      const models = await providers.models();
      const want = q.get("model") || s.model;
      const to = models.find((m) => m.id === want);
      if (!to) return json({ error: `model ${want} is not listed` }, 400);
      const effort = q.has("effort") ? q.get("effort") || undefined : s.settings.effort;
      if (effort && q.has("effort") && !to.efforts.includes(effort)) return json({ error: `${to.name} does not take effort ${effort}` }, 400);
      const lineage = engine.lineage(s.id);
      const ranOn = [...lineage].reverse().find((e) => e.kind === "assistant")?.data.model ?? s.model;
      return json(switchWarning({
        lineage, now: Date.now(), to, toEffort: effort,
        from: models.find((m) => m.id === ranOn),
        toWire: providers.get(to.provider)?.wire ?? "anthropic_messages",
      }));
    },
  },
});
