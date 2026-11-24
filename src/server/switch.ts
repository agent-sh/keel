// One rule for moving a session to another model, used by the session PATCH
// (the picker), the profile POST and the CLI run: settings the new model does
// not take are dropped (an effort or speed it does not list), and the note
// "Model changed" is written only once the change is committed. When the two
// models share a name, the note says which provider each is on, and it keeps
// both qualified ids.
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { Session, SessionSettings } from "../core/types.ts";
import { ModelLookupError, speedOffer, type Providers } from "../providers/registry.ts";
import type { ModelInfo } from "../providers/types.ts";
import { nearestEffort } from "../engine/switch-rule.ts";

// Preview and PATCH must accept exactly the same model, even if it was
// missing from the cached listing when the owner picked it.
export async function resolveSwitchModel(providers: Providers, id: string): Promise<ModelInfo> {
  try { return (await providers.resolve(id, { scoped: true })).info; }
  catch (e) {
    if (!(e instanceof ModelLookupError)) throw e;
    throw Object.assign(e, { status: e.listingFailed ? 409 : 400 });
  }
}

// An optional summary should not spend a request on a route already known to
// be unavailable. Neither this check nor a switch away needs to relist it.
export function switchCompactionBlock(providers: Providers, model: string): string | undefined {
  const pid = model.slice(0, model.indexOf(":"));
  const label = providers.get(pid)?.label ?? pid;
  const failure = providers.listingFailure(pid);
  if (failure) return failure;
  const problem = providers.shut(model);
  if (problem) return `${label}: ${problem.message}`;
  if (!providers.cachedModel(model)) return `the current model ${model} is unavailable`;
}

// What the new model keeps of the session's settings.
export function carrySettings(settings: SessionSettings, info: ModelInfo): SessionSettings {
  const out = { ...settings };
  if (out.effort) {
    const e = nearestEffort(out.effort, info.efforts);
    if (e) out.effort = e;
    else delete out.effort;
  }
  if (out.speed) {
    const o = speedOffer(info, out.speed);
    if (o) out.speed = o.id;
    else delete out.speed;
  }
  return out;
}

// Who asked for the switch: the owner (the page, the API) or `keel run`.
export type SwitchBy = "owner" | "cli";

// The note in the transcript. The new model is told it took over by the
// engine, at the request it first answers (see Engine.tellSwitch).
export type SwitchNote = {
  kind: "model"; text: string; from: string; to: string; by: SwitchBy;
  // The effort moved with it (mapped to the nearest level, or the model's default).
  effort?: { from?: string; to?: string };
  // Made while a turn ran: the turn goes on on the new model from its next request.
  running?: boolean;
};

export async function switchNote(providers: Providers, from: string, to: ModelInfo, o: { by?: SwitchBy; effort?: { from?: string; to?: string }; running?: boolean } = {}): Promise<SwitchNote> {
  const was = providers.cachedModel(from);
  // Two routes may list one name: then each end says its provider (its id
  // when the two providers' labels are the same too).
  const label = (id: string) => providers.statuses().find((p) => p.id === id.slice(0, id.indexOf(":")))?.label ?? id.slice(0, id.indexOf(":"));
  const same = was?.name === to.name;
  const apart = label(from) !== label(to.id);
  const end = (name: string | undefined, id: string) => (!name ? id : same ? `${name} (${apart ? label(id) : id})` : name);
  const e = o.effort && o.effort.from !== o.effort.to ? o.effort : undefined;
  const effortText = e ? (e.to ? ` Effort ${e.from} is now ${e.to}.` : ` ${to.name} does not take effort ${e.from}: it runs at its default.`) : "";
  return {
    kind: "model",
    text: `Model changed from ${end(was?.name, from)} to ${end(to.name, to.id)}.${effortText}${o.running ? " The running turn goes on with it from its next request." : ""}`,
    from, to: to.id, by: o.by ?? "owner",
    ...(e ? { effort: e } : {}),
    ...(o.running ? { running: true } : {}),
  };
}

// Commits a validated model change: the session first, then its note, then
// one event for each.
export async function commitSwitch(store: Store, bus: Bus, providers: Providers, s: Session, info: ModelInfo, patch: Parameters<Store["updateSession"]>[1], o: { by?: SwitchBy; running?: boolean } = {}): Promise<Session> {
  const effort = { from: s.settings.effort, to: patch.settings ? patch.settings.effort : s.settings.effort };
  const note = info.id !== s.model ? await switchNote(providers, s.model, info, { ...o, effort: effort.from ? effort : undefined }) : undefined;
  const next = store.updateSession(s.id, { ...patch, model: info.id });
  if (note) bus.emit({ t: "event", event: store.append(s.id, "note", note) });
  return next;
}
