// One rule for moving a session to another model, used by the session PATCH
// (the picker), the profile POST and the CLI run: settings the new model does
// not take are dropped (an effort or speed it does not list), and the note
// "Model changed" is written only once the change is committed. When the two
// models share a name, the note says which provider each is on, and it keeps
// both qualified ids.
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { Session, SessionSettings } from "../core/types.ts";
import { speedOffer, type Providers } from "../providers/registry.ts";
import type { ModelInfo } from "../providers/types.ts";

// What the new model keeps of the session's settings.
export function carrySettings(settings: SessionSettings, info: ModelInfo): SessionSettings {
  const out = { ...settings };
  if (out.effort && !info.efforts.includes(out.effort)) delete out.effort;
  if (out.speed) {
    const o = speedOffer(info, out.speed);
    if (o) out.speed = o.id;
    else delete out.speed;
  }
  return out;
}

export async function switchNote(providers: Providers, from: string, to: ModelInfo): Promise<{ kind: "model"; text: string; from: string; to: string }> {
  const was = (await providers.models()).find((m) => m.id === from);
  // Two routes may list one name: then each end says its provider (its id
  // when the two providers' labels are the same too).
  const label = (id: string) => providers.statuses().find((p) => p.id === id.slice(0, id.indexOf(":")))?.label ?? id.slice(0, id.indexOf(":"));
  const same = was?.name === to.name;
  const apart = label(from) !== label(to.id);
  const end = (name: string | undefined, id: string) => (!name ? id : same ? `${name} (${apart ? label(id) : id})` : name);
  return { kind: "model", text: `Model changed from ${end(was?.name, from)} to ${end(to.name, to.id)}.`, from, to: to.id };
}

// Commits a validated model change: the session first, then its note, then
// one event for each.
export async function commitSwitch(store: Store, bus: Bus, providers: Providers, s: Session, info: ModelInfo, patch: Parameters<Store["updateSession"]>[1]): Promise<Session> {
  const note = info.id !== s.model ? await switchNote(providers, s.model, info) : undefined;
  const next = store.updateSession(s.id, { ...patch, model: info.id });
  if (note) bus.emit({ t: "event", event: store.append(s.id, "note", note) });
  return next;
}
