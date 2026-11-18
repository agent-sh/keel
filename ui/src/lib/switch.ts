// A model or effort switch in a session with a warm prompt cache: the next
// request reads the context again without it. Ask first, with the tokens and
// the cost, then switch.
import type { SwitchWarning } from "../../../src/engine/cachewarn.ts";
import { confirmAction } from "../components/Confirm.tsx";
import { actions, api, getState } from "./store.ts";
import { fmtCost, fmtTokens } from "./utils.ts";

export async function switchSession(id: string, change: { model?: string; effort?: string }): Promise<boolean> {
  const q = new URLSearchParams();
  if (change.model) q.set("model", change.model);
  if (change.effort) q.set("effort", change.effort);
  const { warning } = await api<{ warning: SwitchWarning | null }>(`/api/sessions/${id}/switch-warning?${q}`);
  if (warning) {
    const name = getState().models.find((m) => m.id === change.model)?.name ?? change.model;
    const cost = warning.cost_usd !== undefined
      ? ` That costs about ${fmtCost(warning.cost_usd)}${warning.cached_cost_usd !== undefined ? `, against ${fmtCost(warning.cached_cost_usd)} from the cache` : ""}.`
      : "";
    const reads = `${warning.certain ? "The next request reads" : "The next request may read"} about ${fmtTokens(warning.uncached_tokens)} tokens again without the prompt cache.`;
    const why = warning.cause === "model"
      ? " The cache belongs to the model the conversation ran on."
      : warning.certain ? " The effort is part of the cached prompt." : " The provider does not say whether the effort is part of the cached prompt.";
    const ok = await confirmAction({
      title: warning.cause === "model" ? `Switch to ${name}?` : `Change the effort to ${change.effort}?`,
      body: reads + cost + why,
      action: warning.cause === "model" ? "Switch" : "Change effort",
    });
    if (!ok) return false;
  }
  await actions.patch(id, change.model ? { model: change.model } : { settings: { effort: change.effort } });
  return true;
}
