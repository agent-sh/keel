// What a model or effort switch does to the session's prompt cache, for the
// pickers to warn before they switch. `ask`: whether the switch is worth a
// question (asksFirst in src/engine/switch-rule.ts, at the owner's
// model_switch.ask_usd). `ran_on` and `can_compact`: what the picker needs to
// price each row and to offer Compact first on it.
import { settings, registerSettings } from "../../admin/settings.ts";
import { switchWarning } from "../../engine/cachewarn.ts";
import { ASK_USD_DEFAULT, asksFirst } from "../../engine/switch-rule.ts";
import { contextTokens } from "../../engine/compact.ts";
import type { RouteModule } from "../app.ts";
import { carrySettings, resolveSwitchModel, switchCompactionBlock } from "../switch.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

registerSettings("model_switch", { ask_usd: ASK_USD_DEFAULT }, (v) =>
  typeof v.ask_usd === "number" && Number.isFinite(v.ask_usd) && v.ask_usd >= 0 ? undefined : "ask_usd is an amount in USD, 0 or more");
const askUsd = () => { const v = Number(settings().model_switch?.ask_usd); return Number.isFinite(v) && v >= 0 ? v : ASK_USD_DEFAULT; };

export const switchRoutes: RouteModule = ({ store, engine, providers }) => ({
  "/api/sessions/:id/switch-warning": {
    GET: async (req: any) => {
      const s = store.session(req.params.id);
      if (!s) return json({ error: "no such session" }, 404);
      const q = new URL(req.url).searchParams;
      const want = q.get("model") || s.model;
      const moving = want !== s.model;
      const unchanged = q.has("model") && !moving && !q.has("effort");
      const to = await resolveSwitchModel(providers, want);
      const running = engine.isRunning(s.id);
      const effort = q.has("effort") ? q.get("effort") || undefined : moving ? carrySettings(s.settings, to).effort : s.settings.effort;
      if (effort && q.has("effort") && !to.efforts.includes(effort)) return json({ error: `${to.name} does not take effort ${effort}` }, 400);
      const lineage = engine.lineage(s.id);
      const ranOn = [...lineage].reverse().find((e) => e.kind === "assistant")?.data.model ?? s.model;
      // Whether the context fits the new model: past its compaction line the
      // next request summarizes first (on that model), so the picker says so
      // and offers to compact on the model in use instead.
      const used = contextTokens(lineage, to.id).used;
      const compactAt = engine.limitOf(s, to.context);
      const fit = { used, window: to.context, compact_at: compactAt, over: used >= compactAt };
      const w = switchWarning({
        lineage, now: Date.now(), to, toEffort: effort,
        from: providers.cachedModel(ranOn),
        toWire: providers.get(to.provider)?.wire ?? "anthropic_messages",
        fromWire: providers.get(ranOn.slice(0, ranOn.indexOf(":")))?.wire ?? "anthropic_messages",
      });
      const can = !running && !switchCompactionBlock(providers, s.model);
      const rule = asksFirst({ lost: w.warning, over: moving && fit.over, askUsd: askUsd() });
      return json({ ...w, fit, running, ...(unchanged ? { unchanged: true } : {}), ...rule, ask_usd: askUsd(), ran_on: ranOn, can_compact: can, can_compact_first: moving && can });
    },
  },
});
