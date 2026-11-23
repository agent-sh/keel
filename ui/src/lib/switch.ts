// A model or effort switch. Asked first when it costs something: a warm
// prompt cache the next request reads again without (the tokens and the
// cost), or a context past the new model's compaction line (the next request
// summarizes it first, on the new model). If idle and the current model is
// available, the owner can compact on it first: that summary reads the
// cache it has now, and the new model starts from the summary.
import type { SwitchWarning } from "../../../src/engine/cachewarn.ts";
import { choose, confirmAction } from "../components/Confirm.tsx";
import { announce } from "./announce.ts";
import { actions, api, failed, getState } from "./store.ts";
import { tipSay } from "./tips.ts";
import { fmtCost, fmtTokens } from "./utils.ts";

type Fit = { used: number; window: number; compact_at: number; over: boolean };

export async function switchSession(id: string, change: { model?: string; effort?: string }): Promise<boolean> {
  let patching = false;
  try {
    const q = new URLSearchParams();
    if (change.model) q.set("model", change.model);
    if (change.effort) q.set("effort", change.effort);
    const { warning, fit, unchanged, can_compact_first } = await api<{ warning: SwitchWarning | null; fit?: Fit; unchanged?: boolean; can_compact_first?: boolean }>(`/api/sessions/${id}/switch-warning?${q}`);
    if (unchanged) {
      const text = "This session is already on that model.";
      tipSay(null, text, 4200);
      announce(text);
      return false;
    }
    const over = !!change.model && !!fit?.over;
    if (warning || over) {
      const models = getState().models;
      const name = models.find((m) => m.id === change.model)?.name ?? change.model;
      const parts: string[] = [];
      if (warning) {
        const cost = warning.cost_usd !== undefined
          ? ` That costs about ${fmtCost(warning.cost_usd)}${warning.cached_cost_usd !== undefined ? `, against ${fmtCost(warning.cached_cost_usd)} from the cache` : ""}.`
          : "";
        const reads = `${warning.certain ? "The next request reads" : "The next request may read"} about ${fmtTokens(warning.uncached_tokens)} tokens again without the prompt cache.`;
        const why = warning.cause === "model"
          ? " The cache belongs to the model the conversation ran on."
          : warning.certain ? " The effort is part of the cached prompt." : " The provider does not say whether the effort is part of the cached prompt.";
        parts.push(reads + cost + why);
      }
      if (over) parts.push(`The conversation (about ${fmtTokens(fit!.used)} tokens) is past where ${name} compacts (${fmtTokens(fit!.compact_at)} of its ${fmtTokens(fit!.window)} window): its next request summarizes it first.`);
      const title = change.model ? `Switch to ${name}?` : `Change the effort to ${change.effort}?`;
      const action = change.model ? "Switch" : "Change effort";
      const cur = getState().sessions[id]?.model;
      const curName = models.find((m) => m.id === cur)?.name ?? "the current model";
      const alt = change.model && can_compact_first && (over || warning?.cause === "model") ? "Compact first" : undefined;
      if (alt) parts.push(`Compact first: ${curName} summarizes the conversation${warning?.cause === "model" ? " from its warm cache" : ""}, and ${name} starts from the summary.`);
      const body = parts.join("\n\n");
      // Careful: the dialog is here to stop an unmeant re-read of the whole context, so a key typed ahead must not answer it.
      const pick = alt ? await choose({ title, body, action, alt, careful: true }) : (await confirmAction({ title, body, action, careful: true })) && "ok";
      if (!pick) return false;
      if (pick === "alt") await api(`/api/sessions/${id}/compact`, { method: "POST", body: JSON.stringify({ for_model: change.model }) });
    }
    patching = true;
    await actions.patch(id, { ...(change.model ? { model: change.model } : {}), ...(change.effort ? { settings: { effort: change.effort } } : {}) });
    return true;
  } catch (e) {
    const status = (e as { status?: number } | null)?.status;
    const refused = status !== undefined && status >= 400 && status < 500;
    const what = change.model ? "model switch" : "effort change";
    const text = `${!patching || refused ? `No ${what} was made` : `Could not confirm the ${what}`}: ${failed(e, { at: what })}`;
    tipSay(null, text, 6500);
    announce(text, "alert");
    return false;
  }
}
