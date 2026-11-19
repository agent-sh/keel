// The model listing of another daemon, for a session it owns: that session's
// next turn runs there, so its picker offers what that daemon lists, never
// this one's catalog. Asked once per machine and again when its link returns.
import { useEffect, useSyncExternalStore } from "react";
import { api, onFeature, reportError, type ListedModel } from "./store.ts";

type Catalog = { models?: ListedModel[]; labels?: Record<string, string>; default?: string; error?: string };
const catalogs = new Map<string, Catalog>();
const asked = new Set<string>();
const subs = new Set<() => void>();
const bump = () => subs.forEach((f) => f());

export function loadPeerModels(machine: string, refresh = false) {
  asked.add(machine);
  api<{ models: ListedModel[]; default?: string; providers?: { id: string; label: string }[] }>(`/api/fleet/machines/${encodeURIComponent(machine)}/api/models${refresh ? "?refresh" : ""}`)
    .then((r) => catalogs.set(machine, { models: r.models, default: r.default, labels: Object.fromEntries((r.providers ?? []).map((p) => [p.id, p.label])) }))
    // The last listing it gave stays; only that it is not current is said.
    .catch((e) => {
      // A machine out of reach (the forwarder's 502) is a state the picker says; anything else is a failure.
      if ((e as { status?: number }).status !== 502) reportError(e, { at: "peer models", machine });
      catalogs.set(machine, { ...catalogs.get(machine), error: e instanceof Error ? e.message : String(e) });
    })
    .finally(bump);
}

onFeature({
  frame: (f) => {
    const m = (f.data as { machine?: string } | undefined)?.machine;
    if (f.name === "fleet_sessions" && m && asked.has(m)) loadPeerModels(m);
  },
});

const none: Catalog = {};
export function usePeerModels(machine?: string): Catalog | undefined {
  useEffect(() => { if (machine && !asked.has(machine)) loadPeerModels(machine); }, [machine]);
  const c = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => (machine ? catalogs.get(machine) ?? none : undefined));
  return c;
}
